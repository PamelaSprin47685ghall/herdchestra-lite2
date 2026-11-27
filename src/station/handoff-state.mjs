// Station handoff state transitions. Pure synchronous functions.
//
// Owns Root rewind commit (atomic compaction + verbatim user prompt restoration
// + epoch/watermark/cache reset) and shared `finishRewind` cleanup used by both
// Root and Child rewinds. Never awaits; the async scheduling ticket lives in
// the host wiring.

import { appendHandoffCompaction } from "../handoff/session.mjs";
import { truncateForHostBoundary } from "../scope/index.mjs";
import { childReturnNudge } from "../scope/return-nudge.mjs";
import {
	collectUserPrompts,
	mergeUserPrompts,
	rebornUserMessages,
} from "../relay/index.mjs";
import {
	formatRebornPrompt,
	rebornStartPrompt,
	resetRootPromotion,
} from "./domain/handoff.mjs";

function isChild(station) {
	return (station.forkOwnerId?.() ?? null) !== null;
}

/**
 * Shared state reset after either a Root or Child rewind rewrote the live branch.
 */
export function finishRewind(station, { rebaseAnchor = false } = {}) {
	truncateForHostBoundary(station.state);
	station.contextCache = null;
	station.hostBoundaryScan = null;
	station.resetDirectoryBaseline?.();
	station.resetUsageWatermark?.();
	if (rebaseAnchor && typeof station.anchor?.rebase === "function") {
		station.anchor.rebase();
	} else {
		station.persist?.();
	}
}

/**
 * Archive any new real user prompts/steers visible in the live Root context.
 * When genuine new user input arrived after a seal, reset `canStop` so the new
 * requirement gets its own seal.
 */
export function syncRootUserPrompts(station, messages = null) {
	if (isChild(station) || !station?.state?.relay) return false;
	const source = Array.isArray(messages)
		? messages
		: typeof station.contextMessages === "function"
			? station.contextMessages()
			: [];
	const current = Array.isArray(station.state.relay.userPrompts)
		? station.state.relay.userPrompts
		: [];
	const exclude = new Set([childReturnNudge()]);
	const fresh = collectUserPrompts(source, { exclude });
	const merged = mergeUserPrompts(current, fresh);
	if (merged.length === current.length && merged.every((text, i) => text === current[i])) {
		return false;
	}
	const reset = resetRootPromotion({ ...station.state.relay, userPrompts: merged });
	station.state.relay = reset.relay;
	station.persist?.();
	return true;
}

/**
 * Build the immutable Root rewind plan for the host ticket, or null when no
 * Root rewind is pending.
 */
export function pendingRootRewindPlan(station) {
	if (isChild(station)) return null;
	const pending = station?.state?.relay?.pendingRewind;
	if (!pending || typeof pending !== "object") return null;
	return {
		pending,
		generation: pending.generation,
		big: pending.big === true,
		id: pending.id ?? null,
		startPrompt: rebornStartPrompt(),
	};
}

/**
 * Clear a pending Root rewind (either unconditionally on user abort / external
 * session transition, or only when matching `plan` if a host rewind ticket
 * aborted/skipped before commit).
 */
export function clearPendingRootRewind(station, plan = null) {
	if (isChild(station)) return false;
	const relay = station?.state?.relay;
	const pending = relay?.pendingRewind ?? null;
	if (plan !== null && plan !== undefined) {
		const sameRef = pending !== null && plan.pending === pending;
		const sameMeta =
			pending !== null &&
			plan.generation === pending.generation &&
			(plan.id ?? null) === (pending.id ?? null);
		if (station.rewindDispatching === plan.pending) station.rewindDispatching = null;
		if (!sameRef && !sameMeta) return false;
	} else {
		station.rewindDispatching = null;
	}
	station.rewoundThisTurn = false;
	if (!pending) return false;
	station.state.relay = {
		...relay,
		pendingRewind: null,
	};
	station.persist?.();
	return true;
}

/**
 * Commit a pending Root rewind after the host confirms the agent loop is idle
 * and in-flight message persistence has settled.
 *
 * Validates `plan` against the live `station.state.relay.pendingRewind` first
 * so a stale or duplicate ticket call is an atomic no-op (`false`).
 *
 * Writes:
 * 1. Merge real user prompts/steers into `state.relay.userPrompts`.
 * 2. Append verbatim user prompts & steers as real `role: "user"` entries.
 * 3. Append one handoff compaction entry carrying the formatted generation
 *    report + continuation/review directive, with `firstKeptEntryId` pointing at
 *    the first restored user entry so the host retains that block. The user
 *    messages therefore precede the record in the branch, and the transcript
 *    projection shows them ahead of it.
 * 4. Clear `pendingRewind`, reset the usage watermark, persist, and replace
 *    live `agent.state.messages` with the fresh
 *    projection from `manager.buildSessionContext()`.
 */
export function commitRootRewind(station, ctx, plan = null) {
	if (isChild(station)) return false;
	const relay = station?.state?.relay;
	const pending = relay?.pendingRewind;
	if (!pending || typeof pending !== "object") return false;
	if (plan !== null && plan !== undefined) {
		const sameRef = plan.pending === pending;
		const sameMeta =
			plan.generation === pending.generation &&
			(plan.id ?? null) === (pending.id ?? null);
		if (!sameRef && !sameMeta) return false;
	}

	const messages =
		typeof station.contextMessages === "function" ? station.contextMessages() : [];
	const userPrompts = mergeUserPrompts(
		relay.userPrompts ?? [],
		collectUserPrompts(messages, { exclude: new Set([childReturnNudge()]) }),
	);
	const summary = formatRebornPrompt({
		report: pending.report,
	});
	const manager = station.manager ?? null;
	let firstRestoredId = "";
	if (manager && typeof manager.appendMessage === "function") {
		const restoredUsers = rebornUserMessages(userPrompts, Date.now());
		for (const userMessage of restoredUsers) {
			try {
				const entryId = manager.appendMessage(userMessage);
				if (firstRestoredId === "" && typeof entryId === "string" && entryId !== "") {
					firstRestoredId = entryId;
				}
			} catch (error) {
				station.noteError?.("handoff", error, { stage: "restore-user-prompts" });
			}
		}
	}
	const compacted = appendHandoffCompaction(
		manager,
		summary,
		station.usage?.lastTotalInput ?? 0,
		firstRestoredId,
	);
	if (!compacted && manager) {
		station.host?.session?.appendHistory?.(
			manager,
			{
				role: "custom",
				customType: "herd-relay-handoff",
				content: [{ type: "text", text: summary }],
				timestamp: Date.now(),
			},
			ctx,
		);
	}
	station.state.relay = {
		...relay,
		userPrompts,
		pendingRewind: null,
	};
	finishRewind(station, { rebaseAnchor: false });
	if (manager && typeof manager.buildSessionContext === "function") {
		try {
			const rebuilt = station.contextMessages();
			station.host?.session?.setMessages?.(ctx, rebuilt);
			station.contextCache = null;
		} catch (error) {
			station.noteError?.("handoff", error, { stage: "rebuild-context" });
		}
	}
	return true;
}
