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

/** Stop only the child loop, at the same seam the host uses for native yield. */
export function stopAfterScopeReturn(agent) {
	const original = agent.afterToolCall;
	const hook = function (ctx, signal) {
		const after = original?.call(this, ctx, signal);
		if (ctx.toolCall.name !== "scope_return" || ctx.isError || ctx.result?.details?.accepted !== true) return after;
		const finish = (override) => {
			if (override?.isError !== true && (override?.details ?? ctx.result.details)?.accepted === true) {
				agent.abort(TERMINAL_RESULT);
			}
			return override;
		};
		return typeof after?.then === "function" ? after.then(finish) : finish(after);
	};
	agent.afterToolCall = hook;
	return () => {
		if (agent.afterToolCall === hook) agent.afterToolCall = original;
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
		installContextPreparation(session, { station, ctx });
		return { ok: true };
	} catch (error) {
		record("fork", error, { phase: "child-context" });
		return failure("INSTALL_FAILED", error);
	}
}
