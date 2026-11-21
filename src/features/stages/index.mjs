// stages port: which workflow stages may open.
//
// `stages` owns admission. It reads the mode `herd` publishes as a constructor
// fact - it never imports herd and never writes it. That direction is the
// bill-split row 4: herd publishes, stages decides.

const GATED = Object.freeze(["acceptance-cases", "architecture-design", "orchestration-plan"]);

export function createStagesOn({ mode } = {}) {
	const readMode = typeof mode === "function" ? mode : () => "off";
	const opened = [];
	const flags = Object.fromEntries(GATED.map((stage) => [stage, false]));
	return {
		name: "on",
		open(scopeId, stage) {
			if (!this.allows(stage)) {
				return { ok: false, code: "INVALID_STAGE", port: "stages", stage };
			}
			opened.push({ scopeId, stage });
			if (Object.hasOwn(flags, stage)) flags[stage] = true;
			return { ok: true, stage };
		},
		allows(stage) {
			// decision-framing exists only while herd is on; every other stage is
			// always allowed to open. The mode is read, never written.
			if (stage === "decision-framing") return readMode() === "on";
			return true;
		},
		snapshot() {
			return { opened: opened.map((entry) => ({ ...entry })), flags: { ...flags } };
		},
	};
}

export function createStagesOff() {
	return {
		name: "off",
		open() {
			return { ok: true, skipped: true };
		},
		allows() {
			return false;
		},
		snapshot() {
			return { opened: [], flags: {} };
		},
	};
}

export const STAGES_IMPLEMENTATIONS = Object.freeze({
	on: createStagesOn,
	off: createStagesOff,
});
