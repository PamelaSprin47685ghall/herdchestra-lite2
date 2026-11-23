import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { loadSharedFirstTurn } from "../host-omp/src/host/shared-first-turn.mjs";

const DATA = new URL("../resources/first-turn.json", import.meta.url);

describe("shared first turn", () => {
	test("loads the frozen round as a question and one full answer", () => {
		const head = loadSharedFirstTurn();

		expect(head).toHaveLength(2);
		expect(head.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(head[0].content.map((part) => part.type)).toEqual(["text"]);
		expect(head[1].content.map((part) => part.type)).toEqual([
			"thinking",
			"text",
		]);
		expect(head[1].content[0].thinking.length).toBeGreaterThan(0);
		expect(head[1].content[1].text.length).toBeGreaterThan(0);
	});

	test("keeps every part of the recorded answer verbatim", () => {
		const recorded = JSON.parse(readFileSync(DATA, "utf8"));
		const head = loadSharedFirstTurn();

		expect(head[0].content).toEqual(recorded[0].content);
		expect(JSON.parse(JSON.stringify(head[1].content))).toEqual(
			recorded[1].content,
		);
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
