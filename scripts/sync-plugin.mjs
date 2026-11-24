#!/usr/bin/env bun
/**
 * Install the plugin into the host's plugin directory.
 *
 * Three install shapes, and the script refuses to blur them:
 *
 * - **link** (`omp plugins link`): the installed path is a symlink at this
 *   working tree. The tree *is* the plugin, so the script prints the mode and
 *   writes nothing.
 * - **installed copy** (`omp plugins install <url>`): a real directory the host
 *   owns. It was installed and resolved by the host's own package manager, so
 *   the script treats it as read-only and says so.
 * - **vendor target**: a real directory this script was asked to fill. Only an
 *   explicit request selects it, because writing into a directory the host
 *   installed is how a sync once overwrote the repository's own package.json.
 *   The host package imports `herdchestra-lite2` by package name, so a vendor
 *   target gets two roots: the host package at the target root, and the core
 *   package under the target's `node_modules/`.
 *
 *   bun run sync:plugin                      report the mode; write only for a vendor target
 *   bun scripts/sync-plugin.mjs --vendor     install/refresh a copy, then verify
 *   bun scripts/sync-plugin.mjs --check      report mode and drift, change nothing
 *   HERDCHESTRA_PLUGIN_DIR=/path bun run sync:plugin
 *   HERDCHESTRA_SYNC=vendor bun run sync:plugin
 *
 * Exit code is 0 only when the install is inspectable and consistent: a link is
 * in sync by construction, an installed copy is not this script's to police,
 * and a vendor target must match the tree after the copy.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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
 * `src/prompts/index.mjs`, two levels up, and the six skills live under
 * `resources/skills/` so the core can inline their bodies into the system
 * prompt. The host package is the extension entry, so it owns the root
 * `package.json`. Skills are no longer a host asset; a stale plugin-root
 * `skills/` from an older vendor copy is removed below.
 */
const UNITS = [
  {
    name: "core",
    source: ROOT,
    dest: CORE_INSTALL,
    dirs: ["src", "resources"],
    stripPackageKeys: ["devDependencies", "scripts", "repository", "keywords"],
  },
  {
    name: "host",
    source: HOST_ROOT,
    dest: "",
    dirs: ["src"],
    stripPackageKeys: ["dependencies", "repository", "keywords"],
  },
];

const FINGERPRINTS = [
  { root: CORE_INSTALL, file: "src/relay/texts.mjs", needle: "status.flow", min: 1 },
  { root: CORE_INSTALL, file: "src/relay/texts.mjs", needle: 'case "reopened"', min: 1 },
  // The scope protocol is the three fork/join/return tools. The receipt chain
  // is gone, so no needle may depend on it. The tool catalog lives in the
  // core: the host package only loops over `engine.tools`.
  { root: CORE_INSTALL, file: "src/tools/catalog.mjs", needle: 'name: "scope_fork"', min: 1 },
  { root: CORE_INSTALL, file: "src/tools/catalog.mjs", needle: 'name: "scope_join"', min: 1 },
  { root: CORE_INSTALL, file: "src/tools/catalog.mjs", needle: 'name: "scope_return"', min: 1 },
];
const checkOnly = process.argv.includes("--check");
const vendorRequested =
  process.argv.includes("--vendor") || process.env.HERDCHESTRA_SYNC === "vendor";

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

/**
 * Directories an older vendor copy shipped where the current install no longer
 * does: the plugin-root `skills/`, and the nested core `skills/` an older core
 * copy carried. The current core keeps skills under `resources/skills/`.
 */
const LEGACY = ["skills", `${CORE_INSTALL}/skills`];

function legacyLeftovers() {
  const targetReal = realpathSync(TARGET);
  return LEGACY.filter((rel) => {
    const path = join(TARGET, rel);
    if (!existsSync(path)) return false;
    // Never follow a nested symlink out of the target: a development copy may
    // link `node_modules/herdchestra-lite2` at this working tree.
    const real = realpathSync(dirname(path));
    return real === targetReal || real.startsWith(`${targetReal}${sep}`);
  });
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

/**
 * The install comes in two shapes, and the sync owns only one of them.
 *
 * `omp plugin link` symlinks `TARGET` at this working tree: the tree is the
 * plugin, so there is nothing to copy, nothing to fingerprint, and no file the
 * sync may touch. Writing through that link is exactly what once rewrote the
 * repository's own `package.json`; this guard makes that impossible.
 *
 * A real directory is a copy install, and the sync owns its contents.
 */
function classifyTarget() {
  let stats;
  try {
    stats = lstatSync(TARGET);
  } catch {
    return { kind: "absent" };
  }
  if (!stats.isSymbolicLink()) return { kind: "copy" };
  const real = realpathSync(TARGET);
  return real === ROOT || real.startsWith(`${ROOT}${sep}`)
    ? { kind: "link", real }
    : { kind: "foreign-link", real };
}

const target = classifyTarget();

if (target.kind === "link") {
  console.log(`sync-plugin: link install -> ${target.real}`);
  console.log("the working tree is the plugin; nothing to copy");
  if (checkOnly) console.log("in sync (link install); nothing to check");
  process.exit(0);
}

if (target.kind === "foreign-link") {
  console.error(`sync-plugin: ${TARGET} links to ${target.real}, outside this repository`);
  console.error("That link is not this script's to replace; point it at host-omp/ or remove it.");
  process.exit(1);
}

if (!existsSync(TARGET)) {
  if (!vendorRequested) {
    console.error(`sync-plugin: no installed plugin at ${TARGET}`);
    console.error("Install it first: omp plugins install <url>, or omp plugins link from host-omp/.");
    console.error("To fill a directory by hand, pass --vendor.");
    process.exit(1);
  }
  // A fresh checkout has no host package yet: this package is private and is
  // not in a registry, so the vendor request is the install. Create the target
  // only when the host's plugin directory exists; a typo'd
  // HERDCHESTRA_PLUGIN_DIR must still fail instead of materializing a plugin
  // tree the host never scans.
  if (!existsSync(dirname(TARGET))) {
    console.error(`sync-plugin: no plugin directory at ${dirname(TARGET)}`);
    console.error("Set HERDCHESTRA_PLUGIN_DIR to the host's plugin directory.");
    process.exit(1);
  }
  mkdirSync(TARGET, { recursive: true });
  console.log(`vendor target created: ${TARGET}`);
}

if (!vendorRequested) {
  console.log(`sync-plugin: installed copy at ${TARGET}`);
  console.log("the host owns this directory; pass --vendor to fill it from this tree");
  if (checkOnly) console.log("not a vendor target; nothing to check");
  process.exit(0);
}

console.log(`sync-plugin: ${ROOT} -> ${TARGET}`);
const drift = collectDrift();
const extra = extraUnder();
const legacy = legacyLeftovers();

for (const { unit, rel } of drift) console.log(`  drift  ${join(unit.dest, rel)}`);
for (const { unit, rel } of extra) console.log(`  extra  ${join(unit.dest, rel)}`);
for (const rel of legacy) console.log(`  legacy ${rel}/`);

if (checkOnly) {
  const problems = fingerprintProblems();
  for (const line of problems) console.log(`  stale  ${line}`);
  if (drift.length === 0 && extra.length === 0 && legacy.length === 0 && problems.length === 0) {
    console.log("in sync; fingerprints ok");
  }
  process.exit(
    drift.length === 0 && extra.length === 0 && legacy.length === 0 && problems.length === 0 ? 0 : 1,
  );
}

if (extra.length > 0) {
  pruneAll(extra);
  console.log(`pruned ${extra.length} file(s)`);
}

for (const rel of legacy) {
  rmSync(join(TARGET, rel), { recursive: true, force: true });
  console.log(`removed legacy ${rel}/`);
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
