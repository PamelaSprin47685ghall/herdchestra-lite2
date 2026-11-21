// Station handoff state transitions. Pure synchronous functions.

import { appendHandoffCompaction } from "../handoff/session.mjs";
import { setAgentMessages } from "../host/capture.mjs";
import { appendHistoryMessage } from "../host/hack-context.mjs";
import { record } from "../host/diagnostics.mjs";
import { truncateForHostBoundary, openChildren, readyChildren } from "../scope/index.mjs";
import { childReturnNudge } from "../scope/return-nudge.mjs";
import {
	applyLedgerEvaluation,
	applyRetirement,
	beginGenerationAfterHandoff,
	collectUserPrompts,
	handoffDemand,
	handoffToolBlockedReason,
	ledgerStats,
	mergeUserPrompts,
	successorOpeningText,
} from "../relay/index.mjs";

function armHandoff(station, _ctx) {
	// Only the `handoff` degree may arm a transfer. `ledger` owes a ledger but
	// never hands off, and `none` owes nothing at all. A station built without
	// a registry (unit doubles) keeps the default: handoff.
	const relayPort = station.registry?.ports?.().relay;
	if (relayPort === "none" || relayPort === "ledger") return false;
	const relay = station.state.relay;
	if (!relay || relay.canStop) return false;
	station.handoffReport = null;
	station.state.relay = {
		...relay,
		handoffPending: true,
	};
	station.persist();
	station.registry?.markPending?.(station);
	return true;
}

function advanceRelayForHandoff(station, options = {}) {
	const relayPort = station.registry?.ports?.().relay;
	if (relayPort === "none" || relayPort === "ledger") return false;
	const relay = station.state.relay;
	if (!relay || !relay.handoffPending || relay.canStop) return false;
	const expected = options.expectedGeneration;
	if (Number.isInteger(expected) && expected !== relay.generation) return false;
	station.state.relay = beginGenerationAfterHandoff(relay, {
		at: Number.isFinite(options.at) ? options.at : Date.now(),
		fromGeneration: relay.generation,
	});
	station.persist();
	return true;
}

/**
 * How many fork results this station still owes a receive. A running child and
 * a returned child that no join has taken are both unreceived. A child branch
 * never evaluates the relay, so only the root counts here.
 */
function unreceivedChildren(station) {
	const ownerId =
		typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
	if (ownerId !== null) return 0;
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	if (!ledger) return 0;
	return openChildren(ledger, "root").length + readyChildren(ledger, "root").length;
}

function recordLedgerEvaluation(station, phases, op, options = {}) {
	// `none` owes nothing, so a ledger write must not turn the full flow on.
	// The caller still gets the shared answer shape, with `changed: false`.
	if (station.registry?.ports?.().relay === "none") {
		return {
			relay: station.state.relay,
			stats: { empty: true, open: 0, total: 0 },
			action: null,
			changed: false,
		};
	}
	const before = station.state.relay;
	const stats = ledgerStats(phases);
	// An empty ledger is a claim that nothing remains. While this root still
	// owns an unreceived child, that claim is false: the write is accepted and
	// reported, but the relay does not advance, no handoff is armed, and no
	// stop is allowed. The tool itself stays available.
	if (options.isError !== true && op !== "view" && stats.empty) {
		const unreceived = unreceivedChildren(station);
		if (unreceived > 0) {
			return { relay: before, stats, action: "held", changed: false, unreceived };
		}
	}
	const applied = applyLedgerEvaluation(before, phases, {
		op,
		...options,
	});
	station.state.relay = applied.relay;
	station.persist();
	return applied;
}

/**
 * Record one natural stop as the empty-ledger submission it is.
 *
 * A stop outside every scope is not a violation to correct: it is the same
 * evaluation a holder would submit with `todo({ list: [] })`. The transition
 * decides the outcome. When the stop arms a handoff, the demand goes out as a
 * user prompt carrying the same text the todo result carries, so the holder
 * writes the report immediately instead of receiving a second wording.
 */
function recordRetirement(station) {
	// `none` owes nothing, so a retirement must not arm a handoff either.
	if (station.registry?.ports?.().relay === "none") return null;
	const applied = applyRetirement(station.state.relay);
	station.state.relay = applied.relay;
	station.persist();
	return applied;
}

/**
 * Record one natural stop outside every scope.
 *
 * A stop is a submission, never a violation. With a non-empty ledger it is a
 * retirement: the holder is exhausted, the ledger is inherited, and the next
 * generation continues the work. Otherwise it is the empty evaluation the same
 * holder would have submitted with `todo({ list: [] })`. Either way the
 * transition decides, and a handoff it arms sends the one demand as a user
 * prompt.
 */
function recordNaturalStop(station, ctx) {
	if (station.registry?.ports?.().relay === "none") return null;
	const relay = station.state.relay;
	if (!relay || relay.handoffPending || relay.canStop) return null;
	// After a handoff the recorded ledger belongs to the predecessor; the
	// successor's own stop is its first evaluation, so it is judged as empty.
	const beforeFirstEvaluation =
		relay.generation > 0 && relay.firstEvaluation === null;
	const retired = !beforeFirstEvaluation && relay.lastLedger?.empty === false;
	const applied = retired
		? recordRetirement(station)
		: recordLedgerEvaluation(station, [], "natural-stop");
	if (!applied || applied.action === null) return applied;
	if (applied.action !== "handoff" && applied.action !== "retire") return applied;
	if (!armHandoff(station, ctx)) return applied;
	// The demand rides the prompt. If the next request cannot see it, the
	// context receipt supplies it instead.
	if (!station.deliverUserMessage(handoffDemand())) {
		record("handoff", new Error("the handoff demand could not be sent as a prompt"), {
			stage: "natural-stop-prompt",
		});
	}
	return applied;
}

/** Clear the inherited-ledger requirement once the successor has looked. */
function markInheritedLedgerViewed(station) {
	const relay = station.state.relay;
	if (!relay?.viewRequired) return false;
	station.state.relay = { ...relay, viewRequired: false };
	station.persist();
	return true;
}

function captureHandoffReport(station, text) {
	if (!station.state.relay?.handoffPending) return false;
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (!trimmed) return false;
	station.handoffReport = trimmed;
	return true;
}

function commitSelfHandoff(station, ctx, report) {
	const relay = station.state.relay;
	if (!relay || !relay.handoffPending || relay.canStop) return { ok: false };
	// A handoff compacts the branch: the successor reads the summary, not the
	// transcript. The archive keeps the user's own prompts across generations
	// and a reload, so the report never has to restate them.
	const messages =
		typeof station.contextMessages === "function" ? station.contextMessages() : [];
	const userPrompts = mergeUserPrompts(
		relay.userPrompts ?? [],
		collectUserPrompts(messages, {
			exclude: new Set([handoffDemand(), handoffToolBlockedReason(), childReturnNudge()]),
		}),
	);
	station.state.relay = { ...relay, userPrompts };
	const opening = successorOpeningText(
		station.state.relay,
		report,
		station.state.pins,
		userPrompts,
	);
	const manager = station.manager ?? ctx?.sessionManager ?? null;
	const compacted = appendHandoffCompaction(
		manager,
		opening,
		station.usage.lastTotalInput ?? 0,
	);
	if (!compacted && manager) {
		appendHistoryMessage(
			manager,
			{
				role: "custom",
				customType: "herd-relay-handoff",
				content: [{ type: "text", text: opening }],
				timestamp: Date.now(),
			},
			ctx,
		);
	}
	truncateForHostBoundary(station.state);
	station.resetUsageWatermark();
	station.handoffReport = null;
	const advanced = advanceRelayForHandoff(station, {
		expectedGeneration: relay.generation,
		at: Date.now(),
	});
	station.registry?.clearPending?.(station);
	if (manager && typeof manager.buildSessionContext === "function") {
		try {
			const rebuilt = manager.buildSessionContext()?.messages;
			if (Array.isArray(rebuilt)) setAgentMessages(ctx, rebuilt);
		} catch (error) {
			// Keep existing agent messages if the rebuild fails, but record it:
			// a silent miss leaves the successor reading the pre-handoff
			// transcript while the branch already holds the compacted one.
			record("handoff", error, { stage: "rebuild-context" });
		}
	}
	return {
		ok: advanced,
		opening,
		relay: station.state.relay,
	};
}

export {
	armHandoff,
	captureHandoffReport,
	commitSelfHandoff,
	advanceRelayForHandoff,
	recordLedgerEvaluation,
	recordNaturalStop,
	markInheritedLedgerViewed,
};
