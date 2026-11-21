// Station handoff state transitions. Pure synchronous functions.

import { appendHandoffCompaction } from "../handoff/session.mjs";
import { setAgentMessages } from "../host/capture.mjs";
import { appendHistoryMessage } from "../host/hack-context.mjs";
import { record } from "../host/diagnostics.mjs";
import { createStageFlags, truncateForHostBoundary } from "../scope/index.mjs";
import {
	applyLedgerEvaluation,
	beginGenerationAfterHandoff,
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
	// A new generation starts a new line of work. The predecessor's S2/S3/S4
	// runs prove nothing about what the successor intends, so every gated stage
	// flag returns to false in the same transaction: `direct-execution` is
	// gated again until this holder opens all three stages itself.
	station.state.stageFlags = createStageFlags();
	station.persist();
	return true;
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
	const applied = applyLedgerEvaluation(before, phases, {
		op,
		...options,
	});
	station.state.relay = applied.relay;
	// Every full-flow transition starts a new line of work: evidence that the
	// previous line's stages ran proves nothing about this one.
	if ((before?.fullFlow === true) !== (applied.relay.fullFlow === true)) {
		station.state.stageFlags = createStageFlags();
	}
	station.persist();
	return applied;
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
	const opening = successorOpeningText(relay, report, station.state.pins);
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
};
