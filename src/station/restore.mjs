// Station restore: rebuild state from the newest persisted snapshot.

import {
	createState,
	createBracketLedger,
	deserializeState,
	foldStateChain,
	isLedgerEntry,
	isStateCheckpoint,
} from "../scope/index.mjs";
import { toolCalls } from "../transcript/index.mjs";

const SESSION_STATE_TYPE = "scope.state";

/** A state entry without its embedded ledger half, which folds separately. */
function stripEmbeddedLedger(data) {
	if (!data || typeof data !== "object" || !["checkpoint", "delta"].includes(data.kind)) return data;
	const { ledger, ...rest } = data;
	return rest;
}

/** The ledger half of a state entry, shaped as its own journal entry. */
function embeddedLedger(data) {
	const half = data?.ledger;
	if (!half || typeof half !== "object") return null;
	return { version: data.version, kind: "ledger", ...half };
}

/** Walk the branch newest-first and collect the state chain, oldest-first. */
function collectChain(manager) {
	const branch = manager?.getBranch?.() ?? [];
	const ledger = [];
	const chain = [];
	let anchored = false;
	// The state chain stops at its newest checkpoint, but the ledger does not:
	// each write stores only the records that moved, so increments belonging to
	// entries older than that checkpoint are the only copy of those changes.
	// Collecting them only as far back as the chain reaches would delete fork
	// history that no newer entry repeats.
	let chainSealed = false;
	let ledgerSealed = false;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== SESSION_STATE_TYPE) {
			continue;
		}
		const data = entry.data;
		// A retired generation journaled retired beats. The domain is gone, and
		// an old session must still load, so its entries are skipped whole.
		if (data?.kind === "amends") continue;
		if (isLedgerEntry(data)) {
			if (!ledgerSealed) {
				const { amends: _amends, ...rest } = data;
				ledger.push(rest);
				if (data.full === true) ledgerSealed = true;
			}
			continue;
		}
		// Legacy checkpoints are complete state baselines, including when they
		// store a JSON string or omit the optional v1 ledger/amends fields.
		// Cut off older domain entries even for empty legacy domains; otherwise
		// they would be incorrectly replayed on top of this newer checkpoint.
		const legacyPayload = data?.kind === "checkpoint" && data.version === 2
			? data.state
			: isStateCheckpoint(data) && !(data?.kind === "checkpoint" && data.version === 3)
				? data
				: null;
		if (legacyPayload !== null) {
			let legacy = legacyPayload;
			if (typeof legacy === "string") {
				try { legacy = JSON.parse(legacy); } catch { legacy = null; }
			}
			if (!ledgerSealed) {
				const brackets = legacy && typeof legacy === "object" && legacy.brackets !== undefined
					? legacy.brackets : createBracketLedger();
				if (brackets && typeof brackets === "object") {
					const { forks, ...head } = brackets;
					ledger.push({ version: 3, kind: "ledger", full: true, set: forks, del: [], head });
				}
				ledgerSealed = true;
			}
		}
		// A write may carry its ledger increment inside the state entry.
		const embedded = embeddedLedger(data);
		if (!ledgerSealed && embedded) {
			ledger.push(embedded);
			if (embedded.full === true) ledgerSealed = true;
		}
		if (chainSealed) continue;
		// `foldStateChain` attaches domain baselines to its state object. A
		// legacy state may instead be JSON text, which must be parsed before
		// folding, just as `deserializeState` would parse it afterwards.
		let stateEntry = stripEmbeddedLedger(data);
		if (typeof data === "string") {
			try { stateEntry = JSON.parse(data); } catch { stateEntry = data; }
		} else if (data?.kind === "checkpoint" && data.version === 2 && typeof data.state === "string") {
			try { stateEntry = { ...data, state: JSON.parse(data.state) }; } catch { /* preserve invalid input */ }
		}
		chain.push(stateEntry);
		if (isStateCheckpoint(data)) {
			anchored = true;
			chainSealed = true;
		}
		// Each independently journaled domain now has a complete baseline,
		// and the core chain has reached its checkpoint. Earlier entries cannot
		// contribute to any of the three domains. The host may still materialize
		// the branch, but there is no reason to inspect its older entries again.
		if (chainSealed && ledgerSealed) break;
	}
	chain.reverse();
	ledger.reverse();
	// The chain stops only where the information stops. A state delta is
	// meaningless without the checkpoint it is a delta against, so every delta
	// newer than that checkpoint has to travel with it: there is no subset of a
	// delta chain that recovers the same state. A bound on how many entries to
	// read therefore cannot save work — it only decides whether a session comes
	// back at all.
	//
	// It used to stop after 512 state entries. A real session passed that
	// distance from its last checkpoint (743 entries on a 5 GB log) and every
	// later load restored *nothing*: the branch still held the checkpoint, and
	// the ledger domain still held its own baseline, but the state chain had
	// been cut above the only entry that could anchor it. Growing a session is
	// exactly how a fixed bound gets passed, so this failure was certain to
	// arrive eventually rather than unlikely to.
	//
	// The scan is now bounded by the branch itself, which is already in memory:
	// each step is a field read, and the fold that follows is proportional to
	// the distance to the checkpoint that will be found or proven absent.
	// Ledger folding is independent of state folding, so one ordered ledger log
	// followed by the state chain replays both without interleaving errors.
	return { chain: [...ledger, ...chain], anchored };
}

/**
 * True when the branch holds a replayable base.
 *
 * A fresh session has none, so its first write must be a checkpoint rather
 * than a delta against a snapshot no entry carries.
 */
export function hasPersistedBase(manager) {
	try {
		const { chain, anchored } = collectChain(manager);
		return chain.length > 0 && anchored;
	} catch {
		return false;
	}
}

/**
 * The newest state entry on the live branch, when the host can say.
 *
 * `persist` holds the serialized state it last wrote, and a delta is only
 * meaningful while the entry carrying that state is still reachable. This id
 * is how the station re-checks the anchor after a fold or any other rewrite
 * of the branch.
 */
export function persistedBaseId(manager) {
	return baseIdOf(manager);
}

/** The id of the newest entry that can anchor a delta, or null. */
function baseIdOf(manager) {
	try {
		const branch = manager?.getBranch?.() ?? [];
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry?.type !== "custom" || entry.customType !== SESSION_STATE_TYPE) {
				continue;
			}
			// The anchor must name the entry that carries the serialized state.
			// A ledger entry shares the custom type but holds fork records; it is
			// not a state snapshot and cannot anchor a delta against one.
			if (isLedgerEntry(entry.data) || entry.data?.kind === "amends") continue;
			return typeof entry.id === "string" ? entry.id : null;
		}
	} catch {
		// A host that cannot walk its branch leaves the anchor unverifiable.
	}
	return null;
}

function restoreState(manager, recordDiagnostic = () => {}) {
	try {
		const { chain, anchored } = collectChain(manager);
		if (chain.length > 0) {
			if (!anchored) {
				recordDiagnostic(
					"restore",
					new Error(
						"state chain holds no checkpoint on this branch: every entry is a delta against a base that is not reachable",
					),
				);
				return createState();
			}
			const folded = foldStateChain(chain);
			if (folded === null) {
				recordDiagnostic("restore", new Error("state chain starts with a delta"));
				return createState();
			}
			{
				// A snapshot never carries a working-level stack or interval
				// collapses. Both are retired history: deserializeState drops
				// them, so there is nothing to prune here.
				return deserializeState(folded);
			}
		}
	} catch (error) {
		// Corrupt or absent history: start empty rather than guess.
		recordDiagnostic("restore", error);
	}
	return createState();
}

export { SESSION_STATE_TYPE, restoreState };
