// The scope read model: the only shape a host sees of the fork tree.
//
// A host renders labels, status rows, and finished records; it never holds a
// ledger. Every function here returns a plain value or a DTO, so changing the
// ledger representation cannot reach across the package boundary.

import { forkOf, RUNNING, READY } from "./forkjoin.mjs";
import { publicScopeId, scopeTitle } from "./scope-id.mjs";
import { scopeActivity } from "./activity.mjs";
import { renderChildRecord } from "../transcript/replay.mjs";
import { childReturnNudge } from "./return-nudge.mjs";

function ledgerOf(forkWiring) {
	return forkWiring?.registry ? forkWiring.states?.ledger : null;
}

/** A plain record: id, status, label, and the fields a display reads. */
function toDTO(record) {
	if (!record || typeof record !== "object") return null;
	return Object.freeze({
		id: record.id ?? null,
		kind: record.kind ?? null,
		status: record.status ?? null,
		ownerId: record.ownerId ?? null,
		depth: record.depth ?? null,
		children: Array.isArray(record.children) ? [...record.children] : [],
		requirements: Array.isArray(record.requirements) ? [...record.requirements] : [],
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
		childrenOf: (id) => {
			const record = recordOf(id);
			return Array.isArray(record?.children) ? [...record.children] : [];
		},
		activity: (lastOwnerId, rootBusy, clock, goal) => {
			const current = ledger();
			return current ? scopeActivity(current, lastOwnerId, rootBusy, clock, goal) : "";
		},
		record: (messages, options) => renderChildRecord(messages, options),
		nudge: () => childReturnNudge(),
	});
}
