// Machine-wide session catalog: normalization, id-addressed lookup and the
// real `tmux` + `omp --resume` launch plan.
//
// This module is pure: no I/O, no host imports. The manager process owns the
// machine-wide list; instances only supply raw records.

import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

const TMUX_NAME_PREFIX = "omp-";

function asString(value) {
	return typeof value === "string" ? value : "";
}

function timeOf(modified) {
	if (modified instanceof Date) {
		const time = modified.getTime();
		return Number.isFinite(time) ? time : 0;
	}
	if (typeof modified === "number") {
		return Number.isFinite(modified) ? modified : 0;
	}
	if (typeof modified === "string") {
		const time = Date.parse(modified);
		return Number.isFinite(time) ? time : 0;
	}
	return 0;
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, path: string, cwd: string, title: string, modified: string, messageCount: number }}
 */
export function normalizeSessionRecord(raw) {
	const record = raw && typeof raw === "object" ? raw : {};
	const messageCount = Number(record.messageCount);
	return {
		id: asString(record.id),
		path: asString(record.path),
		cwd: asString(record.cwd),
		title: asString(record.title),
		modified: record.modified instanceof Date || typeof record.modified === "number" ? record.modified : asString(record.modified),
		messageCount: Number.isFinite(messageCount) && messageCount > 0 ? Math.floor(messageCount) : 0,
	};
}

/**
 * Dedupe by real session id. One conversation may have several files (a
 * continuation is written next to the original), so the newest file wins and
 * keeps its own path and cwd.
 *
 * @param {unknown[]} records
 */
export function mergeMachineSessions(records) {
	const byId = new Map();
	for (const raw of Array.isArray(records) ? records : []) {
		const record = normalizeSessionRecord(raw);
		if (!record.id) continue;
		const existing = byId.get(record.id);
		if (!existing || timeOf(record.modified) > timeOf(existing.modified)) {
			byId.set(record.id, record);
		}
	}
	return [...byId.values()].sort((a, b) => {
		const delta = timeOf(b.modified) - timeOf(a.modified);
		return delta !== 0 ? delta : a.id.localeCompare(b.id);
	});
}

/**
 * Resolve a browser target. Only a session id is accepted; a file path is
 * never turned into a target, because the caller must not name files
 * directly.
 *
 * @param {ReturnType<typeof normalizeSessionRecord>[]} sessions
 * @param {unknown} sessionId
 */
export function resolveSessionTarget(sessions, sessionId) {
	if (typeof sessionId !== "string") return null;
	const id = sessionId.trim();
	if (!id || id.includes("/") || id.includes("\\")) return null;
	const list = Array.isArray(sessions) ? sessions : [];
	return list.find((session) => session.id === id) ?? null;
}

/** Stable eight-character tmux name, derived from the session id only. */
function tmuxSessionName(sessionId) {
	// FNV-1a 64-bit, base36, last eight characters: stable across processes and
	// free of characters tmux treats specially.
	let hash = 0xcbf29ce484222325n;
	const text = String(sessionId);
	for (let index = 0; index < text.length; index += 1) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	const name = hash.toString(36).padStart(8, "0").slice(-8);
	return `${TMUX_NAME_PREFIX}${name}`;
}

/** POSIX single-quote quoting: legal for any byte except NUL. */
function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function missingCwdError(session) {
	const error = new Error(`session ${session.id || "(unknown)"} has no recorded working directory`);
	error.code = "missing_cwd";
	return error;
}

/**
 * Build a detached tmux session in the conversation's original directory,
 * running the real omp binary and resuming the exact session file.
 *
 * The last argument is the command string handed to the login shell; every
 * interpolated path is single-quoted, so a session path or an omp path with
 * spaces and quotes cannot break out into shell syntax.
 *
 * @param {{ session: ReturnType<typeof normalizeSessionRecord>, ompPath?: string, shell?: string }} input
 */
function contextExport(contextPath) {
	if (contextPath === undefined) return "";
	if (typeof contextPath !== "string" || !isAbsolute(contextPath) || contextPath.includes("\0")) {
		throw Object.assign(new Error("invalid launch context path"), { code: "invalid_context_path" });
	}
	return `export OMP_UI_LAUNCH_CONTEXT=${shellQuote(contextPath)}; `;
}

function launchCommand({ ompPath, launchId, contextPath, args = "" }) {
	return `export OMP_UI_LAUNCH_ID=${shellQuote(launchId)}; ${contextExport(contextPath)}exec ${shellQuote(ompPath)}${args}`;
}

/** A fresh argv per call: both launch kinds share one tmux invocation shape. */
function tmuxArgs({ tmuxSession, cwd, shell, commandLine }) {
	return [
		"new-session", "-d", "-s", tmuxSession, "-c", cwd, shell, "-lc", commandLine,
		// Keep the session alive after the user attaches and detaches again:
		// a host-level `destroy-unattached on` would otherwise kill this omp.
		";", "set-option", "-t", tmuxSession, "destroy-unattached", "off",
	];
}

export function buildNewLaunch({ cwd, ompPath = "omp", shell = process.env.SHELL || "/bin/sh", contextPath, launchId = randomUUID() }) {
	if (!cwd) throw Object.assign(new Error("working directory is required"), { code: "missing_cwd" });
	if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) throw Object.assign(new Error("invalid working directory"), { code: "invalid_cwd" });
	const tmuxSession = tmuxSessionName(launchId);
	const commandLine = launchCommand({ ompPath, launchId, contextPath });
	return {
		launchId,
		contextPath,
		tmuxSession,
		cwd,
		command: "tmux",
		args: tmuxArgs({ tmuxSession, cwd, shell, commandLine }),
	};
}

export function buildResumeLaunch({ session, ompPath = "omp", shell = process.env.SHELL || "/bin/sh", contextPath, launchId = randomUUID() }) {
	const record = normalizeSessionRecord(session);
	const cwd = record.cwd;
	if (!cwd) throw missingCwdError(record);
	if (!record.path) {
		const error = new Error(`session ${record.id || "(unknown)"} has no session file path`);
		error.code = "missing_path";
		throw error;
	}
	const tmuxSession = tmuxSessionName(record.id || record.path);
	const commandLine = launchCommand({ ompPath, launchId, contextPath, args: ` --resume ${shellQuote(record.path)}` });
	return {
		launchId,
		contextPath,
		sessionId: record.id,
		tmuxSession,
		cwd,
		command: "tmux",
		args: tmuxArgs({ tmuxSession, cwd, shell, commandLine }),
	};
}
