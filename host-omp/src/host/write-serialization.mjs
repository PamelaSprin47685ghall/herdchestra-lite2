// Write serialization: one process-wide FIFO barrier over file-writing tools.
//
// The host's edit tool reads, replaces, then writes. Two concurrent edits of one
// file both read the old content, so the later write silently discards the
// earlier one while both calls report success. Nothing on the dispatch chain
// serialized them; this queue does now.
//
// One queue instance belongs to one process, not to a gateway and not to an
// agent: every scope in one process shares these files, and a per-agent or
// per-context lock would let two scopes race the same path. The module exports
// the default instance's `serializeWrite`, so callers that never build a queue
// share exactly one, while a test can build its own and inspect it.
//
// Four properties carry the correctness, and each one costs something:
//   - A write whose targets cannot be named takes the exclusive key, never a
//     guess. A guess under-locks, and a lost update is silent.
//   - The queue is one FIFO list, not one chain per key. An exclusive write can
//     wait for every earlier write, and every later write waits for it. Nothing
//     starves, because a queued call only ever waits on calls ahead of it.
//   - One set of running entries is the single source of truth for who holds
//     what. A call checks that set, not a parallel tally that could drift.
//   - A write dispatched from inside a running write runs at once when the outer
//     call already holds every one of its targets, and otherwise queues while
//     ignoring its own ancestors. Nesting therefore never blocks on itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/** Tool names that write files. Any other name is dispatched untouched. */
const WRITE_TOOLS = new Set(["edit", "write", "ast_edit", "apply_patch", "manage_skill"]);

/** The key of a write whose targets cannot be named: it excludes every other write. */
export const EXCLUSIVE = "*";

/** True when this tool name can write a file and must take the lock. */
export function isWriteTool(name) {
	return WRITE_TOOLS.has(name);
}

/** A stable abort error for a call cancelled before it ran. */
export function abortedError(signal) {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error("Tool call aborted before it ran.");
	error.name = "AbortError";
	error.code = "TOOL_ABORTED";
	return error;
}

function isFile(target) {
	try {
		return fs.statSync(target).isFile();
	} catch {
		return false;
	}
}

/**
 * The canonical form of an existing path, or of its deepest existing parent.
 *
 * Mirrors the host's own mutation-queue key: a symlink and its target must share
 * one lock, and a file that does not exist yet still canonicalizes through the
 * parent directory that does.
 */
function canonicalize(target) {
	try {
		return fs.realpathSync.native(target);
	} catch {
		let current = target;
		const segments = [];
		for (;;) {
			const parent = path.dirname(current);
			if (parent === current) return target;
			segments.unshift(path.basename(current));
			try {
				return path.join(fs.realpathSync.native(parent), ...segments);
			} catch {
				current = parent;
			}
		}
	}
}

/**
 * The lock key for one target path, or null when it cannot be named.
 *
 * A null is never replaced by the process cwd: that base is wrong for any
 * session whose cwd differs, and it would key one file under two locks. A
 * `~user` path is null for the same reason: this process cannot know that home
 * directory, so guessing one would key the file under a path it does not have.
 */
export function normalizeTargetPath(raw, cwd) {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	// An internal URL (local://, ssh://, archive://, sqlite://) is not a file
	// path; its own text is the stable key, so equal URLs collide by design.
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return `url:${trimmed}`;
	const base = typeof cwd === "string" && cwd.trim() !== "" ? cwd : null;
	let expanded = trimmed;
	if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
		expanded = os.homedir() + expanded.slice(1);
	} else if (/^~[^/\\]/.test(expanded)) {
		// `~user` names another account's home. Its real path is unknown here, and
		// resolving it under the cwd would invent a key no other call shares.
		return null;
	}
	// A bare root is the host's workspace-root alias, which means the cwd.
	if (expanded === "/" || expanded === "//") return base ? canonicalize(path.resolve(base)) : null;
	const isDrive = /^[A-Za-z]:[\\/]/.test(expanded);
	const isAbsolute = isDrive || expanded.startsWith("/");
	let resolved;
	if (isDrive && process.platform !== "win32") {
		resolved = expanded;
	} else if (isAbsolute) {
		resolved = path.resolve(expanded);
	} else {
		if (!base) return null;
		resolved = path.resolve(base, expanded);
	}
	// `<container>:<member>` names an archive member or a SQLite row. The member
	// is not a file, so two members of one container must share the container's
	// lock or they race inside it.
	if (!isDrive) {
		const at = resolved.indexOf(":");
		if (at > 0) {
			const container = resolved.slice(0, at);
			const member = resolved.slice(at + 1);
			if (member !== "" && !isFile(resolved) && isFile(container)) {
				return canonicalize(container);
			}
		}
	}
	return canonicalize(resolved);
}

const PATCH_FILE_HEADER = /^\*\*\*[ \t]+(?:Add|Update|Delete) File:[ \t]*(.*)$/;
const PATCH_MOVE_HEADER = /^\*\*\*[ \t]+Move to:[ \t]*(.*)$/;
const PATCH_KNOWN_HEADER = /^\*\*\*[ \t]+(?:Begin Patch|End Patch|End of File)[ \t]*$/;
const HASHLINE_HEADER = /^\[([^\]#\r\n]+)#[0-9a-fA-F]{4,}\][ \t]*$/;
// The host's hashline grammar puts `MV` on its own line; leading space is allowed
// because a move inside a nested block is still a move to that file.
const HASHLINE_MOVE = /^[ \t]*MV[ \t]+(.+)$/;

/**
 * The target paths a `{ input }` patch names, or null when they cannot be read.
 *
 * A null means "unreadable", not "no targets": the caller then takes the
 * exclusive key. Sloppy patches and unknown `***` directives return null on
 * purpose — their grammar lives in the host's native parser, and a guessed
 * regex would under-lock on some variant.
 */
export function extractInputPaths(input) {
	if (typeof input !== "string") return null;
	if (/\*\*\*[ \t]*Replace Block:/.test(input) || /\*\*\*[ \t]*Find/.test(input)) return null;
	const paths = [];
	let sawHeader = false;
	let hashline = false;
	for (const line of input.split(/\r?\n/)) {
		const file = PATCH_FILE_HEADER.exec(line);
		if (file) {
			sawHeader = true;
			const target = file[1].trim();
			if (target === "") return null;
			paths.push(target);
			continue;
		}
		const move = PATCH_MOVE_HEADER.exec(line);
		if (move) {
			sawHeader = true;
			const target = move[1].trim();
			if (target === "") return null;
			paths.push(target);
			continue;
		}
		const header = HASHLINE_HEADER.exec(line);
		if (header) {
			sawHeader = true;
			hashline = true;
			paths.push(header[1].trim());
			continue;
		}
		if (hashline) {
			const mv = HASHLINE_MOVE.exec(line);
			if (mv) {
				const target = mv[1].trim();
				if (target === "") return null;
				paths.push(target);
				continue;
			}
		}
		if (line.startsWith("***") && !PATCH_KNOWN_HEADER.test(line)) return null;
	}
	if (!sawHeader || paths.length === 0) return null;
	return paths;
}

/** Path metacharacters: a glob or a pattern cannot be mapped to one lock. */
const GLOB_METACHARS = /[*?\[\]{}]/;

function astFootprint(args, cwd) {
	const paths = args?.paths;
	if (!Array.isArray(paths) || paths.length === 0) return null;
	const keys = new Set();
	for (const raw of paths) {
		if (typeof raw !== "string") return null;
		const trimmed = raw.trim();
		if (GLOB_METACHARS.test(trimmed)) return null;
		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return null;
		const key = normalizeTargetPath(trimmed, cwd);
		if (!key || key.startsWith("url:")) return null;
		// A directory, a glob expansion, or a missing file all mean the tool may
		// write anything below it; only a single existing file can be locked.
		if (!isFile(key)) return null;
		keys.add(key);
	}
	return [...keys].sort();
}

function editFootprint(args, cwd) {
	const rawPath = typeof args?.path === "string" && args.path.trim() !== "" ? args.path : null;
	let raws = null;
	if (rawPath !== null) {
		raws = [rawPath];
		// A patch entry may rename or move to a second file; both are targets.
		if (Array.isArray(args?.edits)) {
			for (const edit of args.edits) {
				if (!edit || typeof edit !== "object") continue;
				for (const field of ["rename", "move", "to", "path"]) {
					const value = edit[field];
					if (typeof value === "string" && value.trim() !== "") raws.push(value);
				}
			}
		}
	} else if (typeof args?.input === "string" && args.input.trim() !== "") {
		raws = extractInputPaths(args.input);
	}
	if (raws === null || raws.length === 0) return null;
	const keys = new Set();
	for (const raw of raws) {
		const key = normalizeTargetPath(raw, cwd);
		if (!key) return null;
		keys.add(key);
	}
	return [...keys].sort();
}

/**
 * What one write call must hold: `{ exclusive, keys }`.
 *
 * `exclusive` means the call may touch any file, so it holds the whole queue.
 * An unknown write tool is always exclusive, so adding a tool name can
 * over-serialize but never under-lock.
 */
export function targetKeys(name, args, cwd) {
	if (name === "manage_skill") return { exclusive: true, keys: [] };
	if (name === "ast_edit") {
		const keys = astFootprint(args, cwd);
		return keys ? { exclusive: false, keys } : { exclusive: true, keys: [] };
	}
	if (name === "write") {
		const key = normalizeTargetPath(args?.path, cwd);
		return key ? { exclusive: false, keys: [key] } : { exclusive: true, keys: [] };
	}
	if (name === "edit" || name === "apply_patch") {
		const keys = editFootprint(args, cwd);
		return keys ? { exclusive: false, keys } : { exclusive: true, keys: [] };
	}
	return { exclusive: true, keys: [] };
}

/**
 * One write queue: the mutable half of this module, owned by exactly one value.
 *
 * The entries waiting (`queue`), the entries running (`activeEntries`), and the
 * held-entry storage (`HELD`) are the queue's whole state. They live in this
 * closure so no second copy can appear and so a test can build a queue it owns.
 */
export function createWriteQueue() {
	/** The write this task already runs inside, if any. */
	const HELD = new AsyncLocalStorage();

	/** The ancestor set of a top-level write: nothing to ignore. */
	const NO_ANCESTORS = new Set();

	/** Entries waiting for their turn, in arrival order. */
	const queue = [];

	/** Every entry now running. This set is the only record of who holds what. */
	const activeEntries = new Set();

	/** True when these two entry footprints may not run at the same time. */
	function footprintsConflict(left, right) {
		if (left.exclusive || right.exclusive) return true;
		for (const key of left.keys) if (right.keySet.has(key)) return true;
		return false;
	}

	/** True when `outer` already holds every target of `inner`. */
	function covers(outer, inner) {
		if (outer.exclusive) return true;
		if (inner.exclusive) return false;
		for (const key of inner.keys) if (!outer.keySet.has(key)) return false;
		return true;
	}

	function launch(entry) {
		if (entry.detach) entry.detach();
		activeEntries.add(entry);
		let result;
		try {
			// A write this task dispatches from inside `run` inherits the held entry, so
			// it can decide whether the outer call already covers its targets.
			result = Promise.resolve(HELD.run(entry, entry.run));
		} catch (error) {
			result = Promise.reject(error);
		}
		const release = () => {
			activeEntries.delete(entry);
			drain();
		};
		result.then(entry.resolve, entry.reject).then(release, release);
	}

	/**
	 * Start every queued write that conflicts with nothing ahead of it.
	 *
	 * The scan keeps a running footprint of the entries it passed, so one call can
	 * neither overtake an earlier call on the same file nor starve behind an
	 * exclusive one. That is the whole fairness argument: order is arrival order per
	 * resource, and each pass launches the longest prefix that is free. A nested call
	 * skips only its own ancestors, so it waits for every sibling write yet never for
	 * the write that dispatched it.
	 */
	function drain() {
		const blocked = [...activeEntries];
		let index = 0;
		while (index < queue.length) {
			const entry = queue[index];
			let conflicts = false;
			for (const other of blocked) {
				if (entry.ancestors.has(other)) continue;
				if (footprintsConflict(entry, other)) {
					conflicts = true;
					break;
				}
			}
			if (conflicts) {
				blocked.push(entry);
				index += 1;
				continue;
			}
			queue.splice(index, 1);
			launch(entry);
			blocked.push(entry);
		}
	}

	/**
	 * Run one write behind this queue.
	 *
	 * A call whose signal is already aborted is refused here and never reaches the
	 * disk. A queued call whose signal aborts leaves the queue at once, so the calls
	 * behind it are not held by a cancelled one.
	 */
	function serializeWrite(name, args, cwd, run, signal) {
		if (signal?.aborted) return Promise.reject(abortedError(signal));
		const footprint = targetKeys(name, args, cwd);
		const keySet = new Set(footprint.keys);
		const held = HELD.getStore();
		// The outer write holds every target of this one, so running now keeps the
		// order the outer call already owns and cannot deadlock.
		if (held && covers(held, { exclusive: footprint.exclusive, keys: footprint.keys, keySet })) {
			try {
				return Promise.resolve(run());
			} catch (error) {
				return Promise.reject(error);
			}
		}
		const ancestors = held ? new Set([...held.ancestors, held]) : NO_ANCESTORS;
		return new Promise((resolve, reject) => {
			const entry = {
				exclusive: footprint.exclusive,
				keys: footprint.keys,
				keySet,
				ancestors,
				run,
				resolve,
				reject,
				detach: null,
			};
			if (signal && typeof signal.addEventListener === "function") {
				const onAbort = () => {
					const at = queue.indexOf(entry);
					if (at === -1) return;
					queue.splice(at, 1);
					entry.detach();
					reject(abortedError(signal));
					drain();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				entry.detach = () => signal.removeEventListener("abort", onAbort);
			}
			queue.push(entry);
			drain();
		});
	}

	return { serializeWrite };
}

/** The one process-wide queue. Every caller that never builds a queue shares it. */
const defaultQueue = createWriteQueue();

/**
 * Run one write behind the process-wide queue.
 *
 * This is the default instance's method, exported for callers that do not need
 * their own queue; the behavior is the module's single queue, unchanged.
 */
export const serializeWrite = defaultQueue.serializeWrite;
