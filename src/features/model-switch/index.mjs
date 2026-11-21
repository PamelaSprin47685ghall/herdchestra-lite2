// Model-switch port: which model a scope runs on.
//
// `on` takes an explicit choice and remembers it. `off` answers the baseline
// for every request and refuses to change it — a constant, not a silent no-op,
// so a caller that expects a switch can see it did not happen.

/** `on`: remember the chosen spec per scope. */
export function modelSwitchOn(baseline = "default") {
	const choices = new Map();
	return {
		name: "on",
		choose(scopeId, spec) {
			if (typeof scopeId !== "string" || scopeId === "") {
				return { ok: false, code: "MODEL_INVALID_SCOPE", port: "modelSwitch" };
			}
			if (typeof spec !== "string" || spec.trim() === "") {
				return { ok: false, code: "MODEL_INVALID_SPEC", port: "modelSwitch" };
			}
			choices.set(scopeId, spec.trim());
			return { ok: true, scopeId, spec: spec.trim() };
		},
		current(scopeId) {
			return { ok: true, spec: choices.get(scopeId) ?? baseline, switched: choices.has(scopeId) };
		},
	};
}

/** `off`: always the baseline, and a refusal to change it. */
export function modelSwitchOff(baseline = "default") {
	return {
		name: "off",
		choose() {
			return { ok: false, code: "MODEL_SWITCH_DISABLED", port: "modelSwitch" };
		},
		current() {
			return { ok: true, spec: baseline, switched: false };
		},
	};
}

export const MODEL_SWITCH_IMPLEMENTATIONS = { on: modelSwitchOn, off: modelSwitchOff };
