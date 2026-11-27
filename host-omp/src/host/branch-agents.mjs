/**
 * Isolated AgentRegistry proxy for a single fork branch.
 *
 * A fork branch runs in its own AgentSession, so the host's
 * `createAgentSession()` registers `flowId` in `config.agentRegistry`. When
 * that falls back to `AgentRegistry.global()`, every fork branch shows up as a
 * standalone row in the host Agent Hub UI.
 *
 * This wrapper implements the host `AgentRegistryApi` surface synchronously:
 * - Operations targeting `flowId` stay private in memory and never touch
 *   `baseRegistry` or emit global registry events.
 * - Operations targeting any other agent id forward to `baseRegistry`, and
 *   rewrite `parentId === flowId` to `ownerAgentId` so real child tasks stay
 *   visible under the owning task (or Main) in Agent Hub.
 */

import { isNonEmptyString } from "./object-read.mjs";

function matchesExpected(ref, expected) {
	return expected === undefined || ref === expected || ref.session === expected;
}

function createNoopAwaits() {
	return {
		hold: () => () => {},
		release: () => {},
		getWaiters: () => [],
		getTargets: () => [],
		list: () => [],
		onChange: () => () => {},
	};
}

function wrapAwaits(baseAwaits, flowId, ownerAgentId) {
	if (!baseAwaits || typeof baseAwaits !== "object") return createNoopAwaits();
	const mapId = (id) => (id === flowId && isNonEmptyString(ownerAgentId) ? ownerAgentId : id);
	return new Proxy(baseAwaits, {
		get(target, prop, receiver) {
			if (prop === "hold" && typeof target.hold === "function") {
				return (waiterId, targets, options) => target.hold(mapId(waiterId), targets, options);
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * Create a scoped AgentRegistryApi proxy for one fork branch.
 *
 * @param {object} options
 * @param {object | null | undefined} options.baseRegistry - Host AgentRegistry (e.g. AgentRegistry.global()).
 * @param {string} options.flowId - The fork branch's agentId to keep private.
 * @param {string | null | undefined} [options.ownerAgentId] - Owning task or Main agentId for child parentId rewriting.
 */
export function createBranchAgentRegistry({ baseRegistry = null, flowId, ownerAgentId = null } = {}) {
	if (!isNonEmptyString(flowId)) {
		throw new TypeError("createBranchAgentRegistry requires a non-empty flowId");
	}

	let localRef = null;
	let generation = 0;

	const awaits = wrapAwaits(baseRegistry?.awaits, flowId, ownerAgentId);

	function buildLocalRef(input) {
		const now = Date.now();
		generation += 1;
		return {
			id: input.id,
			generation,
			displayName: input.displayName ?? input.id,
			kind: input.kind ?? "sub",
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session ?? null,
			sessionFile: input.sessionFile ?? null,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			...(input.activity !== undefined ? { activity: input.activity } : {}),
			...(input.history !== undefined ? { history: input.history } : {}),
			...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
		};
	}

	function rewriteParent(input) {
		if (!input || typeof input !== "object") return input;
		if (input.parentId === flowId && isNonEmptyString(ownerAgentId)) {
			return { ...input, parentId: ownerAgentId };
		}
		return input;
	}

	return {
		awaits,

		register(input) {
			if (input?.id === flowId) {
				localRef = buildLocalRef(input);
				return localRef;
			}
			if (typeof baseRegistry?.register === "function") {
				return baseRegistry.register(rewriteParent(input));
			}
			return buildLocalRef(rewriteParent(input ?? { id: "" }));
		},

		registerIfAvailable(input, expected) {
			if (input?.id === flowId) {
				if (expected === null) {
					if (localRef !== null) return undefined;
					localRef = buildLocalRef(input);
					return localRef;
				}
				if (localRef !== expected) return undefined;
				localRef = buildLocalRef(input);
				return localRef;
			}
			if (typeof baseRegistry?.registerIfAvailable === "function") {
				return baseRegistry.registerIfAvailable(rewriteParent(input), expected);
			}
			return undefined;
		},

		reopen(id, expected) {
			if (id === flowId) {
				if (!localRef || localRef !== expected) return undefined;
				localRef = buildLocalRef({ ...localRef, status: "parked", session: null });
				return localRef;
			}
			return typeof baseRegistry?.reopen === "function" ? baseRegistry.reopen(id, expected) : undefined;
		},

		setHistory(id, history, expectedSessionFile) {
			if (id === flowId) {
				if (!localRef) return false;
				if (expectedSessionFile !== undefined && localRef.sessionFile !== expectedSessionFile) return false;
				localRef.history = history;
				return true;
			}
			return typeof baseRegistry?.setHistory === "function"
				? baseRegistry.setHistory(id, history, expectedSessionFile)
				: false;
		},

		setStatus(id, status, expected) {
			if (id === flowId) {
				if (!localRef || !matchesExpected(localRef, expected)) return false;
				localRef.status = status;
				localRef.lastActivity = Date.now();
				return true;
			}
			return typeof baseRegistry?.setStatus === "function"
				? baseRegistry.setStatus(id, status, expected)
				: false;
		},

		markResultAccepted(id, expected, responseAt) {
			if (id === flowId) {
				if (!localRef || !matchesExpected(localRef, expected)) return false;
				localRef.lifecycle = {
					...localRef.lifecycle,
					...(responseAt !== undefined ? { responseAt } : {}),
					acceptedAt: Date.now(),
				};
				return true;
			}
			return typeof baseRegistry?.markResultAccepted === "function"
				? baseRegistry.markResultAccepted(id, expected, responseAt)
				: false;
		},

		staleAcceptedRuns() {
			return typeof baseRegistry?.staleAcceptedRuns === "function" ? baseRegistry.staleAcceptedRuns() : [];
		},

		setActivity(id, activity) {
			if (id === flowId) {
				if (!localRef) return;
				localRef.activity = activity;
				localRef.lastActivity = Date.now();
				return;
			}
			baseRegistry?.setActivity?.(id, activity);
		},

		attachSession(id, session, sessionFile, expected) {
			if (id === flowId) {
				if (!localRef || !matchesExpected(localRef, expected)) return false;
				localRef.session = session;
				if (sessionFile !== undefined) localRef.sessionFile = sessionFile;
				localRef.lastActivity = Date.now();
				return true;
			}
			return typeof baseRegistry?.attachSession === "function"
				? baseRegistry.attachSession(id, session, sessionFile, expected)
				: false;
		},

		detachSession(id, expected) {
			if (id === flowId) {
				if (!localRef || !matchesExpected(localRef, expected)) return false;
				localRef.session = null;
				localRef.lastActivity = Date.now();
				return true;
			}
			return typeof baseRegistry?.detachSession === "function"
				? baseRegistry.detachSession(id, expected)
				: false;
		},

		unregister(id, expected) {
			if (id === flowId) {
				if (!localRef || !matchesExpected(localRef, expected)) return false;
				localRef = null;
				return true;
			}
			return typeof baseRegistry?.unregister === "function"
				? baseRegistry.unregister(id, expected)
				: false;
		},

		get(id) {
			if (id === flowId) return localRef ?? undefined;
			return typeof baseRegistry?.get === "function" ? baseRegistry.get(id) : undefined;
		},

		list() {
			return typeof baseRegistry?.list === "function" ? baseRegistry.list() : [];
		},

		listVisibleTo(id) {
			const effectiveId = id === flowId && isNonEmptyString(ownerAgentId) ? ownerAgentId : id;
			return typeof baseRegistry?.listVisibleTo === "function"
				? baseRegistry.listVisibleTo(effectiveId)
				: [];
		},

		isRunning(ref) {
			if (ref && ref === localRef) return localRef.status === "running";
			return typeof baseRegistry?.isRunning === "function" ? baseRegistry.isRunning(ref) : false;
		},

		syncSessionStatus(id, session) {
			if (id === flowId) return () => {};
			return typeof baseRegistry?.syncSessionStatus === "function"
				? baseRegistry.syncSessionStatus(id, session)
				: () => {};
		},

		onChange(listener) {
			return typeof baseRegistry?.onChange === "function" ? baseRegistry.onChange(listener) : () => {};
		},
	};
}
