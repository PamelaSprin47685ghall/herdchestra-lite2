#!/usr/bin/env bun
/**
 * FOR DEV ONLY: publish this working tree to the ~/public sync drive, then
 * point this workstation's plugin path at the published copy.
 *
 * `~/public` is the shared drive described in ~/public/topo/index.html: write
 * once on this workstation, and every machine reads its own local copy. No
 * per-host scp, no vendor copy per machine.
 *
 * Paths are hardcoded for development on this workstation:
 *
 *   source   this repository
 *   publish  /home/kunweiz/public/herdchestra-lite2
 *   install  /home/kunweiz/.omp/plugins/node_modules/herdchestra-lite2
 *            (a symlink at the publish directory)
 *
 * The host loads the install path, so the publish directory is the live
 * plugin. This script never writes through a symlink into the repository:
 * the publish path must be a real directory that is neither inside this tree
 * nor an ancestor of it, and the install path must be a symlink (a real
 * directory there is a host-owned install and is refused, not replaced).
 *
 *   bun run sync:dev            publish, ensure the link, verify fingerprints
 *   bun run sync:dev -- --check report drift and link state; write nothing
 *
 * The published tree carries the two extension packages and nothing else; the
 * tests, scripts, and .git stay out. Both extension packages import the core
 * by the package name `herdchestra-lite2`, so the publish carries relative
 * links that resolve that name from either package root:
 *
 *   node_modules/herdchestra-lite2        -> ..
 *   host-omp/node_modules/herdchestra-lite2 -> ../..
 *
 * Relative links keep the sync drive usable on every machine, whatever the
 * home directory is named there.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PUBLISH_DIR = "/home/kunweiz/public/herdchestra-lite2";
const LINK_PATH = "/home/kunweiz/.omp/plugins/node_modules/herdchestra-lite2";
const checkOnly = process.argv.includes("--check");

/**
 * One publish unit: directories and files copied from `source` to
 * `PUBLISH_DIR/dest`, plus the package.json sanitized at that dest.
 * `requiredDirs` fail the publish when absent (a build was not run).
 */
const UNITS = [
  {
    name: "core",
    source: ROOT,
    dest: "",
    dirs: ["src", "resources"],
    files: ["README.md"],
    stripPackageKeys: ["devDependencies", "scripts", "repository", "keywords"],
  },
  {
    name: "host",
    source: join(ROOT, "host-omp"),
    dest: "host-omp",
    dirs: ["src"],
    files: ["README.md"],
    stripPackageKeys: ["repository", "keywords"],
  },
  {
    name: "ui",
    source: join(ROOT, "host-omp-ui"),
    dest: "host-omp-ui",
    dirs: ["src", "shared", "assets", "web/dist"],
    requiredDirs: ["web/dist"],
    stripPackageKeys: ["repository", "keywords", "scripts"],
  },
];

/** Relative package-name links inside the publish directory. */
const LINKS = [
  { path: "node_modules/herdchestra-lite2", target: ".." },
  { path: "host-omp/node_modules/herdchestra-lite2", target: "../.." },
];

/** Facts the published build must carry. Any miss means stale code shipped. */
const FINGERPRINTS = [
  { file: "src/station/domain/handoff.mjs", needle: "signed_sealed_hands_off_nothing_left_on_the_table", min: 1 },
  { file: "src/tools/catalog.mjs", needle: 'JS_TOOL_NAME = "js"', min: 1 },
  { file: "src/tools/catalog.mjs", needle: "name: JS_TOOL_NAME", min: 1 },
  { file: "src/tools/js-ticket.mjs", needle: "AsyncFunction", min: 1 },
  { file: "src/station/domain/capabilities.mjs", needle: "projectCapabilities", min: 1 },
  { file: "resources/prompts/system.md", needle: "scope_abandon", min: 1 },
  { file: "resources/prompts/system.md", needle: "scope_request", min: 0, max: 0 },
  { file: "resources/prompts/system.md", needle: "scope_ask", min: 0, max: 0 },
  { file: "resources/prompts/system.md", needle: "scope_send", min: 0, max: 0 },
  { file: "resources/prompts/features.md", needle: "testing.no-red", min: 1 },
  { file: "resources/prompts/features.md", needle: "scope.aggressive", min: 1 },
  { file: "resources/prompts/features.md", needle: "scope.hard", min: 1 },
  { file: "src/station/domain/capabilities.mjs", needle: 'featureScope === "hard"', min: 1 },
  { file: "src/features/herd/features.mjs", needle: 'fallback: "hard"', min: 1 },
  { file: "src/tools/js-protocol.mjs", needle: 'type: ["object", "array", "string"]', min: 1 },
  { file: "src/station/domain/fork-join.mjs", needle: "coerceComplex", min: 1 },
  { file: "src/features/herd/features.mjs", needle: "META_SKILLS_SENTINEL", min: 1 },
  { file: "resources/prompts/errors.md", needle: "duplicate-scope-path", min: 1 },
];

/** Facts about the working tree itself, which a published copy cannot carry. */
const TREE_FINGERPRINTS = [
  { file: "src/tools/js-ticket.mjs", needle: "> await AsyncFunction(", min: 1 },
  { file: "host-omp-ui/shared/tool-view.mjs", needle: "> await AsyncFunction(", min: 1 },
];

function filesUnder(base, dir) {
  const abs = join(base, dir);
  const found = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(base, rel));
    else if (entry.isFile()) found.push(rel);
    else console.warn(`sync-dev: skipping unsupported entry ${rel}`);
  }
  return found;
}

const sourcePathOf = (unit, rel) => join(unit.source, rel);
const destPathOf = (unit, rel) => join(PUBLISH_DIR, unit.dest, rel);

/** The sanitized package.json the publish must carry, or null when unmanaged. */
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

/** Every file the publish is missing or has stale: `{ unit, rel, content? }`. */
function collectDrift() {
  const drift = [];
  for (const unit of UNITS) {
    for (const dir of unit.dirs) {
      const abs = join(unit.source, dir);
      if (!existsSync(abs)) {
        if ((unit.requiredDirs ?? []).includes(dir)) {
          throw new Error(`missing ${abs}; run: cd host-omp-ui && bun run build:web`);
        }
        continue;
      }
      for (const rel of filesUnder(unit.source, dir)) {
        if (!identical(sourcePathOf(unit, rel), destPathOf(unit, rel))) drift.push({ unit, rel });
      }
    }
    for (const rel of unit.files ?? []) {
      if (!existsSync(sourcePathOf(unit, rel))) continue;
      if (!identical(sourcePathOf(unit, rel), destPathOf(unit, rel))) drift.push({ unit, rel });
    }
    const expected = expectedPackageJson(unit);
    if (expected === null) continue;
    const dest = join(PUBLISH_DIR, unit.dest, "package.json");
    if (!existsSync(dest) || readFileSync(dest, "utf8") !== expected) {
      drift.push({ unit, rel: "package.json", content: expected });
    }
  }
  return drift;
}

/** Files the publish carries that the source no longer ships. */
function extraUnder() {
  const extra = [];
  for (const unit of UNITS) {
    for (const dir of unit.dirs) {
      const destBase = join(PUBLISH_DIR, unit.dest, dir);
      if (!existsSync(destBase)) continue;
      for (const rel of filesUnder(join(PUBLISH_DIR, unit.dest), dir)) {
        if (!existsSync(sourcePathOf(unit, rel))) extra.push({ unit, rel });
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

/** Directories an older vendor copy shipped; never follow a symlink out. */
const LEGACY = ["skills"];

function legacyLeftovers() {
  return LEGACY.filter((rel) => {
    const path = join(PUBLISH_DIR, rel);
    try {
      return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function problemsFor(base, entries) {
  return entries
    .map(({ root = "", file, needle, min, max = Number.POSITIVE_INFINITY }) => {
      const path = join(base, root, file);
      const hits = existsSync(path) ? readFileSync(path, "utf8").split(needle).length - 1 : 0;
      if (hits >= min && hits <= max) return null;
      const wanted = max === Number.POSITIVE_INFINITY ? `at least ${min}` : `${min}-${max}`;
      return `${join(root, file)} carries "${needle}" ${hits} time(s); needs ${wanted}`;
    })
    .filter(Boolean);
}

/**
 * The publish path must be a real directory that is neither this repository
 * nor an ancestor/descendant of it. Writing through a symlink is exactly how
 * a sync once rewrote the repository's own package.json, so it is refused.
 */
function publishProblems({ allowMissing }) {
  let stats;
  try {
    stats = lstatSync(PUBLISH_DIR);
  } catch {
    return allowMissing ? [] : [`no publish directory at ${PUBLISH_DIR}`];
  }
  if (stats.isSymbolicLink()) return [`${PUBLISH_DIR} is a symlink; publish to a real directory`];
  if (!stats.isDirectory()) return [`${PUBLISH_DIR} is not a directory`];
  const real = realpathSync(PUBLISH_DIR);
  const rootReal = realpathSync(ROOT);
  if (real === rootReal) return ["the publish directory resolves to this repository"];
  if (real.startsWith(`${rootReal}${sep}`)) return ["the publish directory is inside this repository"];
  if (rootReal.startsWith(`${real}${sep}`)) return ["this repository is inside the publish directory"];
  return [];
}

/** The install path must be a symlink at the publish directory. */
function linkProblems() {
  let stats;
  try {
    stats = lstatSync(LINK_PATH);
  } catch {
    return [`no install at ${LINK_PATH}`];
  }
  if (!stats.isSymbolicLink()) {
    return [`${LINK_PATH} is a real directory; move it aside first (host-owned install)`];
  }
  let real;
  try {
    real = realpathSync(LINK_PATH);
  } catch {
    return [`${LINK_PATH} is a dangling symlink`];
  }
  const wanted = realpathSync(PUBLISH_DIR);
  return real === wanted ? [] : [`${LINK_PATH} points to ${real}, not ${wanted}`];
}

function ensureLinks() {
  for (const { path: rel, target } of LINKS) {
    const path = join(PUBLISH_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    try {
      const current = lstatSync(path);
      if (current.isSymbolicLink()) unlinkSync(path);
      else if (current.isDirectory()) {
        throw new Error(`${path} is a real directory; remove it before publishing`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    symlinkSync(target, path, "dir");
  }
}

function linkPublishDir() {
  const parent = dirname(LINK_PATH);
  if (!existsSync(parent)) {
    throw new Error(`no plugin directory at ${parent}; start omp once to create it`);
  }
  let stats;
  try {
    stats = lstatSync(LINK_PATH);
  } catch {
    stats = null;
  }
  if (stats && !stats.isSymbolicLink()) {
    throw new Error(`${LINK_PATH} is a real directory; move it aside first, then rerun`);
  }
  if (stats) unlinkSync(LINK_PATH);
  symlinkSync(PUBLISH_DIR, LINK_PATH, "dir");
  console.log(`linked ${LINK_PATH} -> ${PUBLISH_DIR}`);
}

// ---- run ------------------------------------------------------------------

console.log("sync-dev: FOR DEV ONLY — publishes to the ~/public sync drive");
console.log(`  source   ${ROOT}`);
console.log(`  publish  ${PUBLISH_DIR}`);
console.log(`  install  ${LINK_PATH}`);

const publishDirsMissing = !existsSync(PUBLISH_DIR);

if (checkOnly) {
  const problems = [
    ...publishProblems({ allowMissing: true }),
    ...linkProblems(),
    ...problemsFor(PUBLISH_DIR, FINGERPRINTS),
    ...problemsFor(ROOT, TREE_FINGERPRINTS),
  ];
  if (publishDirsMissing) {
    console.log(`publish directory missing: ${PUBLISH_DIR}`);
    process.exit(1);
  }
  const drift = collectDrift();
  const extra = extraUnder();
  const legacy = legacyLeftovers();
  for (const { unit, rel } of drift) console.log(`  drift  ${join(unit.dest, rel)}`);
  for (const { unit, rel } of extra) console.log(`  extra  ${join(unit.dest, rel)}`);
  for (const rel of legacy) console.log(`  legacy ${rel}/`);
  for (const line of problems) console.log(`  stale  ${line}`);
  const clean = drift.length === 0 && extra.length === 0 && legacy.length === 0 && problems.length === 0;
  console.log(clean ? "in sync; fingerprints ok" : "drift detected");
  process.exit(clean ? 0 : 1);
}

if (publishDirsMissing) {
  if (!existsSync(dirname(PUBLISH_DIR))) {
    console.error(`sync-dev: no sync drive at ${dirname(PUBLISH_DIR)}`);
    process.exit(1);
  }
  mkdirSync(PUBLISH_DIR, { recursive: true });
  console.log(`created publish directory: ${PUBLISH_DIR}`);
}

for (const line of publishProblems({ allowMissing: false })) {
  console.error(`sync-dev: ${line}`);
  process.exit(1);
}

const drift = collectDrift();
const extra = extraUnder();
const legacy = legacyLeftovers();

for (const { unit, rel } of drift) console.log(`  drift  ${join(unit.dest, rel)}`);
for (const { unit, rel } of extra) console.log(`  extra  ${join(unit.dest, rel)}`);
for (const rel of legacy) console.log(`  legacy ${rel}/`);

for (const { unit, rel } of extra) rmSync(destPathOf(unit, rel), { force: true });
if (extra.length > 0) console.log(`pruned ${extra.length} file(s)`);
for (const rel of legacy) {
  rmSync(join(PUBLISH_DIR, rel), { recursive: true, force: true });
  console.log(`removed legacy ${rel}/`);
}

copyAll(drift);
if (drift.length > 0) console.log(`copied ${drift.length} file(s)`);
else console.log("already in sync: 0 file(s) copied");

ensureLinks();
linkPublishDir();

const remaining = collectDrift();
if (remaining.length > 0) {
  console.error(`sync-dev: ${remaining.length} file(s) still differ after copy`);
  for (const { unit, rel } of remaining) console.error(`  diff  ${join(unit.dest, rel)}`);
  process.exit(1);
}

const problems = [...problemsFor(PUBLISH_DIR, FINGERPRINTS), ...problemsFor(ROOT, TREE_FINGERPRINTS)];
if (problems.length > 0) {
  console.error("sync-dev: published build is missing current code");
  for (const line of problems) console.error(`  stale  ${line}`);
  process.exit(1);
}

console.log("fingerprints ok: return oath, scope tools");
console.log("restart the session before relying on this build.");
