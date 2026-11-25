// Clock policy: the wall-clock arithmetic over one persisted fork record.
//
// Two implementations share one contract:
//   on  - a deadline, a pause edge, and a one-second overtime unit;
//   off - no bound: no deadline, no pause, no tool gate.
//
// The record is the only state. The port never keeps a keyed map, so a reload
// restores the same clock the branch had before it stopped.
//
// Every write goes through `editRecord`, which marks the record as changed.
// A clock field written without that mark stays in memory and never reaches the
// journal, so the mark is part of the write here rather than a step each of the
// six mutating paths has to remember.

import { editRecord, setRecordFields } from "./record-mutation.mjs";

/** Freeze a branch's clock. The first pause edge wins. */
export function pauseClock(record, now = Date.now()) {
	if (!record || !Number.isFinite(record.deadlineAt)) return false;
	if (Number.isFinite(record.clockPausedAt)) return false;
	return editRecord(record, (target) => {
		target.clockPausedAt = Number.isFinite(now) ? now : Date.now();
	});
}

/** Release a paused clock, shifting the deadline by exactly the paused span. */
export function resumeClock(record, now = Date.now()) {
	if (!record || !Number.isFinite(record.deadlineAt)) return false;
	if (!Number.isFinite(record.clockPausedAt)) return false;
	const at = Number.isFinite(now) ? now : Date.now();
	return editRecord(record, (target) => {
		const paused = Math.max(0, at - target.clockPausedAt);
		target.deadlineAt += paused;
		target.pausedMs = (Number.isFinite(target.pausedMs) ? target.pausedMs : 0) + paused;
		target.clockPausedAt = null;
	});
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
		// The stamp is a record change like any other: a reload has to see that
		// this branch went over, or it would report a fresh bound it no longer has.
		editRecord(record, (target) => {
			target.overtimeAt = at;
		});
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
				// Clearing the clock is a change too: the branch must not come back
				// from a reload holding a deadline nobody set.
				setRecordFields(record, {
					deadlineAt: null,
					overtimeAt: null,
					clockPausedAt: null,
					pausedMs: 0,
				});
				return { ok: false, code: "CLOCK_INVALID_BUDGET" };
			}
			setRecordFields(record, {
				deadlineAt: start + budget,
				overtimeAt: null,
				clockPausedAt: null,
				pausedMs: 0,
			});
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
				// An unbounded clock still has to clear whatever bound the record
				// carried, and that clearing has to reach the journal: a reload
				// that kept the old deadline would gate calls the policy says it
				// never gates.
				setRecordFields(record, {
					deadlineAt: null,
					overtimeAt: null,
					clockPausedAt: null,
					pausedMs: 0,
				});
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
