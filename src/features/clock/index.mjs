// The clock port: who owns the deadline arithmetic.
//
// Two implementations share one contract:
//   on  - a wall clock per scope, with a deadline and an overtime edge;
//   off - nothing is ever late: remaining() reports "no bound", expired() is
//         always false, and start() records nothing.
//
// The port never stores scope state and never reads a switch. A caller hands it
// a scope id; it answers with numbers. Whether the receipt prints a time
// segment is the caller's decision, made from the answer - not from a flag.

/** A refusal every port shares, for calls that cannot be served at all. */
function refusal(code, detail) {
	return { ok: false, code, port: "clock", detail };
}

/** Milliseconds left, or null when this implementation has no bound. */
function remainingOf(entries, scopeId, now) {
	const entry = entries.get(scopeId);
	if (!entry) return null;
	return Math.max(0, entry.deadlineAt - now);
}

export function createClockOn() {
	const entries = new Map();
	return {
		name: "on",
		/** Record a budget for one scope. A non-positive budget is refused. */
		start(scopeId, budgetMs) {
			if (typeof scopeId !== "string" || scopeId === "") {
				return refusal("CLOCK_INVALID_SCOPE", "scopeId must be a non-empty string");
			}
			if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
				return refusal("CLOCK_INVALID_BUDGET", "budgetMs must be a positive number");
			}
			const startedAt = Date.now();
			entries.set(scopeId, { budgetMs, startedAt, deadlineAt: startedAt + budgetMs, overtimeAt: null });
			return { ok: true, scopeId, deadlineAt: startedAt + budgetMs };
		},
		/** Milliseconds left; null when unknown; 0 once the deadline passed. */
		remaining(scopeId, now = Date.now()) {
			return remainingOf(entries, scopeId, now);
		},
		/** True only after the deadline, and it stamps the overtime edge once. */
		expired(scopeId, now = Date.now()) {
			const entry = entries.get(scopeId);
			if (!entry) return false;
			if (now < entry.deadlineAt) return false;
			if (entry.overtimeAt === null) entry.overtimeAt = now;
			return true;
		},
		/** True when this implementation can render a time segment at all. */
		bounded() {
			return true;
		},
		clear(scopeId) {
			return entries.delete(scopeId);
		},
	};
}

export function createClockOff() {
	return {
		name: "off",
		start() {
			return { ok: true };
		},
		// No bound exists, so "remaining" is not zero - zero would mean "expired".
		remaining() {
			return null;
		},
		expired() {
			return false;
		},
		bounded() {
			return false;
		},
		clear() {
			return false;
		},
	};
}
