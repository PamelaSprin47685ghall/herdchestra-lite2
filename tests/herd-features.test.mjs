import { describe, expect, test } from "bun:test";

import {
	FEATURES,
	FEATURE_NAMES,
	META_SKILLS_SENTINEL,
	defaultFeatures,
	featureSections,
	mergeFeatures,
	normalizeFeatures,
	parseFeatureEnv,
	parseHerdCommand,
	sectionKeys,
} from "../src/features/herd/features.mjs";
import { buildPorts } from "../src/core/ports/build.mjs";
import { loadDoc } from "../src/prompts/index.mjs";

describe("the feature table", () => {
	test("has the eight features in declaration order", () => {
		expect(FEATURE_NAMES).toEqual([
			"autopilot",
			"review",
			"chinese",
			"testing",
			"constitution",
			"framing",
			"scope",
			"workspace",
		]);
		expect(Object.keys(FEATURES)).toEqual([...FEATURE_NAMES]);
	});

	test("every fallback is one of its states and the default map is current behavior", () => {
		for (const name of FEATURE_NAMES) {
			expect(FEATURES[name].states).toContain(FEATURES[name].fallback);
			expect(Object.isFrozen(FEATURES[name])).toBe(true);
			expect(Object.isFrozen(FEATURES[name].states)).toBe(true);
		}
		expect(defaultFeatures()).toEqual({
			autopilot: "off",
			review: "on",
			chinese: "on",
			testing: "lean",
			constitution: "full",
			framing: "full",
			scope: "aggressive",
			workspace: "full",
		});
	});

	test("default sections follow feature order and expand the meta-skill sentinel", () => {
		expect(featureSections(defaultFeatures())).toEqual([
			"chinese.on",
			"testing.no-red",
			"testing.lean",
			"constitution.core",
			"constitution.full",
			"framing.plan",
			"framing.full",
			"scope.aggressive",
			"workspace.personal",
			META_SKILLS_SENTINEL,
		]);
		expect(featureSections({ ...defaultFeatures(), workspace: "personal" })).not.toContain(
			META_SKILLS_SENTINEL,
		);
	});

	test("normalizeFeatures falls back per key and lowercases valid states", () => {
		expect(normalizeFeatures({ testing: "NO-RED", scope: "bogus" })).toMatchObject({
			testing: "no-red",
			scope: "aggressive",
			workspace: "full",
		});
	});
});

describe("startup wiring", () => {
	test("buildPorts exposes the parsed feature values and explicit subset", () => {
		const built = buildPorts({ HERD_TESTING: "no-red", HERD_WORKSPACE: "off" });
		expect(built.ok).toBe(true);
		expect(built.features.values.testing).toBe("no-red");
		expect(built.features.values.workspace).toBe("off");
		expect(built.features.values.constitution).toBe("full");
		expect(built.features.explicit).toEqual({ testing: "no-red", workspace: "off" });
	});

	test("buildPorts refuses an invalid feature value before a station exists", () => {
		const built = buildPorts({ HERD_TESTING: "maybe" });
		expect(built.ok).toBe(false);
		expect(built.code).toBe("INVALID_FEATURE_STATE");
		expect(built.feature).toBe("testing");
		expect(built.detail).toContain("feature=testing");
	});
});

describe("features.md is the only section source", () => {
	const doc = loadDoc("features");

	test("every table section exists, is non-empty, and no extra section is shipped", () => {
		expect(Object.keys(doc).sort()).toEqual(sectionKeys().sort());
		for (const key of sectionKeys()) {
			expect(doc[key].trim().length).toBeGreaterThan(0);
		}
		expect(doc["workspace.full"]).toBeUndefined();
	});
});

describe("environment parsing", () => {
	test("nothing set returns the defaults and marks nothing explicit", () => {
		const parsed = parseFeatureEnv({});
		expect(parsed.ok).toBe(true);
		expect(parsed.values).toEqual(defaultFeatures());
		expect(parsed.explicit).toEqual({});
	});

	test("canonical names, legacy Chinese names, and generic disable flags all resolve", () => {
		expect(parseFeatureEnv({ HERD_TESTING: "no-red" }).explicit).toEqual({ testing: "no-red" });
		expect(parseFeatureEnv({ HERD_CHINESE_REMINDER: "off" }).explicit).toEqual({ chinese: "off" });
		expect(parseFeatureEnv({ HERD_DISABLE_CHINESE_REMINDER: "1" }).explicit).toEqual({
			chinese: "off",
		});
		expect(parseFeatureEnv({ HERD_DISABLE_TESTING: "1" }).explicit).toEqual({ testing: "off" });
	});

	test("the canonical name wins over the legacy alias", () => {
		const parsed = parseFeatureEnv({ HERD_CHINESE: "on", HERD_CHINESE_REMINDER: "off" });
		expect(parsed.explicit).toEqual({ chinese: "on" });
	});

	test("an invalid value is refused with the accepted states", () => {
		const parsed = parseFeatureEnv({ HERD_TESTING: "maybe" });
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("INVALID_FEATURE_STATE");
		expect(parsed.feature).toBe("testing");
		expect(parsed.wanted).toBe("maybe");
		expect(parsed.available).toEqual(["off", "no-red", "lean"]);
	});

	test("an unrelated HERD_* variable is ignored", () => {
		const parsed = parseFeatureEnv({ HERD_SOMETHING_ELSE: "x" });
		expect(parsed.ok).toBe(true);
		expect(parsed.explicit).toEqual({});
	});
});

describe("merge precedence", () => {
	test("explicit valid values beat persisted values, invalid explicit values are ignored", () => {
		const merged = mergeFeatures(
			{ autopilot: "on", testing: "off", scope: "adaptive" },
			{ testing: "lean", constitution: "nope" },
		);
		expect(merged.autopilot).toBe("on");
		expect(merged.testing).toBe("lean");
		expect(merged.scope).toBe("adaptive");
		expect(merged.constitution).toBe("full");
	});
});

describe("the /herd command parser", () => {
	test("lists every feature in table order", () => {
		const parsed = parseHerdCommand("", defaultFeatures());
		expect(parsed.kind).toBe("list");
		for (const name of FEATURE_NAMES) expect(parsed.message).toContain(`${name}=`);
	});

	test("shows one feature with its accepted states", () => {
		const parsed = parseHerdCommand("testing", defaultFeatures());
		expect(parsed).toMatchObject({
			kind: "show",
			feature: "testing",
			state: "lean",
			states: ["off", "no-red", "lean"],
		});
	});

	test("sets a state and keeps trailing text for the user message", () => {
		const parsed = parseHerdCommand("testing no-red fix it", defaultFeatures());
		expect(parsed).toMatchObject({
			kind: "set",
			feature: "testing",
			state: "no-red",
			previous: "lean",
			text: "fix it",
		});
		expect(parseHerdCommand("testing LEAN", defaultFeatures()).state).toBe("lean");
	});

	test("refuses an unknown feature or an invalid state with what is available", () => {
		const unknown = parseHerdCommand("bogus", defaultFeatures());
		expect(unknown.kind).toBe("refuse");
		expect(unknown.code).toBe("UNKNOWN_FEATURE");
		expect(unknown.available).toEqual([...FEATURE_NAMES]);

		const bad = parseHerdCommand("testing bogus", defaultFeatures());
		expect(bad.kind).toBe("refuse");
		expect(bad.code).toBe("INVALID_FEATURE_STATE");
		expect(bad.available).toEqual(["off", "no-red", "lean"]);
	});
});
