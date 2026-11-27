// Feature switches: the single source of truth for /herd.
// Pure data and pure functions. No I/O.

export const META_SKILLS_SENTINEL = "@metaSkills";

function freezeFeature(definition) {
	const states = Object.freeze(definition.states.slice());
	const sections = definition.sections
		? Object.freeze(
			Object.fromEntries(
				Object.entries(definition.sections).map(([state, keys]) => [
					state,
					Object.freeze(keys.slice()),
				]),
			),
		)
		: undefined;
	return Object.freeze({
		...definition,
		states,
		...(sections ? { sections } : {}),
	});
}

export const FEATURES = Object.freeze({
	autopilot: freezeFeature({
		states: ["off", "on"],
		fallback: "off",
		runtime: true,
	}),
	review: freezeFeature({
		states: ["off", "on"],
		fallback: "on",
		runtime: true,
	}),
	chinese: freezeFeature({
		states: ["off", "on"],
		fallback: "on",
		sections: { on: ["chinese.on"] },
	}),
	testing: freezeFeature({
		states: ["off", "no-red", "lean"],
		fallback: "lean",
		sections: {
			"no-red": ["testing.no-red"],
			lean: ["testing.no-red", "testing.lean"],
		},
	}),
	constitution: freezeFeature({
		states: ["off", "core", "full"],
		fallback: "full",
		sections: {
			core: ["constitution.core"],
			full: ["constitution.core", "constitution.full"],
		},
	}),
	framing: freezeFeature({
		states: ["off", "plan", "full"],
		fallback: "full",
		sections: {
			plan: ["framing.plan"],
			full: ["framing.plan", "framing.full"],
		},
	}),
	scope: freezeFeature({
		states: ["off", "adaptive", "aggressive"],
		fallback: "aggressive",
		sections: {
			adaptive: ["scope.adaptive"],
			aggressive: ["scope.aggressive"],
		},
	}),
	workspace: freezeFeature({
		states: ["off", "personal", "full"],
		fallback: "full",
		sections: {
			personal: ["workspace.personal"],
			full: ["workspace.personal", META_SKILLS_SENTINEL],
		},
	}),
});

export const FEATURE_NAMES = Object.freeze(Object.keys(FEATURES));

export function statesOf(name) {
	const feature = FEATURES[name];
	return feature ? feature.states : null;
}

export function defaultFeatures() {
	const out = {};
	for (const name of FEATURE_NAMES) out[name] = FEATURES[name].fallback;
	return out;
}

export function normalizeFeatures(input) {
	const source = input !== null && typeof input === "object" ? input : {};
	const out = {};
	for (const name of FEATURE_NAMES) {
		const raw = Object.hasOwn(source, name) ? source[name] : undefined;
		const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
		out[name] = FEATURES[name].states.includes(value)
			? value
			: FEATURES[name].fallback;
	}
	return out;
}

export function copyFeatures(features) {
	return normalizeFeatures(features);
}

function envValue(env, key) {
	if (!env || typeof env !== "object" || !Object.hasOwn(env, key)) return undefined;
	const value = env[key];
	if (value === undefined || value === null) return undefined;
	return String(value).trim().toLowerCase();
}

function invalidState(feature, wanted) {
	const available = FEATURES[feature].states;
	return {
		ok: false,
		code: "INVALID_FEATURE_STATE",
		feature,
		wanted,
		available,
		message: "Invalid state \"" + wanted + "\" for " + feature + ". Available: " + available.join(", "),
	};
}

export function parseFeatureEnv(env = process.env) {
	const values = defaultFeatures();
	const explicit = {};
	for (const name of FEATURE_NAMES) {
		const key = name.toUpperCase();
		let wanted = envValue(env, "HERD_" + key);
		if (wanted === "") wanted = undefined;
		if (wanted === undefined) {
			const disabled = envValue(env, "HERD_DISABLE_" + key);
			if (disabled === "1" || disabled === "true") wanted = "off";
		}
		if (wanted === undefined && name === "chinese") {
			const legacy = envValue(env, "HERD_CHINESE_REMINDER");
			if (legacy !== undefined && legacy !== "") wanted = legacy;
			if (wanted === undefined) {
				const legacyDisabled = envValue(env, "HERD_DISABLE_CHINESE_REMINDER");
				if (legacyDisabled === "1" || legacyDisabled === "true") wanted = "off";
			}
		}
		if (wanted === undefined) continue;
		if (!FEATURES[name].states.includes(wanted)) return invalidState(name, wanted);
		values[name] = wanted;
		explicit[name] = wanted;
	}
	return { ok: true, values, explicit };
}

export function mergeFeatures(persisted, explicit) {
	const out = normalizeFeatures(persisted);
	if (explicit === null || typeof explicit !== "object") return out;
	for (const name of FEATURE_NAMES) {
		const raw = Object.hasOwn(explicit, name) ? explicit[name] : undefined;
		const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
		if (FEATURES[name].states.includes(value)) out[name] = value;
	}
	return out;
}

function refuseFeature(feature, available) {
	return {
		kind: "refuse",
		code: "UNKNOWN_FEATURE",
		feature,
		available,
		message: "Unknown feature \"" + feature + "\". Available: " + available.join(", "),
	};
}

function refuseState(feature, wanted, available) {
	return {
		kind: "refuse",
		code: "INVALID_FEATURE_STATE",
		feature,
		wanted,
		available,
		message: "Invalid state \"" + wanted + "\" for " + feature + ". Available: " + available.join(", "),
	};
}

export function parseHerdCommand(args = "", current = {}) {
	const words = (Array.isArray(args) ? args : String(args ?? "").split(/\s+/))
		.map((word) => String(word))
		.filter((word) => word !== "");
	const values = normalizeFeatures(current);
	if (words.length === 0) {
		return {
			kind: "list",
			message: FEATURE_NAMES.map((name) => name + "=" + values[name]).join(" "),
		};
	}
	const feature = words[0];
	if (!Object.hasOwn(FEATURES, feature)) {
		return refuseFeature(feature, FEATURE_NAMES);
	}
	const definition = FEATURES[feature];
	if (words.length === 1) {
		return {
			kind: "show",
			feature,
			state: values[feature],
			states: definition.states,
			message: feature + "=" + values[feature] + " (" + definition.states.join(" | ") + ")",
		};
	}
	const state = words[1].toLowerCase();
	if (!definition.states.includes(state)) {
		return refuseState(feature, state, definition.states);
	}
	const text = words.slice(2).join(" ");
	return {
		kind: "set",
		feature,
		state,
		previous: values[feature],
		text,
		message: feature + "=" + state,
	};
}

export function featureSections(features = {}) {
	const values = normalizeFeatures(features);
	const out = [];
	for (const name of FEATURE_NAMES) {
		const definition = FEATURES[name];
		if (!definition.sections) continue;
		const keys = definition.sections[values[name]];
		if (!keys) continue;
		for (const key of keys) out.push(key);
	}
	return out;
}

export function sectionKeys() {
	const keys = new Set();
	for (const definition of Object.values(FEATURES)) {
		if (!definition.sections) continue;
		for (const stateKeys of Object.values(definition.sections)) {
			for (const key of stateKeys) {
				if (key !== META_SKILLS_SENTINEL) keys.add(key);
			}
		}
	}
	return [...keys].sort();
}
