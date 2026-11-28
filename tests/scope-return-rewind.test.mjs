// End-to-end scope_return tail-call rewind contracts:
// - Child small handoff rewinds BranchManager to originEntryId (O(1) depth),
//   keeps forkId/path/ownerId/budget/panhandles, drops old-generation noise,
//   merges birth receipt + report into one user message, and delivers cleanly
//   on final oath.
// - Multi-generation child rewind replaces the previous report instead of
//   compounding generations.
// - Root small handoff (`unfinished`) rewinds through compaction; the seal
//   value completes in place (promote without stopLoop), plus mixed-batch
//   refusal, unreceived-children refusal, and real-user-prompt reset.

import { describe, expect, test } from "bun:test";

import { createBranchSession } from "../host-omp/src/host/branch-session.mjs";
import { stopAfterScopeReturn } from "../host-omp/src/host/branch-context.mjs";
import { createForkWiring } from "../src/wiring/fork-wiring.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { attachForkPorts } from "./helpers/fork-attach.mjs";
import { createTestStation } from "./helpers/station-ports.mjs";
import { createBracketLedger, registerFork, RUNNING, READY } from "../src/scope/ledger-brackets.mjs";
import { forkOf } from "../src/scope/ledger-charge.mjs";
import {
	identityForAgent,
	outcomeOf,
} from "../src/scope/fork-registry.mjs";
import { waitForReady } from "../src/tools/join-wait.mjs";
import { notePanhandled } from "../src/scope/panhandle.mjs";
import { handleForkCall, handleJoinCall, handleReturnCall } from "../src/station/fork-controls.mjs";
import { executeReturn } from "../src/station/execute.mjs";
import {
	RETURN_OATH_KEY,
	RETURN_OATH_UNFINISHED,
	RETURN_OATH_VALUE,
} from "../src/station/domain/handoff.mjs";

const OATH = { [RETURN_OATH_KEY]: RETURN_OATH_VALUE };
const UNFINISHED = { [RETURN_OATH_KEY]: RETURN_OATH_UNFINISHED };
const AGENT_REGISTRY = { kind: "agentRegistry" };

function sharedManager() {
	const entries = new Map();
	let leaf = null;
	let seq = 0;
	function appendMessage(message) {
		const id = `entry-${++seq}`;
		entries.set(id, { type: "message", id, parentId: leaf, message });
		leaf = id;
		return id;
	}
	return {
		entries,
		getSessionId: () => "rewind-session-1",
		getCwd: () => "/workspace",
		getHeader: () => ({ taskPromptCacheKey: "task-cache" }),
		getArtifactsDir: () => "/artifacts",
		getLeafId: () => leaf,
		getEntry: (id) => entries.get(id),
		getLeafEntry: () => (leaf ? entries.get(leaf) : undefined),
		getBranch(from = leaf) {
			const path = [];
			for (let id = from; id != null; id = entries.get(id)?.parentId) {
				const entry = entries.get(id);
				if (!entry) break;
				path.unshift(entry);
			}
			return path;
		},
		branch(id) {
			if (!entries.has(id)) throw new Error(`missing entry ${id}`);
			leaf = id;
		},
		resetLeaf() {
			leaf = null;
		},
		seal() {},
		close() {},
		appendMessage,
		appendMessageToBranch(message, parentId, options = {}) {
			const id = `entry-${++seq}`;
			entries.set(id, { type: "message", id, parentId, message });
			if (options.preserveActiveLeaf === false) leaf = id;
			return id;
		},
		appendCustomEntry(customType, data) {
			const id = `custom-${++seq}`;
			entries.set(id, { type: "custom", customType, data, id, parentId: leaf });
			leaf = id;
			return id;
		},
		appendCompaction(summary, shortSummary, firstKeptEntryId, tokensBefore, options = {}) {
			const id = `compact-${++seq}`;
			entries.set(id, {
				type: "compaction",
				id,
				parentId: leaf,
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				method: options.method,
				details: options,
			});
			leaf = id;
			return id;
		},
		buildSessionContext() {
			const path = this.getBranch();
			const lastCompact = path.findLastIndex((entry) => entry.type === "compaction");
			if (lastCompact >= 0) {
				const compaction = path[lastCompact];
				const keepId = compaction.firstKeptEntryId ?? "";
				const retainedStart = keepId
					? path.findIndex((entry, index) => index < lastCompact && entry.id === keepId)
					: -1;
				const out = [{ role: "compactionSummary", summary: compaction.summary }];
				if (retainedStart >= 0) {
					for (let i = retainedStart; i < lastCompact; i += 1) {
						if (path[i].type === "message") out.push(path[i].message);
					}
				}
				for (let i = lastCompact + 1; i < path.length; i += 1) {
					if (path[i].type === "message") out.push(path[i].message);
				}
				return { messages: out };
			}
			return {
				messages: path.filter((entry) => entry.type === "message").map((entry) => entry.message),
			};
		},
	};
}

function ownerSession() {
	return {
		asyncJobManager: { kind: "asyncJobManager" },
		costGate: { kind: "costGate" },
		model: { id: "model-1" },
		modelRegistry: { authStorage: { kind: "authStorage" } },
		sessionId: "rewind-session-1",
		settings: { kind: "settings" },
		systemPrompt: ["owner prompt"],
		preparedExtensions: [{ name: "prepared-extension" }],
		extensionPaths: ["/extensions/base.mjs"],
		agent: { promptCacheKey: "agent-cache", thinkingLevel: "high" },
		getEnabledToolNames: () => ["read", "scope_fork", "scope_join", "scope_return"],
		getActiveToolNames: () => ["read", "scope_fork", "scope_join", "scope_return"],
		getMountedToolCommandNames: () => ["read"],
	};
}

describe("child scope_return rewind (O(1) stack depth + identity preservation)", () => {
	test("small handoff rewinds BranchManager to originEntryId, preserves identity/panhandles/inbox/originAmends, and final oath delivers clean generation", async () => {
		const wiring = createForkWiring();
		const shared = sharedManager();
		shared.appendMessage({ role: "user", content: "root prompt" });
		shared.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "fork-rewind", name: "scope_fork", arguments: {} }],
		});

		const parent = createTestStation(SessionStation, shared, {}, {}, null, null);
		const attached = attachForkPorts(parent, wiring, {
			conversationKey: "session:rewind-session-1",
			ownerSession: ownerSession(),
			prepareChild: (session) => {
				const identity = identityForAgent(wiring.registry, session.agent.id);
				const childStation = createTestStation(SessionStation, session.sessionManager, {}, {}, null, null);
				// In production, `persistRoot` writes to the root branch and
				// `finishRewind({ rebaseAnchor: true })` calls `anchor.rebase()`,
				// which persists to the child's own branch manager! In this test,
				// childStation.manager is the child BranchManager proxy so its
				// appendCustomEntry uses the child proxy's branch without moving
				// shared.leaf — except `createTestStation` initializes `anchor` on
				// `session.sessionManager`. Verify `childStation.manager` is the proxy
				// and spy/check shared leaf right after child prompts.
				childStation.host.session.setMessages = (_ctx, messages) => {
					session.agent.state.messages = messages.slice();
					return true;
				};
				attachForkPorts(childStation, wiring, {
					conversationKey: "session:rewind-session-1",
					identity,
				});
				session._childStation = childStation;
				return { ok: true, station: childStation, ctx: { session } };
			},
			createSession: (spec) =>
				createBranchSession({
					session: spec.ownerSession,
					sessionManager: spec.manager ?? spec.sessionManager,
					flowId: spec.agentId,
					sourceToolCallId: spec.sourceToolCallId,
					agentDisplayName: "Worker",
					agentRegistry: AGENT_REGISTRY,
					async createAgentSession(config) {
						const messages = config.sessionManager.buildSessionContext().messages;
						const prompts = [];
						const depthsBeforePrompt = [];
						let generation = 0;
						const session = {
							sessionManager: config.sessionManager,
							prompts,
							depthsBeforePrompt,
							agent: {
								id: config.agentId,
								state: { messages, stopReason: "stop" },
								abort() {},
							},
							async prompt(text) {
								generation += 1;
								prompts.push(text);
								depthsBeforePrompt.push(config.sessionManager.buildSessionContext().messages.length);
								const userMsg = { role: "user", content: text, timestamp: generation * 10 };
								config.sessionManager.appendMessage(userMsg);
								session.agent.state.messages.push(userMsg);

								const childStation = session._childStation;
								const record = forkOf(attached.ledger, spec.forkId);

								if (generation === 1) {
									// Gen 1: noisy exploration, a panhandle, then a small scope_return.
									notePanhandled(record, "read", { callId: "over-1" });
									const noise1 = {
										role: "assistant",
										content: [
											{ type: "text", text: "gen1 noisy exploration" },
											{ type: "toolCall", id: "r-gen1", name: "read", arguments: { path: "noisy.mjs" } },
										],
										timestamp: 11,
									};
									config.sessionManager.appendMessage(noise1);
									session.agent.state.messages.push(noise1);
									const noiseRes = {
										role: "toolResult",
										toolCallId: "r-gen1",
										toolName: "read",
										content: [{ type: "text", text: "huge noise" }],
										timestamp: 12,
									};
									config.sessionManager.appendMessage(noiseRes);
									session.agent.state.messages.push(noiseRes);

									const retCall = {
										role: "assistant",
										content: [{ type: "toolCall", id: "ret-1", name: "scope_return", arguments: { dafny: "gen1 distilled summary", ...UNFINISHED } }],
										timestamp: 13,
									};
									config.sessionManager.appendMessage(retCall);
									session.agent.state.messages.push(retCall);

									const res = executeReturn(childStation, "ret-1", { dafny: "gen1 distilled summary", ...UNFINISHED }, {});
									expect(res.isError).toBeUndefined();
									expect(res.details.result.rewind).toBe(true);
									expect(res.details.stopLoop).toBe(true);
									expect(record.status).toBe(RUNNING);
									expect(record.handoffCount).toBe(1);
									return;
								}

								if (generation === 2) {
									// Gen 2: the prompt carries the birth receipt and the previous
									// generation's report, and nothing else from gen 1.
									expect(text.startsWith("You are now in the scope /inspector.worker,")).toBe(true);
									expect(text).toContain("gen1 distilled summary");
									expect(text).toContain('read(path="noisy.mjs")');

									// Second small handoff: gen 2 report replaces gen 1 report.
									const work2 = {
										role: "assistant",
										content: [{ type: "text", text: "gen2 refined attempt" }],
										timestamp: 21,
									};
									config.sessionManager.appendMessage(work2);
									session.agent.state.messages.push(work2);
									const res2 = executeReturn(childStation, "ret-2", { dafny: "gen2 distilled summary", ...UNFINISHED }, {});
									expect(res2.details.result.rewind).toBe(true);
									expect(record.handoffCount).toBe(2);
									return;
								}

								// Gen 3: verify gen2 report replaced gen1 report (no exponential growth), then big oath return.
								expect(text).toContain("gen2 distilled summary");
								expect(text).not.toContain("gen1 noisy exploration");
								expect(text).not.toContain("gen1 distilled summary");

								const finalMsg = {
									role: "assistant",
									content: [{ type: "text", text: "gen3 clean verification" }],
									timestamp: 31,
								};
								config.sessionManager.appendMessage(finalMsg);
								session.agent.state.messages.push(finalMsg);
								const finalRes = executeReturn(
									childStation,
									"ret-3",
									{ dafny: "all verified cleanly", ...OATH },
									{},
								);
								expect(finalRes.isError).toBeUndefined();
								expect(finalRes.details.result.sealed).toBe(true);
								expect(finalRes.details.stopLoop).toBe(true);
							},
						};
						return { session };
					},
				}),
		});

		const forkOut = handleForkCall(parent, {
			id: "fork-rewind",
			arguments: {
				forks: [
					{
						path: "/inspector.worker",
						fsm: "solve cleanly",
						profession: "You are a careful engineer.",
						n: 2,
						budget: { read: 1 },
						targets: ["src/a.mjs"],
					},
				],
			},
		});
		expect(forkOut.isError).toBeUndefined();

		const taken = await waitForReady(wiring.registry, attached.ledger, {
			ownerId: "root",
			levelKey: forkOf(attached.ledger, "fork-rewind").levelKey,
		});
		expect(taken.ok).toBe(true);
		const record = forkOf(attached.ledger, "fork-rewind");
		expect(record.handoffCount).toBe(2);
		// Anti-Goodhart: panhandle count survived all rewinds!
		expect(record.panhandleTotal).toBe(1);
		// Child rewinds stay isolated on child branch; note that parent.persist()
		// in this test shares `shared` directly because parent is Root, whereas
		// child BranchManager appends without changing shared's leaf! Verify leaf
		// moved only via Root's own persistLedger (custom-* entries) and never
		// pointed onto any child message entry.
		expect(shared.getEntry(shared.getLeafId())?.type).toBe("custom");
		expect(shared.getEntry(shared.getLeafId())?.parentId).toBeTruthy();
		expect(shared.getBranch().some((entry) => entry.type === "message" && entry.message?.role === "user" && String(entry.message?.content).includes("You are now in the scope /inspector.worker"))).toBe(false);

		// Final published outcome contains ONLY the final clean generation + dafny, not gen1 noise!
		const outcome = outcomeOf(wiring.registry, "fork-rewind");
		expect(outcome.failed).toBe(false);
		expect(outcome.record).toContain("gen3 clean verification");
		expect(outcome.record).toContain("all verified cleanly");
		expect(outcome.record).not.toContain("gen1 noisy exploration");
		expect(outcome.record).not.toContain("gen2 refined attempt");
	});
});

describe("mixed tool-call batch refusal and stopAfterScopeReturn", () => {
	test("refuses scope_return when paired with sibling tool calls in the same assistant message", () => {
		const ledger = createBracketLedger();
		registerFork(ledger, { forkId: "f1", ownerId: "root", levelKey: "L0", fsm: "x", depth: 0 });
		const carrying = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.mjs" } },
				{ type: "toolCall", id: "r1", name: "scope_return", arguments: { dafny: "done", ...OATH } },
			],
		};
		const station = {
			state: { relay: { generation: 0, canStop: false, userPrompts: [], pendingRewind: null } },
			forkLedgerPort: () => ledger,
			forkIdentityPort: () => ({ forkId: "f1", parentOwnerId: "root" }),
			contextMessages: () => [carrying],
		};
		const out = handleReturnCall(
			station,
			{ id: "r1", name: "scope_return", arguments: { dafny: "done", ...OATH } },
			{ currentMessage: carrying },
		);
		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("MIXED_RETURN_TOOL_CALLS");
		expect(forkOf(ledger, "f1").status).toBe(RUNNING);
	});

	test("stopAfterScopeReturn aborts only when details.stopLoop === true", () => {
		const aborts = [];
		const agent = {
			afterToolCall: undefined,
			abort: (reason) => aborts.push(reason),
		};
		const detach = stopAfterScopeReturn(agent);
		try {
			// Root promotion: accepted true, stopLoop false -> must NOT abort.
			agent.afterToolCall({
				toolCall: { name: "scope_return" },
				isError: false,
				result: { details: { accepted: true, promoted: true, stopLoop: false } },
			});
			expect(aborts).toHaveLength(0);

			// Rewind / deliver: stopLoop true -> aborts with TERMINAL_RESULT.
			agent.afterToolCall({
				toolCall: { name: "scope_return" },
				isError: false,
				result: { details: { accepted: true, rewind: true, stopLoop: true } },
			});
			expect(aborts).toEqual([Symbol.for("pi-agent-core.terminal-tool-result")]);
		} finally {
			detach();
		}
	});
});

  describe("Root scope_return lifecycle (completion gate + unreceived gate + fork reset)", () => {
	test("unfinished rewinds, unreceived children block the seal, a seal completes, new fork resets completion", () => {
		const shared = sharedManager();
		shared.appendMessage({ role: "user", content: "initial request" });
		const root = createTestStation(SessionStation, shared, {}, {}, null, null);
		const ledger = root.brackets;
		root.forkLedgerPort = () => ledger;
		root.forkIdentityPort = () => null;
		root.forkOwnerId = () => null;
		root.childSpawnPort = () => () => {};
		root.state.relay.goal = true;

		// Fork one child -> Root big oath must be refused while unreceived.
		const forked = handleForkCall(root, {
			id: "f-root-1",
			arguments: {
				forks: [
					{
						path: "/inspector.sub",
						fsm: "do sub",
						profession: "You are a worker.",
						n: 1,
						budget: { read: 1 },
						targets: ["src/x.mjs"],
					},
				],
			},
		});
		expect(forked.isError).toBeUndefined();

		const blockedBig = handleReturnCall(root, {
			id: "r-big-blocked",
			arguments: { dafny: "try oath with open child", ...OATH },
		});
		expect(blockedBig.isError).toBe(true);
		expect(blockedBig.details.code).toBe("UNRECEIVED_CHILDREN");

		// Small handoff is allowed even with unreceived children!
		const small = handleReturnCall(root, {
			id: "r-small-1",
			arguments: { dafny: "compacting root while child runs", ...UNFINISHED },
		});
		expect(small.isError).toBeUndefined();
		expect(small.details.rewind).toBe(true);
		expect(small.details.stopLoop).toBe(true);
		expect(root.state.relay.generation).toBe(1);
		expect(root.commitRootRewind({})).toBe(true);

		// The restored user entry precedes the compaction record, and the
		// compaction retains it via firstKeptEntryId.
		const branch = shared.getBranch();
		const compactAt = branch.findLastIndex((entry) => entry.type === "compaction");
		const compaction = branch[compactAt];
		const restored = branch[compactAt - 1];
		expect(restored?.message?.content?.[0]?.text).toBe("initial request");
		expect(restored?.message?.attribution).toBe("user");
		expect(compaction.firstKeptEntryId).toBe(restored?.id);
		const projected = shared.buildSessionContext().messages;
		expect(projected[0].role).toBe("compactionSummary");
		expect(projected[1]?.content?.[0]?.text).toBe("initial request");

		// Child returns with oath and Root joins it.
		const child = createTestStation(SessionStation, shared, {}, {}, null, null);
		child.forkLedgerPort = () => ledger;
		child.forkIdentityPort = () => ({ forkId: "f-root-1", parentOwnerId: "root" });
		child.forkOwnerId = () => "f-root-1";
		const childRet = handleReturnCall(child, {
			id: "cr-1",
			arguments: { dafny: "sub done", ...OATH },
		});
		expect(childRet.details.result.sealed).toBe(true);
		expect(forkOf(ledger, "f-root-1").status).toBe(READY);
		const joined = handleJoinCall(root, { id: "j-1", arguments: {} });
		expect(joined.details.result).toBeDefined();

		// Root seal -> promote immediately without a rewind (stopLoop = false, canStop = true).
		const sealed = handleReturnCall(root, {
			id: "r-big-1",
			arguments: { dafny: "verified nothing left", ...OATH },
		});
		expect(sealed.isError).toBeUndefined();
		expect(sealed.details.result.promoted).toBe(true);
		expect(sealed.details.stopLoop).toBeUndefined();
		expect(root.state.relay.canStop).toBe(true);

		// Opening a new fork resets completion (canStop = false).
		handleForkCall(root, {
			id: "f-root-2",
			arguments: {
				forks: [
					{
						path: "/inspector.extra",
						fsm: "more work",
						profession: "You are a worker.",
						n: 1,
						budget: { read: 1 },
						targets: ["src/y.mjs"],
					},
				],
			},
		});
		expect(root.state.relay.canStop).toBe(false);
	});
});
