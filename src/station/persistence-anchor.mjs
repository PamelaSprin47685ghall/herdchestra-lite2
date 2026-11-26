/**
 * Persistence anchor: the append-only state chain's baseline and the rebase
 * that follows a branch rewrite.
 *
 * Three fields move together here — the last serialized state, the entry that
 * carries it, and the count since the last checkpoint — because a delta is
 * only valid while its anchor is still on the branch. Pure synchronous state;
 * the manager and the serialization helpers arrive by injection.
 */

import { commitConsumer, consumerRevision, dropConsumer, registerConsumer } from "../scope/ledger-cache.mjs";
import { CHECKPOINT_ENTRY_LIMIT } from "../scope/persistence.mjs";

/** The ledger half of a plan, without its envelope fields. */
/**
 * The size of an entry as the journal will hold it, in bytes.
 *
 * The payload is JSON data, but a value the encoder refuses is still possible —
 * a bigint, a cycle — and the encoder would then throw. This runs before the
 * write, so a throw costs a retry that writes nothing rather than a retry that
 * writes the same change a second time. The fallback is deliberately huge: it
 * makes the next write a baseline, which is the answer that cannot lose anything.
 *
 * Bytes, not `String.length`: that counts UTF-16 units, so a Chinese transcript
 * measures about a third of its size and the threshold would fire far too late
 * on exactly the sessions that need it.
 */
function entryBytes(entry) {
	try {
		return Buffer.byteLength(JSON.stringify(entry) ?? "", "utf8");
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function ledgerOf(entry) {
	// Forward every increment the planner produced. Naming the fields by hand
	// silently dropped whichever ones a later change added — a list edit
	// stripped here is a ledger that restores with an empty `order`.
	const { version: _version, kind: _kind, ...rest } = entry;
	return rest;
}

export function createPersistenceAnchor({
	manager,
	state,
	initialState,
	initialLedger,
	initialEntryId,
	serialize,
	plan,
	planLedger,
	split,
	type,
	noteError,
}) {
	let lastPersisted = initialState;
	let lastBrackets = null;
	// The entry whose ledger bytes produced `lastBrackets`. Distinct from
	// `lastStateEntryId` whenever a write owed the ledger alone: that entry
	// carries fork records and no serialized state, so it may not be the anchor
	// but it is still the snapshot the next ledger delta subtracts from.
	let lastLedgerEntryId = null;
	let lastStateEntryId = initialEntryId;
	let writes = 0;
	// Entries appended since the last checkpoint, whatever half they carried.
	// `writes` counts state writes only, and the reader's replay window counts
	// entries: a ledger-only turn advances this counter while leaving `writes`
	// alone, which is the gap that let a journal drift past the window with no
	// checkpoint inside it.
	let entriesSinceCheckpoint = 0;
	// The ledger journal has no periodic baseline of its own: a delta is written
	// against the last accepted snapshot, and that snapshot is kept until an
	// anchor check drops it. So the chain only ends at a restart, and restore has
	// to fold every entry it holds — the cost of a cold start grows with the
	// session, not with what changed since the last load.
	//
	// A baseline bounds that, and it is written only when the deltas since the
	// last one have cost at least what the baseline costs. The ledger tree is
	// the large part of a state entry, so the interval is derived from its size:
	// a small journal re-baselines often and cheaply, a journal carrying a
	// transcript re-baselines rarely. The work per write stays roughly constant
	// instead of growing without a bound.
	let ledgerDeltaBytes = 0;
	let ledgerDeltas = 0;
	let ledgerBaselineBytes = 0;
	// A baseline is written when the deltas since the last one have cost what the
	// baseline itself costs, so the journal never holds much more than twice a
	// baseline. That comparison is on measured bytes, not on a count derived from
	// the baseline's size: a count cannot know how large a delta is, and a journal
	// whose deltas carry content would then accumulate many times a baseline
	// before restating it.
	//
	// Two clamps bound the cases a byte count alone gets wrong. The floor keeps a
	// tiny journal from restating itself on every write — with a few hundred bytes
	// per entry, the byte trigger would fire almost immediately and the baseline
	// would be the write. The ceiling bounds the number of entries a cold start
	// has to fold, which matters even when each one is small.
	const LEDGER_BASELINE_MIN_BYTES = 32 * 1024;
	const LEDGER_BASELINE_MAX_DELTAS = 2048;
	let rebased = false;
	const consumerId = {};
	let consumerLedger = null;

	function bindConsumer(ledger) {
		if (ledger === consumerLedger) return;
		if (consumerLedger) dropConsumer(consumerLedger, consumerId);
		consumerLedger = ledger;
		if (ledger) registerConsumer(ledger, consumerId);
		lastBrackets = null;
		lastLedgerEntryId = null;
	}
	bindConsumer(state()?.brackets ?? null);

	// A loaded session already has a ledger baseline in the journal: the entry
	// `initialEntryId` names carries exactly the records `initialLedger` was
	// serialized from. Seeding the snapshot with it makes the first write after
	// a load a delta — the same write the session would have produced had it
	// never stopped — instead of restating the whole tree because the writer
	// forgot what it had already stored. On a long session that restatement is
	// the largest single write it ever makes, and every byte of it is already in
	// the journal.
	//
	// Three conditions, each of them a reason the seed could be wrong:
	//
	//   * `initialLedger` is a copy, not a view. A shared snapshot would take
	//     the serializer's identity fast path on a record the caller edits in
	//     place, and the edit would be reported as no change. Whatever produced
	//     this value is responsible for that; `serializeState` copies.
	//   * `initialEntryId` is the same entry the state half came from, so the id
	//     means what `ledgerSnapshotOnBranch` reads it to mean.
	//   * the entry is still on the leaf path. That is not assumed here:
	//     `persistOnce` re-checks it before subtracting from the snapshot, the
	//     same way it does for a snapshot this module produced itself. A branch
	//     rewritten between load and the first write therefore drops the seed
	//     and writes a baseline, which is the answer that cannot lose anything.
	if (
		initialLedger !== null &&
		initialLedger !== undefined &&
		typeof initialEntryId === "string"
	) {
		lastBrackets = initialLedger;
		lastLedgerEntryId = initialEntryId;
	}

	/**
	 * A bound on the ancestry walk.
	 *
	 * The chain is followed by `parentId` from the leaf; a host that produced a
	 * cycle would spin forever, so the walk stops after this many steps and the
	 * ids it never reached answer "absent". That is the conservative direction:
	 * a wrong "absent" costs one extra checkpoint, a wrong "present" writes a
	 * delta against a baseline the journal no longer holds.
	 */
	const MAX_ANCESTOR_STEPS = 1_000_000;

	/** One whole-branch read, for a manager that cannot address one entry. */
	function readBranch() {
		if (typeof manager?.getBranch !== "function") return null;
		try {
			const branch = manager.getBranch();
			return Array.isArray(branch) ? branch : null;
		} catch {
			return null;
		}
	}

	/**
	 * Membership of several ids on the leaf path, answered in one walk.
	 *
	 * The form this replaces materialised the whole branch once per question,
	 * and a write asks up to three of them: the state baseline, the ledger
	 * snapshot, the amends baseline. `getBranch()` copies one entry per message
	 * in the session, so that read grew with the conversation on every write and
	 * ran three times. Following `parentId` from the leaf answers the same
	 * question without the copy, and stops as soon as every id is settled or the
	 * chain ends — the price is the distance to the furthest answer rather than
	 * the length of the branch.
	 *
	 * Nothing is remembered between calls, and that is deliberate: an entry can
	 * exist in the journal and no longer be an ancestor of the same leaf,
	 * because a rewrite can reparent it. A cached verdict would answer for the
	 * chain as it used to be; a fresh walk cannot.
	 *
	 * @returns {Map<string, boolean>} one answer per id that is a string.
	 */
	function resolveOnLeafPath(ids) {
		const found = new Map();
		const pending = new Set();
		for (const id of ids) {
			if (typeof id !== "string") continue;
			found.set(id, false);
			pending.add(id);
		}
		if (pending.size === 0) return found;

		let leafId;
		let leaf;
		try {
			leafId = typeof manager?.getLeafId === "function" ? manager.getLeafId() : undefined;
			leaf = typeof manager?.getLeafEntry === "function" ? manager.getLeafEntry() : null;
		} catch {
			leafId = undefined;
			leaf = null;
		}

		if (typeof leafId === "string" && pending.delete(leafId)) found.set(leafId, true);
		// The immediate parent is already available without a branch read.
		// Managers need not expose getEntry to answer these two cases.
		if (leaf?.id === leafId && typeof leaf?.parentId === "string" && pending.delete(leaf.parentId)) {
			found.set(leaf.parentId, true);
		}
		if (pending.size === 0) return found;

		if (typeof manager?.getEntry === "function" && typeof leafId === "string") {
			let cursorId = leafId;
			let steps = 0;
			while (typeof cursorId === "string" && pending.size > 0 && steps < MAX_ANCESTOR_STEPS) {
				steps += 1;
				// The leaf object is already in hand; ask the manager only for
				// the entries above it.
				// A host may return a stale leaf object during a branch transition.
				// Only use it for this id when it actually names the same entry;
				// otherwise resolve that id through the manager like every ancestor.
				let entry = cursorId === leafId && leaf?.id === leafId ? leaf : null;
				if (!entry) {
					try {
						entry = manager.getEntry(cursorId);
					} catch {
						entry = null;
					}
				}
				// A malformed or stale lookup must not prove an ancestry relation for
				// an entry with a different id. Treat it as unverifiable.
				if (!entry || entry.id !== cursorId) break;
				if (pending.delete(cursorId)) found.set(cursorId, true);
				if (entry.parentId === cursorId) break;
				cursorId = entry.parentId;
			}
			return found;
		}

		// A manager that cannot address a single entry is read whole — but once
		// for every remaining id, not once per id.
		const branch = readBranch();
		if (branch) {
			for (const entry of branch) {
				const id = entry?.id;
				if (typeof id === "string" && pending.delete(id)) found.set(id, true);
			}
		}
		return found;
	}

	/**
	 * True when `id` is the leaf or an ancestor of it.
	 *
	 * The answers come from one shared walk (`resolveOnLeafPath`) instead of a
	 * branch read per question. Two cases that used to short-circuit are now
	 * covered by the walk itself: the entry being the leaf, and the leaf hanging
	 * directly off it.
	 */
	function onLeafPath(id, ancestry) {
		return typeof id === "string" && ancestry.get(id) === true;
	}

	/**
	 * True when the ledger snapshot still describes content the journal holds.
	 *
	 * `lastBrackets` is what the next ledger entry subtracts from. It comes from
	 * whichever entry last carried ledger bytes, and that is not always the
	 * anchor: a write that owes the ledger alone lands its own entry and
	 * advances this snapshot while the state anchor stays put. If the branch is
	 * then cut back to the anchor, that ledger entry is gone and the snapshot
	 * describes a change the journal no longer has. A delta computed against it
	 * omits exactly that change — and the omission is silent, because the tree
	 * still looks consistent: every container matches, every remaining record
	 * matches, and only the discarded record's content is stale.
	 *
	 * A snapshot taken from the anchor entry itself needs no second check: the
	 * anchor verdict already covers it.
	 */
	function ledgerSnapshotOnBranch(ancestry) {
		if (lastBrackets === null) return true;
		if (lastLedgerEntryId === null) return false;
		return onLeafPath(lastLedgerEntryId, ancestry);
	}

	/**
	 * Write the pending state slice. Returns false only when the write was owed
	 * and did not happen, so a caller can report a lost state write instead of
	 * assuming success; "nothing to write" is a success.
	 */
	let persisting = false;
	let persistAgain = false;
	// A branch rewrite can arrive synchronously from appendCustomEntry. The
	// outer write is still in flight and will otherwise overwrite the reset
	// baselines when it returns, so repeat the reset after that write finishes.
	let rebaseDuringPersist = false;

	function persist() {
		if (persisting) {
			// The outer append may synchronously notify callers. Defer their write
			// until its baseline has been committed, rather than planning against
			// a baseline that is about to change underneath the nested call.
			persistAgain = true;
			return true;
		}
		persisting = true;
		try {
			let rounds = 0;
			do {
				persistAgain = false;
				const ok = persistOnce();
				if (rebaseDuringPersist) {
					rebaseDuringPersist = false;
					resetBaselines();
				}
				if (!ok) return false;
				if (++rounds >= 100 && persistAgain) {
					noteError("persist", new Error("persistence reentry did not settle"));
					return false;
				}
			} while (persistAgain);
			return true;
		} finally {
			persisting = false;
		}
	}

	function persistOnce() {
		if (!manager || typeof manager.appendCustomEntry !== "function") return false;
		try {
			// Anything that rewrites the branch (a fold, an export, a future
			// history tool) drops entries the anchor depends on. A delta written
			// next would replay onto a truncated chain or onto none at all, so
			// the anchors are re-checked here rather than trusted from whichever
			// caller rewrote the branch.
			//
			// Two dependencies, checked separately because they are dropped
			// separately: the state baseline (a delta subtracts from it) and the
			// ledger snapshot (a ledger delta subtracts from it). A write that
			// owed only the ledger advances the second without touching the
			// first, so a fold to the state anchor can strand the ledger
			// snapshot while leaving the state anchor intact.
			// One walk answers every ancestry question this write asks: the state
			// baseline, the ledger snapshot, and the amends baseline. The form
			// this replaces read the whole branch once per question — three
			// times in the common case — and each read copied an entry per
			// message in the session.
			const ancestry = resolveOnLeafPath([
				lastStateEntryId,
				lastLedgerEntryId,
			]);
			if (lastPersisted !== null || lastBrackets !== null) {
				const anchorOk = lastPersisted === null || onLeafPath(lastStateEntryId, ancestry);
				if (!anchorOk) {
					lastPersisted = null;
					lastBrackets = null;
					lastLedgerEntryId = null;
					writes = 0;
					lastStateEntryId = null;
				} else if (!ledgerSnapshotOnBranch(ancestry)) {
					// The snapshot describes a change the journal no longer has.
					// Dropping it makes the next ledger write a full baseline,
					// which restates the whole live tree: the lost change comes
					// back, and nothing stale is resurrected, because a baseline
					// is folded as a replacement rather than an overlay.
					lastBrackets = null;
					lastLedgerEntryId = null;
				}
			}
			// Ledger first: it peeks the dirty mark that `serialize` clears.
			bindConsumer(state()?.brackets ?? null);
			const pendingRevision = consumerRevision(consumerLedger, consumerId);
			// A baseline is written when the deltas since the last one have cost
			// about what the baseline costs, so the total is bounded by twice
			// either. Both terms are measured bytes; the count ceiling is the
			// one bound a byte count cannot give, because a cold start pays per
			// entry as well as per byte.
			const reBaseline =
				lastBrackets !== null &&
				(ledgerDeltaBytes >= Math.max(ledgerBaselineBytes, LEDGER_BASELINE_MIN_BYTES) ||
					ledgerDeltas >= LEDGER_BASELINE_MAX_DELTAS);
			// A baseline is decided only once there is something to write. Asked for
			// unconditionally, it restates the whole ledger tree on a turn that owed
			// nothing: `planLedger(state, null)` cannot answer "no change", because
			// with no baseline it must produce one. So the cheap plan is taken first
			// — it answers null when nothing moved — and the baseline replaces it
			// only when a delta was owed and the interval had come round.
			const cheapPlan = planLedger(state(), lastBrackets, consumerId);
			const ledgerPlan =
				reBaseline && cheapPlan.entry
					? planLedger(state(), null, consumerId)
					: cheapPlan;
			// A refused ledger write is a real failure: the live tree could not
			// be read, and the journal deliberately keeps its last readable
			// state. Reporting success here would hide the loss behind a
			// "nothing owed" answer.
			if (ledgerPlan.refused) {
				noteError("ledger", new Error(`ledger write refused: ${ledgerPlan.refused}`));
				return false;
			}
			// The retired-beat list is gone: no per-turn bookkeeping is written.
			const full = serialize(state());
			const { core } = split(full);
			let entry = plan(lastPersisted, core, writes);
			// A checkpoint bounds how far a reader must fold, and the reader's
			// window counts entries rather than state writes. A turn that moves
			// only a fork record appends an entry the reader must fold through
			// while leaving `writes` where it was, so a session that moves records
			// far more often than it moves the core can reach the window with its
			// last checkpoint hundreds of entries behind it — and then restores as
			// nothing at all, because the window closes before it reaches one.
			//
			// So the bound is taken on what the journal actually received:
			// `entriesSinceCheckpoint` advances on every appended entry, whichever
			// half it carried, and one checkpoint is written when it reaches the
			// limit. Asked only on a write that owes something, because an idle
			// turn's answer must stay "nothing to write"; the counter cannot grow
			// without an append, so a session that was already quiet writes no
			// checkpoint it did not need.
			if (
				entry?.kind !== "checkpoint" &&
				entriesSinceCheckpoint >= CHECKPOINT_ENTRY_LIMIT &&
				(entry !== null || ledgerPlan.entry !== null)
			) {
				// The planner's own answer for "no previous state" is the whole
				// core, which is what a checkpoint carries: asking it that way
				// keeps the shape of a checkpoint in the one place that defines it.
				entry = plan(null, core, 0);
			}
			if (!entry && !ledgerPlan.entry) return true;
			// When both halves are owed they travel in one entry, so one append
			// carries both and neither can land without the other. Two appends
			// could land the ledger and fail the state, and the surviving half
			// would then describe a state the journal never received.
			//
			// The guarantee stops at the write unit. The host hands the line to
			// the OS synchronously, so a killed process keeps both halves; it
			// does not fsync, so a power loss may tear or drop this line; and a
			// failed disk write still returns an id while the entry stays in
			// memory. Advancing the baseline below therefore means "the host
			// accepted this write", not "it is on durable media".
			const payload = entry
				? ledgerPlan.entry
					? { ...entry, ledger: ledgerOf(ledgerPlan.entry) }
					: entry
				: ledgerPlan.entry;
			// Measured before the append. Once `appendCustomEntry` returns, the host
			// has accepted the line: a failure reported after that point is a
			// failure the retry repeats, and the journal gains a second copy of a
			// change it already holds.
			const ledgerBytes = ledgerPlan.entry ? entryBytes(ledgerPlan.entry) : 0;
			const entryId = manager.appendCustomEntry(type, payload);
			// Every appended entry moves the reader one step closer to its window,
			// whichever half it carried; a checkpoint resets the count below.
			entriesSinceCheckpoint += 1;
			if (entry) {
				// Only a state entry may become the anchor. A write that owed the
				// ledger alone lands an entry that carries fork records and no
				// serialized state; naming it here would make the next ancestry
				// check prove the wrong thing — that the ledger entry is still
				// reachable, not that the baseline a delta subtracts from is. A
				// fold that cut between the two would then look like "the anchor
				// is gone" only by accident, and a fold that kept both would look
				// right by accident. Keeping the state entry's id makes the check
				// mean what it says.
				lastStateEntryId = typeof entryId === "string" ? entryId : lastStateEntryId;
				lastPersisted = core;
				writes = entry.kind === "checkpoint" ? 0 : writes + 1;
				if (entry.kind === "checkpoint") entriesSinceCheckpoint = 0;
			}
			if (ledgerPlan.entry) {
				lastBrackets = ledgerPlan.brackets;
				// The running total is what the journal actually holds rather than
				// an estimate of it. A delta's size is a property of the entry, and
				// only measuring it can keep the bound honest. The measurement was
				// taken before the append, so nothing here can fail the write the
				// host has already accepted.
				if (ledgerPlan.entry.full === true) {
					ledgerDeltaBytes = 0;
					ledgerDeltas = 0;
					ledgerBaselineBytes = ledgerBytes;
				} else {
					ledgerDeltaBytes += ledgerBytes;
					ledgerDeltas += 1;
				}
				// Remember which entry the snapshot came from. It is not always
				// the state anchor: a ledger-only write lands its own entry, and
				// a later fold can strand that entry while the state anchor
				// survives. The next write needs to know that, or it computes a
				// delta against a snapshot the journal no longer holds.
				lastLedgerEntryId = typeof entryId === "string" ? entryId : null;
			}
			// The host accepted this write, so nothing is owed any more. This is
			// the only place the ledger's unsettled set is cleared: clearing it
			// earlier would lose the intent when the append throws, and the retry
			// would then owe nothing while the journal holds nothing either.
			if (pendingRevision !== undefined) commitConsumer(consumerLedger, consumerId, pendingRevision);
			return true;
		} catch (error) {
			noteError("persist", error);
			return false;
		}
	}

	/**
	 * A fold rewrote the branch, so every state entry after the fold point is
	 * gone. Drop the baseline and write a checkpoint while the rebased branch
	 * is the live one. The pending rebase tells `maybeRebase` to hand the new
	 * branch to the agent context.
	 */
	function resetBaselines() {
		lastPersisted = null;
		lastBrackets = null;
		lastLedgerEntryId = null;
		writes = 0;
		lastStateEntryId = null;
	}

	function rebase() {
		resetBaselines();
		rebased = true;
		if (persisting) rebaseDuringPersist = true;
		persist();
	}

	return {
		persist,
		rebase,
		needsRebase() {
			return rebased;
		},
		clearRebase() {
			rebased = false;
		},
	};
}
