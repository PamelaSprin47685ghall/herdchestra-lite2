/**
 * Async tickets: the only place `await` is allowed.
 *
 * Each ticket carries one complete async flow and returns a Promise. Stations
 * (SessionStation) stay synchronous; they call these through the injected
 * `tickets` capability bundle at wiring time. Tickets call station sync
 * methods for every state transition and never hold shared state of their own.
 */

import { errorResult, textResult } from "./results.mjs";
import { sendSlashPrompt, sessionFor } from "../host/capture.mjs";
import { modelFrom, modelOf, thinkingFrom, thinkingOf } from "../host/adapter.mjs";
import { record } from "../host/diagnostics.mjs";

import { loadDoc, render } from "../prompts/index.mjs";

const errors = loadDoc("errors");

function safeSession(ctx) {
	try {
		return sessionFor(ctx);
	} catch {
		return null;
	}
}

/** Fire-and-forget steer delivery. The scope result already reports the send. */
export async function sendSteerTicket(pi, text) {
	if (!text) return;
	try {
		await pi?.sendUserMessage?.(text, { deliverAs: "steer" });
	} catch (error) {
		// Steer delivery stays best-effort: it never escapes as an unhandled
		// rejection. But a nudge the model never receives looks exactly like an
		// idle model, so the failure must leave a trace.
		record("tickets", error, { kind: "steer", chars: text.length });
	}
}

/**
 * Fire-and-forget user-message delivery. A plain message without `deliverAs`
 * always starts one turn, which is what `/herd <text>` promises.
 */
export async function sendUserMessageTicket(pi, text) {
	if (!text) return;
	try {
		await pi?.sendUserMessage?.(text);
	} catch (error) {
		// A host that rejects the message must not leak an unhandled rejection,
		// but `/herd <text>` promises the user one turn: losing that message in
		// silence is the worst outcome, so it is recorded instead.
		record("tickets", error, { kind: "prompt", chars: text.length });
	}
}

/**
 * before_agent_start ticket: reactivate `todo` for a read-write subagent, then
 * report the injected system prompt (or undefined when unchanged).
 */
export async function activateToolsTicket(pi, activeTools, prompt, promptChanged) {
	if (typeof pi?.setActiveTools === "function") {
		const next = Array.isArray(activeTools) ? [...activeTools] : [];
		if (!next.includes("todo")) next.push("todo");
		try {
			await pi.setActiveTools(next);
		} catch (error) {
			// A host without tool activation keeps its own tool set, and
			// `todoReady()` turns the relay off. Record why the grant failed so
			// the reason is not guessed from the symptom.
			record("tools", error, { requested: next.length });
		}
	}
	return promptChanged ? { systemPrompt: prompt } : undefined;
}

const THINKING_SUFFIX =
	/(?:\s*[:@]\s*|\s+)(off|minimal|low|medium|high|xhigh)\s*$/i;

function splitThinkingSuffix(text) {
	const value = String(text ?? "").trim();
	const match = THINKING_SUFFIX.exec(value);
	if (!match) return { model: value, thinking: null };
	return {
		model: value.slice(0, match.index).trim(),
		thinking: match[1].toLowerCase(),
	};
}

function normalizedKey(value) {
	return String(value ?? "").trim().toLowerCase();
}

function modelKeyOf(model) {
	if (typeof model === "string") return model.trim() || null;
	if (!model || typeof model !== "object") return null;
	const id = model.id ?? model.model;
	if (typeof id !== "string" || !id) return null;
	return model.provider ? `${model.provider}/${id}` : id;
}

function modelIdentifiers(model) {
	const key = modelKeyOf(model);
	if (!key) return [];
	const ids = new Set([key]);
	if (model && typeof model === "object") {
		const id = model.id ?? model.model;
		const provider = model.provider;
		if (typeof id === "string" && id) {
			ids.add(id);
			if (provider) ids.add(`${provider}/${id}`);
		}
		for (const extra of [model.fullId, model.full_id, model.key]) {
			if (typeof extra === "string" && extra) ids.add(extra);
		}
	}
	return [...ids].map(normalizedKey).filter(Boolean);
}

function sameModelKey(actual, expectedKey) {
	const expected = normalizedKey(expectedKey);
	if (!expected) return false;
	const ids = modelIdentifiers(actual);
	if (ids.includes(expected)) return true;
	if (!expected.includes("/")) {
		return ids.some((id) => id === expected || id.endsWith(`/${expected}`));
	}
	return false;
}

function liveModelFor(ctx, session, target) {
	return modelFrom(target) ?? modelFrom(session) ?? modelOf(ctx);
}

function liveThinkingFor(ctx, session, target) {
	return thinkingFrom(target) ?? thinkingFrom(session) ?? thinkingOf(ctx);
}

function normalizeThinking(level) {
	return String(level ?? "").trim().toLowerCase();
}

function dispatchModelSlash(ctx, slash, target, session) {
	return sendSlashPrompt(target, slash, {
		ctx,
		session: session ?? target ?? undefined,
		slashOnly: true,
		modelRegistry:
			ctx?.modelRegistry ?? session?.modelRegistry ?? target?.modelRegistry,
	});
}

function outputHasError(outputs) {
	return outputs.some(
		(entry) =>
			entry?.kind === "error" ||
			entry?.type === "error" ||
			entry?.isError === true,
	);
}

function outcomeReason(outcome) {
	if (typeof outcome?.error === "string" && outcome.error) return outcome.error;
	if (typeof outcome?.result?.error === "string" && outcome.result.error) {
		return outcome.result.error;
	}
	const outputs = Array.isArray(outcome?.outputs) ? outcome.outputs : [];
	const lastError = [...outputs]
		.reverse()
		.find((entry) => entry?.kind === "error" || entry?.type === "error");
	if (lastError?.text) return String(lastError.text);
	return "host reported model switch failure";
}

/**
 * Perform one pending scoped model switch through the real host slash route.
 * Returns a structured outcome for `station.reconcileActualModel`; it never
 * throws and never falls through to a prompt.
 */
export async function switchModelTicket(pi, ctx, req) {
	const request = req && typeof req === "object" ? req : {};
	const rawCommand =
		typeof request.command === "string" ? request.command.trim() : "";
	const commandName = rawCommand.startsWith("/")
		? rawCommand.split(/\s+/)[0]
		: "/switch";
	const targetSpec =
		(typeof request.targetSpec === "string" && request.targetSpec.trim()
			? request.targetSpec.trim()
			: typeof request.expectedKey === "string"
				? request.expectedKey.trim()
				: "") || null;
	const slash = targetSpec
		? `${commandName} ${targetSpec}`
		: rawCommand || commandName;
	const session = safeSession(ctx) ?? ctx?.session ?? null;
	const target = session ?? ctx ?? null;
	const expectedKey = request.expectedKey || null;
	const expectedThinking = request.expectedThinking !== undefined
		? request.expectedThinking
		: sameModelKey(expectedKey, targetSpec) ? null : splitThinkingSuffix(targetSpec).thinking;
	const base = {
		ok: false,
		handled: false,
		verified: false,
		model: null,
		actualModel: null,
		actualKey: null,
		expectedKey,
		thinking: null,
		outputs: [],
		result: null,
		reason: "model switch unavailable",
		error: "model switch unavailable",
	};
	if (!target) return { ...base, reason: "no session for model switch" };

	let outcome;
	try {
		outcome = await dispatchModelSlash(ctx, slash, target, session);
	} catch (error) {
		const reason = String(error?.message ?? error ?? "model switch failed");
		return { ...base, reason, error: reason };
	}
	await Promise.resolve();

	const outputs = Array.isArray(outcome?.outputs) ? outcome.outputs : [];
	const live = liveModelFor(ctx, session, target);
	const actualKey = modelKeyOf(live);
	const actualThinking = liveThinkingFor(ctx, session, target);
	const handled = outcome?.handled === true;
	const errored =
		outcome?.isError === true ||
		outcome?.failed === true ||
		Boolean(outcome?.error) ||
		outcome?.result?.isError === true ||
		Boolean(outcome?.result?.error) ||
		outputHasError(outputs);

	let verified = false;
	let reason = null;
	if (!handled) {
		reason = "host did not handle model switch";
	} else if (errored) {
		reason = outcomeReason(outcome);
	} else if (expectedKey) {
		if (!actualKey) {
			reason = "actual model unavailable";
		} else if (!sameModelKey(live, expectedKey)) {
			reason = `model mismatch: expected ${expectedKey}, actual ${actualKey}`;
		} else if (
			expectedThinking &&
			actualThinking &&
			normalizeThinking(actualThinking) !== normalizeThinking(expectedThinking)
		) {
			reason = `thinking mismatch: expected ${expectedThinking}, actual ${actualThinking}`;
		} else {
			verified = true;
		}
	} else {
		// The host resolves roles and aliases that the extension cannot name.
		// A handled switch without an error is authoritative, and it also
		// counts when the target already was the live model.
		verified = true;
	}

	const ok = handled && !errored && verified;
	return {
		ok,
		handled,
		verified,
		model: ok ? live : null,
		actualModel: live,
		actualKey,
		expectedKey,
		thinking: actualThinking,
		outputs,
		result: outcome?.result ?? outcome ?? null,
		reason: ok ? null : reason,
		error: ok ? null : reason,
	};
}

function appendModelSwitchWarning(result, req, outcome) {
	const warning = render(errors["model-switch-warning"], {
		command: req?.command ?? "model switch",
		reason: outcome?.reason ?? outcome?.error ?? "unverified",
	});
	const base =
		result && typeof result === "object" ? result : textResult(String(result ?? ""));
	const content = Array.isArray(base.content)
		? base.content.slice()
		: [{ type: "text", text: String(base) }];
	const index = content.findIndex((entry) => entry?.type === "text");
	if (index >= 0) {
		content[index] = {
			...content[index],
			text: `${content[index].text ?? ""}\n\n${warning}`,
		};
	} else {
		content.push({ type: "text", text: warning });
	}
	return {
		...base,
		content,
		details: {
			...(base.details ?? {}),
			modelSwitch: {
				ok: false,
				reason: outcome?.reason ?? outcome?.error ?? null,
				expectedKey: outcome?.expectedKey ?? req?.expectedKey ?? null,
				actualKey: outcome?.actualKey ?? null,
			},
		},
	};
}

export async function scopeTicket(station, toolCallId, params, ctx) {
	let result;
	try {
		result = station.executeScope(toolCallId, params, ctx);
	} catch (error) {
		result = errorResult("SCOPE_INTERNAL_ERROR", String(error?.message ?? error));
	}
	const req =
		typeof station?.takePendingModelSwitch === "function"
			? station.takePendingModelSwitch(ctx)
			: null;
	if (req) {
		const outcome = await switchModelTicket(station.pi, ctx, req);
		try {
			station.reconcileActualModel?.(ctx, req, outcome);
		} catch (error) {
			station.lastError = String(error?.message ?? error);
		}
		if (!outcome?.ok) result = appendModelSwitchWarning(result, req, outcome);
	}
	return result;
}

export async function amendTicket(station, toolCallId, params) {
	try {
		return station.executeAmend(toolCallId, params);
	} catch (error) {
		return errorResult("AMEND_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

export async function pinTicket(station, toolCallId, params) {
	try {
		return station.executePin(toolCallId, params);
	} catch {
		return textResult("OK");
	}
}

