// Station handoff state transitions. Pure synchronous functions.

import { appendHandoffCompaction } from "../handoff/session.mjs";
import { truncateForHostBoundary, unreceivedChildren } from "../scope/index.mjs";
import { childReturnNudge } from "../scope/return-nudge.mjs";
import {
	collectUserPrompts,
	handoffDemand,
	handoffToolBlockedReason,
	mergeUserPrompts,
	successorOpeningText,
} from "../relay/index.mjs";
import {
	decideHandoffAdvance,
	decideHandoffArm,
	decideHandoffReport,
	decideInheritedLedgerViewed,
	decideNaturalStop,
	decideRelayEvaluation,
	decideRetirement,
	decideSelfHandoff,
} from "./domain/handoff.mjs";

function isChild(station) {
	return typeof station.forkOwnerId === "function" && station.forkOwnerId() !== null;
}

/**
 * The resolved relay policy for this station.
 *
 * The station holds the one resolved object port; the registry name table is
 * not consulted. A station double passes the same object through `relayPort`.
 */
function relayPolicyOf(station) {
	return station.relayPort();
}

function armHandoff(station, _ctx) {
	// Only the `handoff` degree may arm a transfer. `ledger` owes a ledger but
	// never hands off, and `none` owes nothing at all.
	const decision = decideHandoffArm({
		relay: station.state.relay,
		isChild: isChild(station),
		canHandoff: relayPolicyOf(station).canHandoff(),
	});
	if (!decision.arm) return false;
	station.handoffReport = null;
	station.state.relay = decision.relay;
	station.persist();
	station.markPending();
	return true;
}

function advanceRelayForHandoff(station, options = {}) {
	const decision = decideHandoffAdvance({
		relay: station.state.relay,
		isChild: isChild(station),
		canHandoff: relayPolicyOf(station).canHandoff(),
		expectedGeneration: options.expectedGeneration,
		at: Number.isFinite(options.at) ? options.at : Date.now(),
	});
	if (!decision.advance) return false;
	station.state.relay = decision.relay;
	station.persist();
	return true;
}

/**
 * How many fork results this station still owes a receive. A running child and
 * a returned child that no join has taken are both unreceived. A child branch
 * never evaluates the relay, so only the root counts here.
 */
function unreceivedRootChildren(station) {
	const ownerId =
		typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
	if (ownerId !== null) return 0;
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	if (!ledger) return 0;
	return unreceivedChildren(ledger, "root").length;
}

function recordLedgerEvaluation(station, phases, op, options = {}) {
	const decision = decideRelayEvaluation({
		relay: station.state.relay,
		owesLedger: relayPolicyOf(station).owesLedger(),
		phases,
		op,
		options,
		unreceived: unreceivedRootChildren(station),
	});
	const { commit, ...applied } = decision;
	if (commit) {
		station.state.relay = applied.relay;
		station.persist();
	}
	return applied;
}

/**
 * Record one small handoff: the holder is exhausted, the ledger on record is
 * inherited, and the next generation continues the work. It never promotes;
 * it only arms the handoff.
 */
function recordRetirement(station) {
	// `none` owes nothing, so a retirement must not arm a handoff either.
	const applied = decideRetirement({
		relay: station.state.relay,
		owesLedger: relayPolicyOf(station).owesLedger(),
	});
	if (!applied) return null;
	station.state.relay = applied.relay;
	station.persist();
	return applied;
}

/**
 * Record one natural stop outside every scope.
 *
 * A stop is a small handoff, never a submission. It transfers the holder and
 * the ledger on record, but it counts no empty evaluation: only a `todo` write
 * advances the two-empty-ledger protocol. A non-empty inherited ledger still
 * requires the successor to view it before writing. The transition decides,
 * and a handoff it arms sends the one demand as a user prompt.
 */
function recordNaturalStop(station, ctx) {
	const plan = decideNaturalStop({
		relay: station.state.relay,
		isChild: isChild(station),
		autopilot: station.state.autopilot,
		owesLedger: relayPolicyOf(station).owesLedger(),
		unreceived: unreceivedRootChildren(station),
	});
	if (!plan) return null;
	const applied = recordRetirement(station);
	if (!applied || applied.action === null) return applied;
	if (applied.action !== "handoff" && applied.action !== "retire") return applied;
	if (!armHandoff(station, ctx)) return applied;
	// The demand rides the prompt. If the next request cannot see it, the
	// context receipt supplies it instead.
	if (!station.deliverUserMessage(handoffDemand())) {
		(station.host?.report?.record ?? station.host?.record)?.("handoff", new Error("the handoff demand could not be sent as a prompt"), {
			stage: "natural-stop-prompt",
		});
	}
	return applied;
}

/** Clear the inherited-ledger requirement once the successor has looked. */
function markInheritedLedgerViewed(station) {
	const decision = decideInheritedLedgerViewed({ relay: station.state.relay });
	if (!decision) return false;
	station.state.relay = decision.relay;
	station.persist();
	return true;
}

function captureHandoffReport(station, text) {
	const decision = decideHandoffReport({
		relay: station.state.relay,
		isChild: isChild(station),
		text,
	});
	if (!decision.capture) return false;
	station.handoffReport = decision.text;
	return true;
}

function commitSelfHandoff(station, ctx, report) {
	const relay = station.state.relay;
	if (!decideSelfHandoff({ relay, isChild: isChild(station) })) {
		return { ok: false };
	}
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
	const manager = station.manager ?? null;
	const compacted = appendHandoffCompaction(
		manager,
		opening,
		station.usage.lastTotalInput ?? 0,
	);
	if (!compacted && manager) {
		station.host?.session?.appendHistory?.(
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
	station.clearPending();
	if (manager && typeof manager.buildSessionContext === "function") {
		try {
			// One rebuild, read through the station's branch projection: the
			// compaction above already moved the leaf, so this is a fresh
			// projection rather than the pre-handoff cache.
			const rebuilt = station.contextMessages();
			station.host?.session?.setMessages?.(ctx, rebuilt);
			// The host now owns a different message list; the next projection
			// must come from the branch, not from the object cached above.
			station.contextCache = null;
		} catch (error) {
			// Keep existing agent messages if the rebuild fails, but record it:
			// a silent miss leaves the successor reading the pre-handoff
			// transcript while the branch already holds the compacted one.
			(station.host?.report?.record ?? station.host?.record)?.("handoff", error, { stage: "rebuild-context" });
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
