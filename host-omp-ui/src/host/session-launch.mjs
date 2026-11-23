// Host-side session launch orchestration. This module owns the tmux spawn,
// the launch-context lifecycle, session catalog wiring, station hydration,
// the bootstrap snapshot, the host shutdown adapter, and the surface watcher.
// The composition root only instantiates and binds these pieces.
import { homedir } from "node:os";
import { join } from "node:path";
import { scanMachineSessions } from "../manager/machine-catalog.mjs";
import { createSessionService } from "../manager/session-service.mjs";
import { buildNewLaunch, buildResumeLaunch } from "../manager/domain/session-catalog.mjs";
import { createClientCommandHandler } from "./client-command.mjs";
import { createManagerClient, sharedManagerToken } from "./manager-client.mjs";
import {
	consumeLaunchContext,
	createLaunchContext,
	pruneLaunchContexts,
	removeLaunchContext,
} from "./launch-context.mjs";
import { executeTmuxLaunch } from "./tmux-launch.mjs";
import { attachSurfaceWatcher, FallbackReconciler, getLastCapture, loadTuiModules } from "./tui-fence.mjs";

function launchContextDirectory() {
	return join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".omp", "run"), "herd-omp-ui", "launch");
}

function resolveOmpPath(env) {
	const ompPath = env.ompPath ?? Bun.which("omp");
	if (!ompPath) throw new Error("Cannot find the omp executable in PATH");
	return ompPath;
}

function createTmuxRunner() {
	return async (command, args) => {
		const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr };
	};
}

function createLaunch({ env, port, token, record }) {
	return async (plan, session) => {
		const path = await createLaunchContext({ directory: launchContextDirectory(), port, token });
		const cleanup = () => {
			void removeLaunchContext(path).catch((error) => record("launch-context-cleanup", error));
		};
		try {
			const ompPath = resolveOmpPath(env);
			const spec = session
				? buildResumeLaunch({ session, ompPath, launchId: plan.launchId, contextPath: path })
				: buildNewLaunch({ cwd: plan.cwd, ompPath, launchId: plan.launchId, contextPath: path });
			const run = createTmuxRunner();
			const hasSession = async (name) => {
				const result = await run("tmux", ["list-sessions", "-F", "#{session_name}"]);
				return result.code === 0 && result.stdout.split("\n").includes(name);
			};
			if (await hasSession(spec.tmuxSession)) throw new Error(`tmux session already exists: ${spec.tmuxSession}`);
			const result = await executeTmuxLaunch({
				spec,
				contextPath: path,
				run,
				hasSession,
				removeContext: removeLaunchContext,
				record,
			});
			if (!result.ok) throw new Error(result.message || "tmux launch failed");
			const timer = setTimeout(cleanup, 60_000);
			timer.unref?.();
			return { tmuxSession: spec.tmuxSession };
		} catch (error) {
			cleanup();
			throw error;
		}
	};
}

function createListSessions({ ctx, record }) {
	return async ({ extraDirs = [] } = {}) => {
		const sessionDir = ctx.sessionManager?.getSessionDir?.();
		const { sessions, diagnostics: errors } = await scanMachineSessions({
			roots: [join(homedir(), ".omp", "agent", "sessions")],
			extraDirs: [...extraDirs, ...(sessionDir ? [sessionDir] : [])],
		});
		for (const error of errors) record("session-catalog", error);
		return sessions;
	};
}

export async function createSessionHost({ env, ctx, record }) {
	const contextPath = process.env.OMP_UI_LAUNCH_CONTEXT;
	delete process.env.OMP_UI_LAUNCH_CONTEXT;
	const launchContext = contextPath ? await consumeLaunchContext(contextPath) : null;
	const token =
		launchContext?.token ??
		env.token ??
		process.env.HERD_OMP_UI_TOKEN ??
		process.env.OMP_UI_TOKEN ??
		(await sharedManagerToken());
	const port =
		launchContext?.port ??
		env.port ??
		Number(process.env.HERD_OMP_UI_PORT ?? process.env.OMP_UI_PORT ?? 37421);
	const staticDir = env.staticDir ?? new URL("../../web/dist/", import.meta.url).pathname;
	try {
		const { diagnostics: cleanupErrors } = await pruneLaunchContexts({ directory: launchContextDirectory() });
		for (const error of cleanupErrors) record("launch-context-cleanup", error);
	} catch (error) {
		record("launch-context-cleanup", error);
	}
	const listSessions = createListSessions({ ctx, record });
	const sessionService = createSessionService({
		loadSessions: listSessions,
		buildNewPlan: ({ cwd }) => buildNewLaunch({ cwd, ompPath: resolveOmpPath(env) }),
		buildPlan: (session) => buildResumeLaunch({ session, ompPath: resolveOmpPath(env) }),
		launch: createLaunch({ env, port, token, record }),
	});
	return { token, port, staticDir, listSessions, sessionService };
}

export async function hydrateStation(station, adapter, ctx) {
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

export function createBootstrapSnapshot({ station, adapter, ctx }) {
	return async () => {
		const snap = station.snapshot();
		const sessionDir = ctx.sessionManager?.getSessionDir?.();
		snap.session = { ...snap.session, cwd: snap.session?.cwd ?? ctx.cwd, sessionDir };
		if (!snap.sessions?.length) snap.sessions = await adapter.listProjectSessions(ctx.cwd);
		return snap;
	};
}

export function createShutdownHandler({ ctx, pi, record }) {
	return () => {
		const stop = ctx?.shutdown ?? pi?.shutdown;
		if (typeof stop === "function") {
			try {
				return stop.call(ctx ?? pi);
			} catch (error) {
				record("shutdown", error);
			}
		}
		const exit = () => process.kill(process.pid, "SIGTERM");
		const schedule = typeof ctx?.setTimeout === "function" ? ctx.setTimeout.bind(ctx) : setTimeout;
		schedule(exit, 50);
	};
}

export async function ensureSurfaceWatcher(runtimeRef) {
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

export function createStartRuntimeTicket({ record }) {
	return async function startRuntime(runtimeRef, env, adapter, ctx) {
		try {
			const host = await createSessionHost({ env, ctx, record });
			await hydrateStation(runtimeRef.station, adapter, ctx);
			if (runtimeRef.disposed) return;
			const isTui = ctx.mode === "tui" && ctx.hasUI;
			const server = await createManagerClient({
				mode: ctx.mode,
				instanceCapabilities: { canCompose: isTui || typeof runtimeRef.pi?.sendUserMessage === "function", canUseTuiSurface: isTui, canAttachments: isTui, canSlashCommands: isTui },
				host: env.host ?? "127.0.0.1",
				preferredPort: host.port,
				token: host.token,
				staticDir: host.staticDir,
				onBootstrap: createBootstrapSnapshot({ station: runtimeRef.station, adapter, ctx }),
				onStatus: (state, reason) => {
					if (runtimeRef.disposed) return;
					if (state === "connected") {
						runtimeRef.url = `http://127.0.0.1:${host.port}/?token=${encodeURIComponent(host.token)}`;
						runtimeRef.reason = null;
					} else {
						runtimeRef.url = null;
						runtimeRef.reason = reason ? String(reason.message ?? reason) : `manager ${state}`;
					}
				},
				onListSessions: host.listSessions,
				ensureSession: host.sessionService.ensureSession,
				newSession: (input, waitForLaunch) => host.sessionService.newSession(input, waitForLaunch),
				onClientConnect: (clientId) => runtimeRef.station.onClientConnected?.(clientId),
				onClientDisconnect: (clientId) => runtimeRef.station.onClientDisconnected?.(clientId),
				onShutdown: createShutdownHandler({ ctx, pi: runtimeRef.pi, record }),
				onClientCommand: createClientCommandHandler({
					getStation: () => runtimeRef.station,
					getTickets: () => runtimeRef.tickets,
					getBridge: () => runtimeRef.bridge,
					getServer: () => runtimeRef.server,
					record,
				}),
				diagnostics: { record },
			});
			if (runtimeRef.disposed) {
				await server.close();
				return;
			}
			runtimeRef.server = server;
			await hydrateStation(runtimeRef.station, adapter, ctx);
			if (runtimeRef.disposed) return;
			server.broadcast({ type: "snapshot", ...runtimeRef.station.snapshot() });
			if (isTui) await ensureSurfaceWatcher(runtimeRef);
		} catch (error) {
			record("start-runtime", error);
			if (runtimeRef) runtimeRef.reason = error instanceof Error ? error.message : String(error);
		}
	};
}
