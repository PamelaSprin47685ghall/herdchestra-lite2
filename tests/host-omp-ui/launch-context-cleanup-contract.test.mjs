import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  lstat, lutimes, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneLaunchContexts } from "../../host-omp-ui/src/host/launch-context.mjs";

// A manager writes one-use launch contexts into a private directory before
// spawning tmux. If it dies before the child consumes the file (crash, SIGKILL,
// tmux failure, registration timeout), that file keeps a live manager token.
// The next manager must prune only its own stale files, and must never touch
// fresh files (a launch in flight), foreign files, or symlink targets.
//
// Call point: the manager leader, after it resolves the launch directory and
// before it serves browser/agent traffic. Consumers never prune; they consume
// only the path they were given.
//
// Only files this module itself writes are fair game:
//   <uuid>.json                      (createLaunchContext)
//   .<uuid>.json.<uuid>.claimed      (in-flight rename inside consume)
const TTL = 60_000;
const token = "secret-token-&|%'$";

function ownName() { return `${randomUUID()}.json`; }
function claimedName() {
  const base = `${randomUUID()}.json`;
  return `.${base}.${randomUUID()}.claimed`;
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

async function age(path, ms, { noFollow = false } = {}) {
  const when = new Date(Date.now() - ms);
  await (noFollow ? lutimes : utimes)(path, when, when);
}

async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), "omp-launch-cleanup-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

describe("launch context stale cleanup", () => {
  test("removes only stale files this module created", () => isolated(async (directory) => {
    const stale = join(directory, ownName());
    const fresh = join(directory, ownName());
    const staleClaim = join(directory, claimedName());
    const freshClaim = join(directory, claimedName());
    const foreign = join(directory, "notes.txt");
    const foreignJson = join(directory, "config.json");
    for (const path of [stale, fresh, staleClaim, freshClaim, foreignJson]) {
      await writeFile(path, JSON.stringify({ port: 39741, token }), { mode: 0o600 });
    }
    await writeFile(foreign, "leave me alone\n", { mode: 0o600 });
    await age(stale, TTL * 2);
    await age(staleClaim, TTL * 2);
    await age(foreign, TTL * 2);
    await age(foreignJson, TTL * 2);

    const result = await pruneLaunchContexts({ directory, maxAgeMs: TTL });

    expect(result.removed).toBe(2);
    expect(await exists(stale)).toBe(false);
    expect(await exists(staleClaim)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(freshClaim)).toBe(true);
    expect(await exists(foreign)).toBe(true);
    expect(await exists(foreignJson)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  }));

  test("never follows a symlink or deletes its target", () => isolated(async (directory) => {
    const target = join(directory, "target.json");
    await writeFile(target, JSON.stringify({ port: 39741, token }), { mode: 0o600 });
    const link = join(directory, ownName());
    await symlink(target, link);
    await age(target, TTL * 2);
    await age(link, TTL * 2, { noFollow: true });

    const result = await pruneLaunchContexts({ directory, maxAgeMs: TTL });

    expect(result.removed).toBe(0);
    expect(await readFile(target, "utf8")).toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
  }));

  test("leaves a same-named directory or non-regular entry untouched", () => isolated(async (directory) => {
    const impostor = join(directory, ownName());
    await mkdir(impostor);
    await age(impostor, TTL * 2);

    const result = await pruneLaunchContexts({ directory, maxAgeMs: TTL });

    expect(result.removed).toBe(0);
    expect(await exists(impostor)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  }));

  test("is idempotent and does not create a missing directory", () => isolated(async (directory) => {
    const stale = join(directory, ownName());
    await writeFile(stale, JSON.stringify({ port: 39741, token }), { mode: 0o600 });
    await age(stale, TTL * 2);

    const first = await pruneLaunchContexts({ directory, maxAgeMs: TTL });
    const second = await pruneLaunchContexts({ directory, maxAgeMs: TTL });
    expect(first.removed).toBe(1);
    expect(second.removed).toBe(0);

    const missing = join(directory, "does-not-exist");
    const result = await pruneLaunchContexts({ directory: missing, maxAgeMs: TTL });
    expect(result.removed).toBe(0);
    expect(await exists(missing)).toBe(false);
  }));

  test("refuses to prune through an unsafe symlinked directory", () => isolated(async (directory) => {
    const real = join(directory, "real");
    await mkdir(real, { mode: 0o700 });
    const stale = join(real, ownName());
    await writeFile(stale, JSON.stringify({ port: 39741, token }), { mode: 0o600 });
    await age(stale, TTL * 2);
    const alias = join(directory, "alias");
    await symlink(real, alias);

    let error;
    try { await pruneLaunchContexts({ directory: alias, maxAgeMs: TTL }); }
    catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain(token);
    expect(await exists(stale)).toBe(true);
  }));
});
