#!/usr/bin/env bun
/**
 * Copy both packages into the installed plugin directory.
 *
 * omp loads `~/.omp/plugins/node_modules/herdchestra-host-omp`, not this
 * working tree, and that package imports `herdchestra-lite2` by package name.
 * So the sync materializes two roots: the host package at the target root, and
 * the core package under the target's `node_modules/`.
 *
 *   bun run sync:plugin                    copy, then verify
 *   bun scripts/sync-plugin.mjs --check    report drift, change nothing
 *   HERDCHESTRA_PLUGIN_DIR=/path bun run sync:plugin
 *
 * Exit code is 0 only when every runtime file matches and the installed build
 * carries the current feature fingerprints.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const HOST_ROOT = join(ROOT, "host-omp");
const TARGET = resolve(
  process.env.HERDCHESTRA_PLUGIN_DIR ??
    join(homedir(), ".omp/plugins/node_modules/herdchestra-host-omp"),
);
const CORE_INSTALL = "node_modules/herdchestra-lite2";

/**
 * One install unit: files copied from `source` into `TARGET/<dest>`, plus the
 * package.json to sanitize there, plus the directories to prune.
 *
 * The core must own `resources/`: prompts resolve relative to
 * `src/prompts/index.mjs`, two levels up. The host package is the extension
 * entry, so it owns the root `package.json` and the `skills/` the host
 * discovers; those skills stay single-sourced in the core and are mirrored
 * here by the `mirrorSkills` unit.
 */
const UNITS = [
  {
    name: "core",
    source: ROOT,
    dest: CORE_INSTALL,
    dirs: ["src", "resources", "skills"],
    stripPackageKeys: ["devDependencies", "scripts", "repository", "keywords"],
  },
  {
    name: "host",
    source: HOST_ROOT,
    dest: "",
    dirs: ["src"],
    stripPackageKeys: ["dependencies", "repository", "keywords"],
  },
  {
    name: "skills-mirror",
    source: join(ROOT, "skills"),
    dest: "skills",
    dirs: ["."],
    stripPackageKeys: null,
  },
];

const FINGERPRINTS = [
  { root: CORE_INSTALL, file: "src/relay/texts.mjs", needle: "status.flow", min: 1 },
  { root: CORE_INSTALL, file: "src/relay/texts.mjs", needle: 'case "reopened"', min: 1 },
  // The scope protocol is the four fork/join/return/panhandle tools. The
  // receipt chain is gone, so no needle may depend on it.
  { root: "", file: "src/activation/tools.mjs", needle: 'name: "scope_fork"', min: 1 },
  { root: "", file: "src/activation/tools.mjs", needle: 'name: "scope_join"', min: 1 },
  { root: "", file: "src/activation/tools.mjs", needle: 'name: "scope_return"', min: 1 },
  { root: "", file: "src/activation/tools.mjs", needle: 'name: "scope_panhandle"', min: 1 },
];
const checkOnly = process.argv.includes("--check");

function filesUnder(base, dir) {
  const abs = dir === "." ? base : join(base, dir);
  const found = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = dir === "." ? entry.name : join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(base, rel));
    else if (entry.isFile()) found.push(rel);
    else console.warn(`sync-plugin: skipping unsupported entry ${rel}`);
  }
  return found;
}

function sourcePathOf(unit, rel) {
  return join(unit.source, rel);
}

function destPathOf(unit, rel) {
  return join(TARGET, unit.dest, rel);
}

/** The sanitized package.json the target must carry, or null when unmanaged. */
function expectedPackageJson(unit) {
  if (!unit.stripPackageKeys) return null;
  const source = JSON.parse(readFileSync(join(unit.source, "package.json"), "utf8"));
  for (const key of unit.stripPackageKeys) delete source[key];
  return `${JSON.stringify(source, null, "\t")}\n`;
}

function identical(src, dest) {
  try {
    return readFileSync(src).equals(readFileSync(dest));
  } catch {
    return false;
  }
}

/**
 * Every file the target is missing or has stale: `{ unit, rel, content? }`.
 * A `content` entry is written verbatim; otherwise the file is copied.
 */
function collectDrift() {
  const drift = [];
  for (const unit of UNITS) {
    for (const rel of unit.dirs.flatMap((dir) => filesUnder(unit.source, dir))) {
      if (!identical(sourcePathOf(unit, rel), destPathOf(unit, rel))) drift.push({ unit, rel });
    }
    const expected = expectedPackageJson(unit);
    if (expected === null) continue;
    const dest = join(TARGET, unit.dest, "package.json");
    if (!existsSync(dest) || readFileSync(dest, "utf8") !== expected) {
      drift.push({ unit, rel: "package.json", content: expected });
    }
  }
  return drift;
}

/** Files the target carries that the source no longer ships. */
function extraUnder() {
  const extra = [];
  for (const unit of UNITS) {
    for (const dir of unit.dirs) {
      const destBase = join(TARGET, unit.dest, dir);
      if (!existsSync(destBase)) continue;
      for (const rel of filesUnder(destBase, ".")) {
        const sourceRel = dir === "." ? rel : join(dir, rel);
        if (!existsSync(sourcePathOf(unit, sourceRel))) extra.push({ unit, rel: sourceRel });
      }
    }
  }
  return extra;
}

function copyAll(drift) {
  for (const { unit, rel, content } of drift) {
    const dest = destPathOf(unit, rel);
    mkdirSync(dirname(dest), { recursive: true });
    // Unlink first: a hard link would otherwise let the copy rewrite the source.
    rmSync(dest, { force: true });
    if (content !== undefined) writeFileSync(dest, content);
    else copyFileSync(sourcePathOf(unit, rel), dest);
  }
}

function pruneAll(extra) {
  for (const { unit, rel } of extra) rmSync(destPathOf(unit, rel), { force: true });
  const dirs = [...new Set(extra.map(({ unit, rel }) => join(unit.dest, dirname(rel))))].sort(
    (a, b) => b.length - a.length,
  );
  for (const start of dirs) {
    let current = start;
    for (;;) {
      // Stop at a unit root; never remove the unit's own directory.
      if (UNITS.some((unit) => unit.dest === current)) break;
      try {
        rmdirSync(join(TARGET, current));
      } catch {
        break;
      }
      const parent = dirname(current);
      if (parent === current || parent === ".") break;
      current = parent;
    }
  }
}

function fingerprintProblems() {
  return FINGERPRINTS.map(({ root, file, needle, min }) => {
    const path = join(TARGET, root, file);
    const hits = existsSync(path) ? readFileSync(path, "utf8").split(needle).length - 1 : 0;
    return hits >= min
      ? null
      : `${join(root, file)} carries "${needle}" ${hits} time(s); needs ${min}`;
  }).filter(Boolean);
}

if (!existsSync(TARGET)) {
  // A fresh checkout has no host package yet: this package is private and is
  // not in a registry, so the sync is the install. Create the target only when
  // the host's plugin directory exists; a typo'd HERDCHESTRA_PLUGIN_DIR must
  // still fail instead of materializing a plugin tree the host never scans.
  if (!existsSync(dirname(TARGET))) {
    console.error(`sync-plugin: no installed plugin at ${TARGET}`);
    console.error("Install it first, or set HERDCHESTRA_PLUGIN_DIR.");
    process.exit(1);
  }
  mkdirSync(TARGET, { recursive: true });
}

console.log(`sync-plugin: ${ROOT} -> ${TARGET}`);
const drift = collectDrift();
const extra = extraUnder();

for (const { unit, rel } of drift) console.log(`  drift  ${join(unit.dest, rel)}`);
for (const { unit, rel } of extra) console.log(`  extra  ${join(unit.dest, rel)}`);

if (checkOnly) {
  const problems = fingerprintProblems();
  for (const line of problems) console.log(`  stale  ${line}`);
  if (drift.length === 0 && extra.length === 0 && problems.length === 0) {
    console.log("in sync; fingerprints ok");
  }
  process.exit(drift.length === 0 && extra.length === 0 && problems.length === 0 ? 0 : 1);
}

if (extra.length > 0) {
  pruneAll(extra);
  console.log(`pruned ${extra.length} file(s)`);
}

if (drift.length > 0) {
  copyAll(drift);
  console.log(`copied ${drift.length} file(s)`);
}

const remaining = collectDrift();
if (remaining.length > 0) {
  console.error(`sync-plugin: ${remaining.length} file(s) still differ after copy`);
  for (const { unit, rel } of remaining) console.error(`  diff  ${join(unit.dest, rel)}`);
  process.exit(1);
}
if (drift.length === 0) console.log("already in sync: 0 file(s) copied");

const problems = fingerprintProblems();
if (problems.length > 0) {
  console.error("sync-plugin: installed build is missing current code");
  for (const line of problems) console.error(`  stale  ${line}`);
  process.exit(1);
}

console.log("fingerprints ok: status.flow, reopened, scope tools");
console.log("restart the session before relying on this build.");
