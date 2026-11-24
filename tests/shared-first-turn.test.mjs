import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { loadSharedFirstTurn } from "../host-omp/src/host/shared-first-turn.mjs";
import { prependFirstTurn } from "../src/station/domain/context.mjs";

const DATA = new URL("../resources/first-turn.json", import.meta.url);

describe("shared first turn", () => {
	test("loads the recorded round verbatim, tool call and result included", () => {
		const head = loadSharedFirstTurn();

		expect(head).toHaveLength(3);
		expect(head.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
		expect(head[0].content.map((part) => part.type)).toEqual(["text"]);
		expect(head[1].content.map((part) => part.type)).toEqual(["toolCall"]);
		expect(head[2].content.map((part) => part.type)).toEqual(["text"]);
		expect(head[1].content[0]).toMatchObject({
			id: "chatcmpl-tool-b1498fbcafbb9475",
			name: "bash",
		});
		expect(head[2].toolCallId).toBe("chatcmpl-tool-b1498fbcafbb9475");
	});

	test("keeps every part of the recorded round verbatim", () => {
		const recorded = JSON.parse(readFileSync(DATA, "utf8"));
		const head = loadSharedFirstTurn();

		expect(JSON.parse(JSON.stringify(head))).toEqual(recorded);
	});

	test("prepends all three messages, tool call and result included", () => {
		const head = loadSharedFirstTurn();
		const user = { role: "user", content: "hello", timestamp: 2 };
		const messages = prependFirstTurn([user], head);

		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect(messages[1].content.map((part) => part.type)).toEqual(["toolCall"]);
		expect(messages[2].toolCallId).toBe(head[2].toolCallId);
		expect(messages[3]).toBe(user);
	});

	test("replays the call as finished history, not a stream in flight", () => {
		const head = loadSharedFirstTurn();
		const assistant = prependFirstTurn([], head)[1];

		// A capture records partialArgs/streamIndex while the call arrives. A
		// replayed round must not: the host would leave the call unfinished and
		// the toolResult would have no call to answer.
		expect(JSON.stringify(head)).not.toContain("partialArgs");
		expect(JSON.stringify(head)).not.toContain("streamIndex");
		expect(assistant.stopReason).toBe("toolUse");
		expect(head[1].content[0].arguments).toEqual({ command: "pwd" });
	});

	test("carries no stale model choice", () => {
		const text = JSON.stringify(loadSharedFirstTurn());

		expect(text).not.toContain("倍价格");
		expect(text).not.toContain("IQ: ");
	});

	test("caches the parsed head", () => {
		expect(loadSharedFirstTurn()).toBe(loadSharedFirstTurn());
	});
});
