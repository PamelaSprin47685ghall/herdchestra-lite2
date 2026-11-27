// USER_ABORT routing: one owner answers, and a miss is reported, not guessed.
//
// Two engines can carry a station for the same manager in a forked tree. The
// router used to call every match (one Esc aborted twice) and, on a miss, call
// the last engine anyway, which built a station for a context nobody owned.
// Both are regressions this file locks out.
import { beforeEach, describe, expect, test } from "bun:test";

import { registerProcessUserAbortEngine } from "../../host-omp/src/host/user-abort.mjs";
import {
	USER_ABORT_ENGINES_KEY,
	USER_ABORT_KEY,
} from "../../host-omp/src/host/process-symbols.mjs";
import {
	reset as resetDiagnostics,
	snapshot as diagnosticsSnapshot,
} from "../../host-omp/src/host/diagnostics.mjs";

function resetRouting() {
	delete globalThis[USER_ABORT_ENGINES_KEY];
	delete globalThis[USER_ABORT_KEY];
	resetDiagnostics();
}

describe("process user-abort routing", () => {
	beforeEach(resetRouting);

	test("the first owner answers and a second match is not called", () => {
		const calls = [];
		const parent = {
			peekStation: () => ({ role: "root" }),
			userAbort: () => {
				calls.push("parent");
				return "parent-answer";
			},
		};
		const child = {
			peekStation: () => ({ role: "child" }),
			userAbort: () => {
				calls.push("child");
				return "child-answer";
			},
		};
		registerProcessUserAbortEngine(parent);
		registerProcessUserAbortEngine(child);

		expect(globalThis[USER_ABORT_KEY]({}, null)).toBe("parent-answer");
		expect(calls).toEqual(["parent"]);
	});

	test("a miss is recorded and creates no station for a foreign context", () => {
		let created = 0;
		const engine = {
			peekStation: () => null,
			hasStation: () => false,
			stationFor: () => {
				created += 1;
				return { onUserAbort: () => "stray" };
			},
			userAbort: () => "should-not-run",
		};
		registerProcessUserAbortEngine(engine);

		expect(globalThis[USER_ABORT_KEY]({}, null)).toBeNull();
		expect(created).toBe(0);
		expect(
			diagnosticsSnapshot().some((entry) => entry.domain === "activation"),
		).toBe(true);
	});
});
