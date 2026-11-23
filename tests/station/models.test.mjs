import { describe, expect, test } from "bun:test";
import { modelKey, modelKeyOf } from "../../src/station/models.mjs";

describe("modelKey", () => {
	test("joins a bare id with its provider", () => {
		expect(modelKey({ provider: "acme", id: "fast" })).toBe("acme/fast");
	});

	test("keeps an id that already carries its provider", () => {
		expect(modelKey({ provider: "acme", id: "acme/fast" })).toBe("acme/fast");
	});

	test("returns the id alone when there is no provider", () => {
		expect(modelKey({ id: "fast" })).toBe("fast");
	});

	test("returns null without an id", () => {
		expect(modelKey({ provider: "acme" })).toBeNull();
		expect(modelKey(null)).toBeNull();
	});
});

describe("modelKeyOf", () => {
	test("prefers an explicit key on a message", () => {
		expect(modelKeyOf({ role: "assistant", modelKey: "acme/fast" })).toBe("acme/fast");
	});

	test("joins a message model object", () => {
		expect(
			modelKeyOf({ role: "assistant", model: { provider: "acme", id: "fast" } }),
		).toBe("acme/fast");
	});

	test("joins a message model id with the message provider", () => {
		expect(modelKeyOf({ role: "assistant", provider: "acme", model: "fast" })).toBe(
			"acme/fast",
		);
	});

	test("does not double a provider already present on the message model", () => {
		expect(
			modelKeyOf({ role: "assistant", provider: "acme", model: "acme/fast" }),
		).toBe("acme/fast");
	});

	test("still accepts a model object", () => {
		expect(modelKeyOf({ provider: "acme", id: "fast" })).toBe("acme/fast");
	});

	test("returns an empty key when the message carries no model", () => {
		expect(modelKeyOf({ role: "assistant" })).toBe("");
	});
});
