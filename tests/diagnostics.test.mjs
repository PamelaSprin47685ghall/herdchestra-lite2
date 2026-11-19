import { describe, expect, test } from "bun:test";
import { createDiagnostics } from "../src/host/diagnostics.mjs";

describe("diagnostics ring", () => {
	test("keeps the newest records when it overflows", () => {
		const ring = createDiagnostics(4);
		for (let index = 1; index <= 10; index += 1) {
			ring.record("usage", new Error(`failure-${index}`));
		}
		expect(ring.total()).toBe(10);
		expect(ring.snapshot().map((entry) => entry.message)).toEqual([
			"failure-7",
			"failure-8",
			"failure-9",
			"failure-10",
		]);
	});

	test("returns records oldest first", () => {
		const ring = createDiagnostics(8);
		ring.record("a", "first");
		ring.record("b", "second");
		ring.record("c", "third");
		expect(ring.snapshot().map((entry) => entry.domain)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("renders a non-error value as text", () => {
		const ring = createDiagnostics();
		ring.record("toleration", undefined);
		ring.record("value", 42);
		expect(ring.snapshot().map((entry) => entry.message)).toEqual(["", "42"]);
	});

	test("keeps an optional detail only when given", () => {
		const ring = createDiagnostics();
		ring.record("context", new Error("bad"), { stage: "apply" });
		ring.record("context", new Error("worse"));
		const [withDetail, withoutDetail] = ring.snapshot();
		expect(withDetail.detail).toEqual({ stage: "apply" });
		expect("detail" in withoutDetail).toBe(false);
	});

	test("reset empties the ring and the count", () => {
		const ring = createDiagnostics(2);
		ring.record("a", "one");
		ring.record("b", "two");
		ring.reset();
		expect(ring.total()).toBe(0);
		expect(ring.snapshot()).toEqual([]);
		ring.record("c", "three");
		expect(ring.snapshot().map((entry) => entry.message)).toEqual(["three"]);
	});

	test("a partial ring reads back in order after wrap", () => {
		const ring = createDiagnostics(3);
		ring.record("a", "one");
		ring.record("b", "two");
		ring.record("c", "three");
		ring.record("d", "four");
		ring.record("e", "five");
		expect(ring.snapshot().map((entry) => entry.message)).toEqual([
			"three",
			"four",
			"five",
		]);
		expect(ring.limit).toBe(3);
	});

	test("coalesces an immediately repeated failure instead of spending a slot", () => {
		const ring = createDiagnostics(2);
		ring.record("status", new Error("render failed"));
		ring.record("status", new Error("render failed"));
		ring.record("status", new Error("render failed"));
		expect(ring.total()).toBe(1);
		expect(ring.snapshot()).toHaveLength(1);
		expect(ring.snapshot()[0].count).toBe(3);
		// The earlier distinct failure keeps its place after the repeat.
		ring.record("usage", new Error("baseline lost"));
		expect(ring.snapshot().map((entry) => entry.domain)).toEqual([
			"status",
			"usage",
		]);
	});

	test("counts a repeat that follows another record as a new entry", () => {
		const ring = createDiagnostics();
		const first = ring.record("a", "boom");
		ring.record("b", "other");
		const third = ring.record("a", "boom");
		expect(ring.total()).toBe(3);
		expect(first.count).toBe(1);
		expect(third.count).toBe(1);
	});
});
