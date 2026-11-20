import { describe, expect, test } from "bun:test";

import {
	reset as resetDiagnostics,
	snapshot as diagnosticsSnapshot,
} from "../src/host/diagnostics.mjs";
import {
	createDisposeBarrier,
	installDisposeBarrier,
} from "../src/activation/fission.mjs";

// A scheduler whose liveness is under the test's control. `waitForBatch`
// returns a promise the test settles through `close()`, which is the same
// event the real scheduler uses to settle `batch.donePromise`.
function schedulerHarness() {
	const resolvers = [];
	const cancelled = [];
	const harness = {
		cancelled,
		live: true,
		waitForBatch() {
			if (!harness.live) return Promise.resolve(undefined);
			return new Promise((resolve) => {
				resolvers.push(resolve);
			});
		},
		hasLiveBatches() {
			return harness.live;
		},
		status() {
			return {
				batches: harness.live ? [{ batchId: "b1", status: "running" }] : [],
			};
		},
		cancelAll(reason) {
			cancelled.push(reason);
			return [];
		},
		close() {
			harness.live = false;
			for (const resolve of resolvers.splice(0)) resolve(undefined);
		},
	};
	return harness;
}

function sessionHarness() {
	const calls = [];
	return {
		calls,
		dispose(options) {
			calls.push(options ?? null);
			return Promise.resolve("disposed");
		},
	};
}

// A virtual clock keeps every barrier test deterministic. Nothing waits on real
// time, so a barrier that forgets its bound surfaces as a promise that never
// settles, not as a hung suite.
function fakeClock() {
	let current = 0;
	const sleepers = [];
	return {
		now: () => current,
		sleep(ms) {
			return new Promise((resolve) => {
				sleepers.push({ at: current + ms, resolve });
			});
		},
		advance(ms) {
			current += ms;
			for (let index = sleepers.length - 1; index >= 0; index -= 1) {
				if (sleepers[index].at > current) continue;
				const [sleeper] = sleepers.splice(index, 1);
				sleeper.resolve();
			}
		},
		pending: () => sleepers.length,
	};
}

// Drive microtasks and macrotasks. The wait loop starts a new iteration on a
// macrotask whenever a batch promise settles, so a microtask-only flush would
// read a correctly yielding loop as stuck.
async function flush(turns = 8) {
	for (let index = 0; index < turns; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

// Observe settlement without risking an unhandled rejection.
function settleProbe(promise) {
	const probe = { settled: false, value: undefined };
	promise.then(
		(value) => {
			probe.settled = true;
			probe.value = value;
		},
		(error) => {
			probe.settled = true;
			probe.value = error;
		},
	);
	return probe;
}

function fissionRecords() {
	return diagnosticsSnapshot().filter((entry) => entry.domain === "fission");
}

describe("createDisposeBarrier", () => {
	test("reports its configured bounds", () => {
		const scheduler = schedulerHarness();
		const barrier = createDisposeBarrier({
			scheduler,
			cancelGraceMs: 20,
			ceilingMs: 50,
		});

		expect(barrier.state()).toEqual({
			released: null,
			live: { live: true, ids: ["b1"] },
			graceMs: 20,
			ceilingMs: 50,
			// No teardown reason has arrived, so the state reports none.
			teardown: null,
		});
	});

	test("waits without a ceiling by default so a long flow can finish", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(barrier.state().ceilingMs).toBe(0);

		const waiting = barrier.wait();
		const probe = settleProbe(waiting);
		await flush();
		expect(probe.settled).toBe(false);
		expect(scheduler.hasLiveBatches()).toBe(true);

		// Only the batch itself releases the ordinary wait.
		scheduler.close();
		await flush();
		expect(await waiting).toBe("quiescent");
	});

	test("returns quiescent without sleeping when no batch is live", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		scheduler.live = false;
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(await barrier.wait()).toBe("quiescent");
		expect(clock.pending()).toBe(0);
	});

	test("releases immediately, without waiting for a poll tick", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 10_000,
			now: clock.now,
			sleep: clock.sleep,
		});

		const waiting = barrier.wait();
		const probe = settleProbe(waiting);
		await flush();
		expect(probe.settled).toBe(false);

		expect(barrier.release("operator")).toBe(true);
		await flush();
		expect(await waiting).toBe("released");
		expect(barrier.release()).toBe(false);
		expect(barrier.state().released).toBe("operator");
		// The poll interval never elapsed: the clock was never advanced.
		expect(clock.now()).toBe(0);
	});

	test("cannot be starved by a batch promise that is already settled", async () => {
		const clock = fakeClock();
		const turns = [];
		const scheduler = {
			hasLiveBatches: () => true,
			status: () => ({ batches: [{ batchId: "b1", status: "running" }] }),
			waitForBatch: () => Promise.resolve(undefined),
		};
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 60_000,
			now: clock.now,
			sleep: clock.sleep,
			turn: (callback) => {
				turns.push(1);
				setImmediate(callback);
			},
		});

		const waiting = barrier.wait();
		const probe = settleProbe(waiting);
		await flush(4);
		// Every settled promise crosses the macrotask turn instead of looping
		// inside one microtask drain, which is what used to freeze the runner.
		expect(turns.length).toBeGreaterThan(0);
		expect(probe.settled).toBe(false);
		expect(scheduler.hasLiveBatches()).toBe(true);

		expect(barrier.release("operator")).toBe(true);
		await flush(2);
		expect(await waiting).toBe("released");
	});

	test("re-issues cancelAll while a postmortem wait is still live", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 10,
			cancelGraceMs: 5_000,
			now: clock.now,
			sleep: clock.sleep,
		});

		const waiting = barrier.wait({ reason: "SIGTERM" });
		await flush();
		expect(scheduler.cancelled).toEqual(["SIGTERM"]);

		// A flow that finishes spawning inside the grace window is a new target.
		clock.advance(250);
		await flush();
		expect(scheduler.cancelled).toEqual(["SIGTERM", "SIGTERM"]);

		scheduler.close();
		await flush();
		expect(await waiting).toBe("quiescent");
	});

	test("bounds a postmortem wait by its grace and cancels once more", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 10,
			cancelGraceMs: 100,
			now: clock.now,
			sleep: clock.sleep,
		});

		const waiting = barrier.wait({ reason: "SIGINT" });
		await flush();
		expect(scheduler.cancelled).toEqual(["SIGINT"]);

		clock.advance(100);
		await flush();
		expect(await waiting).toBe("cancel-deadline");
		expect(scheduler.cancelled).toEqual(["SIGINT", "SIGINT: dispose barrier"]);
	});

	test("honors an explicit ceiling and records why it left", async () => {
		const clock = fakeClock();
		resetDiagnostics();
		const scheduler = schedulerHarness();
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 10,
			ceilingMs: 100,
			now: clock.now,
			sleep: clock.sleep,
		});

		const waiting = barrier.wait();
		const probe = settleProbe(waiting);
		await flush();
		expect(probe.settled).toBe(false);

		clock.advance(100);
		await flush();
		expect(await waiting).toBe("ceiling");
		// The batch was never marked done: the ceiling is an admitted release,
		// not a claim of quiescence.
		expect(scheduler.hasLiveBatches()).toBe(true);
		const records = fissionRecords();
		expect(records.some((entry) => entry.detail?.barrier === "ceiling")).toBe(true);
		expect(scheduler.cancelled).toEqual([]);
	});

	test("stays bounded when status() cannot describe the live batch", async () => {
		const clock = fakeClock();
		const scheduler = {
			hasLiveBatches() {
				return true;
			},
			status() {
				throw new Error("journal sealed");
			},
		};
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 10,
			ceilingMs: 50,
			now: clock.now,
			sleep: clock.sleep,
		});

		const waiting = barrier.wait();
		await flush();
		clock.advance(50);
		await flush();
		expect(await waiting).toBe("ceiling");
	});

	test("treats a rejected batch promise as still pending, not as completion", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		scheduler.waitForBatch = () => Promise.reject(new Error("batch vanished"));
		const barrier = createDisposeBarrier({
			scheduler,
			pollMs: 10,
			ceilingMs: 10_000,
			now: clock.now,
			sleep: clock.sleep,
		});

		const waiting = barrier.wait();
		const probe = settleProbe(waiting);
		await flush();
		clock.advance(100);
		await flush();
		expect(probe.settled).toBe(false);
		expect(scheduler.hasLiveBatches()).toBe(true);

		clock.advance(9_900);
		await flush();
		expect(await waiting).toBe("ceiling");
	});
});

describe("installDisposeBarrier", () => {
	test("holds dispose until the scheduler reports no live batch", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		const session = sessionHarness();
		const installed = installDisposeBarrier(session, scheduler, {
			pollMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(installed).not.toBeNull();

		const disposing = session.dispose();
		await flush();
		expect(session.calls).toHaveLength(0);

		scheduler.close();
		await flush();
		expect(await disposing).toBe("disposed");
		expect(session.calls).toHaveLength(1);
	});

	test("delegates at once when no batch is live and keeps the options", async () => {
		const scheduler = schedulerHarness();
		scheduler.live = false;
		const session = sessionHarness();
		installDisposeBarrier(session, scheduler, { pollMs: 10 });

		const options = { mnemopiConsolidateTimeoutMs: 12 };
		expect(await session.dispose(options)).toBe("disposed");
		expect(session.calls).toEqual([options]);
	});

	test("shares one wait across concurrent dispose calls", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		const session = sessionHarness();
		installDisposeBarrier(session, scheduler, {
			pollMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});

		const first = session.dispose();
		const second = session.dispose({ reason: "SIGINT" });
		// AgentSession.dispose() memoizes its first call, so a later signal
		// joins the wait already in flight instead of starting another one.
		expect(second).toBe(first);

		scheduler.close();
		await flush();
		await first;
		expect(session.calls).toHaveLength(1);
	});

	test("delegates a detached dispose call with the session as receiver", async () => {
		const scheduler = schedulerHarness();
		scheduler.live = false;
		const session = {
			calls: 0,
			dispose() {
				this.calls += 1;
				return Promise.resolve("disposed");
			},
		};
		installDisposeBarrier(session, scheduler, { pollMs: 10 });

		const detached = session.dispose;
		expect(await detached()).toBe("disposed");
		expect(session.calls).toBe(1);
	});

	test("propagates the host's dispose error without calling it twice", async () => {
		const scheduler = schedulerHarness();
		scheduler.live = false;
		const session = {
			calls: 0,
			dispose() {
				this.calls += 1;
				throw new Error("host refused");
			},
		};
		installDisposeBarrier(session, scheduler, { pollMs: 10 });

		const first = session.dispose();
		const second = session.dispose();
		expect(second).toBe(first);
		const error = await first.catch((caught) => caught);
		expect(error.message).toBe("host refused");
		expect(session.calls).toBe(1);
	});

	test("returns the barrier already installed for this session", () => {
		const scheduler = schedulerHarness();
		const session = sessionHarness();

		const first = installDisposeBarrier(session, scheduler);
		const second = installDisposeBarrier(session, schedulerHarness());

		expect(second).toBe(first);
	});

	test("installs independently per session", async () => {
		const scheduler = schedulerHarness();
		scheduler.live = false;
		const one = sessionHarness();
		const two = sessionHarness();

		const first = installDisposeBarrier(one, scheduler);
		const second = installDisposeBarrier(two, scheduler);
		expect(second).not.toBe(first);

		await one.dispose();
		await two.dispose();
		expect(one.calls).toHaveLength(1);
		expect(two.calls).toHaveLength(1);
	});

	test("uninstalls to the host's original dispose", async () => {
		const scheduler = schedulerHarness();
		const session = sessionHarness();
		const installed = installDisposeBarrier(session, scheduler, { pollMs: 10 });

		expect(installed.uninstall()).toBe(true);
		expect(session.dispose).toBe(installed.original);
		expect(installed.uninstall()).toBe(false);

		// scheduler.live is still true, yet the restored host method runs at once.
		expect(await session.dispose()).toBe("disposed");
		expect(session.calls).toHaveLength(1);
	});

	test("leaves a session untouched when liveness cannot be observed", () => {
		const session = sessionHarness();
		const original = session.dispose;

		expect(installDisposeBarrier(session, {})).toBeNull();
		expect(session.dispose).toBe(original);
	});

	test("leaves a session untouched when the host offers no dispose", () => {
		expect(installDisposeBarrier({}, schedulerHarness())).toBeNull();
	});

	test("delegates when liveness throws instead of stranding teardown", async () => {
		const session = sessionHarness();
		installDisposeBarrier(
			session,
			{
				hasLiveBatches() {
					throw new Error("journal sealed");
				},
			},
			{ pollMs: 10 },
		);

		expect(await session.dispose()).toBe("disposed");
		expect(session.calls).toHaveLength(1);
	});

	test("cancels live flows and bounds the wait on a teardown reason", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		const session = sessionHarness();
		installDisposeBarrier(session, scheduler, {
			pollMs: 10,
			cancelGraceMs: 100,
			now: clock.now,
			sleep: clock.sleep,
		});

		const disposing = session.dispose({ reason: "SIGINT" });
		await flush();
		expect(scheduler.cancelled[0]).toBe("SIGINT");

		clock.advance(100);
		await flush();
		expect(await disposing).toBe("disposed");
		expect(session.calls).toEqual([{ reason: "SIGINT" }]);
	});

	test("bounds an ordinary dispose when a ceiling is explicitly configured", async () => {
		const clock = fakeClock();
		const scheduler = schedulerHarness();
		const session = sessionHarness();
		installDisposeBarrier(session, scheduler, {
			pollMs: 10,
			ceilingMs: 100,
			now: clock.now,
			sleep: clock.sleep,
		});

		const disposing = session.dispose();
		await flush();
		expect(session.calls).toHaveLength(0);

		clock.advance(100);
		await flush();
		expect(await disposing).toBe("disposed");
		expect(session.calls).toHaveLength(1);
	});
});
