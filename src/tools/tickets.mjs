/**
 * Async tickets: the only place `await` is allowed.
 *
 * Each ticket carries one complete async flow and returns a Promise. Stations
 * (SessionStation) stay synchronous; they call these through the injected
 * `tickets` capability bundle at wiring time. Tickets call station sync
 * methods for every state transition and never hold shared state of their own.
 */

import { errorResult, textResult } from "./results.mjs";
import { runHandoffInContext } from "../handoff/index.mjs";
import { appendUserTail } from "../transcript/index.mjs";
import { languageSkill } from "../host/prompts.mjs";
import { successorPrompt } from "../relay/index.mjs";

/** Fire-and-forget steer delivery. The scope result already reports the send. */
export async function sendSteerTicket(pi, text) {
	if (!text) return;
	try {
		await pi?.sendUserMessage?.(text, { deliverAs: "steer" });
	} catch {
		// Steer delivery is best-effort; never let it escape as unhandled.
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
		} catch {
			// A host without tool activation keeps its own tool set.
		}
	}
	return promptChanged ? { systemPrompt: prompt } : undefined;
}

export async function scopeTicket(station, toolCallId, params) {
	try {
		return station.executeScope(toolCallId, params);
	} catch (error) {
		return errorResult("SCOPE_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

export async function regretTicket(station, toolCallId, params) {
	try {
		return station.executeRegret(toolCallId, params);
	} catch (error) {
		return errorResult("REGRET_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

export async function deferTicket(station, toolCallId, params) {
	try {
		return station.executeDefer(toolCallId, params);
	} catch (error) {
		return errorResult("DEFER_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

export async function pinTicket(station, toolCallId, params) {
	try {
		return station.executePin(toolCallId, params);
	} catch {
		return textResult("OK");
	}
}

/**
 * Context ticket for the relay handoff path. Runs the real handoff, then either
 * returns the post-handoff transcript (successor's first turn) or falls through
 * to the station's synchronous context transform when the handoff cannot run.
 */
export async function contextHandoffTicket(station, ctx, original) {
	const outcome = await runHandoffInContext(station, ctx, station.pi);
	if (outcome.ok) {
		let live = [];
		try {
			const context = ctx?.sessionManager?.buildSessionContext?.();
			if (Array.isArray(context?.messages)) live = context.messages;
		} catch {
			live = [];
		}
		return {
			messages: appendUserTail(
				live.length > 0 ? live : original,
				`<system-reminder>${languageSkill}</system-reminder>\n\n${successorPrompt(
					station.state.relay,
					station.state.relay.lastLedger ?? null,
				)}`,
			),
		};
	}
	station.lastError = outcome.error;
	return station.transformContext(original, ctx);
}
