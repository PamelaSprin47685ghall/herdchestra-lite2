#!/usr/bin/env node
// Read-only-by-default compactor for an OMP session JSONL.
//
// A session log is one linear parentId chain. Every entry is replayed when the
// host rebuilds a branch, but the scope extension's own restore seals each
// domain at its newest complete baseline:
//
//   state   sealed by the newest checkpoint (isStateCheckpoint)
//   ledger  sealed by the newest entry whose `full === true`
//   amends  sealed by the newest entry that carries an `amends` array
//
// Entries below a seat for their domain are never read again. They are the only
// bytes this tool removes; messages, tool traffic, and non-state custom entries
// are copied byte for byte, and the entry skeleton (id, parentId, type,
// customType, timestamp) survives so the chain and every branch stay intact.
//
// Usage:
//   node tools/compact-session-jsonl.mjs <session.jsonl>            # report only
//   node tools/compact-session-jsonl.mjs <session.jsonl> --out f    # write a copy
//   node tools/compact-session-jsonl.mjs <session.jsonl> --out f --apply
//
// --out never overwrites its input; --apply renames the finished copy over the
// original only after the copy has been re-read and its sealed replay verified.

import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { isLedgerEntry, isStateCheckpoint } from "../src/scope/index.mjs";

const STATE_TYPE = "scope.state";

/** A tombstone keeps the node, its links, and its timestamp; only payload goes. */
function tombstone(entry) {
	return {
		type: entry.type,
		customType: entry.customType,
		id: entry.id,
		parentId: entry.parentId ?? null,
		...(entry.runtime === undefined ? {} : { runtime: entry.runtime }),
		timestamp: entry.timestamp,
		data: { version: 3, kind: "delta", ops: [], compacted: true },
	};
}

function domainOf(data) {
	if (!data || typeof data !== "object") return null;
	if (isLedgerEntry(data)) return "ledger";
	if (data.kind === "amends") return "amends";
	if (isStateCheckpoint(data)) return "state";
	return "state";
}

/** True when this entry is a complete baseline for its domain. */
function sealsDomain(entry, domain) {
	const data = entry.data;
	if (domain === "state") return isStateCheckpoint(data);
	if (domain === "ledger") return isLedgerEntry(data) && data.full === true;
	return Array.isArray(data?.amends);
}

/**
 * Classify one pass over the entries.
 *
 * `live` marks every entry the extension could still read: an entry is live
 * when a newer entry of its domain has not sealed the domain yet. Walking the
 * file once and recording the last seal per domain is enough, because the log
 * is a single chain: a seal below an entry hides that entry from every branch
 * that reaches the seal.
 */
export function classify(entries) {
	const seals = { state: -1, ledger: -1, amends: -1 };
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const domain = domainOf(entry.data);
		if (domain === null) continue;
		if (seals[domain] === -1 && sealsDomain(entry, domain)) seals[domain] = index; // newest baseline
	}
	return seals;
}

/** Indexes of state entries whose domain already has a newer baseline. */
export function deadIndexes(entries) {
	const seals = classify(entries);
	const dead = new Set();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const domain = domainOf(entry.data);
		if (domain === null) continue;
		const seal = seals[domain];
		if (seal !== -1 && index < seal) dead.add(index);
	}
	return dead;
}

async function loadEntries(file) {
	const entries = [];
	const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
	for await (const line of lines) {
		if (line.length === 0) continue;
		entries.push(JSON.parse(line));
	}
	return entries;
}

function bytesOf(value) {
	return Buffer.byteLength(JSON.stringify(value));
}

export function analyze(raw, entries) {
	const dead = deadIndexes(entries);
	let deadBytes = 0;
	let domain = { state: 0, ledger: 0, amends: 0 };
	for (const index of dead) {
		deadBytes += bytesOf(entries[index]);
		const key = domainOf(entries[index].data);
		if (key in domain) domain[key] += 1;
	}
	return { total: raw, dead: deadBytes, deadEntries: dead.size, domain };
}

export async function compact(input, output) {
	const raw = await readFile(input);
	const entries = await loadEntries(input);
	const dead = deadIndexes(entries);
	let out;
	if (dead.size === 0) {
		out = raw;
	} else {
		const kept = [];
		for (let index = 0; index < entries.length; index += 1) {
			kept.push(JSON.stringify(dead.has(index) ? tombstone(entries[index]) : entries[index]));
		}
		out = Buffer.from(`${kept.join("\n")}\n`, "utf8");
	}
	await writeFile(output, out);
	return { before: raw.length, after: out.length, dropped: dead.size };
}

/** Re-read the copy and prove its sealed replay matches the original's. */
export async function verify(input, output) {
	const [a, b] = [await loadEntries(input), await loadEntries(output)];
	if (a.length !== b.length) return { ok: false, reason: `entry count ${a.length} -> ${b.length}` };
	const dead = deadIndexes(a);
	for (let index = 0; index < a.length; index += 1) {
		const left = a[index];
		const right = b[index];
		const skeleton = (e) => [e.type, e.customType ?? null, e.id, e.parentId ?? null, e.timestamp].join("\u0000");
		if (skeleton(left) !== skeleton(right)) return { ok: false, reason: `skeleton differs at ${index}` };
		if (!dead.has(index) && JSON.stringify(left) !== JSON.stringify(right)) {
			return { ok: false, reason: `live entry rewritten at ${index}` };
		}
	}
	return { ok: true, dropped: dead.size };
}

async function main(argv) {
	const file = argv.find((arg) => !arg.startsWith("--"));
	if (!file) {
		process.stderr.write("usage: compact-session-jsonl <session.jsonl> [--out <path>] [--apply]\n");
		return 2;
	}
	const outIndex = argv.indexOf("--out");
	const out = outIndex === -1 ? null : argv[outIndex + 1];
	const raw = await readFile(file);
	const entries = await loadEntries(file);
	const report = analyze(raw.length, entries);
	const pct = report.total === 0 ? 0 : (report.dead / report.total) * 100;
	process.stdout.write(
		`entries=${entries.length} bytes=${report.total} reclaimable=${report.dead} (${pct.toFixed(1)}%) ` +
			`dead=${report.domain.state} state, ${report.domain.ledger} ledger, ${report.domain.amends} amends\n`,
	);
	if (!out) return 0;
	if (path.resolve(out) === path.resolve(file)) {
		process.stderr.write("refusing to write over the input; use --apply for that\n");
		return 2;
	}
	const result = await compact(file, out);
	process.stdout.write(`wrote ${out}: ${result.before} -> ${result.after} bytes\n`);
	const check = await verify(file, out);
	if (!check.ok) {
		process.stderr.write(`verification failed: ${check.reason}; copy left for inspection\n`);
		return 1;
	}
	process.stdout.write(`verified: skeleton and every live entry identical, dropped=${check.dropped}\n`);
	if (!argv.includes("--apply")) return 0;
	const backup = `${file}.bak`;
	await rename(file, backup);
	await rename(out, file);
	process.stdout.write(`applied; original kept at ${backup}\n`);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const code = await main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${error?.stack ?? error}\n`);
		return 1;
	});
	process.exitCode = code;
}
