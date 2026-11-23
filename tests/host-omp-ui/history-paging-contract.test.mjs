import { describe, test, expect } from "bun:test";

import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";
import { parseClientCommand } from "../../host-omp-ui/src/station/domain/protocol-codec.mjs";

// Red contract for long-transcript paging.
//
// The browser must not receive or render the whole transcript. A snapshot
// carries only the newest window plus `history { hasMore, oldestId }`, and
// older windows are fetched by message id. A cursor that no longer exists is
// stale: the client must re-snapshot instead of silently showing a gap.

const WINDOW = 80;

function entries(count) {
	return Array.from({ length: count }, (_, index) => ({
		type: "message",
		id: `m${index}`,
		message: {
			role: index % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `message ${index}` }],
			timestamp: index,
		},
	}));
}

function turnEntries(count) {
	return Array.from({ length: count }, (_, index) => ({
		type: "message",
		id: `m${index}`,
		message: {
			role: index % 50 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `message ${index}` }],
			timestamp: index,
			...(index % 50 === 0 ? { attribution: "user" } : {}),
		},
	}));
}

function makeTurnStation(count = 200) {
	const sent = [];
	const station = createUiBridgeStation({
		capabilities: {
			dispatch: (event) => {
				if (event.type === "sendClientFrame") sent.push(event.payload);
			},
		},
	});
	station.onSessionHydrate({ id: "s1", cwd: "/tmp" }, turnEntries(count));
	return { station, sent };
}

function makeStation(count = 200) {
	const sent = [];
	const station = createUiBridgeStation({
		capabilities: {
			dispatch: (event) => {
				if (event.type === "sendClientFrame") sent.push(event.payload);
			},
		},
	});
	station.onSessionHydrate({ id: "s1", cwd: "/tmp" }, entries(count));
	return { station, sent };
}

describe("turn-aligned paging", () => {
	test("snapshot tail window starts at a real user boundary", () => {
		const { station } = makeTurnStation(200);
		const snapshot = station.snapshot();

		expect(snapshot.messages[0].id).toBe("m100");
		expect(snapshot.messages[0].role).toBe("user");
		expect(snapshot.history.oldestId).toBe("m100");
	});

	test("historyPage starts at a real user boundary instead of cutting a turn", () => {
		const { station } = makeTurnStation(200);
		const page = station.historyPage({ before: "m120", limit: WINDOW });

		expect(page.ok).toBe(true);
		expect(page.messages[0].id).toBe("m0");
		expect(page.messages[0].role).toBe("user");
		expect(page.history.oldestId).toBe("m0");
	});
});

test("a long transcript keeps the current turn's user message in the snapshot", () => {
	const longTurn = Array.from({ length: 325 }, (_, index) => ({
		type: "message",
		id: `m${index}`,
		message: {
			role: index === 1 || index === 264 ? "user" : "assistant",
			content: [{ type: "text", text: `message ${index}` }],
			timestamp: index,
			...(index === 1 || index === 264 ? { attribution: "user" } : {}),
		},
	}));
	const station = createUiBridgeStation({
		capabilities: { dispatch: () => {} },
	});
	station.onSessionHydrate({ id: "long", cwd: "/tmp" }, longTurn);

	const snapshot = station.snapshot();
	expect(snapshot.messages[0].id).toBe("m1");
	expect(snapshot.messages.some((message) => message.id === "m264")).toBe(true);
	expect(snapshot.history).toEqual({ hasMore: true, oldestId: "m1" });

	const page = station.historyPage({ before: snapshot.history.oldestId, limit: 50 });
	expect(page.ok).toBe(true);
	expect(page.messages.map((message) => message.id)).toEqual(["m0"]);
	expect(page.history).toEqual({ hasMore: false, oldestId: "m0" });
});

describe("snapshot carries a tail window", () => {
	test("default snapshot exposes only the newest window and its cursor", () => {
		const { station } = makeStation(200);
		const snapshot = station.snapshot();

		expect(snapshot.messages).toHaveLength(WINDOW);
		expect(snapshot.messages.at(-1).id).toBe("m199");
		expect(snapshot.messages[0].id).toBe(`m${200 - WINDOW}`);
		expect(snapshot.history).toEqual({
			hasMore: true,
			oldestId: `m${200 - WINDOW}`,
		});
	});

	test("a short transcript reports no more history", () => {
		const { station } = makeStation(10);
		const snapshot = station.snapshot();

		expect(snapshot.messages).toHaveLength(10);
		expect(snapshot.history).toEqual({ hasMore: false, oldestId: "m0" });
	});

	test("a transcript up to the window size reports no more history", () => {
		for (const count of [65, 70, 80]) {
			const { station } = makeStation(count);
			const snapshot = station.snapshot();

			expect(snapshot.messages).toHaveLength(count);
			expect(snapshot.history).toEqual({ hasMore: false, oldestId: "m0" });
		}
	});

	test("display groups are generated from the same window, not the full transcript", () => {
		const { station } = makeStation(200);
		const snapshot = station.snapshot();
		const ids = new Set(
			(snapshot.displayGroups ?? []).flatMap((group) => [
				group.message?.id,
				...(group.items ?? []).map((item) => item.id),
				...(group.steps ?? []).map((step) => step.messageId),
			]).filter(Boolean),
		);

		for (const message of snapshot.messages) {
			expect(ids.has(message.id)).toBe(true);
		}
		expect(ids.has("m0")).toBe(false);
	});
});

describe("historyPage walks backwards by message id", () => {
	test("returns the page before the cursor and the next oldest id", () => {
		const { station } = makeStation(200);
		const page = station.historyPage({ before: "m120", limit: WINDOW });

		expect(page.ok).toBe(true);
		expect(page.messages).toHaveLength(WINDOW);
		expect(page.messages.at(-1).id).toBe("m119");
		expect(page.messages[0].id).toBe("m40");
		expect(page.history).toEqual({ hasMore: true, oldestId: "m40" });
	});

	test("the final page reports hasMore false", () => {
		const { station } = makeStation(200);
		const page = station.historyPage({ before: "m40", limit: WINDOW });

		expect(page.ok).toBe(true);
		expect(page.messages).toHaveLength(40);
		expect(page.messages[0].id).toBe("m0");
		expect(page.history).toEqual({ hasMore: false, oldestId: "m0" });
	});

	test("an unknown cursor is stale, not an empty page", () => {
		const { station } = makeStation(200);
		const page = station.historyPage({ before: "missing", limit: WINDOW });

		expect(page.ok).toBe(false);
		expect(page.code).toBe("stale_cursor");
	});

	test("a non-positive limit is refused instead of dumping the transcript", () => {
		const { station } = makeStation(200);
		expect(station.historyPage({ before: "m120", limit: 0 }).ok).toBe(false);
	});

	test("a missing limit falls back to a page large enough to leave the bottom", () => {
		const { station } = makeStation(200);
		const page = station.historyPage({ before: "m120" });

		expect(page.ok).toBe(true);
		expect(page.messages).toHaveLength(50);
		expect(page.messages[0].id).toBe("m70");
		expect(page.history.hasMore).toBe(true);
	});
});

describe("paging keeps the full transcript authoritative", () => {
	test("appending a live message does not drop the tail window", () => {
		const { station } = makeStation(200);
		station.onAgentEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "new" }],
				timestamp: 500,
				id: "m200",
			},
		});
		const snapshot = station.snapshot();
		expect(snapshot.messages.at(-1).id).toBe("m200");
		expect(snapshot.messages).toHaveLength(WINDOW);
		expect(station.historyPage({ before: "m120", limit: WINDOW }).messages.at(-1).id).toBe("m119");
	});
});

describe("manager.history passes the codec", () => {
	test("accepts before and keeps the cursor", () => {
		const parsed = parseClientCommand({
			type: "manager.history",
			before: "m120",
			limit: 80,
			requestId: "r1",
		});

		expect(parsed.ok).toBe(true);
		expect(parsed.type).toBe("manager.history");
		expect(parsed.payload.before).toBe("m120");
	});

	test("rejects a missing before as invalid payload", () => {
		const parsed = parseClientCommand({ type: "manager.history", limit: 80 });

		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("invalid_payload");
	});
});
