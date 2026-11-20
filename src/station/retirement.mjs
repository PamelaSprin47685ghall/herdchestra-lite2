// Owner retirement gate: one explicit identity per station.
//
// A fission owner retires from the `tool_result` hook. That hook runs before
// the host has finished the turn that opened the batch, so an already-started
// turn can still deliver tool calls, and a nested owner's queued turn can
// arrive later. While the batch runs, the station keeps the retirement record:
// its batch id, its opening tool call, and the owner's identity id.
//
// The caller's explicit identity decides. A different identity on the same
// station is the adopted heir or a successor generation, never the retired
// owner, so it is not refused. When the host publishes no identity, the live
// retired pending descriptor stands in. `clearOwnerRetired` ends the refusal
// when the batch resolves: the heir has been adopted and the session may
// interact again.

function identityId(value) {
	if (typeof value === "string" && value !== "") return value;
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		return null;
	}
	if (typeof value.id === "string" && value.id !== "") return value.id;
	if (typeof value.agentId === "string" && value.agentId !== "") return value.agentId;
	return null;
}

/** One wording for every gate that refuses the retired owner. */
export function retiredOwnerReason(batchId) {
	const suffix = typeof batchId === "string" && batchId !== "" ? ` ${batchId}` : "";
	return `OWNER_RETIRED: this fission owner retired when batch${suffix} opened. An already-started turn cannot execute tools or open another batch; the batch's flows, or its adopted heir, continue.`;
}

/** Record the owner that is no longer allowed to act on this station. */
export function markOwnerRetired(station, request = {}) {
	if (!station) return null;
	const identity = request.identity ?? request.ctx?.agent ?? null;
	station.ownerRetired = {
		batchId: typeof request.batchId === "string" ? request.batchId : null,
		toolCallId: typeof request.toolCallId === "string" ? request.toolCallId : null,
		identityId: identityId(identity),
	};
	return station.ownerRetired;
}

/**
 * End the refusal once the batch is terminal. The batch id guard keeps a
 * later batch on the same station from clearing an older retirement, and a
 * mismatched id is answered instead of silently dropping the record.
 */
export function clearOwnerRetired(station, batchId) {
	const record = station?.ownerRetired ?? null;
	if (!record) return false;
	if (typeof batchId === "string" && record.batchId !== null && record.batchId !== batchId) {
		return false;
	}
	station.ownerRetired = null;
	return true;
}

/** The refusal for this caller, or null when the caller may act. */
export function ownerRetirement(station, ctx) {
	const record = station?.ownerRetired ?? null;
	if (!record) return null;
	const caller = identityId(ctx?.agent);
	if (record.identityId !== null && caller !== null) {
		if (caller !== record.identityId) return null;
		return {
			code: "OWNER_RETIRED",
			batchId: record.batchId,
			reason: retiredOwnerReason(record.batchId),
		};
	}
	// The retired identity is unknown, or this context published none. The
	// station's own descriptor is the domain state then: refuse only while it
	// names this retirement and has not resolved.
	const pending = station.pendingFission;
	const stillLive = pending?.retired === true &&
		(record.batchId === null || pending.batchId === record.batchId);
	if (!stillLive) return null;
	return {
		code: "OWNER_RETIRED",
		batchId: record.batchId,
		reason: retiredOwnerReason(record.batchId),
	};
}
