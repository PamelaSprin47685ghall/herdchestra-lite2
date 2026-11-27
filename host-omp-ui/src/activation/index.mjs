// Composition root. It instantiates the station, adapter, fence, tickets and
// server, then binds them with mechanical wiring only. No business branching.
import { record } from "../host/diagnostics.mjs";
import { createHostTickets } from "../host/tickets/host-tickets.mjs";
import { createUiBridge } from "../host/tickets/interaction-bridge.mjs";
import { createSessionAdapter } from "../host/session-adapter.mjs";
import {
	createStartRuntimeTicket,
	ensureSurfaceWatcher,
	hydrateStation,
	sessionEnvelope,
} from "../host/session-launch.mjs";
import { mountTuiFence } from "../host/tickets/fence-ticket.mjs";
import { initialFence, isTuiSurface } from "../station/domain/fence-lifecycle.mjs";
import {
	getLastCapture,
	installComposerCapture,
	loadTuiModules,
	setRealCustomEditor,
} from "../host/tui-fence.mjs";
import { createUiBridgeStation } from "../station/ui-bridge-station.mjs";
import { wireCommands } from "./commands.mjs";
import { wireHooks } from "./hooks.mjs";
import { buildBridgeCapabilities } from "./tickets.mjs";

let runtime = null;

function diagnostics() {
	return { record };
}

function status() {
	if (runtime?.url) return { url: runtime.url, reason: null };
	return { url: null, reason: runtime?.reason ?? "no active main session" };
}

const startRuntime = createStartRuntimeTicket({ record });

// Teardown order matters. `disposed` goes first so a boot still in flight
// cannot install a runtime; then we wait for that boot to settle (bounded),
// so its later writes land before the final flush; then the flush runs while
// `runtime` still resolves dispatch; only then do we clear and tear down.
// A boot that is already past its disposed checks closes its own server.
function settleBoot(boot, deadlineMs) {
	if (!boot) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => finish(), deadlineMs);
		timer.unref?.();
		function finish() {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		}
		Promise.resolve(boot).then(finish, finish);
	});
}

// A station's dispatch must resolve through the runtimeRef it was born with.
// Reading the module-level current runtime at flush time would deliver one
// session's pending deltas to whichever session was installed most recently.
export function bindStationDispatch(runtimeRef) {
	return (event) => runtimeRef?.capabilitiesDispatch?.(event);
}

export async function shutdownRuntime(current, { deadlineMs = 2000 } = {}) {
	if (!current) return;
	current.disposed = true;
	await settleBoot(current.bootPromise, deadlineMs);
	current.station?.flushDeltas?.();
	if (runtime === current) runtime = null;
	current.unsubscribeCapture?.();
	try {
		current.bridge?.cancel?.();
	} catch (error) {
		record("bridge-cancel", error);
	}
	try {
		current.watcher?.dispose?.();
	} catch (error) {
		record("watcher-dispose", error);
	}
	try {
		current.uiDecoration?.dispose?.();
	} catch (error) {
		record("ui-decoration-dispose", error);
	}
	try {
		await current.server?.close?.();
	} catch (error) {
		record("server-close", error);
	}
}

export function wireUiExtension(pi, env = {}) {
	const onSessionStart = async (_event, ctx) => {
		try {
			if (!ctx || ctx.agent?.kind === "sub") {
				runtime = { reason: "session is not a main session", url: null };
				return;
			}
			const isTui = isTuiSurface(ctx);
			const modules = isTui ? await loadTuiModules(pi) : null;
			if (modules?.CustomEditor) setRealCustomEditor(modules.CustomEditor);
			if (modules?.Composer) installComposerCapture({ ComposerClass: modules.Composer });

			const adapter = createSessionAdapter({ ctx, pi });
			const runtimeRef = {
				ctx,
				pi,
				adapter,
				modules,
				capture: isTui ? getLastCapture() : null,
				url: null,
				reason: "starting the local web surface",
				server: null,
				watcher: null,
				reconciler: null,
				disposed: false,
			};
			const station = createUiBridgeStation({
				cwd: ctx.cwd,
				// Bind to this session's ref, not the module-level current runtime:
				// during shutdown's bounded boot wait a new runtime may already be
				// installed, and this station's pending deltas must never reach it.
				capabilities: { dispatch: bindStationDispatch(runtimeRef) },
			});
			const tickets = createHostTickets({
				adapter,
				pi,
				ctx,
				diagnostics: diagnostics(),
				getServer: () => runtimeRef.server,
				getEditor: () => runtimeRef.capture?.editor,
				getTui: () => runtimeRef.capture?.tui,
				getReconciler: () => runtimeRef.reconciler,
			});
			const bridge = createUiBridge({ station, getServer: () => runtimeRef.server });
			runtimeRef.capture?.editor?.setBridge?.(bridge);
			runtimeRef.station = station;
			runtimeRef.tickets = tickets;
			runtimeRef.bridge = bridge;
			runtimeRef.fence = initialFence(modules);
			station.onMetaUpdate?.({ fence: runtimeRef.fence });
			runtimeRef.capabilitiesDispatch = buildBridgeCapabilities({
				tickets,
				diagnostics: diagnostics(),
				onResult: (event, result) => station.reconcileTicketResult(event, result),
			}).dispatch;
			runtime = runtimeRef;
			if (isTui) mountTuiFence({
				ctx,
				modules,
				bridge,
				runtimeRef,
				station,
				record,
				isCurrent: () => runtime === runtimeRef,
				ensureSurfaceWatcher,
			});
			// Keep the boot promise so shutdown can wait for it. startRuntime has
			// its own error boundary, so a failure never escapes as a rejection.
			runtimeRef.bootPromise = startRuntime(runtimeRef, env, adapter, ctx);
		} catch (error) {
			record("session-start", error);
		}
	};

	const onSessionShutdown = async () => {
		await shutdownRuntime(runtime);
	};

	wireHooks({
		pi,
		getStation: () => runtime?.station,
		diagnostics: diagnostics(),
		onSessionStart,
		onSessionShutdown,
		onSessionChange: (ctx) => {
			const current = runtime;
			if (!current?.adapter) return;
			const next = ctx ?? current.ctx;
			void hydrateStation(current.station, current.adapter, next).then(() => {
				if (runtime === current && !current.disposed) {
					current.server?.update?.(sessionEnvelope(current.adapter, next), current.station.snapshot());
				}
			}).catch((error) => record("refresh-sessions", error));
		},
	});
	wireCommands({ pi, getStatus: status, getAdapter: () => runtime?.adapter, onSessionResult: (result) => {
		if (!result.ok) runtime?.station?.onNotify?.(`Session: ${result.code}`, "error");
	} });
}
