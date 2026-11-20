import { describe, expect, test } from "bun:test";

import { installFissionInput, uninstallFissionInput } from "../src/activation/fission.mjs";

// The host's AgentSession methods live on the prototype. Using a class here
// exercises the same shadow-and-delete restoration the real session needs.
class OwnerSession {
	constructor() {
		this.prompts = [];
		this.steers = [];
		this.aborts = [];
		this.agent = { id: "owner" };
	}

	async prompt(text) {
		this.prompts.push(text);
		return true;
	}

	async steer(text) {
		this.steers.push(text);
	}

	async abort(options) {
		this.aborts.push(options ?? null);
	}
}

function harness({ leaves = [], live = true, disposed = false } = {}) {
	const state = {
		leaves,
		live,
		disposed,
		broadcasts: [],
		cancels: [],
		broadcastResult: null,
	};
	const scheduler = {
		status: () => ({ disposed: state.disposed }),
		hasLiveBatches: () => state.live,
		activeLeaves: () => (state.live ? state.leaves : []),
		broadcast(text) {
			state.broadcasts.push(text);
			return (
				state.broadcastResult ?? {
					ok: true,
					broadcastId: `bc${state.broadcasts.length}`,
					recipients: state.leaves.map((flow) => flow.label),
				}
			);
		},
		cancelAll(reason) {
			state.cancels.push(reason);
			return [];
		},
	};
	return { session: new OwnerSession(), scheduler, state };
}

const FLOWS = [
	{ id: "f0", label: "batch.0" },
	{ id: "f1", label: "batch.1" },
];

describe("fission owner input broadcast", () => {
	test("prompt text reaches every active leaf, not the retired owner", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		const bridge = installFissionInput(session, scheduler);
		expect(bridge?.installed).toBe(true);

		const forwarded = await session.prompt("keep going");

		expect(forwarded).toBe(false);
		expect(state.broadcasts).toEqual(["keep going"]);
		expect(session.prompts).toEqual([]);
	});

	test("steer text is broadcast while the batch is live", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		installFissionInput(session, scheduler);

		await session.steer("one more constraint");

		expect(state.broadcasts).toEqual(["one more constraint"]);
		expect(session.steers).toEqual([]);
	});

	test("a slash command stays a host command", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		installFissionInput(session, scheduler);

		await session.prompt("/status");

		expect(state.broadcasts).toEqual([]);
		expect(session.prompts).toEqual(["/status"]);
	});

	test("input with no active leaf is refused, never routed to the owner", async () => {
		const { session, scheduler, state } = harness({ leaves: [] });
		installFissionInput(session, scheduler);

		await expect(session.prompt("too early")).rejects.toThrow(/no active flow/);
		expect(state.broadcasts).toEqual([]);
		expect(session.prompts).toEqual([]);
	});

	test("a refused broadcast is reported, not dropped", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		state.broadcastResult = { ok: false, code: "UNSUPPORTED", detail: "no flow accepted the broadcast" };
		installFissionInput(session, scheduler);

		await expect(session.prompt("hello")).rejects.toThrow(/no flow accepted the broadcast/);
		expect(session.prompts).toEqual([]);
	});

	test("input returns to the host once the batch closes", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		installFissionInput(session, scheduler);
		expect(Object.hasOwn(session, "prompt")).toBe(true);

		// The bridge stays installed through the ordinary prompts that come
		// before any batch exists; only a call that has seen a live batch arms
		// restoration.
		state.live = true;
		expect(await session.prompt("during the batch")).toBe(false);
		expect(state.broadcasts).toEqual(["during the batch"]);

		state.live = false;
		const forwarded = await session.prompt("after the batch");

		expect(forwarded).toBe(true);
		expect(session.prompts).toEqual(["after the batch"]);
		expect(state.broadcasts).toEqual(["during the batch"]);
		expect(Object.hasOwn(session, "prompt")).toBe(false);
		expect(Object.hasOwn(session, "steer")).toBe(false);
		expect(Object.hasOwn(session, "abort")).toBe(false);
	});

	test("a bridge installed before any batch survives ordinary prompts", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS, live: false });
		installFissionInput(session, scheduler);

		expect(await session.prompt("the first user turn")).toBe(true);
		expect(Object.hasOwn(session, "prompt")).toBe(true);

		// The batch opens later, during that same owner turn.
		state.live = true;
		expect(await session.prompt("now broadcast")).toBe(false);
		expect(state.broadcasts).toEqual(["now broadcast"]);
	});

	test("an owner prompt waits for a batch opened during its turn", async () => {
		const { session, scheduler, state } = harness({ live: false });
		let finish;
		const done = new Promise((resolve) => { finish = resolve; });
		scheduler.status = () => ({ disposed: false, batches: [{ batchId: "b1", status: "running" }] });
		scheduler.waitForBatch = () => done;
		session.prompt = async () => { state.live = true; return true; };
		installFissionInput(session, scheduler);
		let returned = false;
		const prompt = session.prompt("start").then(() => { returned = true; });
		await Promise.resolve();
		await Promise.resolve();
		expect(returned).toBe(false);
		state.live = false;
		finish();
		await prompt;
		expect(returned).toBe(true);
	});

	test("a disposed scheduler is not live even with an open batch record", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS, disposed: true });
		installFissionInput(session, scheduler);

		const forwarded = await session.prompt("late input");

		expect(forwarded).toBe(true);
		expect(session.prompts).toEqual(["late input"]);
		expect(state.broadcasts).toEqual([]);
	});

	test("uninstall restores the host methods in place", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		installFissionInput(session, scheduler);

		expect(uninstallFissionInput(session)).toBe(true);
		const forwarded = await session.prompt("plain session");

		expect(forwarded).toBe(true);
		expect(session.prompts).toEqual(["plain session"]);
		expect(state.broadcasts).toEqual([]);
		expect(uninstallFissionInput(session)).toBe(false);
	});
});

describe("fission owner abort fan-out", () => {
	test("Esc stops every active leaf before the owner cleans itself up", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		installFissionInput(session, scheduler);

		await session.abort({ reason: "User interrupt" });

		expect(state.cancels).toEqual(["User interrupt"]);
		expect(session.aborts).toHaveLength(1);
	});

	test("an abort with no active leaf is the owner's retirement, not a fan-out", async () => {
		const { session, scheduler, state } = harness({ leaves: [] });
		installFissionInput(session, scheduler);

		await session.abort({ reason: "User interrupt" });

		// retireOwner() aborts the owner Agent directly and returns
		// `abort: false`; this path also covers a ctx.abort() fallback that
		// arrives before the first flow exists.
		expect(state.cancels).toEqual([]);
		expect(session.aborts).toHaveLength(1);
	});

	test("abort after the batch closed delegates without cancelling anything", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		installFissionInput(session, scheduler);
		state.live = false;

		await session.abort();

		expect(state.cancels).toEqual([]);
		expect(session.aborts).toEqual([null]);
	});

	test("a cancelled fan-out still aborts the owner", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		scheduler.cancelAll = () => {
			throw new Error("flows already gone");
		};
		installFissionInput(session, scheduler);

		await session.abort();

		expect(session.aborts).toHaveLength(1);
		expect(state.cancels).toEqual([]);
	});
});

describe("fission input across the batch boundary", () => {
	test("a prompt typed while the last flows finish is handed to the heir", async () => {
		const { session, scheduler, state } = harness({ leaves: [], live: true });
		// A real scheduler names its open batch; only then may the bridge wait.
		scheduler.status = () => ({
			disposed: false,
			batches: state.live ? [{ batchId: "b1", status: "finalizing", flows: [] }] : [],
		});
		let leafChecks = 0;
		scheduler.activeLeaves = () => {
			// The first check is the wrapper's own precondition. The wait's
			// check is where adoption completes, so close the batch there.
			leafChecks += 1;
			if (leafChecks > 1) state.live = false;
			return [];
		};
		installFissionInput(session, scheduler);

		await expect(session.prompt("late input")).resolves.toBe(true);
		expect(session.prompts).toEqual(["late input"]);
		expect(state.broadcasts).toEqual([]);
	});

	test("a steer typed while the last flows finish reaches the host", async () => {
		const { session, scheduler, state } = harness({ leaves: [], live: true });
		scheduler.status = () => ({
			disposed: false,
			batches: state.live ? [{ batchId: "b1", status: "finalizing", flows: [] }] : [],
		});
		let leafChecks = 0;
		scheduler.activeLeaves = () => {
			leafChecks += 1;
			if (leafChecks > 1) state.live = false;
			return [];
		};
		installFissionInput(session, scheduler);

		await session.steer("late steer");

		expect(session.steers).toEqual(["late steer"]);
		expect(state.broadcasts).toEqual([]);
	});

	test("a prompt typed while flows are spawning is broadcast once a leaf appears", async () => {
		const { session, scheduler, state } = harness({ leaves: [], live: true });
		scheduler.status = () => ({
			disposed: false,
			batches: state.live
				? [{ batchId: "b1", status: "starting", flows: [{ flowId: "f0", status: "spawning" }] }]
				: [],
		});
		let leafChecks = 0;
		scheduler.activeLeaves = () => {
			leafChecks += 1;
			// The precondition sees an empty batch; the wait sees the leaf.
			return leafChecks > 1 ? FLOWS : [];
		};
		installFissionInput(session, scheduler);

		await expect(session.prompt("start now")).resolves.toBe(false);
		expect(state.broadcasts).toEqual(["start now"]);
		expect(session.prompts).toEqual([]);
	});

	test("a partial broadcast names the flows that missed it", async () => {
		const { session, scheduler, state } = harness({ leaves: FLOWS });
		state.broadcastResult = {
			ok: true,
			broadcastId: "bc9",
			recipients: FLOWS.map((flow) => flow.label),
			delivered: ["batch.0"],
			failures: [{ flowId: "f1", error: "agent is busy" }],
		};
		installFissionInput(session, scheduler);

		const failure = await session.prompt("hello").then(
			() => null,
			(error) => error,
		);

		expect(failure?.code).toBe("FISSION_BROADCAST_PARTIAL");
		expect(failure?.message).toContain("f1");
		expect(session.prompts).toEqual([]);
		expect(state.broadcasts).toEqual(["hello"]);
	});

	test("a live batch the scheduler cannot name is refused without waiting", async () => {
		const { session, scheduler, state } = harness({ leaves: [], live: true });
		// `status()` names no batch here, so there is nothing to poll; the
		// settle budget must not delay the refusal.
		installFissionInput(session, scheduler);
		const startedAt = Date.now();

		await expect(session.prompt("too early")).rejects.toThrow(/no active flow/);

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(state.broadcasts).toEqual([]);
		expect(session.prompts).toEqual([]);
	});
});
