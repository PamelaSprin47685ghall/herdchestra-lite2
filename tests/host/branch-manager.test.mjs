import { describe, expect, test } from "bun:test";

import { createBranchManager } from "../../host-omp/src/host/branch-manager.mjs";

/**
 * A raw manager whose appends read the manager-global leaf, which is the host
 * contract the flow proxy exists to tame. `appendMessageToBranch` is absent so
 * the fallback path through appendAt is exercised.
 */
function createShared() {
	const entries = new Map();
	let leaf = null;
	const append = (message) => {
		const id = `entry-${entries.size}`;
		entries.set(id, { id, parentId: leaf, message });
		leaf = id;
		return id;
	};
	const shared = {
		getLeafId: () => leaf,
		getEntry: (id) => entries.get(id),
		getBranch(from = leaf) {
			const path = [];
			for (let id = from; id != null; id = entries.get(id).parentId) path.unshift(entries.get(id));
			return path;
		},
		branch(id) {
			leaf = id;
		},
		resetLeaf() {
			leaf = null;
		},
		seal() {},
		close() {},
		appendMessage: (message) => append(message),
		buildSessionContext: () => ({ leaf }),
	};
	return { shared, entries, append, leaf: () => leaf };
}

describe("createBranchManager leaf scoping", () => {
	test("appendMessage runs at the flow tail and restores the shared leaf", () => {
		const { shared, entries, append, leaf } = createShared();
		const rootTip = append({ role: "user", content: "root" });
		const otherTip = append({ role: "user", content: "other" });
		const flow = createBranchManager(shared, { tail: rootTip });

		// The journal leaf now sits on another flow.
		shared.branch(otherTip);
		const id = flow.appendMessage({ role: "user", content: "flow work" });

		expect(entries.get(id).parentId).toBe(rootTip);
		expect(leaf()).toBe(otherTip);
		expect(flow.getLeafId()).toBe(id);
	});

	test("leaf reads run at the flow tail and leave the shared leaf alone", () => {
		const { shared, append, leaf } = createShared();
		const rootTip = append({ role: "user", content: "root" });
		const otherTip = append({ role: "user", content: "other" });
		const flow = createBranchManager(shared, { tail: rootTip });

		shared.branch(otherTip);
		expect(flow.buildSessionContext()).toEqual({ leaf: rootTip });
		expect(leaf()).toBe(otherTip);
	});

	test("an asynchronous write is refused and the leaf is restored", () => {
		const { shared, append, leaf } = createShared();
		const tip = append({ role: "user", content: "root" });
		shared.buildSessionContext = async () => ({ leaf });
		const flow = createBranchManager(shared, { tail: tip });

		expect(() => flow.buildSessionContext()).toThrow("appendAt requires a synchronous write");
		expect(leaf()).toBe(tip);
	});

	test("a throwing write is re-raised after the leaf is restored", () => {
		const { shared, append, leaf } = createShared();
		const tip = append({ role: "user", content: "root" });
		shared.appendModeChange = () => {
			throw new Error("boom");
		};
		const flow = createBranchManager(shared, { tail: tip });

		expect(() => flow.appendModeChange("x")).toThrow("boom");
		expect(leaf()).toBe(tip);
	});
});
