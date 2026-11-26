/**
 * Host-bound tickets: the asynchronous flows that speak the omp host API.
 *
 * The pure control flows live in `src/tools/tickets.mjs` and are host-free;
 * this node binds them to the host capabilities they need (diagnostics, the
 * fork registry waiters, model switching) and adds the tickets whose whole
 * body is a host call (steer, prompt, rewind, scoped model switch).
 *
 * Everything here is the adapter side of the boundary: when the wiring moves
 * into the host package, this file moves with it unchanged.
 */

import { sendSlashPrompt, sessionFor } from "./capture.mjs";
import { managerOf, modelFrom, modelOf, sessionOf, thinkingFrom, thinkingOf } from "./adapter.mjs";
import { hasScopeReturnStop } from "./branch-context.mjs";
import { record } from "./diagnostics.mjs";

const textResult = (text) => ({ content: [{ type: "text", text }] });


/**
 * The warning a model switch appends when the host cannot prove the switch
 * landed. The text lives with the host verb because only this package can
 * observe the post-switch model.
 */
function modelSwitchWarning(vars = {}) {
	const command = vars.command ?? "model switch";
	const reason = vars.reason ?? "unverified";
	return `⚠ The ${command} could not be verified: ${reason}. The next request may still use the previous model.`;
}

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
		await pi?.sendUserMessage?.(text, { deliverAs: "steer", attribution: "agent" });
	} catch (error) {
		// Steer delivery stays best-effort: it never escapes as an unhandled
		// rejection. But a nudge the model never receives looks exactly like an
		// idle model, so the failure must leave a trace.
		record("tickets", error, { kind: "steer", chars: text.length });
	}
}

/**
 * Fire-and-forget user-message delivery. A plain message without `deliverAs`
 * always starts one turn, which is what `/herd-autopilot <text>` promises.
 */
export async function sendUserMessageTicket(pi, text) {
	if (!text) return;
	try {
		await pi?.sendUserMessage?.(text, { attribution: "agent" });
	} catch (error) {
		// A host that rejects the message must not leak an unhandled rejection,
		// but `/herd-autopilot <text>` promises the user one turn: losing that message in
		// silence is the worst outcome, so it is recorded instead.
		record("tickets", error, { kind: "prompt", chars: text.length });
	}
}

function supportsRootRewind(pi, session, manager) {
	return Boolean(
		session && manager && manager === session.sessionManager &&
		!session.isDisposed && !session.isSessionTransitioning &&
		typeof session.withQueueDrainPaused === "function" &&
		typeof session.waitForIdle === "function" &&
		typeof session.settleInFlightMessagePersistence === "function" &&
		(typeof session.prompt === "function" || typeof pi?.sendUserMessage === "function") &&
		typeof manager.getSessionId === "function" &&
		typeof manager.getLeafId === "function" &&
		typeof manager.getBranch === "function" &&
		typeof manager.appendCompaction === "function" &&
		typeof manager.appendMessage === "function" &&
		typeof manager.buildSessionContext === "function" &&
		Array.isArray(session.agent?.state?.messages) && hasScopeReturnStop(session.agent),
	);
}

export function canRewindRoot(pi, ctx) {
	return supportsRootRewind(pi, sessionOf(ctx), managerOf(ctx));
}

/** Run detached from agent_end, which must never await its own idle barrier. */
export async function rewindRootTicket(pi, station, ctx, plan) {
	let committed = false;
	try {
		const session = sessionOf(ctx);
		const manager = managerOf(ctx);
		if (!supportsRootRewind(pi, session, manager) || station.manager !== manager) return;
		const sessionId = manager.getSessionId();
		const epoch = session.transcriptEpoch;
		const agent = session.agent;
		let resume;
		await session.withQueueDrainPaused(async () => {
			await session.waitForIdle();
			await session.settleInFlightMessagePersistence();
			if (
				session.isStreaming || session.isAborting || session.hasAdmittedSubmission || session.agent !== agent ||
				session.transcriptEpoch !== epoch || sessionOf(ctx) !== session ||
				managerOf(ctx) !== manager || manager.getSessionId() !== sessionId ||
				station.manager !== manager || !supportsRootRewind(pi, session, manager)
			) return;
			// Commit checks that the plan still owns the station. Do not yield
			// between that check, the transcript mutation, and the resume request.
			committed = station.commitRootRewind(ctx, plan) === true;
			if (!committed) return;
			if (typeof session.prompt !== "function") {
				resume = Promise.resolve(pi.sendUserMessage(plan.startPrompt, { attribution: "agent" }));
				resume.catch((error) => record("tickets", error, { kind: "rewind-resume" }));
				return;
			}
			// Release the queue hold as soon as the prompt claims the host, or
			// when it fails before admission. Await the actual prompt outside.
			let admitted;
			const admission = new Promise((resolve) => { admitted = resolve; });
			resume = Promise.resolve(session.prompt(plan.startPrompt, {
				synthetic: true,
				attribution: "agent",
				userInitiated: false,
				expandPromptTemplates: false,
				runCommands: false,
				throwOnDrop: true,
				onPromptAdmitted: admitted,
			}));
			resume.then(admitted, admitted);
			await admission;
		});
		await resume;
	} finally {
		if (!committed) station.abortRootRewind?.(plan);
	}
}

const THINKING_SUFFIX =
	/(?:\s*[:@]\s*|\s+)(off|minimal|low|medium|high|xhigh|max)\s*$/i;

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
