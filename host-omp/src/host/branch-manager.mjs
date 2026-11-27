// Per-flow proxy over one shared SessionManager.
//
// Host facts this file is built on (oh-my-pi
// packages/coding-agent/src/session/session-manager.ts):
//
// * #freshEntryFields() reads the manager-global leaf. Every plain append
//   (appendMessage, appendCustomEntry, appendCompaction, ...) therefore lands
//   on whichever flow wrote last. appendAt() below runs a synchronous write
//   inside a leaf scope and restores the entry.
// * appendMessageToBranch(message, parentId, options) appends off-branch and
//   never moves the leaf; it records activeLeafId = the shared leaf.
// * appendModelUsage(usage, { sessionId, parentId }) moves the leaf only when
//   parentId equals the active leaf, and restores it otherwise.
// * branch(id) / resetLeaf() are the only public leaf movers. getBranch(fromId)
//   accepts an explicit origin, while getConversationTip(),
//   buildSessionContext(), getLastModelChangeRole(),
//   getSessionLocalModelChange(), getCredentialPins() and
//   getInjectedTtsrRules() all read the manager-global leaf internally.
// * getConversationTip() adds a global guard: the branch tip must also be the
//   newest conversation entry in the whole journal. With several branches in
//   one journal that guard fails for every flow but the latest writer, so the
//   proxy derives the tip from the flow's own branch with the host's predicate.
// * getBranchView() returns a live memo of the global active branch. A live
//   per-flow memo cannot exist without moving that leaf, so this proxy returns
//   a fresh snapshot instead (read-only callers; the host forbids mutation).
// * seal() is terminal: #recordEntry then drops every append. close() flushes
//   and releases the append writer. releaseRetainedEntries() also clears the
//   in-memory journal. Those three are reference counted across flow proxies.
// * appendEntriesAtomically() owns a process-wide atomic batch: it stages
//   entries, rewrites the whole journal, and on failure reparents entries and
//   recomputes the leaf. discardEntryDurably() is the amend path and rewrites
//   the journal around a discarded entry. Neither can be scoped to one flow,
//   so both are rejected. rewriteEntries() only re-serialises the shared
//   in-memory journal and is leaf-independent, so it passes through.
// * setSessionName() appends a title_change entry through #freshEntryFields()
//   synchronously before its first await. The proxy routes that synchronous
//   prefix to its own tail and restores the shared leaf before returning the
//   host's promise.
//
// Known gaps, all outside what a manager instance can enforce:
//
// 1. A holder that keeps the raw manager and calls seal(), close() or
//    releaseRetainedEntries() directly bypasses the lease count. Every holder
//    (the root holder included) must use createBranchManager() or
//    retainBranchManager().
// 2. appendMessageToBranch records the shared active leaf as activeLeafId, so
//    a reload in the middle of a fork tree resumes at the root leaf, not at a
//    child leaf. A child branch is selected by appending at its own tail
//    through this proxy; the proxy does not change that host rule.
// 3. The proxy assumes a single JS thread: every leaf scope is synchronous and
//    must never span an await. A host append that becomes asynchronous would
//    break isolation. setSessionName is the only async entry point and is
//    handled by scoping only its synchronous prefix.
// 4. getBranchView() is a snapshot here, not the host's live memo. Callers
//    that hold the array across later appends will not observe them.
// 5. #recordEntry notifies onEntryAppended synchronously. An observer that
//    appends through the same proxy during that callback still sees the old
//    tail, so its entry becomes a sibling. Observers must queue such writes.

// The live leaf is the branch tip; getLeafId() may point at a metadata entry
// the host moved past, so the branch is the authority here.
function leafId(shared) {
	return shared.getBranch().at(-1)?.id ?? null;
}

/**
 * Run one synchronous write with the journal leaf aimed at `tail`, then
 * restore the leaf the caller had. Host writes read the manager-global leaf,
 * so this is the only way a flow aims an append at its own branch.
 */
function appendAt(shared, tail, write) {
	const saved = leafId(shared);
	let value;
	let failure;
	let failed = false;
	try {
		selectLeaf(shared, tail);
		value = write();
		if (value && typeof value.then === "function") {
			throw new TypeError("appendAt requires a synchronous write");
		}
	} catch (error) {
		failed = true;
		failure = error;
	}
	try {
		selectLeaf(shared, saved);
		if (leafId(shared) !== saved) throw new Error("leaf not restored");
	} catch (error) {
		throw new AggregateError(failed ? [failure, error] : [error], "leaf restore failed");
	}
	if (failed) throw failure;
	return value;
}

/** A routing failure that the caller must resolve instead of retrying. */
class BranchManagerError extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.name = "BranchManagerError";
		this.code = code;
	}
}

// Marker every flow proxy carries; the registry keeps the key stable across
// instances and across extension copies.
import { BRANCH_MANAGER } from "./process-symbols.mjs";

/** True only for a proxy built by createBranchManager(). */
export function isBranchManager(value) {
	if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
	return value[BRANCH_MANAGER] === true;
}
/**
 * Unwrap a flow proxy to the shared SessionManager beneath it. Every flow
 * carries its own manager proxy over one shared journal, so a lookup keyed by
 * the manager must ask for the shared object, not the proxy. Returns null for
 * a value that is neither object nor function, so callers can test the result.
 */
export function sharedManagerOf(value) {
	if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
	return isBranchManager(value) ? value.shared ?? null : value;
}

const REQUIRED_METHODS = ["getLeafId", "getBranch", "branch", "resetLeaf", "seal", "close"];

/** Sync appends that read the manager-global leaf and return the new entry id. */
const LEAF_WRITES = [
	"appendThinkingLevelChange",
	"appendServiceTierChange",
	"appendModeChange",
	"appendModelChange",
	"appendSessionInit",
	"appendCompaction",
	"appendResetBoundary",
	"appendCustomEntry",
	"appendCustomMessageEntry",
	"appendTtsrInjection",
	"appendCredentialPin",
	"appendLabelChange",
];

/** Sync reads that consult the manager-global branch internally. */
const LEAF_READS = [
	"buildSessionContext",
	"getLastModelChangeRole",
	"getSessionLocalModelChange",
	"getCredentialPins",
	"getInjectedTtsrRules",
];

// A mirror of the host's conversationTip predicate. conversationTip() returns
// the newest entry whose type is in this set, excluding eval-state snapshots.
const CONVERSATION_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary", "reset_boundary"]);
const EVAL_STATE_CONTEXT_TYPE = "eval-state-context";

function movesConversation(entry) {
	if (!CONVERSATION_ENTRY_TYPES.has(entry?.type)) return false;
	const customType = entry.type === "custom_message"
		? entry.customType
		: entry.message && "customType" in entry.message
			? entry.message.customType
			: undefined;
	return customType !== EVAL_STATE_CONTEXT_TYPE;
}

/** One lease registry per shared manager, so unrelated managers never share a count. */
const registries = new WeakMap();

/** Flow proxies by the manager they wrap, so the station layer can find one. */
const flowProxies = new WeakMap();

function registryFor(shared) {
	let registry = registries.get(shared);
	if (!registry) {
		registry = { holders: 0, sealed: false, closed: false, lastCloser: null, closing: null, entriesRelease: null };
		registries.set(shared, registry);
	}
	return registry;
}

function assertShared(shared) {
	if (!shared || (typeof shared !== "object" && typeof shared !== "function")) {
		throw new BranchManagerError("BRANCH_UNSUPPORTED", "a shared SessionManager instance is required");
	}
	const missing = REQUIRED_METHODS.filter((name) => typeof shared[name] !== "function");
	if (typeof shared.getEntry !== "function" && typeof shared.getEntries !== "function") {
		missing.push("getEntry()/getEntries()");
	}
	if (missing.length > 0) {
		throw new BranchManagerError(
			"BRANCH_UNSUPPORTED",
			`shared manager lacks ${missing.join(", ")}; a flow proxy cannot isolate its leaf without them`,
		);
	}
}

/** True when a manager exposes the leaf contract a flow proxy needs. */
export function canProxyBranchManager(shared) {
	try {
		assertShared(shared);
		return true;
	} catch {
		return false;
	}
}

function registerFlowProxy(shared, proxy, keys) {
	let map = flowProxies.get(shared);
	if (!map) {
		map = new Map();
		flowProxies.set(shared, map);
	}
	for (const key of keys) {
		if (typeof key === "string" && key !== "") map.set(key, proxy);
	}
}

/**
 * Find the flow proxy created over `value` (a raw manager or a proxy) for
 * `flowKey`. A host session may expose its manager without the proxy it was
 * handed, so the station layer resolves the proxy by identity instead.
 */
export function findBranchManager(value, flowKey) {
	if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
	if (isBranchManager(value)) return value;
	if (typeof flowKey !== "string" || flowKey === "") return null;
	return flowProxies.get(value)?.get(flowKey) ?? null;
}

function acquireLease(shared) {
	const registry = registryFor(shared);
	if (registry.sealed || registry.closed) {
		throw new BranchManagerError(
			"BRANCH_LEASE_CLOSED",
			"cannot join a shared manager that is already sealed or closed",
		);
	}
	registry.holders += 1;
	return { shared, registry, sealed: false, closed: false };
}

/** Drop one lease; the last sealer raises the host's terminal write barrier. */
function sealLease(lease) {
	if (lease.sealed) return;
	lease.sealed = true;
	lease.registry.holders -= 1;
	if (lease.registry.holders > 0 || lease.registry.sealed) return;
	lease.registry.sealed = true;
	lease.shared.seal();
}

/** Drop one lease; the last closer owns the single host close. */
function closeLease(lease) {
	const registry = lease.registry;
	if (lease.closed) return registry.closing ?? Promise.resolve();
	lease.closed = true;
	if (!lease.sealed) {
		lease.sealed = true;
		registry.holders -= 1;
	}
	if (registry.holders > 0) return Promise.resolve();
	if (registry.closed) return registry.closing ?? Promise.resolve();
	registry.closed = true;
	registry.lastCloser = lease;
	registry.closing = Promise.resolve().then(() => lease.shared.close());
	return registry.closing;
}

/**
 * Only the last closer may release the shared journal, and only after close()
 * has flushed it. close() persists the retained entries; releaseRetainedEntries()
 * clears them from memory, so releasing first would discard the transcript.
 */
function releaseEntriesLease(lease) {
	const registry = lease.registry;
	if (!lease.closed || registry.lastCloser !== lease) return undefined;
	registry.entriesRelease ??= (registry.closing ?? Promise.resolve()).then((value) => {
		if (typeof lease.shared.releaseRetainedEntries === "function") lease.shared.releaseRetainedEntries();
		return value;
	});
	return registry.entriesRelease;
}

function requireMethod(shared, name) {
	if (typeof shared[name] !== "function") {
		throw new BranchManagerError("BRANCH_UNSUPPORTED", `shared manager does not implement ${name}()`);
	}
}

function selectLeaf(shared, leaf) {
	if (leaf == null) shared.resetLeaf();
	else shared.branch(leaf);
}

function hasEntry(shared, id) {
	if (id == null) return false;
	if (typeof shared.getEntry === "function") return shared.getEntry(id) !== undefined;
	return shared.getEntries().some((entry) => entry.id === id);
}

function entryFor(shared, id) {
	if (id == null) return undefined;
	if (typeof shared.getEntry === "function") return shared.getEntry(id);
	return shared.getEntries().find((entry) => entry.id === id);
}

function assertWritable(state) {
	if (state.lease.sealed) {
		throw new BranchManagerError("BRANCH_RELEASED", "flow proxy is sealed; its appends can no longer be obeyed");
	}
}

/**
 * Every append returns the new entry id, and the flow tail must advance with
 * it. A missing id would leave the tail where it was, so the next write would
 * become a sibling of the entry just written instead of its child.
 */
function committedId(value, operation) {
	if (typeof value !== "string" || value === "") {
		throw new BranchManagerError("BRANCH_UNSUPPORTED", `${operation}() did not return an entry id`);
	}
	return value;
}

/**
 * Hold the shared manager open without owning a flow leaf. The batch owner keeps
 * one of these for the whole session so an individual flow's dispose cannot
 * close the manager out from under its siblings.
 */
export function retainBranchManager(shared) {
	assertShared(shared);
	const lease = acquireLease(shared);
	return {
		get released() {
			return lease.closed;
		},
		release() {
			if (lease.closed) return lease.registry.closing ?? Promise.resolve();
			sealLease(lease);
			const closing = closeLease(lease);
			return releaseEntriesLease(lease) ?? closing;
		},
	};
}

/**
 * Create the per-flow view. `tail` is the flow's own active leaf; `label` is
 * only carried for diagnostics.
 */
export function createBranchManager(shared, options = {}) {
	assertShared(shared);
	const tail = options.tail ?? null;
	if (tail !== null) {
		if (typeof tail !== "string" || !hasEntry(shared, tail)) {
			throw new BranchManagerError("BRANCH_UNSUPPORTED", `flow tail ${String(tail)} is not an entry of the shared manager`);
		}
	}
	const lease = acquireLease(shared);
	const state = { tail, label: options.label ?? "", lease };
	const operations = Object.create(null);
	const currentTail = () => state.tail;

	function writeAtTail(name, args) {
		assertWritable(state);
		requireMethod(shared, name);
		const id = committedId(appendAt(shared, currentTail(), () => shared[name](...args)), name);
		state.tail = id;
		return id;
	}

	operations.appendMessage = (message) => {
		assertWritable(state);
		const tail = currentTail();
		if (typeof shared.appendMessageToBranch === "function") {
			const id = committedId(shared.appendMessageToBranch(message, tail, { preserveActiveLeaf: true }), "appendMessageToBranch");
			state.tail = id;
			return id;
		}
		requireMethod(shared, "appendMessage");
		const id = committedId(appendAt(shared, tail, () => shared.appendMessage(message)), "appendMessage");
		state.tail = id;
		return id;
	};

	operations.appendMessageToBranch = (message, parentId, branchOptions) => {
		assertWritable(state);
		requireMethod(shared, "appendMessageToBranch");
		const tail = currentTail();
		const parent = parentId === undefined ? tail : parentId;
		const id = committedId(shared.appendMessageToBranch(message, parent, branchOptions), "appendMessageToBranch");
		if (branchOptions?.preserveActiveLeaf === false && parent === tail) state.tail = id;
		return id;
	};

	operations.appendModelUsage = (usage, owner) => {
		assertWritable(state);
		requireMethod(shared, "appendModelUsage");
		const tail = currentTail();
		const parentId = owner?.parentId === undefined ? tail : owner.parentId;
		const sessionId = owner?.sessionId ?? (typeof shared.getSessionId === "function" ? shared.getSessionId() : undefined);
		if (sessionId === undefined) {
			throw new BranchManagerError("BRANCH_UNSUPPORTED", "shared manager exposes no session id for model usage");
		}
		// The host advances the leaf when the owner is the active leaf. Selecting
		// the owner first makes that path explicit; appendAt restores the shared
		// leaf regardless.
		const id = committedId(appendAt(shared, parentId, () => shared.appendModelUsage(usage, { sessionId, parentId })), "appendModelUsage");
		if (parentId === tail) state.tail = id;
		return id;
	};

	for (const name of LEAF_WRITES) operations[name] = (...args) => writeAtTail(name, args);

	operations.branchWithSummary = (branchFromId, summary, details, fromExtension) => {
		assertWritable(state);
		requireMethod(shared, "branchWithSummary");
		const parent = branchFromId === undefined ? currentTail() : branchFromId;
		const id = committedId(appendAt(shared, parent, () => shared.branchWithSummary(parent, summary, details, fromExtension)), "branchWithSummary");
		state.tail = id;
		return id;
	};

	operations.setSessionName = (name, source, trigger) => {
		assertWritable(state);
		requireMethod(shared, "setSessionName");
		// The host records the title entry synchronously before its first await.
		// Scope only that prefix, remember the leaf it leaves behind, restore the
		// shared leaf, and hand the pending persistence promise back untouched.
		const tail = currentTail();
		const saved = shared.getLeafId();
		let written = null;
		let promise;
		let failure;
		let failed = false;
		try {
			selectLeaf(shared, tail);
			promise = shared.setSessionName(name, source, trigger);
			written = shared.getLeafId();
		} catch (error) {
			failed = true;
			failure = error;
		}
		try {
			selectLeaf(shared, saved);
			if (shared.getLeafId() !== saved) throw new Error("shared leaf not restored");
		} catch (error) {
			throw new AggregateError(failed ? [failure, error] : [error], "branch manager leaf restore failed");
		}
		if (failed) throw failure;
		// A rename that appended moved the leaf to the new title entry, which was
		// recorded at the flow's tail. A no-op rename leaves the leaf at the tail.
		if (typeof written === "string" && written !== tail) {
			const entry = entryFor(shared, written);
			if (entry?.parentId === tail) state.tail = written;
		}
		return promise;
	};

	for (const name of LEAF_READS) {
		operations[name] = (...args) => {
			requireMethod(shared, name);
			// appendAt is the project's synchronous leaf-scope primitive. Reads do
			// not advance the tail.
			return appendAt(shared, currentTail(), () => shared[name](...args));
		};
	}

	// Read the tip from the flow's own branch. The host's own getConversationTip()
	// guards against a branch tip older than the journal's newest conversation
	// entry, a guard parallel flows would constantly fail.
	operations.getConversationTip = () => {
		const branch = operations.getBranch();
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			if (movesConversation(branch[index])) return branch[index];
		}
		return undefined;
	};

	// A per-flow live memo cannot exist without moving the shared leaf. Hand out
	// a snapshot of this flow's branch and document the difference.
	operations.getBranchView = () => operations.getBranch();

	operations.getBranch = (fromId) => {
		// The host treats a nullish origin as "the active leaf"; mirror that.
		const origin = fromId ?? currentTail();
		if (origin === null) return [];
		return shared.getBranch(origin);
	};

	operations.getLeafId = () => currentTail();
	operations.getLeafEntry = () => entryFor(shared, currentTail());

	operations.branch = (id) => {
		assertWritable(state);
		if (typeof id !== "string") throw new TypeError("branch(id) requires an entry id");
		if (!hasEntry(shared, id)) throw new Error(`Entry ${id} not found`);
		state.tail = id;
	};

	operations.resetLeaf = () => {
		assertWritable(state);
		state.tail = null;
	};

	// The atomic batch stages entries across the whole shared journal and its
	// rollback reparents other flows' entries. Amend rewrites the journal around
	// a discarded leaf. Neither is a per-flow operation.
	operations.appendEntriesAtomically = () => {
		throw new BranchManagerError(
			"BRANCH_UNSUPPORTED",
			"appendEntriesAtomically() owns the shared journal's atomic batch and cannot be scoped to one flow",
		);
	};
	operations.discardEntryDurably = () => {
		throw new BranchManagerError(
			"BRANCH_UNSUPPORTED",
			"discardEntryDurably() rewrites the shared journal by entry id; a flow corrects itself through its own return report instead",
		);
	};
	operations.discardEntriesDurably = () => {
		throw new BranchManagerError(
			"BRANCH_UNSUPPORTED",
			"discardEntriesDurably() removes journal entries across every flow; a flow corrects itself through its own return report instead",
		);
	};
	operations.ingestReplicatedEntry = () => {
		throw new BranchManagerError(
			"BRANCH_UNSUPPORTED",
			"ingestReplicatedEntry() writes at the shared journal's global leaf; a flow writes through its own tail",
		);
	};

	operations.seal = () => {
		sealLease(lease);
	};
	operations.close = () => closeLease(lease);
	operations.releaseRetainedEntries = () => releaseEntriesLease(lease);

	Object.defineProperties(operations, {
		shared: { get: () => shared, enumerable: true },
		tail: {
			get: () => currentTail(),
			set: (value) => {
				if (value === null) {
					state.tail = null;
					return;
				}
				if (typeof value !== "string" || !hasEntry(shared, value)) {
					throw new BranchManagerError("BRANCH_UNSUPPORTED", `flow tail ${String(value)} is not an entry`);
				}
				state.tail = value;
			},
			enumerable: true,
		},
		label: { get: () => state.label, enumerable: true },
		lease: { get: () => lease, enumerable: false },
	});
	Object.defineProperty(operations, BRANCH_MANAGER, { value: true, enumerable: false });

	const bound = new Map();
	const proxy = new Proxy(operations, {
		get(target, property) {
			if (property === "then") return undefined;
			if (property === Symbol.toStringTag) return "BranchManager";
			if (property in target) return target[property];
			if (typeof property === "symbol") return Reflect.get(shared, property, shared);
			const value = Reflect.get(shared, property, shared);
			if (typeof value !== "function") return value;
			let method = bound.get(property);
			if (!method) {
				// Bind to the real manager: its implementation uses private fields.
				method = value.bind(shared);
				bound.set(property, method);
			}
			return method;
		},
		set(target, property, value) {
			if (property === "tail") {
				target.tail = value;
				return true;
			}
			if (property === "shared" || property === "label" || property === "lease") return false;
			return Reflect.set(shared, property, value, shared);
		},
		has(target, property) {
			return property in target || property in shared;
		},
	});
	registerFlowProxy(shared, proxy, [options.flowId, options.label]);
	return proxy;
}
