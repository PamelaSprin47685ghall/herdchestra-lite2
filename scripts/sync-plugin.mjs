#!/usr/bin/env bun
/**
 * Copy the extension's runtime files into the installed plugin directory.
 *
 * omp loads ~/.omp/plugins/node_modules/herdchestra-lite2, not this working
 * tree, so an edit here reaches a session only after this copy plus a restart.
 *
 *   bun run sync:plugin                    copy, then verify
 *   bun scripts/sync-plugin.mjs --check    report drift, change nothing
 *   HERDCHESTRA_PLUGIN_DIR=/path bun run sync:plugin
 *
 * Exit code is 0 only when every runtime file matches and the installed build
 * carries the current feature fingerprints.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TARGET = resolve(
  process.env.HERDCHESTRA_PLUGIN_DIR ??
    join(homedir(), ".omp/plugins/node_modules/herdchestra-lite2"),
);
const RUNTIME_DIRS = ["src", "resources"];
const FINGERPRINTS = [
  { file: "src/relay/texts.mjs", needle: "status.flow", min: 1 },
  { file: "src/relay/texts.mjs", needle: 'case "reopened"', min: 1 },
  // The `rw` gate moved into fission validation: accounting.mjs owns the two
  // refusals (before the first ledger, and in decision-framing), while
  // controls.mjs keeps the single end-of-scope relay check. Counting two in
  // controls.mjs described a shape the file no longer has.
  { file: "src/scope/accounting.mjs", needle: "state.relay?.fullFlow === true", min: 2 },
  { file: "src/station/controls.mjs", needle: "state.relay?.fullFlow === true", min: 1 },
];
const checkOnly = process.argv.includes("--check");

function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesUnder(rel));
    } else if (entry.isFile()) {
      found.push(rel);
    } else {
      console.warn(`sync-plugin: skipping unsupported entry ${rel}`);
    }
  }
  return found;
}

function identical(src, dest) {
  try {
    return readFileSync(src).equals(readFileSync(dest));
  } catch {
    return false;
  }
}

function copyAll(drift) {
  for (const rel of drift) {
    const dest = join(TARGET, rel);
    mkdirSync(dirname(dest), { recursive: true });
    // Unlink first: a hard link would otherwise let the copy rewrite the source.
    rmSync(dest, { force: true });
    copyFileSync(join(ROOT, rel), dest);
  }
}

function fingerprintProblems() {
  return FINGERPRINTS.map(({ file, needle, min }) => {
    const path = join(TARGET, file);
    const hits = existsSync(path) ? readFileSync(path, "utf8").split(needle).length - 1 : 0;
    return hits >= min ? null : `${file} carries "${needle}" ${hits} time(s); needs ${min}`;
  }).filter(Boolean);
}

function driftUnder(root) {
  return RUNTIME_DIRS.flatMap(filesUnder).filter((rel) => !identical(join(root, rel), join(TARGET, rel)));
}

if (!existsSync(TARGET)) {
  console.error(`sync-plugin: no installed plugin at ${TARGET}`);
  console.error("Install it first, or set HERDCHESTRA_PLUGIN_DIR.");
  process.exit(1);
}

console.log(`sync-plugin: ${ROOT} -> ${TARGET}`);
const drift = driftUnder(ROOT);

for (const rel of drift) console.log(`  drift  ${rel}`);

if (checkOnly) {
  const problems = fingerprintProblems();
  for (const line of problems) console.log(`  stale  ${line}`);
  if (drift.length === 0 && problems.length === 0) console.log("in sync; fingerprints ok");
  process.exit(drift.length === 0 && problems.length === 0 ? 0 : 1);
}

if (drift.length > 0) {
  copyAll(drift);
  console.log(`copied ${drift.length} file(s)`);
  const remaining = driftUnder(ROOT);
  if (remaining.length > 0) {
    console.error(`sync-plugin: ${remaining.length} file(s) still differ after copy`);
    for (const rel of remaining) console.error(`  diff  ${rel}`);
    process.exit(1);
  }
} else {
  console.log("already in sync: 0 file(s) copied");
}

const problems = fingerprintProblems();
if (problems.length > 0) {
  console.error("sync-plugin: installed build is missing current code");
  for (const line of problems) console.error(`  stale  ${line}`);
  process.exit(1);
}

console.log("fingerprints ok: status.flow, reopened, fullFlow gates");
console.log("restart the session before relying on this build.");
