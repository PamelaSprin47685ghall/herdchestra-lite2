// Composition root. It instantiates the station, adapter, fence, tickets and
// server, then binds them with mechanical wiring only. No business branching.
import { createHostTickets, createUiBridge } from "../host/bridge-tickets.mjs";
import { record } from "../host/diagnostics.mjs";
import { createSessionAdapter } from "../host/session-adapter.mjs";
import {
	createStartRuntimeTicket,
	ensureSurfaceWatcher,
	hydrateStation,
} from "../host/session-launch.mjs";
import {
	captureHostFromEditorSlot,
	createBridgeEditorClass,
	decorateUiContext,
	getLastCapture,
	getRealCustomEditor,
	installComposerCapture,
	loadTuiModules,
	setRealCustomEditor,
	subscribeComposerCapture,
} from "../host/tui-fence.mjs";
import { createUiBridgeStation } from "../station/ui-bridge-station.mjs";
import { wireCommands } from "./commands.mjs";
import { wireHooks } from "./hooks.mjs";
import { buildBridgeCapabilities } from "./tickets.mjs";

let runtime = null;

function diagnostics() {
	return { record };
}

function noteFenceError(runtimeRef, domain, error) {
	runtimeRef.fence.moduleErrors.push(error instanceof Error ? error.message : String(error));
	record(domain, error);
}

function status() {
	if (runtime?.url) return { url: runtime.url, reason: null };
	return { url: null, reason: runtime?.reason ?? "no active main session" };
}

const startRuntime = createStartRuntimeTicket({ record });

export function wireUiExtension(pi, env = {}) {
	const onSessionStart = async (_event, ctx) => {
		try {
			if (!ctx || ctx.agent?.kind === "sub") {
				runtime = { reason: "session is not a main session", url: null };
				return;
			}
			const isTui = ctx.mode === "tui" && ctx.hasUI;
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
				capabilities: { dispatch: (event) => runtime?.capabilitiesDispatch?.(event) },
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
			runtimeRef.fence = {
				composerCaptured: false,
				tuiCaptured: false,
				editorInstalled: false,
				uiDecorated: false,
				surfaceWatcherActive: false,
				moduleErrors: modules?.errors ?? ["tui-modules-unavailable"],
			};
			station.onMetaUpdate?.({ fence: runtimeRef.fence });
			runtimeRef.capabilitiesDispatch = buildBridgeCapabilities({
				tickets,
				diagnostics: diagnostics(),
				onReported: (patch) => station.onMetaUpdate(patch),
			}).dispatch;
			runtime = runtimeRef;
			if (isTui) runtimeRef.unsubscribeCapture = subscribeComposerCapture((capture) => {
				if (runtime !== runtimeRef || runtimeRef.disposed) return;
				runtimeRef.capture = capture;
				capture?.editor?.setBridge?.(runtimeRef.bridge);
				if (runtimeRef.fence) {
					runtimeRef.fence.composerCaptured = Boolean(capture?.composer);
					runtimeRef.fence.tuiCaptured = Boolean(capture?.tui);
					runtimeRef.station?.onMetaUpdate?.({ fence: runtimeRef.fence });
				}
				void ensureSurfaceWatcher(runtimeRef).then(() => {
					if (runtime !== runtimeRef || runtimeRef.disposed || !runtimeRef.fence) return;
					runtimeRef.fence.surfaceWatcherActive = Boolean(runtimeRef.watcher);
					runtimeRef.station?.onMetaUpdate?.({ fence: runtimeRef.fence });
				}).catch((error) => record("capture-watcher", error));
			});

			if (isTui) try {
				// Observe the slot before installing our own editor: omp invokes the
				// factory synchronously, so a wrapper installed afterwards never sees
				// BridgeEditor and never attaches the completion observer.
				captureHostFromEditorSlot(ctx.ui, bridge);
				const Base = modules?.CustomEditor ?? getRealCustomEditor();
				if (Base) {
					// Never steal an editor another extension already installed.
					const owned = ctx.ui?.getEditorComponent?.();
					if (!owned) {
						const BridgeEditor = createBridgeEditorClass(Base);
						ctx.ui?.setEditorComponent?.(
							(tui, theme, keybindings) => new BridgeEditor(bridge, tui, theme, keybindings),
						);
						runtimeRef.fence.editorInstalled = true;
					} else {
						runtimeRef.fence.moduleErrors.push("editor-slot-owned");
					}
				} else {
					runtimeRef.fence.moduleErrors.push("custom-editor-unavailable");
				}
			} catch (error) {
				noteFenceError(runtimeRef, "editor", error);
			}
			if (isTui) try {
				const decorated = decorateUiContext({ ui: ctx.ui, mode: ctx.mode, isSubagent: false, bridge });
				runtimeRef.uiDecoration = decorated;
				runtimeRef.fence.uiDecorated = Boolean(decorated?.ok);
			} catch (error) {
				noteFenceError(runtimeRef, "decorate-ui", error);
			}
			if (isTui) try {
				const captured = captureHostFromEditorSlot(ctx.ui, bridge);
				runtimeRef.fence.composerCaptured = Boolean(captured.captured?.composer);
				runtimeRef.fence.tuiCaptured = Boolean(captured.captured?.tui);
				runtimeRef.fence.editorInstalled = runtimeRef.fence.editorInstalled || Boolean(captured.captured?.editorBound || captured.captured?.editor);
				if (!captured.captured?.composer && captured.captured?.tui) {
					const names = Object.getOwnPropertyNames(captured.captured.tui).slice(0, 30).join(",");
					runtimeRef.fence.moduleErrors.push(`tui-own:${names}`);
				}
				if (captured.error) runtimeRef.fence.moduleErrors.push(String(captured.error?.message ?? captured.error));
				runtimeRef.capture = captured.captured ?? runtimeRef.capture;
			} catch (error) {
				noteFenceError(runtimeRef, "capture-host", error);
			}
			station.onMetaUpdate?.({ fence: runtimeRef.fence });
			void startRuntime(runtimeRef, env, adapter, ctx);
		} catch (error) {
			record("session-start", error);
		}
	};

	const onSessionShutdown = async () => {
		const current = runtime;
		runtime = null;
		if (!current) return;
		current.disposed = true;
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
			void hydrateStation(current.station, current.adapter, ctx ?? current.ctx).then(() => {
				if (runtime === current && !current.disposed) {
					const session = current.adapter.sessionInfo();
					current.server?.update?.({ ...session, cwd: session?.cwd ?? (ctx ?? current.ctx).cwd, sessionDir: (ctx ?? current.ctx).sessionManager?.getSessionDir?.() }, current.station.snapshot());
				}
			}).catch((error) => record("refresh-sessions", error));
		},
	});
	wireCommands({ pi, getStatus: status, getAdapter: () => runtime?.adapter, onSessionResult: (result) => {
		if (!result.ok) runtime?.station?.onNotify?.(`Session: ${result.code}`, "error");
	} });
}
