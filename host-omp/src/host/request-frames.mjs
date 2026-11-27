/**
 * Observe the cache-related parts of one prepared provider request.
 *
 * The host adapter supplies this projection after its last content conversion.
 * It must include the complete tool definitions, not only tool names. It puts
 * cache directives in cacheSettings and leaves unrelated HTTP metadata out.
 *
 * A frame holds hashes only. The caller owns its lifetime. This module keeps
 * no request history and makes no claim about a provider's actual cache hits.
 */
import { createHash } from "node:crypto";
import { isObject } from "./object-read.mjs";

const FIELDS = Object.freeze([
	"namespace",
	"tools",
	"system",
	"messages",
	"cacheSettings",
]);
const HASH = /^[a-f0-9]{64}$/;

function unavailable(field, reason) {
	return Object.freeze({ status: "unavailable", field, reason });
}

function digest(value) {
	const text = JSON.stringify(value);
	if (typeof text !== "string") throw new TypeError("Value has no JSON form");
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Capture an immutable frame from an explicit provider projection.
 *
 * namespace contains the effective provider, model, API, and cache route.
 * tools contains the full provider tool definitions in their sent order.
 * system contains the provider's system or instructions value, or null.
 * messages contains the provider's ordered conversation values.
 * cacheSettings contains cache-only directives, or null.
 *
 * Array and object property order are preserved. A changed hash is evidence
 * of a changed projection, not proof of a cache miss.
 */
export function captureRequestFrame(input) {
	if (!isObject(input)) return unavailable("request", "INVALID_PROJECTION");

	const values = {};
	for (const field of FIELDS) {
		try {
			if (!Object.hasOwn(input, field)) return unavailable(field, "MISSING_FIELD");
			values[field] = input[field];
		} catch {
			return unavailable(field, "READ_FAILED");
		}
	}
	if (!isObject(values.namespace)) return unavailable("namespace", "INVALID_NAMESPACE");
	if (!Array.isArray(values.tools)) return unavailable("tools", "INVALID_TOOLS");
	if (!Array.isArray(values.messages)) return unavailable("messages", "INVALID_MESSAGES");

	const hashes = {};
	for (const field of ["namespace", "tools", "system", "cacheSettings"]) {
		try {
			hashes[field] = digest(values[field]);
		} catch {
			return unavailable(field, "SERIALIZE_FAILED");
		}
	}

	const messages = [];
	for (let index = 0; index < values.messages.length; index += 1) {
		try {
			messages.push(digest(values.messages[index]));
		} catch {
			return unavailable("messages", `SERIALIZE_FAILED_AT_${index}`);
		}
	}

	return Object.freeze({
		status: "ready",
		hashes: Object.freeze(hashes),
		messages: Object.freeze(messages),
	});
}

function validFrame(frame) {
	try {
		if (frame?.status !== "ready" || !isObject(frame.hashes)) return false;
		if (!Array.isArray(frame.messages)) return false;
		for (const field of ["namespace", "tools", "system", "cacheSettings"]) {
			if (typeof frame.hashes[field] !== "string" || !HASH.test(frame.hashes[field])) return false;
		}
		for (const value of frame.messages) {
			if (typeof value !== "string" || !HASH.test(value)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Compare two captured requests without inferring provider cache behavior.
 *
 * The common prefix is measured in complete messages. Namespace and cache
 * settings have separate results, so a route change or a moved cache boundary
 * cannot be confused with a change to the conversation text.
 */
export function compareRequestFrames(before, after) {
	if (!validFrame(before)) return unavailable("before", "FRAME_UNAVAILABLE");
	if (!validFrame(after)) return unavailable("after", "FRAME_UNAVAILABLE");

	const changedFields = [];
	for (const field of ["namespace", "tools", "system", "cacheSettings"]) {
		if (before.hashes[field] !== after.hashes[field]) changedFields.push(field);
	}

	let commonMessages = 0;
	const limit = Math.min(before.messages.length, after.messages.length);
	while (commonMessages < limit && before.messages[commonMessages] === after.messages[commonMessages]) {
		commonMessages += 1;
	}
	const equalMessages =
		commonMessages === before.messages.length &&
		commonMessages === after.messages.length;
	if (!equalMessages) changedFields.push("messages");

	return Object.freeze({
		status: "compared",
		changedFields: Object.freeze(changedFields),
		namespaceMatches: before.hashes.namespace === after.hashes.namespace,
		headMatches:
			before.hashes.tools === after.hashes.tools &&
			before.hashes.system === after.hashes.system,
		settingsMatch: before.hashes.cacheSettings === after.hashes.cacheSettings,
		messages: Object.freeze({
			commonMessages,
			beforeMessages: before.messages.length,
			afterMessages: after.messages.length,
			previousIsPrefix: commonMessages === before.messages.length,
			equal: equalMessages,
		}),
	});
}
