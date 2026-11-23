import { describe, expect, test } from "bun:test";
import { mkdtemp, chmod, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLaunchContext, consumeLaunchContext } from "../../host-omp-ui/src/host/launch-context.mjs";
import { buildNewLaunch, buildResumeLaunch } from "../../host-omp-ui/src/manager/domain/session-catalog.mjs";

// One-use private launch context: the manager writes it before invoking tmux,
// the new plugin consumes it before connecting. Only its path may be passed in
// tmux arguments; the token itself must never appear there.
const port = 39741;
const token = "secret-value-contains-'&|%";

async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), "omp-launch-context-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

describe("manager launch context", () => {
  test("securely transfers the same manager port and token once", () => isolated(async (directory) => {
    const path = await createLaunchContext({ directory, port, token });
    const info = await lstat(path);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o077).toBe(0);
    if (typeof process.getuid === "function") expect(info.uid).toBe(process.getuid());
    expect(await consumeLaunchContext(path)).toEqual({ port, token });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(consumeLaunchContext(path)).rejects.toThrow();
  }));

  test("new and resumed sessions convey a context path without exposing credentials in argv", () => isolated(async (directory) => {
    const path = await createLaunchContext({ directory, port, token });
    const plans = [
      buildNewLaunch({ cwd: "/tmp", ompPath: "/usr/bin/omp", shell: "/bin/sh", contextPath: path }),
      buildResumeLaunch({ session: { id: "session-1", cwd: "/tmp", path: "/tmp/session.jsonl" }, ompPath: "/usr/bin/omp", shell: "/bin/sh", contextPath: path }),
    ];
    for (const plan of plans) {
      const argv = JSON.stringify([plan.command, ...plan.args]);
      expect(argv).toContain(path);
      expect(argv).not.toContain(token);
      expect(argv).not.toContain(encodeURIComponent(token));
    }
    expect(await consumeLaunchContext(path)).toEqual({ port, token });
  }));

  test("rejects a world-readable context without returning its token", () => isolated(async (directory) => {
    const path = await createLaunchContext({ directory, port, token });
    await chmod(path, 0o644);
    let error;
    try { await consumeLaunchContext(path); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain(token);
  }));

  test("refuses a symlink instead of consuming its target", () => isolated(async (directory) => {
    const target = await createLaunchContext({ directory, port, token });
    const link = join(directory, "link");
    await symlink(target, link);
    await expect(consumeLaunchContext(link)).rejects.toThrow();
    expect((await lstat(target)).isFile()).toBe(true);
    expect(await consumeLaunchContext(target)).toEqual({ port, token });
  }));

  test("invalid or malformed context fails explicitly without disclosing contents", () => isolated(async (directory) => {
    const path = join(directory, "bad");
    await writeFile(path, JSON.stringify({ port: -1, token }), { mode: 0o600 });
    let error;
    try { await consumeLaunchContext(path); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain(token);
    const other = join(directory, "malformed");
    await writeFile(other, "{broken", { mode: 0o600 });
    await expect(consumeLaunchContext(other)).rejects.toThrow();
  }));
});
