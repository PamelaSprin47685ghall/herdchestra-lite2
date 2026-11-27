// Bind a fork child to the request preparation its own station needs.
//
// The root station is installed by the host event bridge. A child session is
// created outside that event path and is built with `hasUI:false`; without
// this step its model requests never reach `station.prepareRequest`, so the
// host's skill receipt is committed by the default path and can fail the
// prefix check before the child produces any message.
//
// The child station is lazy: it is created the first time `stationFor(ctx)`
// sees the child context. Asking for it here, before the first prompt, attaches
// the fork identity and gives context preparation the real station.

import { installContextPreparation } from "./context-preparation.mjs";
import { record } from "./diagnostics.mjs";

const TERMINAL_RESULT = Symbol.for("pi-agent-core.terminal-tool-result");
const RETURN_STOP = Symbol.for("herdchestra-lite2.scope-return-stop.v1");

export function hasScopeReturnStop(agent) {
	return Boolean(agent?.[RETURN_STOP] && agent.afterToolCall === agent[RETURN_STOP].hook);
}

export function releaseScopeReturnDrain(session) {
	session?.agent?.[RETURN_STOP]?.releaseDrain?.();
}

export function takeScopeReturnRunHold(session) {
	const binding = session?.agent?.[RETURN_STOP];
	if (!binding?.releaseRun) return null;
	const release = binding.releaseRun;
	binding.releaseRun = null;
	return release;
}

export function releaseScopeReturnRunHold(session) {
	takeScopeReturnRunHold(session)?.();
}

/** Stop at the host's native terminal-result seam, after the result is accepted. */
export function stopAfterScopeReturn(agent, session = null) {
	if (typeof agent?.abort !== "function") return;
	const existing = agent[RETURN_STOP];
	if (existing) {
		if (session) existing.session = session;
		return;
	}
	const original = agent.afterToolCall;
	const binding = { session, hook: null, releaseDrain: null, releaseRun: null };
	const holdDrain = () => {
		const owner = binding.session;
		if (typeof owner?.withQueueDrainPaused !== "function" || binding.releaseDrain) return;
		let release;
		const held = new Promise((resolve) => { release = resolve; });
		const releaseHold = () => {
			binding.releaseDrain = null;
			release();
		};
		binding.releaseDrain = releaseHold;
		// The host schedules stranded queue delivery before its final agent_end.
		// Keep that delivery parked until the rewind ticket takes over the hold.
		const failed = (error) => {
			if (binding.releaseDrain === releaseHold) releaseHold();
			record("hooks", error, { phase: "scope-return-queue" });
		};
		try {
			const pending = Promise.resolve(owner.withQueueDrainPaused(() => held));
			pending.catch(failed);
		} catch (error) {
			failed(error);
		}
	};
	const holdRewindRun = () => {
		const owner = binding.session;
		const jobs = owner?.asyncJobManager;
		if (typeof jobs?.register !== "function" || binding.releaseRun) return;
		let release;
		const held = new Promise((resolve) => { release = resolve; });
		let jobId = null;
		let released = false;
		const releaseRun = () => {
			if (released) return;
			released = true;
			if (binding.releaseRun === releaseRun) binding.releaseRun = null;
			if (jobId !== null) {
				try {
					jobs.acknowledgeDeliveries?.([jobId]);
				} catch (error) {
					record("hooks", error, { phase: "scope-return-run-hold" });
				}
			}
			release();
		};
		const ownerId =
			typeof owner.getAgentId === "function"
				? owner.getAgentId()
				: owner.agent?.id;
		try {
			// Register a silent running job before aborting the old loop so
			// AgentSession keeps `isRunActive` true across the rewind handoff
			// and print-mode (`--wait-async`) waits for the resumed turn
			// instead of disposing the session in the gap.
			jobId = jobs.register(
				"herd-rewind",
				"Root scope rewind handoff",
				async () => {
					await held;
					return "";
				},
				ownerId ? { ownerId } : undefined,
			);
			binding.releaseRun = releaseRun;
		} catch (error) {
			release();
			record("hooks", error, { phase: "scope-return-run-hold" });
		}
	};
	const hook = function (ctx, signal) {
		const after = original?.call(this, ctx, signal);
		// The tool's own name no longer decides this. Every call arrives as `js`
		// and reports its terminal intent through `details.stopLoop`; the js
		// ticket guarantees that result is terminal and exclusive in its beat.
		const finish = (override) => {
			const details = override?.details ?? ctx.result?.details;
			// The per-tool signal also covers steers. An accepted return still
			// ends the loop when a steer raced it; only an Agent abort wins.
			if (!agent.isAborting && !(override?.isError ?? ctx.isError) && details?.stopLoop === true) {
				if (details.scope === "root" && details.rewind === true) {
					holdDrain();
					holdRewindRun();
				}
				agent.abort(TERMINAL_RESULT);
			}
			return override;
		};
		return typeof after?.then === "function" ? after.then(finish) : finish(after);
	};
	binding.hook = hook;
	agent.afterToolCall = hook;
	Object.defineProperty(agent, RETURN_STOP, { value: binding, configurable: true });
	return () => {
		if (agent[RETURN_STOP] !== binding) return;
		binding.releaseDrain?.();
		binding.releaseRun?.();
		if (agent.afterToolCall === hook) agent.afterToolCall = original;
		delete agent[RETURN_STOP];
	};
}

function failure(code, error = null) {
	return { ok: false, code, error };
}

/**
 * Prepare one child session. Returns a discriminated result instead of
 * throwing: a preparation gap is reported by the caller and must not turn a
 * healthy child into a failed one.
 */
export function prepareChildContext(session, stationFor, options = {}) {
	if (!session || typeof session !== "object") return failure("NO_SESSION");
	const runner = session.extensionRunner;
	let base = null;
	if (runner && typeof runner.createContext === "function") {
		try {
			base = runner.createContext();
		} catch (error) {
			record("fork", error, { phase: "child-context" });
			return failure("NO_CONTEXT", error);
		}
	}
	if (!base || typeof stationFor !== "function") return failure("NO_CONTEXT");
	// The host may hand back a context without the child's agent id. The
	// station registry resolves a fork from that id; with it missing the child
	// station is built as root and scope_return can never resolve its bracket.
	const agentId =
		options.agentId ??
		session.agent?.id ??
		(typeof session.getAgentId === "function" ? session.getAgentId() : null);
	const ctx =
		typeof agentId === "string" && agentId !== ""
			? {
					...base,
					agent: { ...(base.agent ?? {}), id: agentId },
					agentId,
				}
			: base;
	let station = null;
	try {
		station = stationFor(ctx);
	} catch (error) {
		record("fork", error, { phase: "child-station" });
		return failure("NO_STATION", error);
	}
	if (!station || typeof station.prepareRequest !== "function") {
		return failure("NO_STATION");
	}
	// A station may have been created before the host bound the child's agent
	// id. Re-attach its ports now that the identity resolves; otherwise it
	// stays a root station for the rest of the child's life.
	if (typeof options.refresh === "function" && station.forkOwnerId?.() === null) {
		try {
			options.refresh(station, ctx);
		} catch (error) {
			record("fork", error, { phase: "child-identity" });
			return failure("NO_IDENTITY", error);
		}
	}
	try {
		stopAfterScopeReturn(session.agent, session);
		installContextPreparation(session, { station, ctx });
		return { ok: true, station, ctx };
	} catch (error) {
		record("fork", error, { phase: "child-context" });
		return failure("INSTALL_FAILED", error);
	}
}
