// Clock policy: the wall-clock arithmetic over one persisted fork record.
//
// Two implementations share one contract:
//   on  - a deadline, a pause edge, and a one-second overtime unit;
//   off - no bound: no deadline, no pause, no tool gate.
//
// The record is the only state. The port never keeps a keyed map, so a reload
// restores the same clock the branch had before it stopped.

/** Freeze a branch's clock. The first pause edge wins. */
export function pauseClock(record, now = Date.now()) {
	if (!record || !Number.isFinite(record.deadlineAt)) return false;
	if (Number.isFinite(record.clockPausedAt)) return false;
	record.clockPausedAt = Number.isFinite(now) ? now : Date.now();
	return true;
}

/** Release a paused clock, shifting the deadline by exactly the paused span. */
export function resumeClock(record, now = Date.now()) {
	if (!record || !Number.isFinite(record.deadlineAt)) return false;
	if (!Number.isFinite(record.clockPausedAt)) return false;
	const at = Number.isFinite(now) ? now : Date.now();
	const paused = Math.max(0, at - record.clockPausedAt);
	record.deadlineAt += paused;
	record.pausedMs = (Number.isFinite(record.pausedMs) ? record.pausedMs : 0) + paused;
	record.clockPausedAt = null;
	return true;
}

/** How much wall clock a branch has left. The deadline itself is overtime. */
export function deadlineInfo(record, now = Date.now()) {
	if (!record || !Number.isFinite(record.deadlineAt)) return { bounded: false };
	const at = Number.isFinite(record.clockPausedAt)
		? record.clockPausedAt
		: Number.isFinite(now)
			? now
			: Date.now();
	const leftMs = record.deadlineAt - at;
	if (leftMs <= 0) return { bounded: true, overtime: true, leftMs: 0 };
	return { bounded: true, overtime: false, leftMs };
}

/**
 * The tool admission limit is always absent: the deadline is measured, never
 * enforced against a running call. A call that starts or ends after the
 * deadline keeps its result; the overrun is recorded as a debt and the caller
 * reads it on the record. The first overrun stamps `overtimeAt`.
 */
export function toolLimitOf(record, now = Date.now()) {
	const deadline = record?.deadlineAt;
	if (!Number.isFinite(deadline)) return null;
	const at = Number.isFinite(now) ? now : Date.now();
	if (at >= deadline && (record.overtimeAt === null || record.overtimeAt === undefined)) {
		record.overtimeAt = at;
	}
	return null;
}

export function createClockOn(now = () => Date.now()) {
	return {
		name: "on",
		bounded: true,
		start(record, clockMs, startedAt) {
			if (!record || typeof record !== "object") {
				return { ok: false, code: "CLOCK_INVALID_RECORD" };
			}
			const budget = Number.isFinite(clockMs) ? clockMs : record.timeBudgetMs;
			const start = Number.isFinite(startedAt)
				? startedAt
				: Number.isFinite(record.startedAt)
					? record.startedAt
					: now();
			if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(start)) {
				record.deadlineAt = null;
				record.overtimeAt = null;
				record.clockPausedAt = null;
				record.pausedMs = 0;
				return { ok: false, code: "CLOCK_INVALID_BUDGET" };
			}
			record.deadlineAt = start + budget;
			record.overtimeAt = null;
			record.clockPausedAt = null;
			record.pausedMs = 0;
			return { ok: true, deadlineAt: record.deadlineAt };
		},
		pause(record, at) {
			return pauseClock(record, at ?? now());
		},
		resume(record, at) {
			return resumeClock(record, at ?? now());
		},
		info(record, at) {
			return deadlineInfo(record, at ?? now());
		},
		toolLimit(record, at) {
			return toolLimitOf(record, at ?? now());
		},
	};
}

export function createClockOff() {
	return {
		name: "off",
		bounded: false,
		start(record) {
			if (record && typeof record === "object") {
				record.deadlineAt = null;
				record.overtimeAt = null;
				record.clockPausedAt = null;
				record.pausedMs = 0;
			}
			return { ok: true };
		},
		pause() {
			return false;
		},
		resume() {
			return false;
		},
		info() {
			return { bounded: false };
		},
		toolLimit() {
			return null;
		},
	};
}

export const CLOCK_IMPLEMENTATIONS = {
	on: createClockOn,
	off: createClockOff,
};
