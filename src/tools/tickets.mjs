/**
 * Async tickets: the only place `await` is allowed.
 *
 * Each ticket carries one complete async flow and returns a Promise. Stations
 * (SessionStation) stay synchronous; they call these through the injected
 * `tickets` capability bundle at wiring time. Tickets call station sync
 * methods for every state transition and never hold shared state of their own.
 */

import { errorResult, textResult } from "./results.mjs";
import { scheduleBackgroundHandoff } from "../handoff/index.mjs";
import { managerOf, safeSession } from "../handoff/session.mjs";

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
 * Context ticket for the relay handoff path. Schedules the real handoff in the
 * background (fire-and-forget) when the branch already has >= 2 messages, then
 * immediately returns the station's synchronous context transform so the host's
 * `context` hook never hits its handler timeout.
 */
export function contextHandoffTicket(station, ctx, original) {
	const liveSession = safeSession(ctx) ?? station.handoffSession ?? null;
	const liveManager = managerOf(liveSession, ctx);
	let canSchedule = true;
	if (liveManager && typeof liveManager.getBranch === "function") {
		try {
			const messageEntries = liveManager
				.getBranch()
				.filter((entry) => entry?.type === "message");
			if (messageEntries.length < 2) canSchedule = false;
		} catch {
			canSchedule = true;
		}
	}
	if (canSchedule) scheduleBackgroundHandoff(station, ctx, station.pi);
	return station.transformContext(original, ctx);
}
