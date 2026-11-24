import { describe, expect, test } from "bun:test";
import { onContext } from "../../src/station/gates.mjs";

const OPENING = "shared opening";

function firstTurn() {
	return [{ role: "user", content: [{ type: "text", text: OPENING }] }];
}

function stubStation(transform) {
	const notes = [];
	return {
		notes,
		policy: () => "interactive",
		transformContext: transform,
		noteError: (domain, error) => notes.push({ domain, error }),
	};
}

function openings(messages) {
	return messages.filter((message) =>
		Array.isArray(message?.content) &&
		message.content.some((part) => part?.text === OPENING),
	).length;
}

describe("context hook opening fallback", () => {
	test("injects the opening when the projection throws", () => {
		const station = stubStation(() => {
			throw new Error("projection failed");
		});
		const result = onContext(station, [], {}, firstTurn());

		expect(openings(result.messages)).toBe(1);
		expect(station.notes).toHaveLength(1);
		expect(station.notes[0].domain).toBe("context");
		expect(station.notes[0].error.message).toBe("projection failed");
	});

	test("injects the opening when the projection returns the original list", () => {
		const station = stubStation((original) => ({ messages: original }));
		const result = onContext(station, [{ role: "user", content: [] }], {}, firstTurn());

		expect(openings(result.messages)).toBe(1);
	});

	test("does not re-inject when an amendment shortens the list but keeps the opening", () => {
		const amended = { role: "user", content: [{ type: "text", text: "amended" }] };
		const station = stubStation(() => ({ messages: [...firstTurn(), amended] }));
		const result = onContext(station, [{ role: "user", content: [] }, { role: "user", content: [] }], {}, firstTurn());

		expect(openings(result.messages)).toBe(1);
		expect(result.messages).toHaveLength(2);
	});

	test("does not duplicate an opening the projection already contains", () => {
		const station = stubStation((original) => ({
			messages: [...firstTurn(), ...original],
		}));
		const result = onContext(station, [{ role: "user", content: [] }], {}, firstTurn());

		expect(openings(result.messages)).toBe(1);
	});
});
