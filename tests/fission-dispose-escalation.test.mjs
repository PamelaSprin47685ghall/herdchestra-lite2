import { describe, expect, test } from "bun:test";

import {
	createDisposeBarrier,
	installDisposeBarrier,
} from "../src/activation/fission.mjs";

// A scheduler whose liveness is under the test's control. `waitForBatch`
// resolves when the test closes the batch, the same event the real scheduler
// uses to settle `batch.donePromise`.
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

describe("fission dispose barrier escalation", () => {
	test("a later teardown reason cancels immediately and bounds the shared wait", async () => {
		const scheduler = schedulerHarness();
		const session = sessionHarness();
		installDisposeBarrier(session, scheduler, { pollMs: 1, cancelGraceMs: 15 });

		const first = session.dispose();
		await Promise.resolve();
		expect(scheduler.cancelled).toEqual([]);

		const second = session.dispose({ reason: "SIGINT" });
		expect(second).toBe(first);
		// The escalation cancels synchronously, before any await can run.
		expect(scheduler.cancelled[0]).toBe("SIGINT");

		await first;
		// The host's own dispose still receives the first call's arguments.
		expect(session.calls).toEqual([null]);
	});

	test("a repeated teardown reason keeps the first grace deadline", () => {
		const scheduler = schedulerHarness();
		const barrier = createDisposeBarrier({ scheduler, pollMs: 1, cancelGraceMs: 1_000 });

		expect(barrier.escalate("SIGINT")).toBe(true);
		const armed = barrier.state().teardown.deadline;
		expect(barrier.escalate("SIGTERM")).toBe(true);

		expect(barrier.state().teardown.reason).toBe("SIGTERM");
		expect(barrier.state().teardown.deadline).toBe(armed);
		expect(scheduler.cancelled).toEqual(["SIGINT", "SIGTERM"]);
	});

	test("a teardown reason still ends the wait when cancelAll cannot stop the flows", async () => {
		const scheduler = schedulerHarness();
		const session = sessionHarness();
		installDisposeBarrier(session, scheduler, { pollMs: 1, cancelGraceMs: 10 });

		const first = session.dispose();
		await Promise.resolve();
		session.dispose({ reason: "SIGTERM" });

		await first;
		expect(session.calls).toHaveLength(1);
		expect(scheduler.cancelled[0]).toBe("SIGTERM");
	});

	test("an ordinary wait still ends as quiescent when the batch closes", async () => {
		const scheduler = schedulerHarness();
		const session = sessionHarness();
		installDisposeBarrier(session, scheduler, { pollMs: 1 });

		const disposing = session.dispose();
		await Promise.resolve();
		expect(session.calls).toHaveLength(0);

		scheduler.close();
		expect(await disposing).toBe("disposed");
		expect(scheduler.cancelled).toEqual([]);
	});

	test("escalation after quiescence does not run the host dispose twice", async () => {
		const scheduler = schedulerHarness();
		scheduler.live = false;
		const session = sessionHarness();
		installDisposeBarrier(session, scheduler, { pollMs: 1 });

		const first = session.dispose();
		await first;
		const second = session.dispose({ reason: "SIGINT" });

		expect(second).toBe(first);
		expect(session.calls).toHaveLength(1);
	});
});
