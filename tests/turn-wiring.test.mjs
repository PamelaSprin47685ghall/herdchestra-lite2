// Wiring around the two turn totals.
//
// These cases fail on the defects time-verify named: a user message or a late
// copy of an already counted assistant message closing the next request, a
// child station writing a different ledger than the one fork reads, and a
// failed window surviving into the next agent turn.

import { describe, expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";

import { wireHooks } from "../host-omp/src/activation/hooks.mjs";
import {
	adoptLedger,
	createForkRegistry,
	ledgerFor,
} from "../src/scope/fork-registry.mjs";
import { selectForkLedger } from "../src/station/domain/fork-ledger.mjs";
import { createBracketLedger } from "../src/scope/ledger-brackets.mjs";
import { restoreLedger, serializeLedger } from "../src/scope/ledger-serialize.mjs";
import { serializeState } from "../src/scope/state-codec.mjs";
import { createState } from "../src/scope/state.mjs";
import { SessionStation } from "../src/station/station.mjs";

function station() {
	const built = createTestStation(SessionStation, { getSessionId: () => "s" }, {}, {}, null, null);
	built.brackets = createBracketLedger();
	built.state.brackets = built.brackets;
	return built;
}

function assistant(id) {
	return { role: "assistant", id, content: [{ type: "text", text: id }] };
}

describe("turn totals survive a reload", () => {
	test("serialize and restore keep the two numbers", () => {
		const ledger = createBracketLedger();
		ledger.totals.turnMs = 40_000;
		ledger.totals.turns = 2;
		const restored = restoreLedger(serializeLedger(ledger));
		expect(restored.totals).toEqual({ turnMs: 40_000, turns: 2 });
		expect(restored.totals).not.toBe(ledger.totals);
	});

	test("a snapshot without totals restores as zero", () => {
		const ledger = createBracketLedger();
		const payload = serializeLedger(ledger);
		delete payload.totals;
		const restored = restoreLedger(payload);
		expect(restored.totals).toEqual({ turnMs: 0, turns: 0 });
	});
});

describe("a reload with no open forks keeps the turn totals", () => {
	function reloadStation(totals) {
		const state = createState();
		state.brackets.totals = { ...totals };
		const data = serializeState(state);
		const manager = {
			getSessionId: () => "reload-totals",
			getBranch: () => [
				{ type: "custom", customType: "scope.state", id: "e1", data },
			],
		};
		const registry = createForkRegistry();
		const built = createTestStation(SessionStation, 
			manager,
			{},
			{},
			{
				forkWiring: () => ({ registry }),
				host: () => ({
					session: { conversationKey: () => "reload-key" },
					fork: {
						ledgerFor: (forkRegistry, key) => ledgerFor(forkRegistry, key),
						adoptLedger: (forkRegistry, key, ledger) =>
							adoptLedger(forkRegistry, key, ledger),
					},
				}),
				implementations: () => ({}),
			},
			null,
		);
		return { built, registry };
	}

	test("an empty index does not erase restored totals", () => {
		const { built, registry } = reloadStation({ turnMs: 40_000, turns: 2 });
		expect(built.brackets.totals).toEqual({ turnMs: 40_000, turns: 2 });
		expect(built.state.brackets).toBe(built.brackets);
		expect(ledgerFor(registry, "reload-key").totals).toEqual({
			turnMs: 40_000,
			turns: 2,
		});
	});

	test("the resolver fills an empty tree from a totals-only index", () => {
		const indexed = createBracketLedger();
		indexed.totals = { turnMs: 30_000, turns: 1 };
		const restored = createBracketLedger();
		restored.order.push("f");
		const chosen = selectForkLedger({ indexed, restored }).ledger;
		expect(chosen).toBe(restored);
		expect(chosen.totals).toEqual({ turnMs: 30_000, turns: 1 });
	});

	test("samples already on the chosen ledger are not zeroed", () => {
		const indexed = createBracketLedger();
		indexed.order.push("f");
		indexed.totals = { turnMs: 10_000, turns: 1 };
		const restored = createBracketLedger();
		const chosen = selectForkLedger({ indexed, restored }).ledger;
		expect(chosen).toBe(indexed);
		expect(chosen.totals).toEqual({ turnMs: 10_000, turns: 1 });
	});

	test("two sampled ledgers are neither summed nor overwritten", () => {
		const indexed = createBracketLedger();
		indexed.order.push("f");
		indexed.totals = { turnMs: 10_000, turns: 1 };
		const restored = createBracketLedger();
		restored.order.push("g");
		restored.totals = { turnMs: 20_000, turns: 2 };
		const chosen = selectForkLedger({ indexed, restored }).ledger;
		expect(chosen).toBe(indexed);
		expect(chosen.totals).toEqual({ turnMs: 10_000, turns: 1 });
		expect(restored.totals).toEqual({ turnMs: 20_000, turns: 2 });
	});
});

describe("one assistant message closes one open request", () => {
	test("a second delivery of the same message does not close the next request", () => {
		const s = station();
		const first = assistant("a");
		s.beginRequestSample(1_000);
		expect(s.finishRequestSample(1_100, first)).toBe(100);
		s.beginRequestSample(2_000);
		expect(s.onUsageMessage(first, {})).toBe(undefined);
		expect(s.brackets.totals).toEqual({ turnMs: 100, turns: 1 });
		expect(s.turnClock.startedAt).toBe(2_000);
		const second = assistant("b");
		expect(s.finishRequestSample(2_050, second)).toBe(50);
		expect(s.brackets.totals).toEqual({ turnMs: 150, turns: 2 });
	});

	test("a user message does not close an open request", () => {
		const s = station();
		s.beginRequestSample(1_000);
		s.onUsageMessage({ role: "user", content: "interrupt" }, {});
		expect(s.brackets.totals).toEqual({ turnMs: 0, turns: 0 });
		expect(s.turnClock.startedAt).toBe(1_000);
		expect(s.finishRequestSample(1_040, assistant("a"))).toBe(40);
	});

	test("a zero-usage assistant message still counts", () => {
		const s = station();
		s.beginRequestSample(1_000);
		const message = assistant("bare");
		s.finishRequestSample(1_025, message);
		expect(s.brackets.totals).toEqual({ turnMs: 25, turns: 1 });
	});
});

describe("an unfinished request is dropped, not folded into the next one", () => {
	test("session_stop clears the window and does not add a turn", () => {
		const s = station();
		s.beginRequestSample(1_000);
		s.onSessionStop({}, { signal: { aborted: true }, reason: "aborted" });
		expect(s.turnClock.startedAt).toBe(null);
		expect(s.brackets.totals).toEqual({ turnMs: 0, turns: 0 });
		expect(s.finishRequestSample(9_000, assistant("late"))).toBe(null);
	});

	test("the next agent turn drops a failed window before its own request", () => {
		const s = station();
		s.beginRequestSample(1_000);
		s.onBeforeAgentStart({ systemPrompt: "" }, {});
		expect(s.turnClock.startedAt).toBe(null);
		s.beginRequestSample(5_000);
		expect(s.finishRequestSample(5_010, assistant("next"))).toBe(10);
		expect(s.brackets.totals).toEqual({ turnMs: 10, turns: 1 });
	});
});

describe("concurrent scopes write one totals object", () => {
	test("bindForkPorts makes the child station count into the parent ledger", () => {
		const parent = station();
		const child = station();
		const shared = parent.brackets;
		child.brackets = createBracketLedger();
		child.bindForkPorts({ ledger: shared });
		expect(child.brackets).toBe(shared);
		expect(child.state.brackets).toBe(shared);
		parent.beginRequestSample(0);
		parent.finishRequestSample(30, assistant("root"));
		child.beginRequestSample(0);
		child.finishRequestSample(70, assistant("child"));
		expect(shared.totals).toEqual({ turnMs: 100, turns: 2 });
	});
});

describe("message_end does not treat a user message as a turn", () => {
	test("the dedicated listener ignores a non-assistant message", () => {
		const seen = [];
		const pi = {
			on(event, handler) {
				this[event] = handler;
			},
		};
		wireHooks(pi, {
			station: () => ({
				onUsageMessage: (message) => seen.push(message.role),
				noteScopeRequest() {},
				beginRequestSample() {},
				onAssistantMessage() {},
				onToolCall() {},
				onContext() {},
				onBeforeAgentStart() {},
				onSessionSwitch() {},
				onSessionCompact() {},
			}),
			stationForStop: () => ({ onSessionStop() {} }),
		});
		pi.message_end({ message: { role: "user" } }, {});
		pi.message_end({ message: { role: "assistant", id: "a" } }, {});
		expect(seen).toEqual(["assistant"]);
	});
});
