// Red contract for the machine-wide session manager. Written, not run.
//
// Minimal module interface under test:
//   host-omp-ui/src/manager/domain/session-catalog.mjs
//     normalizeSessionRecord(raw) -> { id, path, cwd, title, modified, messageCount }
//     mergeMachineSessions(records) -> normalized[], deduped by id, newest modified wins
//     resolveSessionTarget(sessions, sessionId) -> session | null  (id only, never a path)
//     buildResumeLaunch({ session, ompPath = "omp", shell = process.env.SHELL || "/bin/sh" })
//       -> { tmuxSession, cwd, command: "tmux", args: string[] }
//       throws Error with .code === "missing_cwd" when session.cwd is empty
//   host-omp-ui/src/manager/session-service.mjs
//     createSessionService({ loadSessions, findLiveInstance, launch, buildPlan })
//       ensureSession(sessionId) -> { ok: true, kind: "reused"|"launched", instanceId, tmuxSession? }
//                                 | { ok: false, code: "unknown_session" }
//                                 | { ok: false, code: "launch_failed", message }
//       Concurrent ensureSession calls for one id share one launch (single-flight);
//       a failed launch clears the in-flight slot so a retry is possible.
import { describe, expect, it } from "bun:test";

import {
	buildResumeLaunch,
	mergeMachineSessions,
	normalizeSessionRecord,
	resolveSessionTarget,
} from "../../host-omp-ui/src/manager/domain/session-catalog.mjs";
import { createSessionService } from "../../host-omp-ui/src/manager/session-service.mjs";

function record(overrides) {
	return {
		id: "session-1",
		path: "/home/u/.omp/agent/sessions/-proj-a/2026-01-01T00-00-00_session-1.jsonl",
		cwd: "/proj/a",
		title: "A",
		modified: "2026-01-01T00:00:00.000Z",
		messageCount: 3,
		...overrides,
	};
}

// The shell command is the argv value right after -lc. tmux keepalive
// commands follow it in the same invocation, so args.at(-1) is not the command.
function commandLineOf(plan) {
	return plan.args[plan.args.indexOf("-lc") + 1];
}

describe("machine-wide session catalog", () => {
	it("keeps id, path and cwd for sessions from different working directories", () => {
		const a = normalizeSessionRecord(record({}));
		const b = normalizeSessionRecord(
			record({
				id: "session-2",
				path: "/home/u/.omp/agent/sessions/-proj-b/2026-01-02T00-00-00_session-2.jsonl",
				cwd: "/proj/b",
				title: "B",
				modified: "2026-01-02T00:00:00.000Z",
			}),
		);

		expect(a).toMatchObject({ id: "session-1", cwd: "/proj/a" });
		expect(b).toMatchObject({ id: "session-2", cwd: "/proj/b" });
		expect(a.path).toContain("session-1");
		expect(b.path).toContain("session-2");
	});

	it("dedupes by id across projects and keeps the newest file with its own cwd", () => {
		const older = record({ path: "/old/session-1.jsonl", cwd: "/proj/a" });
		const newer = record({
			path: "/new/session-1.jsonl",
			cwd: "/proj/moved",
			modified: "2026-03-01T00:00:00.000Z",
		});

		const merged = mergeMachineSessions([older, newer]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ id: "session-1", path: "/new/session-1.jsonl", cwd: "/proj/moved" });
	});

	it("resolves by session id only and refuses a path from the browser", () => {
		const sessions = mergeMachineSessions([record({})]);

		expect(resolveSessionTarget(sessions, "session-1")?.cwd).toBe("/proj/a");
		expect(resolveSessionTarget(sessions, record({}).path)).toBeNull();
		expect(resolveSessionTarget(sessions, "missing")).toBeNull();
	});
});

describe("real tmux + omp resume launch plan", () => {
	it("builds a detached tmux session in the original cwd that resumes the exact file", () => {
		const session = normalizeSessionRecord(record({}));
		const plan = buildResumeLaunch({ session, ompPath: "/usr/local/bin/omp", shell: "/bin/zsh" });
		const commandLine = commandLineOf(plan);

		expect(plan.command).toBe("tmux");
		expect(plan.cwd).toBe("/proj/a");
		expect(plan.tmuxSession).toMatch(/^omp-[a-z0-9]{8}$/);
		expect(plan.args).toContain("new-session");
		expect(plan.args).toContain("-d");
		expect(plan.args).toContain("-s");
		expect(plan.args).toContain(plan.tmuxSession);
		expect(plan.args).toContain("-c");
		expect(plan.args).toContain("/proj/a");
		expect(plan.args).toContain("/bin/zsh");
		expect(plan.args).toContain("-lc");
		expect(commandLine).toContain("/usr/local/bin/omp");
		expect(commandLine).toContain("--resume");
		expect(commandLine).toContain(session.path);
		expect(commandLine).not.toContain("--restore");
	});

	it("derives a stable, collision-free tmux name from the session id", () => {
		const first = buildResumeLaunch({ session: normalizeSessionRecord(record({})) });
		const again = buildResumeLaunch({ session: normalizeSessionRecord(record({})) });
		const other = buildResumeLaunch({ session: normalizeSessionRecord(record({ id: "session-2" })) });

		expect(again.tmuxSession).toBe(first.tmuxSession);
		expect(other.tmuxSession).not.toBe(first.tmuxSession);
	});

	it("keeps the resumed session alive after the user attaches and detaches", () => {
		const plan = buildResumeLaunch({ session: normalizeSessionRecord(record({})) });

		// The user may run `tmux a` and later detach. A user-level
		// destroy-unattached must not then kill the omp that the Web opened.
		expect(plan.args.slice(-6)).toEqual([
			";",
			"set-option",
			"-t",
			// `set-option -t` takes the session name; the `=` exact-match
			// prefix is only valid for session targets like `has-session`.
			plan.tmuxSession,
			"destroy-unattached",
			"off",
		]);
		// Default socket: a plain `tmux a` must find this session.
		expect(plan.args).not.toContain("-L");
	});

	it("passes a cwd and a session file with spaces and quotes without splitting them", () => {
		const cwd = "/proj/with space/it's mine";
		const path = "/home/u/.omp/agent/sessions/-proj/2026-01-01T00-00-00_it's.jsonl";
		const ompPath = "/opt/omp dir/omp";
		const plan = buildResumeLaunch({
			session: normalizeSessionRecord(record({ cwd, path })),
			ompPath,
			shell: "/bin/zsh",
		});

		// cwd travels as one argv element and never through a shell.
		expect(plan.cwd).toBe(cwd);
		expect(plan.args[plan.args.indexOf("-c") + 1]).toBe(cwd);

		// The command line is a POSIX single-quoted command, so each path stays
		// one shell word even when it contains a quote.
		const commandLine = commandLineOf(plan);
		const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
		expect(commandLine).toContain(quote(ompPath));
		expect(commandLine).toContain(quote(path));
		expect(commandLine).toContain("--resume");
	});

	it("fails visibly when a legacy session has no cwd instead of guessing a directory", () => {
		expect(() => buildResumeLaunch({ session: normalizeSessionRecord(record({ cwd: "" })) })).toThrow();

		try {
			buildResumeLaunch({ session: normalizeSessionRecord(record({ cwd: "" })) });
		} catch (error) {
			expect(error.code).toBe("missing_cwd");
		}
	});
});

describe("session service: reuse, single-flight, visible failure", () => {
	it("reuses an already-live omp instance and never launches a second one", async () => {
		let launches = 0;
		const service = createSessionService({
			loadSessions: async () => [record({})],
			findLiveInstance: (sessionId) => (sessionId === "session-1" ? { instanceId: "live-1" } : null),
			launch: async () => {
				launches += 1;
				return { instanceId: "new-1" };
			},
		});

		const result = await service.ensureSession("session-1");

		expect(result).toMatchObject({ ok: true, kind: "reused", instanceId: "live-1" });
		expect(launches).toBe(0);
	});

	it("single-flights concurrent opens of the same idle session", async () => {
		let launches = 0;
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const service = createSessionService({
			loadSessions: async () => [record({})],
			findLiveInstance: () => null,
			launch: async () => {
				launches += 1;
				await gate;
				return { instanceId: "new-1", tmuxSession: "omp-abc12345" };
			},
		});

		const first = service.ensureSession("session-1");
		const second = service.ensureSession("session-1");
		await Promise.resolve();
		expect(launches).toBe(1);

		release();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toMatchObject({ ok: true, kind: "launched", instanceId: "new-1" });
		expect(b).toEqual(a);
		expect(launches).toBe(1);
	});

	it("reports a launch failure to the caller and clears the in-flight slot for retry", async () => {
		let attempts = 0;
		const service = createSessionService({
			loadSessions: async () => [record({})],
			findLiveInstance: () => null,
			launch: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("tmux: command not found");
				return { instanceId: "new-2" };
			},
		});

		const failed = await service.ensureSession("session-1");
		expect(failed).toMatchObject({ ok: false, code: "launch_failed" });
		expect(failed.message).toContain("tmux");

		const retried = await service.ensureSession("session-1");
		expect(retried).toMatchObject({ ok: true, kind: "launched", instanceId: "new-2" });
		expect(attempts).toBe(2);
	});

	it("releases the per-cwd new-session slot when a launch never registers", async () => {
		let launches = 0;
		const service = createSessionService({
			loadSessions: async () => [],
			launch: async () => {
				launches += 1;
				return { instanceId: `pending-${launches}` };
			},
			awaitRegistration: () => new Promise(() => {}),
			timeoutMs: 25,
		});

		const timedOut = await service.newSession({ cwd: "/proj/a" });
		expect(timedOut).toMatchObject({ ok: false, code: "launch_timeout" });
		expect(timedOut.message).toContain("did not settle");

		// The slot is free, so the retry launches and registers instead of
		// waiting forever on the flight that never answered.
		const retried = await service.newSession(
			{ cwd: "/proj/a" },
			() => Promise.resolve({ instanceId: "inst-2" }),
		);
		expect(retried).toMatchObject({ ok: true, kind: "launched", instanceId: "inst-2" });
		expect(launches).toBe(2);
	});

	it("refuses an unknown session id without touching the launcher", async () => {
		let launches = 0;
		const service = createSessionService({
			loadSessions: async () => [record({})],
			findLiveInstance: () => null,
			launch: async () => {
				launches += 1;
				return { instanceId: "never" };
			},
		});

		const result = await service.ensureSession("missing");
		expect(result).toEqual({ ok: false, code: "unknown_session" });
		expect(launches).toBe(0);
	});
});
