import { describe, expect, test } from "bun:test";
import { SessionStation } from "../src/station/station.mjs";
import { messageChars, prefixChars, sliceChars } from "../src/transcript/index.mjs";

// `contextMessages` reads only `manager` and `contextCache`, so a prototype
// object exercises the cache without building a full station bundle.
function stationWith(manager) {
	const station = Object.create(SessionStation.prototype);
	station.manager = manager;
	station.contextCache = null;
	return station;
}

function managerWith(branches) {
	const calls = [];
	let leafId = null;
	return {
		calls,
		setLeaf(next) {
			leafId = next;
		},
		getLeafId() {
			return leafId;
		},
		buildSessionContext() {
			calls.push(leafId);
			return { messages: branches[leafId] ?? [] };
		},
	};
}

describe("contextMessages branch projection cache", () => {
	test("one projection per leaf, however many reads", () => {
		const manager = managerWith({ a: [{ role: "user", content: "hi" }] });
		manager.setLeaf("a");
		const station = stationWith(manager);

		const first = station.contextMessages();
		const second = station.contextMessages();
		const third = station.contextMessages();

		expect(manager.calls).toEqual(["a"]);
		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(first.length).toBe(1);
	});

	test("a new leaf rebuilds, and never returns the stale projection", () => {
		const manager = managerWith({
			a: [{ role: "user", content: "hi" }],
			b: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
		});
		manager.setLeaf("a");
		const station = stationWith(manager);

		expect(station.contextMessages().length).toBe(1);
		manager.setLeaf("b");
		const moved = station.contextMessages();

		expect(manager.calls).toEqual(["a", "b"]);
		expect(moved.length).toBe(2);
		// A later read of the same leaf stays on the new projection.
		expect(station.contextMessages()).toBe(moved);
	});

	test("a rebuild that returns to a previously seen leaf id still rebuilds", () => {
		// Branch mutations produce fresh entry ids, so a leaf id that
		// reappears means the branch genuinely returned to that shape.
		const manager = managerWith({ a: [{ role: "user", content: "one" }] });
		manager.setLeaf("a");
		const station = stationWith(manager);
		const before = station.contextMessages();

		manager.setLeaf("b");
		station.contextMessages();
		manager.setLeaf("a");
		const after = station.contextMessages();

		expect(manager.calls).toEqual(["a", "b", "a"]);
		expect(after.length).toBe(before.length);
	});

	test("a manager without a leaf id keeps the uncached behavior", () => {
		const reads = [];
		const station = stationWith({
			buildSessionContext() {
				reads.push(null);
				return { messages: [{ role: "user", content: "hi" }] };
			},
		});

		const first = station.contextMessages();
		const second = station.contextMessages();

		expect(reads.length).toBe(2);
		expect(second).not.toBe(first);
		expect(second.length).toBe(1);
	});

	test("a throwing rebuild clears the cache instead of serving it", () => {
		let fail = false;
		let reads = 0;
		let leaf = "a";
		const station = stationWith({
			getLeafId: () => leaf,
			buildSessionContext() {
				reads += 1;
				if (fail) throw new Error("host unavailable");
				return { messages: [{ role: "user", content: "hi" }] };
			},
		});

		expect(station.contextMessages().length).toBe(1);
		// A new leaf forces a rebuild; that rebuild fails.
		leaf = "b";
		fail = true;
		expect(station.contextMessages()).toEqual([]);
		expect(station.contextCache).toBeNull();
		fail = false;
		expect(station.contextMessages().length).toBe(1);
		expect(reads).toBe(3);
	});

	test("a cached projection survives a host that would now throw", () => {
		let fail = false;
		let reads = 0;
		const station = stationWith({
			getLeafId: () => "a",
			buildSessionContext() {
				reads += 1;
				if (fail) throw new Error("host unavailable");
				return { messages: [{ role: "user", content: "hi" }] };
			},
		});

		expect(station.contextMessages().length).toBe(1);
		fail = true;
		// The branch has not moved, so the cached projection is still this
		// branch's answer and the host is never asked again.
		expect(station.contextMessages().length).toBe(1);
		expect(reads).toBe(1);
	});

	test("a non-array projection reads as an empty transcript", () => {
		const station = stationWith({
			getLeafId: () => "a",
			buildSessionContext: () => ({ messages: null }),
		});
		expect(station.contextMessages()).toEqual([]);
	});
});

describe("prefixChars equals sliceChars over a prefix", () => {
	const messages = [
		{ role: "user", content: "héllo 世界" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", arguments: '{"path":"a.mjs"}' },
			],
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", arguments: { path: "b.mjs", query: "x" } }],
		},
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
	];

	test("every prefix bound follows slice semantics", () => {
		for (let end = 0; end <= messages.length; end += 1) {
			expect(prefixChars(messages, end)).toBe(sliceChars(messages.slice(0, end)));
		}
		expect(prefixChars(messages, 999)).toBe(sliceChars(messages));
		expect(prefixChars(messages, undefined)).toBe(sliceChars(messages));
		expect(prefixChars(messages, -2)).toBe(sliceChars(messages.slice(0, -2)));
		expect(prefixChars(messages, Number.NaN)).toBe(sliceChars(messages.slice(0, Number.NaN)));
		expect(prefixChars(null, 4)).toBe(0);
	});

	test("messageChars keeps the counted units the ledger bills", () => {
		expect(messageChars({ content: "abc" })).toBe(3);
		expect(messageChars({ content: [{ type: "thinking", text: "abc" }] })).toBe(3);
		expect(messageChars({ content: [{ type: "toolCall", arguments: "12345" }] })).toBe(5);
		expect(messageChars({ content: [{ type: "toolCall", arguments: { a: 1 } }] })).toBe(
			JSON.stringify({ a: 1 }).length,
		);
		expect(messageChars({ content: [{ type: "text", text: 42 }] })).toBe(2);
		expect(messageChars(null)).toBe(0);
		expect(messageChars({ content: [{ type: "text" }, null, "bare"] })).toBe(0);
	});

	test("a rewritten block is recounted, not remembered", () => {
		const message = { content: [{ type: "text", text: "ab" }] };
		expect(messageChars(message)).toBe(2);
		message.content[0].text = "abcd";
		expect(messageChars(message)).toBe(4);
	});
});
