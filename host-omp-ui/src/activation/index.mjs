// Composition root. It instantiates the station, adapter, fence, tickets and
// server, then binds them with mechanical wiring only. No business branching.
import { homedir } from "node:os";
import { join } from "node:path";
import { scanMachineSessions } from "../manager/machine-catalog.mjs";
import { createSessionService } from "../manager/session-service.mjs";
import { buildNewLaunch, buildResumeLaunch } from "../manager/domain/session-catalog.mjs";
import { createHostTickets, createUiBridge } from "../host/bridge-tickets.mjs";
import { record } from "../host/diagnostics.mjs";
import { createManagerClient, sharedManagerToken } from "../host/manager-client.mjs";
import { createLaunchContext, consumeLaunchContext, removeLaunchContext, pruneLaunchContexts } from "../host/launch-context.mjs";
import { executeTmuxLaunch } from "../host/tmux-launch.mjs";
import { createSessionAdapter } from "../host/session-adapter.mjs";
import {
	attachSurfaceWatcher,
	captureHostFromEditorSlot,
	FallbackReconciler,
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

function status() {
	if (runtime?.url) return { url: runtime.url, reason: null };
	return { url: null, reason: runtime?.reason ?? "no active main session" };
}

async function hydrate(runtimeRef, adapter, ctx) {
	const station = runtimeRef.station;
	station.onSessionHydrate?.(adapter.sessionInfo(), adapter.branch());
	station.onUsageUpdate?.(adapter.contextUsage() ?? adapter.usage());
	station.onMetaUpdate?.({
		model: adapter.currentModel(),
		thinkingLevel: adapter.thinkingLevel(),
		thinkingLevels: adapter.thinkingLevels(),
		modes: adapter.modes(),
	});
	station.onModelsUpdate?.(adapter.models());
	station.onSessionsUpdate?.(await adapter.listProjectSessions(ctx.cwd));
}

async function startRuntime(runtimeRef, env, adapter, ctx) {
	try {
		const contextPath = process.env.OMP_UI_LAUNCH_CONTEXT;
		delete process.env.OMP_UI_LAUNCH_CONTEXT;
		const launchContext = contextPath ? await consumeLaunchContext(contextPath) : null;
		const token = launchContext?.token ?? env.token ?? process.env.HERD_OMP_UI_TOKEN ?? process.env.OMP_UI_TOKEN ?? await sharedManagerToken();
		const port = launchContext?.port ?? env.port ?? Number(process.env.HERD_OMP_UI_PORT ?? process.env.OMP_UI_PORT ?? 37421);
		const staticDir = env.staticDir ?? new URL("../../web/dist/", import.meta.url).pathname;
		const launchDirectory = join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".omp", "run"), "herd-omp-ui", "launch");
		try {
			const { diagnostics: cleanupErrors } = await pruneLaunchContexts({ directory: launchDirectory });
			for (const error of cleanupErrors) record("launch-context-cleanup", error);
		} catch (error) {
			record("launch-context-cleanup", error);
		}
		const listSessions = async ({ extraDirs = [] } = {}) => {
			const sessionDir = ctx.sessionManager?.getSessionDir?.();
			const { sessions, diagnostics: errors } = await scanMachineSessions({
				roots: [join(homedir(), ".omp", "agent", "sessions")],
				extraDirs: [...extraDirs, ...(sessionDir ? [sessionDir] : [])],
			});
			for (const error of errors) record("session-catalog", error);
			return sessions;
		};
		await hydrate(runtimeRef, adapter, ctx);
		if (runtimeRef.disposed) return;
		const sessionService = createSessionService({
			loadSessions: listSessions,
			buildNewPlan: ({ cwd }) => {
				const ompPath = env.ompPath ?? Bun.which("omp");
				if (!ompPath) throw new Error("Cannot find the omp executable in PATH");
				return buildNewLaunch({ cwd, ompPath });
			},
			buildPlan: (session) => {
				const ompPath = env.ompPath ?? Bun.which("omp");
				if (!ompPath) throw new Error("Cannot find the omp executable in PATH");
				return buildResumeLaunch({ session, ompPath });
			},
			launch: async (plan, session) => {
				const directory = join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".omp", "run"), "herd-omp-ui", "launch");
				const path = await createLaunchContext({ directory, port, token });
				const cleanup = () => { void removeLaunchContext(path).catch((error) => record("launch-context-cleanup", error)); };
				try {
					const ompPath = env.ompPath ?? Bun.which("omp");
					if (!ompPath) throw new Error("Cannot find the omp executable in PATH");
					const spec = session
						? buildResumeLaunch({ session, ompPath, launchId: plan.launchId, contextPath: path })
						: buildNewLaunch({ cwd: plan.cwd, ompPath, launchId: plan.launchId, contextPath: path });
					const run = async (command, args) => {
						const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
						const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
						return { code, stdout, stderr };
					};
					const hasSession = async (name) => {
						const result = await run("tmux", ["list-sessions", "-F", "#{session_name}"]);
						return result.code === 0 && result.stdout.split("\n").includes(name);
					};
					if (await hasSession(spec.tmuxSession)) throw new Error(`tmux session already exists: ${spec.tmuxSession}`);
					const result = await executeTmuxLaunch({ spec, contextPath: path, run, hasSession, removeContext: removeLaunchContext, record });
					if (!result.ok) throw new Error(result.message || "tmux launch failed");
					const timer = setTimeout(cleanup, 60_000);
					timer.unref?.();
					return { tmuxSession: spec.tmuxSession };
				} catch (error) {
					cleanup();
					throw error;
				}
			},
		});
		const isTui = ctx.mode === "tui" && ctx.hasUI;
		const server = await createManagerClient({
			mode: ctx.mode,
			instanceCapabilities: { canCompose: isTui || typeof runtimeRef.pi?.sendUserMessage === "function", canUseTuiSurface: isTui, canAttachments: isTui, canSlashCommands: isTui },
			host: env.host ?? "127.0.0.1",
			preferredPort: port,
			token,
			staticDir,
			onBootstrap: async () => {
				const snap = runtimeRef.station.snapshot();
				const sessionDir = ctx.sessionManager?.getSessionDir?.();
				snap.session = { ...snap.session, cwd: snap.session?.cwd ?? ctx.cwd, sessionDir };
				if (!snap.sessions?.length) snap.sessions = await adapter.listProjectSessions(ctx.cwd);
				return snap;
			},
			onStatus: (state, reason) => {
				if (runtimeRef.disposed) return;
				if (state === "connected") {
					runtimeRef.url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
					runtimeRef.reason = null;
				} else {
					runtimeRef.url = null;
					runtimeRef.reason = reason ? String(reason.message ?? reason) : `manager ${state}`;
				}
			},
			onListSessions: listSessions,
			ensureSession: sessionService.ensureSession,
			newSession: (input, waitForLaunch) => sessionService.newSession(input, waitForLaunch),
			onClientConnect: (clientId) => runtimeRef.station.onClientConnected?.(clientId),
			onClientDisconnect: (clientId) => runtimeRef.station.onClientDisconnected?.(clientId),
			onShutdown: () => {
				const stop = ctx?.shutdown ?? runtimeRef.pi?.shutdown;
				if (typeof stop === "function") {
					try {
						return stop.call(ctx ?? runtimeRef.pi);
					} catch (error) {
						record("shutdown", error);
					}
				}
				const exit = () => process.kill(process.pid, "SIGTERM");
				const schedule = typeof ctx?.setTimeout === "function" ? ctx.setTimeout.bind(ctx) : setTimeout;
				schedule(exit, 50);
			},
			onClientCommand: async (command, clientId) => {
				if (command?.type === "interaction.respond") {
					const payload = command.payload ?? {};
					let result;
					try {
						const pending = runtimeRef.station.snapshot().pendingInteractions.find((item) => item.id === payload.requestId);
						if (pending?.kind === "plan_review") {
							result = await runtimeRef.tickets.resolvePlanReviewTicket({
								reviewId: payload.requestId, choice: payload.choice ?? payload.value, input: payload.input,
							});
						} else {
							result = runtimeRef.bridge.resolve(payload.requestId, payload);
							if (result.ok) runtimeRef.station.resolveInteraction(payload.requestId, "web", payload);
						}
					} catch (error) {
						record("interaction-response", error);
						result = { ok: false, code: "failed" };
					}
					if (payload.commandId) server.sendToClient(clientId, {
						type: "command.result", requestId: payload.commandId, ok: Boolean(result?.ok),
						...(!result?.ok ? { code: result?.code ?? "failed", errors: result?.errors ?? null } : {}),
					});
					if (!result?.ok) server.sendToClient(clientId, {
						type: "interaction.error", requestId: payload.requestId, code: result?.code ?? "failed", errors: result?.errors ?? null,
					});
					return;
				}
				runtimeRef.station.onClientCommand?.(clientId, command);
			},
			diagnostics: diagnostics(),
		});
		if (runtimeRef.disposed) {
			await server.close();
			return;
		}
		runtimeRef.server = server;
		await hydrate(runtimeRef, adapter, ctx);
		if (runtimeRef.disposed) return;
		server.broadcast({ type: "snapshot", ...runtimeRef.station.snapshot() });
		if (isTui) await attachWatcherIfReady(runtimeRef);
	} catch (error) {
		record("start-runtime", error);
		if (runtimeRef) runtimeRef.reason = error instanceof Error ? error.message : String(error);
	}
}

async function attachWatcherIfReady(runtimeRef) {
	if (!runtimeRef || runtimeRef.disposed || runtimeRef.watcher) return;
	const capture = runtimeRef.capture ?? getLastCapture();
	if (!capture?.tui) return;
	const modules = runtimeRef.modules ?? (await loadTuiModules(runtimeRef.pi));
	// Loading modules yields: shutdown or another capture may have won meanwhile.
	if (runtimeRef.disposed || runtimeRef.watcher) return;
	const ReconcilerClass = modules?.Reconciler ?? FallbackReconciler;
	if (!ReconcilerClass) return;
	const watcher = attachSurfaceWatcher({
		tui: capture.tui,
		composer: capture.composer,
		ReconcilerClass,
		onFrame: (frame) => runtimeRef.station.onSurfaceFrame?.(frame),
	});
	runtimeRef.reconciler = watcher.reconciler;
	runtimeRef.watcher = watcher;
	if (runtimeRef.fence) {
		runtimeRef.fence.surfaceWatcherActive = true;
		runtimeRef.station?.onMetaUpdate?.({ fence: runtimeRef.fence });
	}
}

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
				station,
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
				void attachWatcherIfReady(runtimeRef).then(() => {
					if (runtime !== runtimeRef || runtimeRef.disposed || !runtimeRef.fence) return;
					runtimeRef.fence.surfaceWatcherActive = Boolean(runtimeRef.watcher);
					runtimeRef.station?.onMetaUpdate?.({ fence: runtimeRef.fence });
				}).catch((error) => record("capture-watcher", error));
			});

			if (isTui) try {
				// Observe the slot before installing our own editor: omp invokes the
				// factory synchronously, so a wrapper installed afterwards never sees
				// BridgeEditor and never attaches the completion observer.
				if (isTui) captureHostFromEditorSlot(ctx.ui, bridge);
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
				runtimeRef.fence.moduleErrors.push(error instanceof Error ? error.message : String(error));
				record("editor", error);
			}
			if (isTui) try {
				const decorated = decorateUiContext({ ui: ctx.ui, mode: ctx.mode, isSubagent: false, bridge });
				runtimeRef.uiDecoration = decorated;
				runtimeRef.fence.uiDecorated = Boolean(decorated?.ok);
			} catch (error) {
				runtimeRef.fence.moduleErrors.push(error instanceof Error ? error.message : String(error));
				record("decorate-ui", error);
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
				runtimeRef.fence.moduleErrors.push(error instanceof Error ? error.message : String(error));
				record("capture-host", error);
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
			void hydrate(current, current.adapter, ctx ?? current.ctx).then(() => {
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
