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
});
