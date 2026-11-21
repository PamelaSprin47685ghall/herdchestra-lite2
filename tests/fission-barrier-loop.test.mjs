// The owner's prompt() must not resolve while a fission batch is still live.
// The host treats a resolved prompt as a finished turn and announces it, so a
// single barrier wait let the desktop notification fire halfway through a
// batch. These tests drive the real patched prompt through a scheduler whose
// liveness the test controls.

import { describe, expect, test } from "bun:test";

import { installFissionInput } from "../src/activation/fission.mjs";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A scheduler that reports whatever liveness the test currently wants.
 *
 * The real barrier polls, so `status()` must name the live batch for the loop
 * to keep waiting; clearing `batches` is how a test ends the wait.
 */
function controllableScheduler() {
	const batches = [];
	return {
		batches,
		broadcast() {
			throw new Error("this test never broadcasts");
		},
		pauseAll() {},
		hasLiveBatches() {
			return batches.length > 0;
		},
		status() {
			return { batches: batches.map((batch) => ({ ...batch, status: "running" })) };
		},
		interruptEpoch() {
			return 0;
		},
	};
}

function ownerSession(scheduler) {
	const session = {
		promptCalls: 0,
		waitForIdleCalls: 0,
		async prompt() {
			session.promptCalls += 1;
			// The scope call inside this turn opens the batch. The host's own turn
			// is already committed, so the bridge enters its idle branch and must
			// park the caller until that batch is gone.
			scheduler.batches.push({ batchId: "b1" });
			return "turn-result";
		},
		async waitForIdle() {
			session.waitForIdleCalls += 1;
		},
	};
	return session;
}

describe("the owner prompt stays parked while a batch is live", () => {
	test("a live batch that outlives one wait keeps prompt() unresolved", async () => {
		const scheduler = controllableScheduler();
		const session = ownerSession(scheduler);
		installFissionInput(session, scheduler);

		let settled = false;
		const call = session.prompt("hello").then((value) => {
			settled = true;
			return value;
		});

		await sleep(200);
		expect(session.promptCalls).toBe(1);
		// A single wait would have returned here, one poll interval in.
		expect(settled).toBe(false);

		scheduler.batches.length = 0;
		await expect(call).resolves.toBe("turn-result");
		expect(settled).toBe(true);
	});
});
