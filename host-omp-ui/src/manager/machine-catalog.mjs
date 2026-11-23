import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";

const FILE_CONCURRENCY = 8;
const JSONL_SUFFIX = ".jsonl";

/**
 * Index every session file under the given roots without opening a session.
 *
 * A root may contain session files directly or one level of bucket
 * directories. Reading stops at the first session header, so a large
 * transcript is never loaded. Corrupt files and missing roots become
 * diagnostics; they never reject the scan.
 *
 * @param {{ roots?: string[], extraDirs?: string[] }} options
 * @returns {Promise<{ sessions: Array<object>, diagnostics: Array<{path: string, code: string, message: string}> }>}
 */
export async function scanMachineSessions({ roots = [], extraDirs = [] } = {}) {
	const diagnostics = [];
	const files = new Set();

	for (const root of dedupePaths([...roots, ...extraDirs])) {
		await collectRoot(root, files, diagnostics);
	}

	const records = await mapLimit([...files].sort(), FILE_CONCURRENCY, readRecord);
	const groups = new Map();

	for (const record of records) {
		if (record.diagnostic) {
			diagnostics.push(record.diagnostic);
			continue;
		}
		const group = groups.get(record.session.id);
		if (group) group.push(record.session);
		else groups.set(record.session.id, [record.session]);
	}

	const sessions = [];
	for (const [id, group] of groups) {
		sessions.push(buildSession(id, group));
	}
	sessions.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
	diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));

	return { sessions, diagnostics };
}

function dedupePaths(paths) {
	const seen = new Set();
	const result = [];
	for (const path of paths) {
		if (typeof path !== "string" || path.length === 0) continue;
		const absolute = resolve(path);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		result.push(absolute);
	}
	return result;
}

async function collectRoot(root, files, diagnostics) {
	const info = await stat(root).catch(() => null);
	if (!info) {
		diagnostics.push(diagnostic(root, "missing_root", "session root does not exist"));
		return;
	}
	if (!info.isDirectory()) {
		diagnostics.push(diagnostic(root, "missing_root", "session root is not a directory"));
		return;
	}

	await scanDirectory(root, files, diagnostics, true);
}

async function collectBucket(path, files, diagnostics) {
	await scanDirectory(path, files, diagnostics, false);
}

async function scanDirectory(dir, files, diagnostics, descend) {
	const entries = await readEntries(dir, diagnostics);
	if (!entries) return;

	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		if (isJsonl(entry.name)) {
			files.add(resolve(dir, entry.name));
			continue;
		}
		if (descend && entry.isDirectory()) await collectBucket(resolve(dir, entry.name), files, diagnostics);
	}
}

async function readEntries(dir, diagnostics) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error) {
		diagnostics.push(diagnostic(dir, "unreadable", describe(error)));
		return null;
	}
}

async function readRecord(path) {
	const info = await lstat(path).catch((error) => ({ error }));
	if (info.error) return { diagnostic: diagnostic(path, "unreadable", describe(info.error)) };
	if (!info.isFile()) return { diagnostic: diagnostic(path, "unreadable", "entry is not a regular file") };

	let header;
	try {
		header = await readSessionHeader(path);
	} catch (error) {
		return { diagnostic: diagnostic(path, "unreadable", describe(error)) };
	}
	if (!header) return { diagnostic: diagnostic(path, "invalid_header", "no session header found") };

	return { session: { id: header.id, path, header, modified: Math.round(info.mtimeMs) } };
}

const HEADER_LOOKAHEAD_LINES = 16;
const FALLBACK_TITLE_LENGTH = 60;

async function readSessionHeader(path) {
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });

	let pendingTitle;
	let header;
	let linesAfterHeader = 0;

	try {
		for await (const line of lines) {
			const text = line.trim();
			if (text.length === 0) continue;

			let entry;
			try {
				entry = JSON.parse(text);
			} catch {
				continue;
			}

			// Some sessions carry the title in a standalone top-level entry
			// instead of the session header. Keep the first non-empty one.
			if (pendingTitle === undefined && entry?.type === "title") {
				const title = cleanTitle(entry.title);
				if (title) pendingTitle = title;
			}
			if (pendingTitle === undefined && entry?.type === "session_info") {
				const title = cleanTitle(entry.name ?? entry.title);
				if (title) pendingTitle = title;
			}

			if (isSessionHeader(entry)) {
				header = entry;
				if (cleanTitle(header.title)) return header;
				if (pendingTitle) return { ...header, title: pendingTitle };
				continue;
			}

			if (!header) continue;

			// A title entry can also follow the header in older files.
			if (entry?.type === "title") {
				const title = cleanTitle(entry.title);
				if (title) return { ...header, title };
			}

			linesAfterHeader += 1;
			if (linesAfterHeader > HEADER_LOOKAHEAD_LINES) break;

			// Last resort: a real user message, never an agent-injected one.
			if (entry?.type === "message" && entry.message?.role === "user" && entry.message?.attribution === "user" && entry.message?.synthetic !== true) {
				const title = cleanTitle(messageText(entry.message.content));
				if (title) return { ...header, title };
			}
		}

		if (!header) return null;
		return pendingTitle && !cleanTitle(header.title) ? { ...header, title: pendingTitle } : header;
	} finally {
		lines.close();
		stream.destroy();
	}
}

function cleanTitle(value) {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, FALLBACK_TITLE_LENGTH);
}

function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
}

function isSessionHeader(entry) {
	return (
		entry !== null &&
		typeof entry === "object" &&
		entry.type === "session" &&
		typeof entry.id === "string" &&
		entry.id.length > 0
	);
}

function buildSession(id, group) {
	const referenced = new Set();
	for (const file of group) {
		const ref = stringOrUndefined(file.header.continuationOf)?.trim();
		if (!ref) continue;
		for (const candidate of group) {
			if (candidate.path !== file.path && references(candidate, ref)) referenced.add(candidate.path);
		}
	}

	const unreferenced = group.filter((file) => !referenced.has(file.path));
	const canonical = [...(unreferenced.length > 0 ? unreferenced : group)].sort(compareRecency)[0];
	const header = canonical.header;

	return {
		id,
		path: canonical.path,
		cwd: nonEmptyString(header.cwd),
		title: stringOrUndefined(header.title),
		modified: canonical.modified,
		origin: stringOrUndefined(header.origin),
		continuationOf: stringOrUndefined(header.continuationOf),
		previousPaths: group
			.filter((file) => file.path !== canonical.path)
			.map((file) => file.path)
			.sort(),
	};
}

function references(candidate, ref) {
	const name = basename(candidate.path);
	const stem = name.endsWith(JSONL_SUFFIX) ? name.slice(0, -JSONL_SUFFIX.length) : name;

	if (ref === name || ref === stem || ref === candidate.header.id) return true;
	return ref.length >= 8 && (name.startsWith(ref) || stem.startsWith(ref));
}

function compareRecency(a, b) {
	return b.modified - a.modified || a.path.localeCompare(b.path);
}

function isJsonl(name) {
	return name.endsWith(JSONL_SUFFIX);
}

function nonEmptyString(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function stringOrUndefined(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function diagnostic(path, code, message) {
	return { path, code, message };
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

async function mapLimit(items, limit, mapper) {
	const results = new Array(items.length);
	let cursor = 0;

	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await mapper(items[index], index);
		}
	});

	await Promise.all(workers);
	return results;
}
