/**
 * The beat: one `js` tool call's interrupt state machine.
 *
 * The host can interrupt an interruptible tool in two ways: a queued user
 * message aborts the tool signal with `TOOL_INTERRUPT_ABORT_REASON` (soft), and
 * every explicit stop or peer request aborts it with another reason. The ticket
 * used to hand the host's signal to every inner dispatch, so a soft interrupt
 * killed real work and a script blocked on a bare Promise never returned.
 *
 * A beat owns one AbortController per inner op. It decides once, from what is
 * actually in flight:
 *
 * - explicit -> interrupt everything;
 * - soft with any work -> steer: cancel parks, keep work, let the script finish;
 * - soft with only parks (or nothing) -> interrupt.
 *
 * Pure state and Promise manipulation: no I/O, no `await`.
 */

export const TOOL_INTERRUPT_ABORT_REASON = Symbol.for("pi-agent-core.tool-interrupt");

export const BEAT_CLOSED = "BEAT_CLOSED";
export const BEAT_NO_MORE_WAITS = "BEAT_NO_MORE_WAITS";
export const BEAT_STEERED = "BEAT_STEERED";
export const JS_INTERRUPTED = "JS_INTERRUPTED";
export const JS_STEERED = "JS_STEERED";

const PARK_TOOLS = new Set(["scope_join", "scope_request", "wait", "ask"]);

/** A park is a pure wait; everything else is work with a real side effect. */
export function opClassOf(name) {
	return PARK_TOOLS.has(name) ? "park" : "work";
}

export function isSoftAbort(reason) {
	return reason === TOOL_INTERRUPT_ABORT_REASON;
}

export function beatError(code, message) {
	const error = new Error(`${code}: ${message}`);
	error.code = code;
	return error;
}

function describeReason(reason) {
	if (reason === TOOL_INTERRUPT_ABORT_REASON) return "tool-interrupt";
	if (reason && typeof reason === "object") {
		if (typeof reason.message === "string" && reason.message !== "") return reason.message;
		if (typeof reason.name === "string" && reason.name !== "") return reason.name;
	}
	return String(reason ?? "aborted");
}

/**
 * Build one beat. `signal` is the host's per-tool signal; it is observed only
 * for the abort decision, never forwarded to an inner dispatch.
 */
export function createBeat({ signal = null } = {}) {
	const ops = new Map();
	const details = {
		decision: null,
		reason: null,
		abortReason: null,
		inFlight: [],
		lateCalls: 0,
		orphanWork: 0,
	};
	let closed = false;
	let parksAllowed = true;
	let seq = 0;
	let resolveClosing = null;
	const closing = new Promise((resolve) => {
		resolveClosing = resolve;
	});
	// A steer lets the script finish naturally, but the script itself may park
	// forever on a bare Promise after its work has settled. This second release
	// is armed only after every surviving work op has settled and one macrotask
	// has been yielded, so a script that was about to finish still wins.
	let resolveSteerClosing = null;
	const steerClosing = new Promise((resolve) => {
		resolveSteerClosing = resolve;
	});
	let detach = null;

	function inFlight() {
		return [...ops.values()].filter((op) => !op.done).map((op) => ({
			name: op.name,
			cls: op.cls,
		}));
	}

	function decide(reason) {
		if (details.decision !== null) return details.decision;
		const explicit = !isSoftAbort(reason);
		details.reason = explicit ? "explicit" : "soft";
		details.abortReason = describeReason(reason);
		details.inFlight = inFlight();
		const hasWork = details.inFlight.some((op) => op.cls === "work");
		const decision = explicit || !hasWork ? "interrupt" : "steer";
		details.decision = decision;
		if (decision === "interrupt") {
			closed = true;
			parksAllowed = false;
			for (const op of ops.values()) {
				if (!op.done) op.controller.abort(reason);
			}
			resolveClosing({ decision });
		} else {
			parksAllowed = false;
			// A park is a pure wait: cancelling it lets the target answer the
			// steering scope without destroying the work that keeps running.
			for (const op of ops.values()) {
				if (!op.done && op.cls === "park") op.controller.abort(reason);
			}
			// The script may outlive its work on a bare Promise. Wait for every
			// surviving work op, give the script one macrotask to finish, then
			// release the tool call with JS_STEERED instead of hanging forever.
			void waitForLiveWork().then(() => {
				setTimeout(() => resolveSteerClosing({ steered: true }), 0);
			});
		}
		return decision;
	}

	if (signal) {
		if (signal.aborted) {
			decide(signal.reason);
		} else {
			const onAbort = () => decide(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			detach = () => signal.removeEventListener?.("abort", onAbort);
		}
	}

	/**
	 * Steer only: wait until every surviving work op has settled. Extracted so
	 * the decision can arm the steer release without a reference to the object
	 * literal below.
	 */
	async function waitForLiveWork() {
		for (;;) {
			const live = [...ops.values()].filter((op) => !op.done && op.cls === "work");
			details.orphanWork = live.length;
			if (live.length === 0) {
				details.orphanWork = 0;
				return;
			}
			await Promise.allSettled(live.map((op) => op.promise).filter(Boolean));
		}
	}

	return {
		details,
		closing,
		steerClosing,

		get decision() {
			return details.decision;
		},

		get closed() {
			return closed;
		},

		/**
		 * Refuse a call before any other check (halted, mixed return, missing
		 * dispatch). After an interrupt the stable answer is BEAT_CLOSED even
		 * when the same script already called scope_return, and the refusal is
		 * counted once.
		 */
		rejectIfClosed(name) {
			if (closed) {
				details.lateCalls += 1;
				throw beatError(BEAT_CLOSED, `api.${name} was called after the beat closed.`);
			}
			if (!parksAllowed) {
				const cls = opClassOf(name);
				if (cls === "park") {
					throw beatError(BEAT_NO_MORE_WAITS, `api.${name} would park after a steer.`);
				}
				throw beatError(
					BEAT_STEERED,
					`api.${name} was called after a steer; only work already in flight may finish.`,
				);
			}
		},

		/** Register one op before dispatch; throws when the beat refuses it. */
		beginOp(name) {
			if (closed) {
				details.lateCalls += 1;
				throw beatError(BEAT_CLOSED, `api.${name} was called after the beat closed.`);
			}
			const cls = opClassOf(name);
			if (!parksAllowed) {
				if (cls === "park") {
					throw beatError(BEAT_NO_MORE_WAITS, `api.${name} would park after a steer.`);
				}
				throw beatError(
					BEAT_STEERED,
					`api.${name} was called after a steer; only work already in flight may finish.`,
				);
			}
			const op = {
				id: `${name}#${seq++}`,
				name,
				cls,
				controller: new AbortController(),
				promise: null,
				entry: null,
				done: false,
			};
			ops.set(op.id, op);
			return op;
		},

		/** Attach the dispatch promise so a steer can wait for surviving work. */
		attach(op, promise, entry) {
			op.promise = Promise.resolve(promise);
			op.entry = entry;
			return op.promise;
		},

		endOp(op) {
			if (!op || op.done) return;
			op.done = true;
			ops.delete(op.id);
		},

		/** Give every op abandoned by an interrupt a terminal inner-call entry. */
		sealOps(reason = null) {
			for (const op of ops.values()) {
				if (op.entry && op.entry.resultText === undefined) {
					op.entry.isError = true;
					op.entry.resultText =
						reason ??
						`${op.name} interrupted (${details.abortReason ?? "aborted"}) before it returned`;
				}
				op.done = true;
			}
			ops.clear();
		},

		waitForWork: waitForLiveWork,

		dispose() {
			detach?.();
			detach = null;
		},
	};
}
