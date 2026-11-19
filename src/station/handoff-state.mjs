// Station handoff state transitions. Pure synchronous functions.

import { appendHandoffCompaction } from "../handoff/session.mjs";
import { setAgentMessages } from "../host/capture.mjs";
import { appendHistoryMessage } from "../host/hack-context.mjs";
import { truncateForHostBoundary } from "../scope/index.mjs";
import {
	applyLedgerEvaluation,
	beginGenerationAfterHandoff,
	successorOpeningText,
} from "../relay/index.mjs";

function armHandoff(station, _ctx) {
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

function recordLedgerEvaluation(station, phases, op, options = {}) {
	const applied = applyLedgerEvaluation(station.state.relay, phases, {
		op,
		...options,
	});
	station.state.relay = applied.relay;
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
		station.lastTotalInput ?? 0,
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
		} catch {
			// Keep existing agent messages if context rebuild fails.
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
