import { describe, expect, test } from "bun:test";

import {
	defaultFeatures,
} from "../src/features/herd/features.mjs";
import {
	createFlowState,
	createState,
	deserializeState,
	serializeState,
} from "../src/scope/index.mjs";
import {
	projectCapabilities,
	renderConsoleReceipt,
} from "../src/station/domain/capabilities.mjs";
import { injectSystemPrompt } from "../src/prompts/inject.mjs";
import { onHerdCommand } from "../src/station/gates.mjs";
import { decideScopeReturn } from "../src/station/domain/handoff.mjs";
import { createRelay } from "../src/relay/index.mjs";

function allOff() {
	return {
		chinese: "off",
		testing: "off",
		constitution: "off",
		framing: "off",
		scope: "off",
		workspace: "off",
	};
}

function prompt(features) {
	return injectSystemPrompt("HOST", { features });
}

describe("feature state", () => {
	test("a fresh state carries every feature at its fallback", () => {
		expect(createState().features).toEqual(defaultFeatures());
	});

	test("a flow state shares the live feature object with its base", () => {
		const root = createState();
		const child = createFlowState(root);
		root.features.testing = "off";
		expect(child.features.testing).toBe("off");
		child.features.chinese = "off";
		expect(root.features.chinese).toBe("off");
		root.features = { ...defaultFeatures(), scope: "adaptive" };
		expect(child.features.scope).toBe("adaptive");
	});
});

describe("persistence", () => {
	test("round-trips the feature map", () => {
		const state = createState();
		state.features.testing = "no-red";
		state.features.scope = "adaptive";
		state.features.workspace = "personal";
		const restored = deserializeState(serializeState(state));
		expect(restored.features.testing).toBe("no-red");
		expect(restored.features.scope).toBe("adaptive");
		expect(restored.features.workspace).toBe("personal");
	});

	test("drops the retired autopilot boolean and falls back for missing features", () => {
		const state = createState();
		const legacy = serializeState(state);
		delete legacy.features;
		legacy.autopilot = true;
		const restored = deserializeState(legacy);
		expect(restored.features.autopilot).toBeUndefined();
		expect(restored.relay?.goal === true).toBe(false);
		expect(restored.features.testing).toBe("lean");
	});

	test("an invalid stored feature value falls back", () => {
		const state = createState();
		const stored = serializeState(state);
		stored.features.testing = "maybe";
		stored.features.scope = "nope";
		const restored = deserializeState(stored);
		expect(restored.features.testing).toBe("lean");
		expect(restored.features.scope).toBe("hard");
	});
});

describe("capability signature and receipt", () => {
	test("the Chinese feature changes capSig but not the printed state", () => {
		const on = projectCapabilities({ isChild: false, autopilot: false, chinese: "on" });
		const off = projectCapabilities({ isChild: false, autopilot: false, chinese: "off" });
		expect(on.signature).not.toBe(off.signature);
		expect(on.state).not.toHaveProperty("chinese");
		expect(renderConsoleReceipt(on, { chinese: "on" })).toContain("强制以简体中文思考");
		expect(renderConsoleReceipt(off, { chinese: "off" })).not.toContain("强制以简体中文思考");
	});
});

describe("prompt assembly", () => {
	test("all-off keeps the mechanism and drops every policy marker", () => {
		const text = prompt(allOff());
		for (const marker of [
			"强制以简体中文思考",
			"Punish You Otherwise",
			"Do not run Red",
			"not tested yet",
			"Chesterton",
			"grandpa rules",
			"Bayesian",
			"three gates",
			"sqrt(n)",
			"managers, not labourers",
			"Fei Xiaotong",
			"<inlined-skill",
		]) {
			expect(text).not.toContain(marker);
		}
		for (const marker of ["The one tool", "scope_fork", "REPL probe", "scope_abandon"]) {
			expect(text).toContain(marker);
		}
	});

	test("defaults carry the current policy", () => {
		const text = prompt(defaultFeatures());
		for (const marker of [
			"Punish You Otherwise",
			"Do not run Red",
			"not tested yet",
			"Chesterton",
			"grandpa rules",
			"Bayesian",
			"three gates",
			"sqrt(n)",
			"orthogonal seams",
			"Fei Xiaotong",
			"<inlined-skill",
		]) {
			expect(text).toContain(marker);
		}
		expect(text.split("Do not run Red").length - 1).toBe(1);
	});

	test("testing states are a ladder", () => {
		const noRed = prompt({ ...allOff(), testing: "no-red" });
		const lean = prompt({ ...allOff(), testing: "lean" });
		expect(noRed).toContain("Do not run Red");
		expect(noRed).not.toContain("not tested yet");
		expect(lean).toContain("Do not run Red");
		expect(lean).toContain("not tested yet");
	});

	test("constitution states are a ladder", () => {
		const core = prompt({ ...allOff(), constitution: "core" });
		const full = prompt({ ...allOff(), constitution: "full" });
		expect(core).toContain("Chesterton");
		expect(core).not.toContain("grandpa rules");
		expect(full).toContain("Chesterton");
		expect(full).toContain("grandpa rules");
	});

	test("framing states are a ladder", () => {
		const plan = prompt({ ...allOff(), framing: "plan" });
		const full = prompt({ ...allOff(), framing: "full" });
		expect(plan).toContain("Bayesian");
		expect(plan).not.toContain("three gates");
		expect(full).toContain("Bayesian");
		expect(full).toContain("three gates");
	});

	test("scope adaptive and aggressive are alternatives", () => {
		const adaptive = prompt({ ...allOff(), scope: "adaptive" });
		const aggressive = prompt({ ...allOff(), scope: "aggressive" });
		expect(adaptive).toContain("caller never receives tool results");
		expect(adaptive).not.toContain("sqrt(n)");
		expect(aggressive).toContain("sqrt(n)");
		expect(aggressive).toContain("managers, not labourers");
		expect(aggressive).not.toContain("caller never receives tool results");

		const hard = prompt({ ...allOff(), scope: "hard" });
		expect(hard).toContain("orthogonal seams");
		expect(hard).toContain("state.scopes_summary");
		expect(hard).not.toContain("caller never receives tool results");
		expect(hard).not.toContain("managers, not labourers");
		expect(adaptive).not.toContain("state.scopes_summary");
		expect(aggressive).not.toContain("state.scopes_summary");
	});

	test("workspace full adds the meta skills to the personal profile", () => {
		const personal = prompt({ ...allOff(), workspace: "personal" });
		const full = prompt({ ...allOff(), workspace: "full" });
		expect(personal).toContain("Fei Xiaotong");
		expect(personal).not.toContain("<inlined-skill");
		expect(full).toContain("Fei Xiaotong");
		expect(full).toContain("<inlined-skill");
	});

	test("the feature object order does not change the prompt bytes", () => {
		const features = defaultFeatures();
		const reversed = Object.fromEntries(Object.entries(features).reverse());
		expect(prompt(features)).toBe(prompt(reversed));
	});

	test("root and child with shared features produce identical prompts", () => {
		const root = createState();
		const child = createFlowState(root);
		expect(prompt(root.features)).toBe(prompt(child.features));
	});
});

describe("onHerdCommand", () => {
	function fakeStation(features = defaultFeatures(), herd = "on") {
		const calls = { persist: 0, prompts: [] };
		return {
			portTable: { herd },
			state: { features },
			persist() {
				calls.persist += 1;
			},
			deliverUserMessage(text) {
				calls.prompts.push(text);
			},
			calls,
		};
	}

	test("sets a feature, persists, and sends trailing text", () => {
		const station = fakeStation();
		const result = onHerdCommand(station, "testing no-red fix it");
		expect(result).toMatchObject({ ok: true, kind: "set", feature: "testing", state: "no-red", text: "fix it" });
		expect(station.state.features.testing).toBe("no-red");
		expect(station.calls.persist).toBe(1);
		expect(station.calls.prompts).toEqual(["fix it"]);
	});

	test("list and show do not persist or send", () => {
		const station = fakeStation();
		expect(onHerdCommand(station, "").kind).toBe("list");
		expect(onHerdCommand(station, "testing").kind).toBe("show");
		expect(station.calls.persist).toBe(0);
		expect(station.calls.prompts).toEqual([]);
	});

	test("a refusal does not mutate or persist", () => {
		const station = fakeStation();
		const result = onHerdCommand(station, "testing maybe");
		expect(result.ok).toBe(false);
		expect(result.code).toBe("INVALID_FEATURE_STATE");
		expect(station.state.features.testing).toBe("lean");
		expect(station.calls.persist).toBe(0);
	});

	test("HERD_HERD=off refuses the whole command", () => {
		const station = fakeStation(defaultFeatures(), "off");
		const result = onHerdCommand(station, "testing off");
		expect(result).toMatchObject({ ok: false, code: "HERD_UNAVAILABLE" });
		expect(station.state.features.testing).toBe("lean");
	});
});

  describe("root seal completion", () => {
	const bigOath = {
		dafny: "done",
		signed_sealed_hands_off_nothing_left_on_the_table:
			"a_ferocious_audacious_master_would_change_nothing",
	};
	const decide = (relay, args = bigOath) =>
		decideScopeReturn({
			isRoot: true,
			relay,
			canRewindRoot: true,
			args,
			callId: "call-1",
		});

	test("a seal promotes on the first oath, matching a subscope", () => {
		const first = decide(createRelay());
		expect(first.kind).toBe("promote");
		expect(first.relay.canStop).toBe(true);
		expect(first.relay.pendingRewind).toBeNull();
	});

	test("continue rewinds root and keeps completion closed", () => {
		const out = decide(createRelay(), {
			dafny: "still working",
			signed_sealed_hands_off_nothing_left_on_the_table: "continue",
		});
		expect(out.kind).toBe("rewind");
		expect(out.relay.canStop).toBe(false);
		expect(out.relay.pendingRewind).not.toBeNull();
		expect(out.relay.pendingRewind.downgraded).toBeUndefined();
	});

	test("break at root rewinds like continue, marked degraded", () => {
		const out = decide(createRelay(), {
			dafny: "handing back a degraded result",
			signed_sealed_hands_off_nothing_left_on_the_table: "break",
		});
		expect(out.kind).toBe("rewind");
		expect(out.downgraded).toBe(true);
		expect(out.relay.canStop).toBe(false);
		expect(out.relay.pendingRewind.downgraded).toBe(true);
	});

	test("the retired unfinished value is refused", () => {
		const out = decide(createRelay(), {
			dafny: "stale caller",
			signed_sealed_hands_off_nothing_left_on_the_table: "unfinished",
		});
		expect(out).toEqual({ ok: false, code: "INVALID_RETURN_OATH" });
	});

	test("open children still refuse the seal", () => {
		const out = decideScopeReturn({
			isRoot: true,
			relay: createRelay(),
			canRewindRoot: true,
			unreceived: 1,
			args: bigOath,
			callId: "call-2",
		});
		expect(out).toMatchObject({ ok: false, code: "UNRECEIVED_CHILDREN" });
	});
  });
