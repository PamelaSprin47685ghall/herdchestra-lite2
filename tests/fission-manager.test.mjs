import { describe, expect, test } from "bun:test";

import {
	createFissionManager,
	createFlowTailResolver,
	FissionManagerError,
	findFissionManager,
	isFissionManager,
	retainFissionManager,
} from "../src/host/fission-manager.mjs";

// A journal that mirrors the host facts the proxy is built on: one shared
// active leaf, plain appends that follow it, off-branch appends that never
// move it, resume-on-owner model usage, and a title append that runs before
// setSessionName() returns its persistence promise.
function makeShared({ journal = true } = {}) {
	const entries = [];
	const calls = {
		seal: 0,
		close: 0,
		release: 0,
		events: [],
		namePromise: Promise.resolve("saved"),
	};
	let leaf = null;
	let sequence = 0;
	const candidate = () => `e${(sequence += 1).toString(16).padStart(3, "0")}`;
	const appendEntry = (fields) => {
		const id = candidate();
		const entry = { id, parentId: leaf, ...fields };
		entries.push(entry);
		leaf = id;
		return id;
	};
	const shared = {
		calls,
		entries,
		getLeafId: () => leaf,
		getSessionId: () => "session-1",
		getBranch: (fromId) => {
			let current = fromId === undefined ? leaf : fromId;
			const branch = [];
			while (current != null) {
				const entry = entries.find((item) => item.id === current);
				if (!entry) throw new Error(`missing entry ${current}`);
				branch.unshift(entry);
				current = entry.parentId;
			}
			return branch;
		},
		getEntry: (id) => entries.find((entry) => entry.id === id),
		getEntries: () => entries.slice(),
		getEntriesView: () => entries.slice(),
		branch: (id) => {
			if (!entries.some((entry) => entry.id === id)) throw new Error(`Entry ${id} not found`);
			leaf = id;
		},
		resetLeaf: () => {
			leaf = null;
		},
		appendMessage: (message) => appendEntry({ type: "message", message }),
		appendMessageToBranch: (message, parentId) => {
			// Host fact: an off-branch append never moves the shared leaf.
			const id = candidate();
			entries.push({ id, parentId, type: "message", message, activeLeafId: leaf });
			return id;
		},
		appendModelUsage: (usage, owner) => {
			const id = candidate();
			entries.push({ id, parentId: owner.parentId, type: "model_usage", usage, sessionId: owner.sessionId });
			if (owner.parentId === leaf) leaf = id;
			return id;
		},
		appendCustomEntry: (customType, data) => appendEntry({ type: "custom", customType, data }),
		appendCustomMessageEntry: (customType, content) => appendEntry({ type: "custom_message", customType, content }),
		appendModelChange: (...args) => appendEntry({ type: "model_change", args }),
		branchWithSummary: (fromId, summary, details, fromExtension) =>
			appendEntry({ type: "branch_summary", fromId, summary, details, fromExtension }),
		buildSessionContext: () => ({ leafId: leaf, branch: shared.getBranch() }),
		getCredentialPins: () => [],
		setSessionName: (name, source, trigger) => {
			const parent = leaf;
			appendEntry({ type: "title_change", name, source, trigger });
			calls.events.push(["title", parent]);
			return calls.namePromise;
		},
		seal: () => {
			calls.seal += 1;
			calls.events.push(["seal"]);
		},
		close: () => {
			calls.close += 1;
			calls.events.push(["close:start", entries.length]);
			return Promise.resolve().then(() => {
				calls.events.push(["close:flushed"]);
				return "closed";
			});
		},
		releaseRetainedEntries: () => {
			calls.release += 1;
			calls.events.push(["release"]);
			entries.length = 0;
			leaf = null;
		},
	};
	if (!journal) {
		delete shared.getEntries;
		delete shared.getEntriesView;
	}
	return shared;
}

function seed(shared) {
	return shared.appendMessage({ role: "user", content: "root", timestamp: 0 });
}

function codeOf(run) {
	try {
		run();
	} catch (error) {
		return error.code;
	}
	return undefined;
}

const ids = (branch) => branch.map((entry) => entry.id);
const eventNames = (shared) => shared.calls.events.map(([name]) => name);

describe("fission manager", () => {
	test("refuses a shared object without the leaf contract", () => {
		expect(() => createFissionManager({})).toThrow(FissionManagerError);
		expect(() => retainFissionManager(null)).toThrow(FissionManagerError);
		expect(codeOf(() => createFissionManager({ getLeafId: () => null }))).toBe("FISSION_UNSUPPORTED");
		expect(codeOf(() => retainFissionManager({}))).toBe("FISSION_UNSUPPORTED");
	});

	test("rejects a tail that is not an entry without taking a lease", async () => {
		const shared = makeShared();
		seed(shared);
		expect(codeOf(() => createFissionManager(shared, { tail: "nope" }))).toBe("FISSION_UNSUPPORTED");
		expect(codeOf(() => createFissionManager(shared, { tail: 42 }))).toBe("FISSION_UNSUPPORTED");
		// A leaked lease would keep the manager open after the only holder goes.
		await retainFissionManager(shared).release();
		expect(shared.calls.seal).toBe(1);
		expect(shared.calls.close).toBe(1);
		expect(shared.calls.release).toBe(1);
	});

	test("writes each flow along its own leaf and restores the shared leaf", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root, label: "a" });
		const b = createFissionManager(shared, { tail: root, label: "b" });
		const a1 = a.appendMessage({ role: "assistant", content: "a1" });
		expect(shared.getLeafId()).toBe(root);
		const b1 = b.appendMessage({ role: "assistant", content: "b1" });
		expect(shared.getLeafId()).toBe(root);
		const a2 = a.appendCustomEntry("scope.begin", { intent: "a" });
		expect(shared.getLeafId()).toBe(root);
		expect(a.tail).toBe(a2);
		expect(b.tail).toBe(b1);
		expect(a.getLeafId()).toBe(a2);
		expect(b.getLeafId()).toBe(b1);
		expect(ids(a.getBranch())).toEqual([root, a1, a2]);
		expect(ids(b.getBranch())).toEqual([root, b1]);
		expect(a.shared).toBe(shared);
		expect(a.label).toBe("a");
		expect(b.label).toBe("b");
	});

	test("restores whichever shared leaf another flow or writer left active", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const b = createFissionManager(shared, { tail: root });
		const b1 = b.appendMessage({ role: "user", content: "b" });
		shared.branch(b1);
		const a1 = a.appendCustomEntry("scope.begin", {});
		expect(shared.getLeafId()).toBe(b1);
		expect(ids(a.getBranch())).toEqual([root, a1]);
		shared.resetLeaf();
		const a2 = a.appendModelChange("model-x");
		expect(shared.getLeafId()).toBeNull();
		expect(ids(a.getBranch())).toEqual([root, a1, a2]);
	});

	test("appendMessageToBranch advances the flow tail only when it continues from it", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const off = a.appendMessageToBranch({ role: "user", content: "off" }, root, { preserveActiveLeaf: true });
		expect(a.tail).toBe(root);
		expect(shared.getLeafId()).toBe(root);
		const on = a.appendMessageToBranch({ role: "user", content: "on" }, root, { preserveActiveLeaf: false });
		expect(a.tail).toBe(on);
		expect(shared.getLeafId()).toBe(root);
		const sibling = a.appendMessageToBranch({ role: "user", content: "sibling" }, off, { preserveActiveLeaf: false });
		expect(a.tail).toBe(on);
		expect(shared.getLeafId()).toBe(root);
		expect(ids(a.getBranch())).toEqual([root, on]);
		expect(shared.getEntry(sibling).parentId).toBe(off);
	});

	test("appendModelUsage follows the flow tail and restores the shared leaf", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const first = a.appendMessage({ role: "user", content: "a" });
		const b = createFissionManager(shared, { tail: root });
		const b1 = b.appendMessage({ role: "user", content: "b" });
		shared.branch(b1);
		const usage = a.appendModelUsage({ cost: 1 });
		expect(a.tail).toBe(usage);
		expect(shared.getLeafId()).toBe(b1);
		const entry = shared.getEntry(usage);
		expect(entry).toMatchObject({ type: "model_usage", parentId: first, sessionId: "session-1" });
		const second = a.appendModelUsage({ cost: 2 }, { parentId: root });
		expect(shared.getEntry(second).parentId).toBe(root);
		expect(a.tail).toBe(usage);
		expect(shared.getLeafId()).toBe(b1);
	});

	test("leaf-scoped reads observe the flow branch and restore the shared leaf", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const a1 = a.appendMessage({ role: "assistant", content: "a1" });
		shared.branch(root);
		const context = a.buildSessionContext();
		expect(context.leafId).toBe(a1);
		expect(context.branch.at(-1).id).toBe(a1);
		expect(shared.getLeafId()).toBe(root);
		expect(a.tail).toBe(a1);
	});

	test("derives the conversation tip from the flow branch", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const first = a.appendMessage({ role: "assistant", content: "first" });
		a.appendCustomEntry("scope.begin", {});
		expect(a.getConversationTip().id).toBe(first);
		a.appendCustomMessageEntry("eval-state-context", "hidden");
		expect(a.getConversationTip().id).toBe(first);
		a.appendMessage({ role: "user", content: "hidden", customType: "eval-state-context" });
		expect(a.getConversationTip().id).toBe(first);
		const custom = a.appendCustomMessageEntry("note", "visible");
		expect(a.getConversationTip().id).toBe(custom);
		const summary = a.branchWithSummary(undefined, "summary", {}, true);
		expect(a.getConversationTip().id).toBe(summary);
		const b = createFissionManager(shared, { tail: root });
		b.appendMessage({ role: "assistant", content: "newer" });
		expect(a.getConversationTip().id).toBe(summary);
		expect(b.getConversationTip().message.content).toBe("newer");
		const empty = createFissionManager(shared);
		expect(empty.getConversationTip()).toBeUndefined();
		expect(empty.getBranch()).toEqual([]);
	});

	test("branch, resetLeaf and the tail setter stay inside the flow", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const a1 = a.appendMessage({ role: "assistant", content: "a1" });
		const a2 = a.appendMessage({ role: "assistant", content: "a2" });
		a.branch(a1);
		expect(a.getLeafId()).toBe(a1);
		expect(shared.getLeafId()).toBe(root);
		a.tail = a2;
		expect(a.getLeafId()).toBe(a2);
		expect(codeOf(() => {
			a.tail = "missing";
		})).toBe("FISSION_UNSUPPORTED");
		expect(() => a.branch("missing")).toThrow(/not found/);
		expect(() => a.branch(7)).toThrow(TypeError);
		a.resetLeaf();
		expect(a.getLeafId()).toBeNull();
		expect(a.getLeafEntry()).toBeUndefined();
		expect(a.getBranch()).toEqual([]);
		expect(a.getConversationTip()).toBeUndefined();
		expect(shared.getLeafId()).toBe(root);
		const rooted = a.appendMessage({ role: "user", content: "rooted" });
		expect(a.getBranch().map((entry) => [entry.id, entry.parentId])).toEqual([[rooted, null]]);
	});

	test("the last seal raises the host barrier and blocks further writes", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const b = createFissionManager(shared, { tail: root });
		a.seal();
		expect(shared.calls.seal).toBe(0);
		expect(codeOf(() => a.appendMessage({ role: "user", content: "late" }))).toBe("FISSION_RELEASED");
		expect(ids(a.getBranch())).toEqual([root]);
		const b1 = b.appendMessage({ role: "user", content: "still open" });
		expect(b.tail).toBe(b1);
		b.seal();
		expect(shared.calls.seal).toBe(1);
		expect(codeOf(() => createFissionManager(shared, { tail: root }))).toBe("FISSION_LEASE_CLOSED");
	});

	test("closes once after the last holder and releases entries after the flush", async () => {
		const shared = makeShared();
		const root = seed(shared);
		const holder = retainFissionManager(shared);
		const flow = createFissionManager(shared, { tail: root });
		await flow.close();
		expect(shared.calls.close).toBe(0);
		expect(shared.calls.seal).toBe(0);
		expect(holder.released).toBe(false);
		const closing = holder.release();
		expect(holder.released).toBe(true);
		expect(shared.calls.close).toBe(0);
		expect(await closing).toBe("closed");
		expect(shared.calls.seal).toBe(1);
		expect(shared.calls.close).toBe(1);
		expect(shared.calls.release).toBe(1);
		const events = eventNames(shared);
		expect(events.at(-1)).toBe("release");
		expect(events.indexOf("release")).toBeGreaterThan(events.indexOf("close:flushed"));
	});

	test("the last closing flow releases the journal after the flush", async () => {
		const shared = makeShared();
		const root = seed(shared);
		const holder = retainFissionManager(shared);
		const flow = createFissionManager(shared, { tail: root });
		await holder.release();
		expect(shared.calls.close).toBe(0);
		expect(shared.calls.release).toBe(0);
		await flow.close();
		expect(shared.calls.close).toBe(1);
		expect(shared.calls.release).toBe(0);
		const releasing = flow.releaseRetainedEntries();
		expect(shared.calls.release).toBe(0);
		expect(await releasing).toBe("closed");
		expect(shared.calls.release).toBe(1);
		const events = eventNames(shared);
		expect(events.indexOf("release")).toBeGreaterThan(events.indexOf("close:flushed"));
		await flow.releaseRetainedEntries();
		expect(shared.calls.release).toBe(1);
	});

	test("setSessionName scopes its synchronous title append and returns the host promise", async () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const b = createFissionManager(shared, { tail: root });
		const b1 = b.appendMessage({ role: "user", content: "b" });
		shared.branch(b1);
		const pending = Promise.resolve("saved");
		shared.calls.namePromise = pending;
		const returned = a.setSessionName("Title", "user", "test");
		expect(returned).toBe(pending);
		const title = a.getLeafEntry();
		expect(title).toMatchObject({ type: "title_change", parentId: root, name: "Title" });
		expect(a.tail).toBe(title.id);
		expect(shared.getLeafId()).toBe(b1);
		expect(ids(a.getBranch())).toEqual([root, title.id]);
		expect(await returned).toBe("saved");
	});

	test("supports a manager that exposes journal reads only through getEntry", async () => {
		const shared = makeShared({ journal: false });
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		const message = a.appendMessage({ role: "user", content: "hello" });
		expect(ids(a.getBranch())).toEqual([root, message]);
		expect(a.getLeafEntry().id).toBe(message);
		shared.branch(message);
		const pending = Promise.resolve("saved");
		shared.calls.namePromise = pending;
		const returned = a.setSessionName("Title");
		expect(returned).toBe(pending);
		const title = a.getLeafEntry();
		expect(title.type).toBe("title_change");
		expect(a.tail).toBe(title.id);
		expect(shared.getLeafId()).toBe(message);
		expect(await returned).toBe("saved");
	});

	test("refuses journal-wide operations and absent host methods", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		expect(codeOf(() => a.appendEntriesAtomically(() => {}))).toBe("FISSION_UNSUPPORTED");
		expect(codeOf(() => a.discardEntryDurably("id"))).toBe("FISSION_UNSUPPORTED");
		const bare = makeShared();
		const bareRoot = seed(bare);
		delete bare.appendModelUsage;
		const b = createFissionManager(bare, { tail: bareRoot });
		expect(codeOf(() => b.appendModelUsage({}, {}))).toBe("FISSION_UNSUPPORTED");
	});

	test("forwards unknown host members and exposes the lease state", () => {
		const shared = makeShared();
		const root = seed(shared);
		const a = createFissionManager(shared, { tail: root });
		expect(a.getSessionId()).toBe("session-1");
		expect(a.getEntries()).toHaveLength(1);
		expect(a.then).toBeUndefined();
		expect(Object.prototype.toString.call(a)).toBe("[object FissionManager]");
		expect(() => {
			a.shared = shared;
		}).toThrow();
		expect(() => {
			a.label = "other";
		}).toThrow();
	});
});

describe("fission manager live flow tails", () => {
	function beginFlow(shared, label, parent) {
		shared.branch(parent);
		return shared.appendCustomEntry("scope.begin", { flow: label });
	}

	test("resolves a flow's live leaf and ignores its siblings", () => {
		const shared = makeShared();
		const root = seed(shared);
		const aBegin = beginFlow(shared, "b1.0", root);
		const bBegin = beginFlow(shared, "b1.1", root);
		shared.branch(aBegin);
		const aWrite = shared.appendCustomEntry("scope.state", { seq: 1 });
		shared.branch(bBegin);
		const bWrite = shared.appendCustomEntry("scope.state", { seq: 2 });

		const resolveA = createFlowTailResolver(shared, { label: "b1.0" });
		const resolveB = createFlowTailResolver(shared, { flowId: "b1.1" });
		expect(resolveA()).toBe(aWrite);
		expect(resolveB()).toBe(bWrite);
		expect(resolveA()).not.toBe(bWrite);
	});

	test("a resolver-driven proxy follows raw scheduler writes", () => {
		const shared = makeShared();
		const root = seed(shared);
		const begin = beginFlow(shared, "b1.0", root);
		const proxy = createFissionManager(shared, {
			label: "b1.0",
			resolveTail: createFlowTailResolver(shared, { label: "b1.0" }),
		});
		expect(proxy.getLeafId()).toBe(begin);
		// The scheduler writes the flow's closing boundary through the raw
		// manager; the proxy's next write must continue from it, not from its
		// own stale tail.
		const end = shared.appendCustomEntry("scope.end", {});
		const message = proxy.appendMessage({ role: "assistant", content: "after" });
		expect(shared.getLeafId()).toBe(end);
		expect(shared.getEntry(message).parentId).toBe(end);
		expect(ids(proxy.getBranch()).slice(-2)).toEqual([end, message]);
	});

	test("one flow's disposal never seals the manager for its siblings", async () => {
		const shared = makeShared();
		const root = seed(shared);
		beginFlow(shared, "b1.0", root);
		beginFlow(shared, "b1.1", root);
		const a = createFissionManager(shared, {
			label: "b1.0",
			resolveTail: createFlowTailResolver(shared, { label: "b1.0" }),
		});
		const b = createFissionManager(shared, {
			label: "b1.1",
			resolveTail: createFlowTailResolver(shared, { label: "b1.1" }),
		});
		expect(isFissionManager(a)).toBe(true);
		expect(findFissionManager(shared, "b1.0")).toBe(a);
		await a.close();
		expect(shared.calls.seal).toBe(0);
		expect(shared.calls.close).toBe(0);
		const written = b.appendMessage({ role: "assistant", content: "alive" });
		expect(shared.getEntry(written).parentId).not.toBeNull();
	});
});
