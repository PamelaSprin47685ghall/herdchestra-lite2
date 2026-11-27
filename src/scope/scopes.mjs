// The scope read model: the only shape a host sees of the fork tree.
//
// A host renders labels, status rows, and finished records; it never holds a
// ledger. Every function here returns a plain value or a DTO, so changing the
// ledger representation cannot reach across the package boundary.

import { forkOf } from "./ledger-charge.mjs";
import { READY, RUNNING } from "./ledger-brackets.mjs";
import { publicScopeId, scopeTitle } from "./scope-id.mjs";
import { scopeActivity } from "./activity.mjs";
import { renderChildRecord } from "../transcript/replay.mjs";
import { childReturnNudge } from "./return-nudge.mjs";

/** A plain record: id, status, label, and the fields a display reads. */
function toDTO(record) {
	if (!record || typeof record !== "object") return null;
	return Object.freeze({
		id: record.forkId ?? record.scopeId ?? null,
		role: record.role ?? null,
		path: record.path ?? null,
		status: record.status ?? null,
		ownerId: record.ownerId ?? null,
		depth: record.depth ?? null,
		label: scopeTitle(publicScopeId(record)),
	});
}

export function createScopes({ forkWiring }) {
	const ledger = () => forkWiring?.ledger ?? null;
	const recordOf = (id) => {
		const current = ledger();
		return current ? forkOf(current, id) : null;
	};
	return Object.freeze({
		of: (id) => toDTO(recordOf(id)),
		status: (id) => recordOf(id)?.status ?? null,
		label: (id) => {
			const record = recordOf(id);
			return record ? scopeTitle(publicScopeId(record)) : null;
		},
		isRunning: (id) => recordOf(id)?.status === RUNNING,
		isReady: (id) => recordOf(id)?.status === READY,
		// Direct children in registration order. The record names its upscope and
		// the ledger holds the order, so no stored child list can go stale.
		childrenOf: (id) => {
			const current = ledger();
			if (!current) return [];
			return current.order.filter(
				(forkId) => forkOf(current, forkId)?.upscopeId === id,
			);
		},
		activity: (lastOwnerId, rootBusy, clock, goal) => {
			const current = ledger();
			return current ? scopeActivity(current, lastOwnerId, rootBusy, clock, goal) : "";
		},
		record: (messages, options) => renderChildRecord(messages, options),
		nudge: () => childReturnNudge(),
	});
}
