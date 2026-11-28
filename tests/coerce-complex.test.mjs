import { describe, expect, test } from "bun:test";

import { coerceComplex } from "../src/core/primitives.mjs";

describe("coerceComplex", () => {
	test("returns live objects and arrays unchanged", () => {
		const object = { a: 1 };
		const array = [1, 2];
		expect(coerceComplex(object)).toBe(object);
		expect(coerceComplex(array)).toBe(array);
	});

	test("decodes a JSON-string object and array", () => {
		expect(coerceComplex('{"a":1}')).toEqual({ a: 1 });
		expect(coerceComplex(" [1,2] ")).toEqual([1, 2]);
	});

	test("keeps JSON primitives and malformed or bare strings", () => {
		for (const value of ["1", "true", "null", '"x"', "{", "not json", ""]) {
			expect(coerceComplex(value)).toBe(value);
		}
	});

	test("does not recurse into a live payload", () => {
		const inputs = { body: '{"x":1}' };
		expect(coerceComplex(inputs)).toBe(inputs);
		expect(inputs.body).toBe('{"x":1}');
	});
});
