import { describe, expect, test } from "bun:test";

import { createEventMux } from "../src/host/event-mux.mjs";

const message = (type, text, extra = {}) => ({
	type,
	message: { role: "assistant", content: [{ type: "text", text }], ...extra },
	...(type === "message_update" ? { assistantMessageEvent: { type: "text_delta", delta: text } } : {}),
});
const tool = (type, toolCallId, value) => ({ type, toolCallId, toolName: "read", args: {}, ...value });

describe("event mux", () => {
	test("one flow forwards each original event immediately and unchanged", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const events = [
			{ type: "turn_start" }, message("message_start", ""),
			message("message_update", "a"), message("message_update", "ab"),
			message("message_end", "ab"), tool("tool_execution_start", "1"),
			tool("tool_execution_update", "1", { partialResult: "a" }),
			tool("tool_execution_update", "1", { partialResult: "ab" }),
			tool("tool_execution_end", "1", { result: "ab" }), { type: "turn_end" },
		];
		for (const [index, event] of events.entries()) {
			mux.accept("a", event);
			expect(output.length).toBe(index + 1);
			expect(output[index]).toBe(event);
		}
	});

	test("buffers competing messages and replays their latest cumulative update", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const a = [message("message_start", "a"), message("message_update", "aa"), message("message_end", "aaa")];
		const b = [message("message_start", "b"), message("message_update", "bb"), message("message_update", "bbb"), message("message_end", "bbbb")];
		mux.accept("a", a[0]);
		for (const event of b) mux.accept("b", event);
		mux.accept("a", a[1]);
		expect(output).toEqual(a.slice(0, 2));
		mux.accept("a", a[2]);
		expect(output).toEqual([...a, b[0], b[2], b[3]]);
	});

	test("hands the lease to an unfinished waiter and keeps tools between messages", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const aStart = message("message_start", "a");
		const aEnd = message("message_end", "a");
		const bStart = message("message_start", "b");
		const bUpdate = message("message_update", "bb");
		const bEnd = message("message_end", "bbb");
		const start = tool("tool_execution_start", "t");
		const update = tool("tool_execution_update", "t", { partialResult: "partial" });
		const end = tool("tool_execution_end", "t", { result: "done" });
		mux.accept("a", aStart);
		mux.accept("b", bStart);
		mux.accept("b", bUpdate);
		mux.accept("a", start);
		mux.accept("a", update);
		mux.accept("a", end);
		mux.accept("a", aEnd);
		expect(output).toEqual([aStart, aEnd, bStart, bUpdate]);
		mux.accept("b", bEnd);
		expect(output).toEqual([aStart, aEnd, bStart, bUpdate, bEnd, start, end]);
	});

	test("shows each broadcast once, including when its first copy is buffered", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const open = message("message_start", "busy");
		const close = message("message_end", "busy");
		const data = { role: "user", details: { fissionBroadcast: { broadcastId: "broadcast-1", recipients: 2 } } };
		const first = [message("message_start", "hello", data), message("message_end", "hello", data)];
		const second = [message("message_start", "hello", data), message("message_end", "hello", data)];
		mux.accept("a", open);
		for (const event of first) mux.accept("b", event);
		for (const event of second) mux.accept("c", event);
		mux.accept("a", close);
		expect(output).toEqual([open, close, ...first]);
	});

	test("cancellation closes and replays a buffered message with the supplied end", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const start = message("message_start", "a");
		const end = message("message_end", "a");
		const waiting = message("message_start", "b");
		const aborted = message("message_end", "partial", { stopReason: "aborted" });
		mux.accept("a", start);
		mux.accept("b", waiting);
		mux.cancel("b", aborted);
		mux.accept("a", end);
		expect(output).toEqual([start, end, waiting, aborted]);
	});

	test("tool completion only removes updates from the matching execution", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const open = message("message_start", "busy");
		const close = message("message_end", "busy");
		const firstStart = tool("tool_execution_start", "reused");
		const firstUpdate = tool("tool_execution_update", "reused", { partialResult: "first" });
		const secondStart = tool("tool_execution_start", "reused");
		const secondUpdate = tool("tool_execution_update", "reused", { partialResult: "second" });
		const secondEnd = tool("tool_execution_end", "reused", { result: "done" });
		mux.accept("a", open);
		for (const event of [firstStart, firstUpdate, secondStart, secondUpdate, secondEnd]) mux.accept("b", event);
		mux.accept("a", close);
		expect(output).toEqual([open, close, firstStart, firstUpdate, secondStart, secondEnd]);
	});

	test("discards a cancelled copy's own terminal events instead of throwing", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const start = message("message_start", "a");
		const aborted = message("message_end", "partial", { stopReason: "aborted" });
		mux.accept("a", start);
		mux.cancel("a", aborted);
		// The source stays subscribed, so the same copy can still deliver its
		// real end or a late update after the supplied terminal event.
		expect(() => mux.accept("a", message("message_end", "a"))).not.toThrow();
		expect(() => mux.accept("a", message("message_update", "late"))).not.toThrow();
		expect(output).toEqual([start, aborted]);
	});

	test("a cancelled flow can open a new message", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const first = message("message_start", "a");
		const aborted = message("message_end", "partial", { stopReason: "aborted" });
		mux.accept("a", first);
		mux.cancel("a", aborted);
		const second = message("message_start", "b");
		const secondEnd = message("message_end", "b");
		mux.accept("a", second);
		mux.accept("a", secondEnd);
		expect(output).toEqual([first, aborted, second, secondEnd]);
	});

	test("cancelling a duplicate broadcast copy loses no display", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		// The host carries the id under message.details; the third argument is
		// spread into the message itself.
		const broadcast = { details: { fissionBroadcast: { broadcastId: "broadcast-1" } } };
		const first = [message("message_start", "hello", broadcast), message("message_end", "hello", broadcast)];
		const duplicate = [message("message_start", "hello", broadcast), message("message_end", "hello", broadcast)];
		const aborted = message("message_end", "hello", { ...broadcast, stopReason: "aborted" });
		for (const event of first) mux.accept("a", event);
		mux.accept("b", duplicate[0]);
		mux.cancel("b", aborted);
		expect(() => mux.accept("b", duplicate[1])).not.toThrow();
		expect(output).toEqual(first);
	});

	test("dropping a dead lease holder closes its window and frees the queue", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const aStart = message("message_start", "a");
		const aUpdate = message("message_update", "aa");
		const b = [
			message("message_start", "b"),
			message("message_update", "bb"),
			message("message_end", "bbb"),
		];
		mux.accept("a", aStart);
		mux.accept("a", aUpdate);
		for (const event of b) mux.accept("b", event);

		mux.drop("a");

		// The window closes on the last snapshot the source itself sent.
		expect(output).toEqual([
			aStart,
			aUpdate,
			{ type: "message_end", message: { ...aUpdate.message, stopReason: "aborted" } },
			...b,
		]);
		// The dead source may still deliver its own terminal events.
		expect(() => mux.accept("a", message("message_end", "late"))).not.toThrow();
		expect(() => mux.accept("a", message("message_update", "later"))).not.toThrow();
		expect(output).toHaveLength(6);
	});

	test("dropping a buffered unfinished copy leaves the FIFO free", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const open = message("message_start", "a");
		const close = message("message_end", "a");
		mux.accept("a", open);
		mux.accept("b", message("message_start", "b"));
		mux.accept("b", message("message_update", "bb"));

		mux.drop("b");

		const c = [
			message("message_start", "c"),
			message("message_update", "cc"),
			message("message_end", "ccc"),
		];
		for (const event of c) mux.accept("c", event);
		mux.accept("a", close);
		expect(output).toEqual([open, close, ...c]);
	});

	test("a flow that already ended while buffered still displays after detach", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const open = message("message_start", "a");
		const close = message("message_end", "a");
		const b = [
			message("message_start", "b"),
			message("message_update", "bb"),
			message("message_end", "bbb"),
		];
		mux.accept("a", open);
		for (const event of b) mux.accept("b", event);

		mux.drop("b");

		mux.accept("a", close);
		expect(output).toEqual([open, close, ...b]);
	});

	test("a dropped broadcast copy does not consume its id", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const broadcast = { details: { fissionBroadcast: { broadcastId: "broadcast-1", recipients: 2 } } };
		const open = message("message_start", "busy");
		const close = message("message_end", "busy");
		const firstStart = message("message_start", "hello", broadcast);
		const second = [
			message("message_start", "hello", broadcast),
			message("message_end", "hello", broadcast),
		];
		mux.accept("a", open);
		mux.accept("b", firstStart);

		mux.drop("b");

		for (const event of second) mux.accept("c", event);
		mux.accept("a", close);
		// b never reached the screen, so c's copy is the first rendered one.
		expect(output).toEqual([open, close, ...second]);
	});

	test("a displayed broadcast stays deduped after its flow is dropped", () => {
		const output = [];
		const mux = createEventMux((event) => output.push(event));
		const broadcast = { details: { fissionBroadcast: { broadcastId: "broadcast-1", recipients: 2 } } };
		const first = [
			message("message_start", "hello", broadcast),
			message("message_end", "hello", broadcast),
		];
		for (const event of first) mux.accept("a", event);
		mux.drop("a");

		const duplicate = [
			message("message_start", "hello", broadcast),
			message("message_end", "hello", broadcast),
		];
		for (const event of duplicate) mux.accept("b", event);
		// A skipped copy must not take the lease from later real work.
		const later = message("message_start", "next");
		mux.accept("b", later);
		expect(output).toEqual([...first, later]);
	});
});
