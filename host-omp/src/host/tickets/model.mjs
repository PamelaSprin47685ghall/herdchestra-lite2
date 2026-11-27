// Scoped model switching: perform the host slash switch and reconcile the result.
//
// The station has already taken the pending request by the time a ticket runs
// here, so these functions only perform the switch and report what the host
// says. None of them writes the parent's model, and none of them throws: a
// failed switch becomes an outcome the station can record.

import { sendSlashPrompt, sessionFor } from "../capture.mjs";
import {
	liveModelFor,
	liveThinkingFor,
	modelKeyOf,
	normalizeThinking,
	sameModelKey,
	splitThinkingSuffix,
} from "./model-identifiers.mjs";
import { modelSwitchWarning, textResult } from "./prompt.mjs";

/**
 * Yield one microtask so the host can commit the model it just selected.
 *
 * The slash route resolves before the session's model field is observably
 * updated, and the reconciliation below reads that field to verify the switch.
 * This hop is the fence between the two: remove it and the verification can read
 * the previous model and report a mismatch the user never caused. It is one
 * microtask and not a timer, so nothing else in the loop runs between the
 * host's release and the read.
 */
function yieldForHostModelCommit() {
	return Promise.resolve();
}

function safeSession(ctx) {
	try {
		return sessionFor(ctx);
	} catch {
		return null;
	}
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
 * Restore a scoped model through the host route.
 *
 * The station has already taken the pending request. This performs the switch
 * and reconciles what the host reports; it never writes the parent's model.
 */
export async function restoreScopedModelTicket(station, ctx, req, result, finish) {
	const outcome = await switchModelTicket(station.pi, ctx, req);
	station.reconcileActualModel(ctx, req, outcome);
	if (!outcome.ok) station.noteScopedModelFailure(req, outcome);
	return finish ? finish(result) : result;
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
	await yieldForHostModelCommit();

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
	const warning = modelSwitchWarning({
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

/**
 * Apply a pending user model switch, if the host queued one.
 *
 * The switch used to be applied by the old scope ticket alone. Both the
 * working-level scope and `scope_fork` now route through this helper, so a
 * `/model` choice lands on the next request whichever control tool comes
 * first.
 */
export async function applyPendingModelSwitch(pi, station, ctx, result) {
	const req =
		typeof station?.takePendingModelSwitch === "function"
			? station.takePendingModelSwitch(ctx)
			: null;
	if (!req) return result;
	const outcome = await switchModelTicket(station.pi, ctx, req);
	try {
		station.reconcileActualModel?.(ctx, req, outcome);
	} catch (error) {
		station.noteError?.("model", error);
	}
	return outcome?.ok ? result : appendModelSwitchWarning(result, req, outcome);
}
