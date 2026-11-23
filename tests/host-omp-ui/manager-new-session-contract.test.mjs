// Red contract for creating a real OMP session from the Web manager.
// Written, not run.
//
// The Web is the user's entry point. Its "new session" action must start a
// real `omp` in a tmux session in a trusted working directory -- the same
// thing the user gets by typing `tmux` and then `cd <dir> && omp`. It must
// not resume anything, must not switch an existing conversation, and must not
// report success before the new instance has registered with the manager.
//
// Minimal interface under test:
//   host-omp-ui/src/manager/domain/session-catalog.mjs
//     buildNewLaunch({ cwd, ompPath = "omp", shell = process.env.SHELL || "/bin/sh" })
//       -> { tmuxSession, cwd, command: "tmux", args: string[] }
//       throws Error with .code === "missing_cwd" for an empty cwd and
//       .code === "invalid_cwd" for a relative path or one containing "..".
//
//   host-omp-ui/src/manager/session-service.mjs
//     createSessionService({
//       loadSessions, findLiveInstance, launch, buildPlan, buildNewPlan,
//       awaitRegistration,
//     })
//       newSession({ cwd }) -> { ok: true, kind: "launched", tmuxSession, cwd, instanceId? }
//                            | { ok: false, code: "missing_cwd" | "invalid_cwd" }
//                            | { ok: false, code: "launch_failed" | "registration_failed", message }
//
//     newSession launches one real omp (never `--resume`), waits for
//     awaitRegistration(plan) before resolving, and single-flights concurrent
//     requests for the same cwd. A failed launch or failed registration
//     clears the in-flight slot so the user can retry. newSession never reads
//     the session catalog and never calls ensureSession: creating a session
//     must not reuse, switch or overwrite any existing conversation.
import { describe, expect, it } from "bun:test";

import {
	buildNewLaunch,
	buildResumeLaunch,
	normalizeSessionRecord,
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

function newSessionService(overrides = {}) {
	const calls = { launches: 0, loads: 0, registrations: 0 };
	const launches = [];
	const service = createSessionService({
		// Creating a session must not touch the catalog at all.
		loadSessions: () => {
			calls.loads += 1;
			throw new Error("newSession must not read the session catalog");
		},
		findLiveInstance: () => {
			throw new Error("newSession must not reuse or switch a live session");
		},
		launch: async (plan) => {
			calls.launches += 1;
			launches.push(plan);
			return { ok: true };
		},
		awaitRegistration: async (plan) => {
			calls.registrations += 1;
			return { instanceId: `instance-${plan.tmuxSession}` };
		},
		...overrides,
	});
	return { service, calls, launches };
}

describe("new session launch plan: a real omp, not a resume", () => {
	it("starts omp in the requested cwd and never passes --resume or --restore", () => {
		const plan = buildNewLaunch({
			cwd: "/proj/new",
			ompPath: "/usr/local/bin/omp",
			shell: "/bin/zsh",
		});
		const commandLine = commandLineOf(plan);

		expect(plan.command).toBe("tmux");
		expect(plan.cwd).toBe("/proj/new");
		expect(plan.tmuxSession).toMatch(/^omp-[a-z0-9]{8}$/);
		expect(plan.args).toContain("new-session");
		expect(plan.args).toContain("-d");
		expect(plan.args).toContain("-s");
		expect(plan.args).toContain(plan.tmuxSession);
		expect(plan.args).toContain("-c");
		expect(plan.args).toContain("/proj/new");
		expect(plan.args).toContain("/bin/zsh");
		expect(plan.args).toContain("-lc");
		expect(commandLine).toContain("/usr/local/bin/omp");
		expect(commandLine).not.toContain("--resume");
		expect(commandLine).not.toContain("--restore");
	});

	it("uses a different tmux name from a resume plan for the same directory", () => {
		const fresh = buildNewLaunch({ cwd: "/proj/a" });
		const resumed = buildResumeLaunch({ session: normalizeSessionRecord(record({ cwd: "/proj/a" })) });

		expect(fresh.tmuxSession).not.toBe(resumed.tmuxSession);
	});

	it("keeps the new session alive after the user attaches and detaches", () => {
		const plan = buildNewLaunch({ cwd: "/proj/new" });

		// The user may run `tmux a` and later detach. A user-level
		// destroy-unattached must not then kill the omp that the Web started.
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

	it("passes a cwd with spaces and quotes as one argv element", () => {
		const cwd = "/proj/with space/it's mine";
		const ompPath = "/opt/omp dir/omp";
		const plan = buildNewLaunch({ cwd, ompPath, shell: "/bin/zsh" });

		expect(plan.cwd).toBe(cwd);
		expect(plan.args[plan.args.indexOf("-c") + 1]).toBe(cwd);
		expect(commandLineOf(plan)).toContain(`'${ompPath.replaceAll("'", "'\\''")}'`);
	});

	it("rejects an empty or relative working directory instead of guessing one", () => {
		for (const cwd of ["", "  ", "relative/dir", "/proj/../etc"]) {
			expect(() => buildNewLaunch({ cwd })).toThrow();
			try {
				buildNewLaunch({ cwd });
			} catch (error) {
				expect(["missing_cwd", "invalid_cwd"]).toContain(error.code);
			}
		}
	});
});

describe("new session service: one real launch, then await registration", () => {
	it("launches once and resolves only after the new instance has registered", async () => {
		const order = [];
		const { service, calls, launches } = newSessionService({
			launch: async (plan) => {
				calls.launches += 1;
				launches.push(plan);
				order.push("launch");
				return { ok: true };
			},
			awaitRegistration: async (plan) => {
				order.push("registration");
				return { instanceId: "instance-new" };
			},
		});

		const result = await service.newSession({ cwd: "/proj/new" });

		expect(result).toMatchObject({
			ok: true,
			kind: "launched",
			cwd: "/proj/new",
			instanceId: "instance-new",
		});
		expect(result.tmuxSession).toMatch(/^omp-[a-z0-9]{8}$/);
		expect(order).toEqual(["launch", "registration"]);
		expect(commandLineOf(launches[0])).not.toContain("--resume");
		expect(calls.loads).toBe(0);
	});

	it("single-flights concurrent requests for the same cwd", async () => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { service, calls } = newSessionService({
			launch: async (plan) => {
				calls.launches += 1;
				await gate;
				return { ok: true };
			},
		});

		const first = service.newSession({ cwd: "/proj/new" });
		const second = service.newSession({ cwd: "/proj/new" });
		await Promise.resolve();
		expect(calls.launches).toBe(1);

		release();
		const [a, b] = await Promise.all([first, second]);
		expect(a.ok).toBe(true);
		expect(b).toEqual(a);
		expect(calls.launches).toBe(1);
	});

	it("does not merge requests for different working directories", async () => {
		const { service, calls } = newSessionService();

		const [a, b] = await Promise.all([
			service.newSession({ cwd: "/proj/one" }),
			service.newSession({ cwd: "/proj/two" }),
		]);

		expect(a.ok && b.ok).toBe(true);
		expect(a.tmuxSession).not.toBe(b.tmuxSession);
		expect(calls.launches).toBe(2);
		expect(calls.loads).toBe(0);
	});

	it("reports a failed launch and allows a retry", async () => {
		let attempts = 0;
		const { service } = newSessionService({
			launch: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("tmux: command not found");
				return { ok: true };
			},
		});

		const failed = await service.newSession({ cwd: "/proj/new" });
		expect(failed).toMatchObject({ ok: false, code: "launch_failed" });
		expect(failed.message).toContain("tmux");

		const retried = await service.newSession({ cwd: "/proj/new" });
		expect(retried).toMatchObject({ ok: true, kind: "launched" });
		expect(attempts).toBe(2);
	});

	it("reports a failed registration instead of claiming the session is ready", async () => {
		let attempts = 0;
		const { service } = newSessionService({
			awaitRegistration: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("instance did not register in time");
				return { instanceId: "instance-new" };
			},
		});

		const failed = await service.newSession({ cwd: "/proj/new" });
		expect(failed).toMatchObject({ ok: false, code: "registration_failed" });
		expect(failed.message).toContain("register");

		const retried = await service.newSession({ cwd: "/proj/new" });
		expect(retried).toMatchObject({ ok: true, kind: "launched", instanceId: "instance-new" });
		expect(attempts).toBe(2);
	});

	it("refuses an untrusted cwd without launching", async () => {
		for (const cwd of ["", "relative/dir", "/proj/../etc"]) {
			const { service, calls } = newSessionService();
			const result = await service.newSession({ cwd });
			expect(result.ok).toBe(false);
			expect(["missing_cwd", "invalid_cwd"]).toContain(result.code);
			expect(calls.launches).toBe(0);
			expect(calls.loads).toBe(0);
		}
	});
});
