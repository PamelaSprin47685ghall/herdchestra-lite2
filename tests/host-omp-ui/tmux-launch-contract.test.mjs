import { describe, expect, test } from "bun:test";
import { executeTmuxLaunch } from "../../host-omp-ui/src/host/tmux-launch.mjs";

// Contract for the real failure observed in an isolated tmux run:
// `tmux new-session ... ; set-option ... destroy-unattached off` can exit
// non-zero after the session was created. The child OMP is already starting
// and will consume its one-shot launch context. Treating that non-zero exit as
// "nothing started" deletes the context and leaves the child unable to reach
// the manager. The launcher must distinguish "session exists" from "launch
// failed", and must never delete a context that a live session will consume.

const spec = {
	command: "tmux",
	args: [
		"new-session", "-d", "-s", "omp-abc12345",
		"-c", "/tmp/project",
		"/bin/sh", "-lc", "exec /usr/local/bin/omp",
		";", "set-option", "-t", "omp-abc12345", "destroy-unattached", "off",
	],
	tmuxSession: "omp-abc12345",
};

function harness({ code = 0, stdout = "", stderr = "", runThrows = null, alive = false } = {}) {
	const calls = { removed: [], run: [], hasSession: [] };
	return {
		calls,
		options: {
			spec,
			contextPath: "/run/herd-omp-ui/launch/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json",
			run: async (command, args) => {
				calls.run.push({ command, args });
				if (runThrows) throw runThrows;
				return { code, stdout, stderr };
			},
			hasSession: async (name) => {
				calls.hasSession.push(name);
				return alive;
			},
			removeContext: async (path) => {
				calls.removed.push(path);
			},
		},
	};
}

describe("tmux launch outcome", () => {
	test("a live session is launched even when the keepalive command exits non-zero", async () => {
		const h = harness({ code: 1, stderr: "no such session: =omp-abc12345", alive: true });
		const result = await executeTmuxLaunch(h.options);

		expect(result.ok).toBe(true);
		expect(result.tmuxSession).toBe("omp-abc12345");
		expect(result.keepaliveFailed).toBe(true);
		expect(result.diagnostics.map((item) => item.code)).toContain("keepalive_failed");
	});

	test("does not delete the context delivered to a live session", async () => {
		const h = harness({ code: 1, stderr: "no such session: =omp-abc12345", alive: true });
		await executeTmuxLaunch(h.options);

		expect(h.calls.removed).toEqual([]);
		expect(h.calls.hasSession).toEqual(["omp-abc12345"]);
	});

	test("removes the context and reports failure when the session was never created", async () => {
		const h = harness({ code: 1, stderr: "no such directory: /tmp/project", alive: false });
		const result = await executeTmuxLaunch(h.options);

		expect(result.ok).toBe(false);
		expect(result.code).toBe("launch_failed");
		expect(result.message).toContain("no such directory");
		expect(h.calls.removed).toEqual([h.options.contextPath]);
	});

	test("a spawn exception with no live session is a safe failed launch", async () => {
		const h = harness({ runThrows: new Error("spawn tmux EACCES"), alive: false });
		const result = await executeTmuxLaunch(h.options);

		expect(result.ok).toBe(false);
		expect(result.code).toBe("launch_failed");
		expect(h.calls.removed).toEqual([h.options.contextPath]);
	});

	test("a spawn exception must not delete the context if the session is alive", async () => {
		const h = harness({ runThrows: new Error("stdout closed"), alive: true });
		const result = await executeTmuxLaunch(h.options);

		expect(result.ok).toBe(true);
		expect(result.keepaliveFailed).toBe(true);
		expect(h.calls.removed).toEqual([]);
	});

	test("passes exactly the planned argv and no token", async () => {
		const h = harness({ code: 0, alive: true });
		await executeTmuxLaunch(h.options);

		expect(h.calls.run).toHaveLength(1);
		expect(h.calls.run[0].command).toBe("tmux");
		expect(h.calls.run[0].args).toEqual(spec.args);
		// A token is never part of the launch plan; only the context path may
		// identify the one-shot credentials.
		expect(h.calls.run[0].args.some((arg) => arg.includes("token"))).toBe(false);
	});
});
