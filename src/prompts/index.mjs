/**
 * Prompt documents. Every model-facing string lives in a Markdown document
 * under resources/prompts/, split into `## section` blocks.
 *
 * The documents are read once, synchronously, on first use at module scope,
 * never inside a station method, so the station rule "no I/O in synchronous
 * state transitions" still holds. Each document becomes a frozen record.
 */

import { readFileSync } from "node:fs";

const ROOT = new URL("../../resources/prompts/", import.meta.url);
const cache = new Map();
const SECTION = /^## ([a-z][a-z0-9._-]*)\s*$/;
const DOC_NAME = /^[a-z0-9][a-z0-9._/-]*$/;

function fail(message, cause) {
	throw new Error(message, cause === undefined ? undefined : { cause });
}

/** Load one document and return its sections as a frozen record. */
export function loadDoc(name) {
	if (typeof name !== "string" || !DOC_NAME.test(name)) {
		throw new TypeError(`Invalid prompt document name: ${String(name)}`);
	}
	const cached = cache.get(name);
	if (cached !== undefined) return cached;

	let raw;
	try {
		raw = readFileSync(new URL(`${name}.md`, ROOT), "utf8");
	} catch (error) {
		throw fail(`Missing prompt document: ${name}.md`, error);
	}

	const sections = {};
	let current = null;
	let body = [];

	const flush = () => {
		if (current === null) return;
		const text = body.join("\n").trim();
		if (text === "") fail(`Empty prompt section: ${name}#${current}`);
		if (Object.prototype.hasOwnProperty.call(sections, current)) {
			fail(`Duplicate prompt section: ${name}#${current}`);
		}
		Object.defineProperty(sections, current, {
			value: text,
			enumerable: true,
			writable: false,
			configurable: false,
		});
	};

	for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
		const match = SECTION.exec(line);
		if (match) {
			flush();
			current = match[1];
			body = [];
			continue;
		}
		if (current !== null) body.push(line);
	}
	flush();

	if (Object.keys(sections).length === 0) {
		throw fail(`Prompt document has no sections: ${name}.md`);
	}
	const doc = Object.freeze(sections);
	cache.set(name, doc);
	return doc;
}

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Names of every placeholder a template expects. */
export function placeholderNames(template) {
	const names = new Set();
	for (const match of template.matchAll(PLACEHOLDER)) names.add(match[1]);
	return [...names];
}

/**
 * Fill {{name}} placeholders. A missing variable throws instead of rendering a
 * half sentence, because a silent gap is worse than a loud failure.
 */
export function render(template, vars = {}) {
	return template.replace(PLACEHOLDER, (_whole, key) => {
		if (!Object.prototype.hasOwnProperty.call(vars, key)) {
			throw new Error(`Missing prompt variable: ${key}`);
		}
		return String(vars[key]);
	});
}

/**
 * Every prompt document the extension ships. Kept in one list so activation
 * can load them all, instead of discovering a missing file mid-session on the
 * first tool call that needs it.
 */
export const DOCUMENTS = [
	"errors",
	"labels",
	"receipts/relay",
	"receipts/scope",
	"system",
	"tools/fork-join",
	"tools/notes",
	"tools/todo",
	"vibe-mode",
];

/** Load every document now; a missing file throws here, at startup. */
export function preloadDocs(names = DOCUMENTS) {
	for (const name of names) loadDoc(name);
	return names.length;
}
