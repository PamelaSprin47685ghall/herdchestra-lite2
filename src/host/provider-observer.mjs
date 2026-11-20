/**
 * Observe the provider payload hook without changing the request.
 *
 * The host emits before_provider_request with { type, payload }; its context
 * supplies the model. Later hooks or provider transport code can still change
 * the payload, so these observations are not a capture of the final wire.
 */
import { createHash } from "node:crypto";
import { record } from "./diagnostics.mjs";
import { captureRequestFrame, compareRequestFrames } from "./request-frames.mjs";

const APIS = new Set([
	"anthropic-messages",
	"openai-responses",
	"openai-codex-responses",
	"openai-completions",
	"google-generative-ai",
	"google-vertex",
]);
const OPENAI_CONTROLS = [
	"prompt_cache_retention", "prompt_cache_options", "cache_control",
	"reasoning", "reasoning_effort", "tool_choice", "parallel_tool_calls",
	"response_format", "text",
];
const ANTHROPIC_CONTROLS = [
	"cache_control", "thinking", "tool_choice", "output_config",
	"context_management", "anthropic_beta", "betas",
];
const GOOGLE_CONTROLS = [
	"cachedContent", "thinkingConfig", "toolConfig", "responseMimeType",
	"responseSchema", "responseJsonSchema",
];

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hash(value) {
	try {
		const text = JSON.stringify(value);
		if (typeof text !== "string") return null;
		return createHash("sha256").update(text, "utf8").digest("hex");
	} catch {
		return null;
	}
}

function select(source, names) {
	const result = {};
	for (const name of names) {
		if (Object.hasOwn(source, name) && source[name] !== undefined) result[name] = source[name];
	}
	return result;
}

// Only remove cache directives from known protocol locations. A schema can
// define an ordinary property named cache_control; that property must survive.
function contentRecord(value, path, directives) {
	if (!isObject(value)) return value;
	const result = { ...value };
	if (Object.hasOwn(result, "cache_control")) {
		if (result.cache_control !== undefined) directives.push({ path, value: result.cache_control });
		delete result.cache_control;
	}
	return result;
}

function contentList(values, path, directives, withContent = false) {
	if (!Array.isArray(values)) return values;
	return values.map((value, index) => {
		const itemPath = path + "[" + index + "]";
		const result = contentRecord(value, itemPath, directives);
		if (withContent && isObject(result) && Array.isArray(result.content)) {
			result.content = contentList(result.content, itemPath + ".content", directives);
		}
		return result;
	});
}

function unavailable(reason, format = null) {
	return { status: "unavailable", format, reason };
}

/** Project only the supported provider payload shapes seen at the host hook. */
export function projectProviderRequest(payload, model) {
	try {
		const api = model?.api;
		if (!APIS.has(api)) return { status: "unsupported", format: null, reason: "UNSUPPORTED_API" };
		if (!isObject(payload)) return unavailable("INVALID_PAYLOAD", api);

		const directives = [];
		let tools;
		let system;
		let messages;
		let controls;
		let partialReason = null;

		if (api === "google-generative-ai" || api === "google-vertex") {
			// The host hook receives GenerateContentParameters, before the
			// transport converts its config to the REST request body.
			const config = isObject(payload.config) ? payload.config : payload;
			tools = config.tools ?? [];
			system = config.systemInstruction ?? null;
			messages = payload.contents;
			controls = select(config, GOOGLE_CONTROLS);
			if (config.cachedContent != null) partialReason = "CACHED_CONTENT_REFERENCE";
		} else {
			tools = contentList(payload.tools ?? [], "tools", directives);
			if (api === "anthropic-messages") {
				system = Array.isArray(payload.system)
					? contentList(payload.system, "system", directives)
					: payload.system ?? null;
				messages = contentList(payload.messages, "messages", directives, true);
				controls = select(payload, ANTHROPIC_CONTROLS);
			} else if (api === "openai-completions") {
				// System/developer messages keep their positions in this API.
				system = null;
				messages = contentList(payload.messages, "messages", directives, true);
				controls = select(payload, OPENAI_CONTROLS);
			} else {
				system = payload.instructions ?? null;
				const input = typeof payload.input === "string" ? [payload.input] : payload.input;
				messages = contentList(input, "input", directives, true);
				controls = select(payload, OPENAI_CONTROLS);
				if (payload.previous_response_id != null) partialReason = "PREVIOUS_RESPONSE_REFERENCE";
				else if (payload.conversation != null) partialReason = "CONVERSATION_REFERENCE";
			}
		}

		if (!Array.isArray(tools) || !Array.isArray(messages)) return unavailable("INVALID_CONTENT_SHAPE", api);
		const wireModel = typeof payload.model === "string" ? payload.model : model?.id ?? null;
		if (typeof wireModel !== "string") return unavailable("MISSING_MODEL", api);

		return {
			status: "projected",
			format: api,
			history: partialReason ? "partial" : "full",
			partialReason,
			wireModelDiffers: typeof model?.id === "string" && wireModel !== model.id,
			projection: {
				namespace: {
					provider: model?.provider ?? null,
					providerType: model?.providerType ?? null,
					api,
					model: wireModel,
					baseUrl: model?.baseUrl ?? null,
					promptCacheKey: payload.prompt_cache_key ?? null,
					sessionId: payload.session_id ?? null,
				},
				tools,
				system,
				messages,
				cacheSettings: { controls, directives },
			},
		};
	} catch {
		return unavailable("PROJECTION_FAILED");
	}
}

function historyRevision(station) {
	try {
		const state = station.state ?? {};
		const epoch = state.epoch ?? 0;
		const collapses = Array.isArray(state.collapses) ? state.collapses : [];
		return hash({
			epoch,
			generation: state.relay?.generation ?? 0,
			hostBoundary: station.hostBoundaryKey ?? null,
			amends: Array.isArray(state.amends) ? state.amends : [],
			collapses: collapses
				.filter((item) => item?.collapsed !== false && (item?.epoch ?? 0) === epoch)
				.map((item) => ({
					begin: item.beginToolCallId ?? null,
					end: item.endToolCallId ?? null,
					report: item.report ?? null,
				})),
		});
	} catch {
		return null;
	}
}

function previousObservation(station) {
	// Flow stations inherit from the owner with Object.create. Never inherit
	// the owner's observation slot as the flow's previous request.
	return Object.hasOwn(station, "providerObservation") ? station.providerObservation : null;
}

/** Return only this station's latest safe reports, including normal changes. */
export function providerDiagnostics(station) {
	if (!station || typeof station !== "object") return [];
	const request = previousObservation(station)?.report;
	const response = Object.hasOwn(station, "providerResponse") ? station.providerResponse : null;
	return [request, response].filter(Boolean);
}

function firstDifference(before, after, comparison) {
	if (comparison.messages.equal) return null;
	const index = comparison.messages.commonMessages;
	return {
		index,
		before: before.messages[index] ?? null,
		after: after.messages[index] ?? null,
	};
}

/** Record one bounded, hash-only observation on the current station. */
export function observeProviderRequest(station, event, ctx) {
	const previous = previousObservation(station);
	const sequence = (previous?.sequence ?? 0) + 1;
	const revision = historyRevision(station);
	const projected = projectProviderRequest(event?.payload, ctx?.model);
	let frame = null;
	let classification = projected.status;
	let comparison = null;
	let difference = null;
	let revisionChanged = false;
	let reason = projected.reason ?? null;

	if (projected.status === "projected") {
		const captured = captureRequestFrame(projected.projection);
		if (captured.status !== "ready") {
			classification = "unavailable";
			reason = captured.reason;
		} else if (projected.history === "partial") {
			// A suffix cannot be compared with a complete prompt. It also
			// breaks the baseline for the next complete request.
			classification = "partial";
			reason = projected.partialReason;
		} else {
			frame = captured;
			classification = "baseline";
			if (previous?.frame?.status === "ready") {
				comparison = compareRequestFrames(previous.frame, frame);
				if (comparison.status === "compared") {
					difference = firstDifference(previous.frame, frame, comparison);
					revisionChanged = revision !== null && previous.revision !== null && revision !== previous.revision;
					if (!comparison.namespaceMatches) classification = "namespace-changed";
					else if (revisionChanged) classification = "context-rewritten";
					else if (!comparison.headMatches || !comparison.messages.previousIsPrefix) classification = "prefix-changed";
					else if (!comparison.settingsMatch) classification = "settings-changed";
					else classification = "prefix-preserved";
				} else {
					classification = "unavailable";
					reason = comparison.reason;
				}
			}
		}
	}

	const report = Object.freeze({
		layer: "provider",
		source: "before_provider_request",
		finalWire: false,
		sequence,
		classification,
		format: projected.format,
		history: projected.history ?? "unknown",
		reason,
		wireModelDiffers: projected.wireModelDiffers ?? false,
		historyRevisionChanged: revisionChanged,
		hashes: frame?.hashes ?? null,
		messageCount: frame?.messages.length ?? null,
		comparison,
		firstDifference: difference,
	});
	station.providerObservation = { sequence, revision, frame, report };
	if (["prefix-changed", "unavailable"].includes(classification)) {
		record("provider", "Provider payload observation: " + classification, report);
	}
	return report;
}

/**
 * The host emits this before consuming the response stream. It supplies no
 * reliable usage total or request-to-frame link, so do not invent either.
 */
export function observeProviderResponse(station, event) {
	const report = Object.freeze({
		layer: "provider",
		source: "after_provider_response",
		status: Number.isInteger(event?.status) ? event.status : null,
		requestIdHash: typeof event?.requestId === "string" ? hash(event.requestId) : null,
		correlated: false,
		usageAvailable: false,
	});
	station.providerResponse = report;
	return report;
}

/** Bind the real host events. Observer results must never replace payloads. */
export function wireProviderObservation(pi, registry) {
	pi.on("before_provider_request", (event, ctx) => {
		try {
			observeProviderRequest(registry.stationFor(ctx), event, ctx);
		} catch {
			record("provider", "Provider payload observation unavailable", {
				layer: "provider", source: "before_provider_request", reason: "OBSERVER_FAILED",
			});
		}
	});
	pi.on("after_provider_response", (event, ctx) => {
		try {
			observeProviderResponse(registry.stationFor(ctx), event);
		} catch {
			record("provider", "Provider response observation unavailable", {
				layer: "provider", source: "after_provider_response", reason: "OBSERVER_FAILED",
			});
		}
	});
}
