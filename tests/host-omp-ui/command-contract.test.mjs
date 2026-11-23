import { describe, test, expect } from "bun:test";

import { buildBridgeCapabilities } from "../../host-omp-ui/src/activation/tickets.mjs";
import { createHostTickets } from "../../host-omp-ui/src/host/bridge-tickets.mjs";

// Red contract for the manager-style command channel.
//
// Every state-changing web command is a correlated request: the origin browser
// supplies { clientId, requestId }, and the bridge answers exactly one
// `command.result` frame with the same requestId — success or failure. A
// successful model switch must additionally push the host's post-switch state
// (`meta.update`), read after the await, so the selector reflects what the host
// actually holds instead of echoing the requested alias.
//
// Not covered here because it needs the station factory: the receipt contract
// below is the same one every client command must satisfy.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeHarness(overrides = {}) {
	const sent = [];
	const broadcast = [];
	const tickets = {
		sendClientFrameTicket: async ({ clientId, frame }) => {
			sent.push({ clientId, frame });
			return { ok: true };
		},
		broadcastFrameTicket: async (frame) => {
			broadcast.push(frame);
			return { ok: true };
		},
		submitComposerTicket: async () => ({ ok: true }),
		abortSessionTicket: async () => ({ ok: true }),
		setModelTicket: async () => ({
			ok: true,
			value: { provider: "p", id: "m" },
			reported: { model: { provider: "p", id: "m" }, thinkingLevel: "high" },
		}),
		setThinkingTicket: async () => ({ ok: true }),
		setModeTicket: async () => ({ ok: true }),
		...overrides,
	};
	const capabilities = buildBridgeCapabilities({ tickets, diagnostics: { record() {} } });
	return { sent, broadcast, capabilities };
}

const CASES = [
	["submitComposer", { text: "hello" }],
	["abort", {}],
	["setModel", { provider: "p", modelId: "m" }],
	["setThinking", { level: "high" }],
	["setMode", { mode: "plan" }],
];

function resultFrames(sent) {
	return sent.filter(({ frame }) => frame?.type === "command.result");
}

describe("correlated command receipts", () => {
	for (const [type, payload] of CASES) {
		test(`${type}: success answers the originating client once`, async () => {
			const { sent, capabilities } = makeHarness();
			capabilities.dispatch({ type, payload: { ...payload, clientId: "c1", requestId: "r1" } });
			await flush();
			const results = resultFrames(sent);
			expect(results).toHaveLength(1);
			expect(results[0].clientId).toBe("c1");
			expect(results[0].frame).toMatchObject({
				type: "command.result",
				requestId: "r1",
				ok: true,
			});
		});
	}

	test("failure carries the domain code back to the origin", async () => {
		const { sent, capabilities } = makeHarness({
			setThinkingTicket: async () => ({ ok: false, code: "invalid_level" }),
		});
		capabilities.dispatch({
			type: "setThinking",
			payload: { level: "nope", clientId: "c1", requestId: "r7" },
		});
		await flush();
		const results = resultFrames(sent);
		expect(results).toHaveLength(1);
		expect(results[0].frame).toMatchObject({
			type: "command.result",
			requestId: "r7",
			ok: false,
			code: "invalid_level",
		});
	});

	test("a rejected ticket is reported as a failed result, not only a toast", async () => {
		const { sent, capabilities } = makeHarness({
			abortSessionTicket: async () => {
				throw new Error("host exploded");
			},
		});
		capabilities.dispatch({ type: "abort", payload: { clientId: "c1", requestId: "r8" } });
		await flush();
		const results = resultFrames(sent);
		expect(results).toHaveLength(1);
		expect(results[0].frame).toMatchObject({
			type: "command.result",
			requestId: "r8",
			ok: false,
			code: "failed",
		});
	});

	test("commands without a request id stay silent", async () => {
		const { sent, capabilities } = makeHarness();
		capabilities.dispatch({ type: "setModel", payload: { provider: "p", modelId: "m" } });
		capabilities.dispatch({ type: "abort", payload: {} });
		await flush();
		expect(resultFrames(sent)).toHaveLength(0);
	});
});

describe("authoritative state after a model switch", () => {
	test("the host's post-switch model is broadcast, not the requested alias", async () => {
		const { broadcast, capabilities } = makeHarness({
			setModelTicket: async () => ({
				ok: true,
				value: { provider: "p", id: "alias" },
				reported: {
					model: { provider: "p", id: "canonical" },
					thinkingLevel: "medium",
				},
			}),
		});
		capabilities.dispatch({
			type: "setModel",
			payload: { provider: "p", modelId: "alias", clientId: "c1", requestId: "r2" },
		});
		await flush();
		const meta = broadcast.filter((frame) => frame?.type === "meta.update");
		expect(meta).toHaveLength(1);
		expect(meta[0]).toMatchObject({
			type: "meta.update",
			model: { provider: "p", id: "canonical" },
			thinkingLevel: "medium",
		});
	});

	test("a successful switch with no host report fabricates no meta frame", async () => {
		const { broadcast, capabilities } = makeHarness({
			setModelTicket: async () => ({ ok: true, value: { provider: "p", id: "m" } }),
		});
		capabilities.dispatch({
			type: "setModel",
			payload: { provider: "p", modelId: "m", clientId: "c1", requestId: "r3" },
		});
		await flush();
		expect(broadcast.filter((frame) => frame?.type === "meta.update")).toHaveLength(0);
	});
});

function makeHost({ pi: piOverrides = {}, current = () => ({ provider: "p", id: "old" }), session } = {}) {
	const ctx = {
		...(session ? { session } : {}),
		models: {
			list: () => [
				{ provider: "p", id: "old" },
				{ provider: "p", id: "alias" },
			],
			current,
			resolve: (spec) => (spec === "p/alias" ? { provider: "p", id: "alias" } : undefined),
		},
	};
	const pi = {
		setModel: async () => true,
		...piOverrides,
	};
	const tickets = createHostTickets({ adapter: {}, pi, ctx, diagnostics: { record() {} } });
	return { tickets, ctx, pi };
}

describe("setModelTicket reports what the host holds", () => {
	test("reads the current model after the await", async () => {
		let current = { provider: "p", id: "old" };
		const { tickets } = makeHost({
			current: () => current,
			pi: {
				setModel: async () => {
					// The host canonicalises the alias; the requested name is not
					// what the session ends up running.
					current = { provider: "p", id: "canonical" };
					return true;
				},
			},
		});
		const result = await tickets.setModelTicket({ provider: "p", modelId: "alias" });
		expect(result.ok).toBe(true);
		expect(result.reported?.model).toEqual({ provider: "p", id: "canonical" });
	});

	test("reports the thinking levels the new model actually supports", async () => {
		let levels = ["off", "auto", "low", "high"];
		const { tickets } = makeHost({
			session: { getAvailableEffortSelectors: () => levels },
			pi: {
				setModel: async () => {
					levels = ["off", "auto", "low", "xhigh"];
					return true;
				},
			},
		});
		const result = await tickets.setModelTicket({ provider: "p", modelId: "alias" });
		expect(result.ok).toBe(true);
		expect(result.thinkingLevels).toEqual(["off", "auto", "low", "xhigh"]);
	});

	test("a model without reasoning reports an empty level list", async () => {
		const { tickets } = makeHost({
			session: { getAvailableEffortSelectors: () => [] },
		});
		const result = await tickets.setModelTicket({ provider: "p", modelId: "alias" });
		expect(result.ok).toBe(true);
		expect(result.thinkingLevels).toEqual([]);
	});

	test("unknown ids are rejected before the host is touched", async () => {
		let calls = 0;
		const { tickets } = makeHost({
			pi: {
				setModel: async () => {
					calls++;
					return true;
				},
			},
		});
		const result = await tickets.setModelTicket({ provider: "p", modelId: "missing" });
		expect(result).toMatchObject({ ok: false, code: "unknown_model" });
		expect(calls).toBe(0);
	});

	test("a host refusal is a model_rejected result", async () => {
		const { tickets } = makeHost({ pi: { setModel: async () => false } });
		const result = await tickets.setModelTicket({ provider: "p", modelId: "alias" });
		expect(result).toMatchObject({ ok: false, code: "model_rejected" });
	});
});
