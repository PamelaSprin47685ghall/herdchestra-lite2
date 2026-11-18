/**
 * Herdchestra Lite 2.0 station: SessionStation holds all scope/relay state and
 * exposes pure synchronous gatekeeper methods. Tickets (async) live in
 * tickets.mjs and handoff.mjs; wiring (wiring.mjs) binds host events to these
 * gatekeepers and injects ticket capabilities.
 *
 * Station rules (AGENTS.md Ticket Station Method):
 * - Every method is a plain synchronous function. No async/await.
 * - Stations only read/write their own state and manipulate ticket Promises.
 * - Gatekeepers complete all state transitions, then tail-call a ticket at the
 *   function end. They never await the ticket.
 * - Ticket capabilities arrive through the constructor bundle; a station
 *   without a capability cannot create that ticket.
 *
 * Host contract (omp 18.20.x):
 * - `pi.on("assistant_message", ...)` runs before persistence, agent context,
 *   and tool dispatch. Scope transitions are processed there.
 * - `pi.on("tool_call", ...)` can block a call with `{ block, reason }`.
 * - `pi.on("context", ...)` returns the outbound message list only.
 * - `ctx.sessionManager` exposes getBranch/appendMessage/branch/
 *   buildSessionContext/appendCustomEntry.
 * - `pi.sendUserMessage(text, { deliverAs: "steer" })` queues a user prompt.
 */

import {
	applyRegret,
	beginScope,
	budgetText,
	chargeTool,
	closeScope,
	createState,
	currentScope,
	deferIntent,
	deserializeState,
	findElderSibling,
	scopeOrder,
	serializeState,
	truncateForHostBoundary,
} from "./engine.mjs";
import {
	appendUserTail,
	applyCollapses,
	beatKey,
	collectPinnedMessages,
	filterRegrets,
	findBegin,
	findRegretTarget,
	findToolCallIndex,
	finishedReport,
	isCollapsed,
	rewriteVibeMessage,
	toolCalls,
} from "./transcript.mjs";
import { injectSystemPrompt, languageSkill, outsideScopeInstruction } from "./prompts.mjs";
import {
	agentPolicy,
	READ_ONLY_SUBAGENT,
	READ_WRITE_SUBAGENT,
} from "./agent-policy.mjs";
import { setAgentMessages, sessionFor } from "./runner-capture.mjs";
import { continueFeedback, errorResult, isHandoffCompaction, textResult } from "./results.mjs";
import {
	applyLedgerEvaluation,
	beginGenerationAfterHandoff,
	firstEvaluationNudge,
	handoffFocus,
	invalidatePromotion,
	isTodoView,
	openLedgerNudge,
	recordHandoffFailure,
	relayStatusText,
} from "./relay.mjs";

const CONTROL_TOOLS = new Set(["scope", "regret", "defer", "pin"]);
const SESSION_STATE_TYPE = "scope.state";

// ---------------------------------------------------------------------------
// Module-level pure helpers (no station state)
// ---------------------------------------------------------------------------

function restoreState(manager) {
	try {
		const branch = manager?.getBranch?.() ?? [];
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry?.type === "custom" && entry.customType === SESSION_STATE_TYPE) {
				const restored = deserializeState(entry.data);
				// A crash can leave an active scope whose begin message never
				// reached the transcript. Drop such scopes instead of charging
				// every later tool call to a scope that can never be closed.
				if (restored.scopes.length > 0 || restored.collapses.length > 0) {
					try {
						const context = manager.buildSessionContext?.();
						const messages = Array.isArray(context?.messages) ? context.messages : [];
						const visible = new Set();
						for (const message of messages) {
							if (message?.role !== "assistant") continue;
							for (const call of toolCalls(message)) visible.add(call.id);
						}
						// A scope whose begin left the branch can never be closed
						// or folded. Drop it instead of charging later calls to it.
						restored.scopes = restored.scopes.filter((scope) =>
							visible.has(scope.beginToolCallId),
						);
						// A collapse record whose begin left the branch has already
						// lost its interior. Treat it as folded so the elder lookup
						// never asks for a message that cannot be shown.
						for (const record of restored.collapses) {
							if (record?.collapsed === false && !visible.has(record.beginToolCallId)) {
								record.collapsed = true;
							}
						}
					} catch {
						// Keep the restored state when the host cannot expose context.
					}
				}
				return restored;
			}
		}
	} catch {
		// Corrupt or absent history: start empty rather than guess.
	}
	return createState();
}

function parseArgs(call) {
	const raw = call?.arguments;
	if (raw && typeof raw === "object") return raw;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}

function controlsIn(message) {
	return toolCalls(message).filter((call) => CONTROL_TOOLS.has(call.name));
}

function processedKey(calls) {
	return calls
		.map((call) => call.id)
		.sort()
		.join(",");
}

function cloneMessage(message) {
	if (!message || typeof message !== "object") return message;
	return {
		...message,
		...(Array.isArray(message.content)
			? {
					content: message.content.map((block) =>
						block && typeof block === "object" ? { ...block } : block,
					),
				}
			: {}),
	};
}

function finishedResultMessage(toolCallId, report) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "scope",
		content: [{ type: "text", text: finishedReport(report) }],
		isError: false,
		timestamp: Date.now(),
	};
}

function beginText(scope) {
	return [
		"You are now inside this scope.",
		`Intent: ${scope.intent}`,
		`Budget (innermost scope only): ${budgetText(scope) || "none"}.`,
		"Only the innermost scope's budget is used. A tool not listed in the budget has zero budget calls. scope, regret, defer, and pin are free.",
		"todo is free but forbidden inside any active scope. Close every scope before updating the ledger; a natural stop requires a successful todo evaluation outside all scopes.",
		"Calls in one assistant message spend at most one unit in total, split across the tools used in proportion to their call counts and rounded to two decimals. A tool whose balance runs out is blocked while the rest of the message still runs. Budget and spend by assistant turns.",
		"Do not write the final user-facing answer while inside a scope. Close every scope first; only after every scope closes may you answer the user.",
		"When this scope closes, its elder sibling at the same level is collapsed; this scope stays visible until a younger sibling closes.",
		'Call scope({ end: { return_markdown: "<report for your future self>" } }) when this task is complete. return_markdown is a self-delivery report; write the user-facing answer as ordinary assistant text.',
	].join("\n");
}

function endText(
	report,
	foldedReport,
	deferredCount,
	steerText,
	steerSent,
	transitioning = false,
	remainingScope = null,
) {
	const lines = [];
	if (transitioning) {
		lines.push("Scope closed.");
	} else if (remainingScope) {
		lines.push(
			`Scope closed. You are back inside the enclosing scope: ${remainingScope.intent} (remaining budget: ${budgetText(remainingScope) || "none"}).`,
		);
	} else {
		lines.push("Scope closed. You are outside all scopes.");
	}
	if (foldedReport !== null) {
		lines.push(
			`Your elder sibling scope at this level was collapsed; its begin receipt now reads: ${foldedReport}`,
		);
	} else {
		lines.push("No elder sibling scope was collapsed.");
	}
	lines.push(
		`This scope keeps its internal turns until a younger sibling scope closes; its begin receipt will then read: ${report}`,
	);
	if (deferredCount > 0) {
		lines.push(
			steerSent
				? `${deferredCount} deferred finding(s) were delivered as a steering user message:`
				: `${deferredCount} deferred finding(s) follow:`,
		);
		lines.push(steerText);
	} else {
		lines.push("No deferred findings were recorded in this scope.");
	}
	if (remainingScope) {
		lines.push(
			"todo cannot be called inside any scope. Before finishing, close every enclosing scope, then call todo to update the ledger. A non-empty ledger forbids stopping; an empty ledger must trigger the real /handoff protocol.",
		);
	} else {
		lines.push(
			"Call todo now to evaluate the ledger before writing the final user-facing answer. A non-empty ledger forbids stopping; an empty ledger must trigger the real /handoff protocol.",
		);
	}
	if (!transitioning) {
		if (remainingScope) {
			lines.push(
				"Do not write the final user-facing answer yet. Continue inside the enclosing scope, or close it when the whole task is complete. Finishing is not a tool call.",
			);
		} else {
			lines.push(
				"You are outside all scopes. Only a promoted empty-ledger successor evaluation allows the final user-facing answer as ordinary assistant text. Do not put it in return_markdown. Finishing is not a tool call.",
			);
		}
	}
	return lines.join("\n");
}

function regretText(applied) {
	const refunded = Number.isInteger(applied.refunded) ? applied.refunded : 0;
	const residual = Array.isArray(applied.residualDefers) ? applied.residualDefers.length : 0;
	const lines = [
		"Undid the previous beat. It will not appear in the next LLM request.",
		refunded > 0 ? `Refunded ${refunded} tool call(s).` : "No tool budget was refunded by that beat.",
		`Remaining: ${budgetText(applied.scope) || "none"}.`,
	];
	if (residual > 0) {
		lines.push(
			`${residual} defer finding(s) from that beat were withdrawn but remain valid; they will still be delivered when this scope ends.`,
		);
	}
	return lines.join("\n");
}

function budgetLine(scope) {
	return scope ? budgetText(scope) || "none" : "none";
}

function scopeTailInstruction(state) {
	const scope = currentScope(state);
	if (!scope) return outsideScopeInstruction;
	return `You are inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Remaining budget (innermost scope only): ${budgetLine(scope)}. Only the innermost scope's budget is used; scope, regret, defer, and pin are free. todo is free but forbidden inside any active scope; close every scope before updating the ledger. Calls in one assistant message share at most one unit, split across the tools used in proportion to their call counts and rounded to two decimals; a tool whose balance runs out is blocked while the rest of the message still runs. Do not write the final user-facing answer while inside a scope. When this task is complete, call scope({ end: { return_markdown: "<report for your future self>" } }). If an enclosing scope remains, you will return inside it; only when every scope is closed may you write the final answer as ordinary assistant text. Finishing is not a tool call.`;
}

/** The exact outbound user tail: additional-system-instructions + language skill. */
export function tailText(state) {
	return [
		`<additional-system-instructions><skill version="1.0">${scopeTailInstruction(state)}</skill></additional-system-instructions>`,
		`<system-reminder>${languageSkill}</system-reminder>`,
	].join("\n\n");
}

function insideScopeNudge(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	return `You are still inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Do not write the final user-facing conclusion yet. Continue the task; when it is complete, close this scope with scope({ end: { return_markdown: "<report for your future self>" } }). todo is forbidden inside every scope, so close this scope and every enclosing scope before updating the ledger. Only outside all scopes may you write the final answer as ordinary assistant text, and only after a promoted empty-ledger successor evaluation. If you are permanently blocked, close the scope with a return_markdown report explaining the block, then answer outside only after the relay evaluation.`;
}

function tailKey(message) {
	if (!message || typeof message !== "object") return "";
	if (message.role === "toolResult") return `toolResult:${message.toolCallId}`;
	if (message.role === "assistant") {
		return `assistant:${message.timestamp ?? 0}:${toolCalls(message).map((call) => call.id).sort().join(",")}`;
	}
	if (message.role === "user") {
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map((block) => (block?.type === "text" ? block.text : "")).join("")
				: "";
		return `user:${text.slice(0, 80)}`;
	}
	return `${message.role}:${message.customType ?? ""}`;
}

function hostBoundaryKey(messages) {
	if (!Array.isArray(messages)) return null;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "custom") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((block) =>
								typeof block?.text === "string" ? block.text : "",
							)
							.join("\n")
					: "";
		if (
			message.customType === "handoff" ||
			message.customType === "herd-relay-handoff" ||
			text.includes("<handoff-context>")
		) {
			return `${message.customType ?? ""}:${message.timestamp ?? ""}:${text.length}`;
		}
	}
	return null;
}

function sameTail(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return false;
	return tailKey(a[a.length - 1]) === tailKey(b[b.length - 1]);
}

function safeSessionFor(ctx) {
	try {
		return sessionFor(ctx);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// SessionStation: pure synchronous state holder + gatekeepers
// ---------------------------------------------------------------------------

export class SessionStation {
	constructor(manager, pi, tickets, registry) {
		this.manager = manager;
		this.pi = pi;
		this.tickets = tickets;
		this.registry = registry;
		this.state = restoreState(manager);
		this.handled = new Map();
		this.processedCalls = new Set();
		this.processedMessages = new Set();
		this.callGroups = new Map();
		this.nudged = new WeakSet();
		this.needsRebase = false;
		this.lastError = null;
		this.hostBoundaryKey = null;
		this.agentPolicy = null;
		this.relayPromptPendingFor = null;
		this.relayPromptSentFor = null;
		this.handoffExecuting = false;
		this.handoffSwitched = false;
		this.handoffSession = null;
		this.handoffFocus = null;
		this.handoffAdvanced = false;
		this.sessionStopRunning = false;
	}

	// -- Persistence ---------------------------------------------------------

	persist() {
		const manager = this.manager;
		if (!manager || typeof manager.appendCustomEntry !== "function") return;
		try {
			manager.appendCustomEntry(SESSION_STATE_TYPE, serializeState(this.state));
		} catch (error) {
			this.lastError = String(error?.message ?? error);
		}
	}

	// -- Policy --------------------------------------------------------------

	policy(ctx) {
		if (this.agentPolicy === null) this.agentPolicy = agentPolicy(ctx);
		return this.agentPolicy;
	}

	// -- Internal helpers ----------------------------------------------------

	setHandled(toolCallId, result) {
		this.handled.set(toolCallId, result);
		if (this.handled.size > 512) {
			const oldest = this.handled.keys().next().value;
			this.handled.delete(oldest);
		}
	}

	deliverSteer(text) {
		if (!text || !this.tickets.canSteer) return false;
		this.tickets.steer(text);
		return true;
	}

	contextMessages() {
		try {
			const context = this.manager?.buildSessionContext?.();
			return Array.isArray(context?.messages) ? context.messages : [];
		} catch {
			return [];
		}
	}

	assistantForToolCall(toolCallId) {
		const messages = this.contextMessages();
		const index = findToolCallIndex(messages, toolCallId);
		if (index < 0) return null;
		return { messages, index, message: messages[index] };
	}

	findBeginEntry(beginToolCallId) {
		try {
			const branch = this.manager?.getBranch?.() ?? [];
			for (const entry of branch) {
				if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
				if (toolCalls(entry.message).some((call) => call.id === beginToolCallId)) return entry;
			}
		} catch {
			// A manager without getBranch cannot fork; the caller reports the error.
		}
		return null;
	}

	rememberCallGroups(message) {
		if (!message || message.role !== "assistant") return;
		const key = beatKey(message);
		for (const call of toolCalls(message)) {
			if (!this.callGroups.has(call.id)) this.callGroups.set(call.id, key);
		}
		if (this.callGroups.size > 1024) {
			for (const id of this.callGroups.keys()) {
				this.callGroups.delete(id);
				if (this.callGroups.size <= 512) break;
			}
		}
	}

	// -- Control tool handlers -------------------------------------------------

	handleRegretCall(call, base, currentIndex) {
		const args = parseArgs(call);
		const reflection = trimText(args.reflection);
		if (!reflection) {
			return errorResult("INVALID_ARGUMENT", "regret.reflection must be a non-empty string.", {
				field: "reflection",
			});
		}
		const scope = currentScope(this.state);
		if (!scope) {
			return errorResult("NOT_IN_SCOPE", "regret is only allowed inside a scope.");
		}
		const target = findRegretTarget(this.state, base, currentIndex, scope);
		if (!target.ok) return errorResult(target.code, target.reason);
		const applied = applyRegret(this.state, {
			scopeId: scope.id,
			beat: target.beat,
			toolCalls: target.toolCalls,
		});
		if (!applied.ok) return errorResult(applied.code, applied.reason);
		applied.scope = currentScope(this.state);
		return textResult(regretText(applied), { refunded: applied.refunded });
	}

	handleDeferCall(call) {
		const args = parseArgs(call);
		const intent = trimText(args.intent);
		if (!intent) {
			return errorResult("INVALID_ARGUMENT", "defer.intent must be a non-empty string.", { field: "intent" });
		}
		const out = deferIntent(this.state, { toolCallId: call.id, intent });
		if (!out.ok) return errorResult(out.code, out.reason);
		return textResult("OK");
	}

	handlePinCall() {
		return textResult("OK");
	}

	handleScopeCall(call, { base, currentMessage, currentPersisted, sameMessageBeginIds }) {
		const args = parseArgs(call);
		const hasBegin = args.begin !== undefined && args.begin !== null;
		const hasEnd = args.end !== undefined && args.end !== null;
		if (!hasBegin && !hasEnd) {
			return errorResult("INVALID_ARGUMENT", "Provide begin, end, or both.");
		}
		// The assistant_message hook processes controls before tool dispatch. A
		// handoff-pending begin must be rejected here, otherwise the scope would
		// open even though the tool result is blocked.
		if (hasBegin && this.state.relay?.handoffPending) {
			return errorResult(
				"RELAY_HANDOFF_PENDING",
				"A relay handoff is pending. Do not open a new scope; wait for the successor.",
			);
		}
		if (hasBegin && !hasEnd) {
			const begin = args.begin;
			const out = beginScope(this.state, {
				toolCallId: call.id,
				intent: begin?.intent,
				budget: begin?.budget,
			});
			if (!out.ok) return errorResult(out.code, out.reason);
			return textResult(beginText(out.scope));
		}

		if (hasBegin) {
			const validation = beginScope(createState(), {
				toolCallId: call.id,
				intent: args.begin?.intent,
				budget: args.begin?.budget,
			});
			if (!validation.ok) return errorResult(validation.code, validation.reason);
		}
		const endArg = args.end;
		const report = trimText(
			typeof endArg === "string" ? endArg : endArg?.return_markdown,
		);
		if (!report) {
			return errorResult(
				"INVALID_ARGUMENT",
				"scope.end.return_markdown must be a non-empty self-delivery report.",
			);
		}
		const scope = currentScope(this.state);
		if (!scope) {
			return errorResult("NOT_IN_SCOPE", "scope end is only allowed inside a scope.");
		}
		if (sameMessageBeginIds?.has(scope.beginToolCallId)) {
			return errorResult(
				"SAME_MESSAGE_BOUNDARY",
				"A scope cannot begin and end in the same assistant message. Begin it in one message, do the work, then end it in a later message.",
			);
		}
		// A close is a state transition, not a history edit. The begin may be gone
		// after compaction, restore, or an earlier fork; close anyway and record a
		// collapse only when its begin is still addressable.
		const selfVisible =
			findBegin(base, scope.beginToolCallId) !== null &&
			this.findBeginEntry(scope.beginToolCallId) !== null;

		// A closing scope collapses its immediately elder sibling at the same
		// level. The closing scope itself stays fully visible until a younger
		// sibling closes. This keeps collapse local to one sibling chain instead of
		// reaching into a parent's interior.
		const parentId =
			this.state.scopes.length > 1
				? this.state.scopes[this.state.scopes.length - 2].id
				: null;
		const order = scopeOrder(scope);
		const elder = findElderSibling(
			this.state,
			parentId,
			order,
			scope.boundary ?? 0,
			scope.epoch ?? 0,
		);
		let foldedReport = null;
		if (elder) {
			const folded = this.foldElder({
				elder,
				base,
				currentMessage,
				currentPersisted,
			});
			if (folded.folded) foldedReport = folded.report;
		}
		const closed = closeScope(this.state, { toolCallId: call.id, report });
		if (!closed.ok) return errorResult(closed.code, closed.reason);
		if (selfVisible) {
			this.state.collapses.push({
				beginToolCallId: scope.beginToolCallId,
				endToolCallId: call.id,
				report,
				parentId,
				order,
				boundary: scope.boundary ?? 0,
				epoch: scope.epoch ?? 0,
				collapsed: false,
				createdAt: Date.now(),
			});
		}
		const deferred = closed.defers ?? [];
		const steerSent = this.deliverSteer(closed.steerText);
		const remainingScope = currentScope(this.state);
		let text = endText(
			report,
			foldedReport,
			deferred.length,
			closed.steerText,
			steerSent,
			hasBegin,
			remainingScope,
		);
		if (hasBegin) {
			const opened = beginScope(this.state, {
				toolCallId: call.id,
				intent: args.begin.intent,
				budget: args.begin.budget,
			});
			text += `\n\n${beginText(opened.scope)}`;
		}
		return textResult(text, {
			scopeId: scope.id,
			deferred: deferred.length,
		});
	}

	// -- Fork and fold ---------------------------------------------------------

	forkCollapse({ collapse, begin, beginEntry, oldMessages, currentMessage, currentPersisted }) {
		const manager = this.manager;
		if (
			!manager ||
			typeof manager.appendMessage !== "function" ||
			typeof manager.branch !== "function" ||
			!begin?.assistant
		) {
			return { ok: false, code: "FORK_UNAVAILABLE", reason: "The host session manager cannot append or branch messages." };
		}
		const endIndex = findToolCallIndex(oldMessages, collapse.endToolCallId);
		if (endIndex < 0 || endIndex <= begin.resultIndex) {
			return {
				ok: false,
				code: "SCOPE_BOUNDARY",
				reason: "The assistant message that ended the previous scope is not present on the current branch.",
			};
		}
		// The live assistant message may reach persistence after this hook. Replaying
		// it here would duplicate it, so stop at the persisted tail.
		const persistedEnd =
			currentPersisted === false &&
			currentMessage &&
			oldMessages[oldMessages.length - 1] === currentMessage
				? oldMessages.length - 1
				: oldMessages.length;
		if (persistedEnd <= endIndex) {
			return {
				ok: false,
				code: "SCOPE_BOUNDARY",
				reason: "The previous scope's end has no persisted tail to replay.",
			};
		}
		try {
			const parentId = beginEntry.parentId ?? null;
			if (parentId) {
				manager.branch(parentId);
			} else if (typeof manager.resetLeaf === "function") {
				manager.resetLeaf();
			} else {
				return { ok: false, code: "FORK_UNAVAILABLE", reason: "The scope begin is the root and resetLeaf is unavailable." };
			}
			manager.appendMessage(cloneMessage(begin.assistant));
			manager.appendMessage(finishedResultMessage(collapse.beginToolCallId, collapse.report));
			const beginIds = new Set(toolCalls(begin.assistant).map((call) => call.id));
			for (let index = 0; index < endIndex; index += 1) {
				const message = oldMessages[index];
				if (
					message?.role === "toolResult" &&
					beginIds.has(message.toolCallId) &&
					message.toolCallId !== collapse.beginToolCallId
				) {
					manager.appendMessage(cloneMessage(message));
				}
			}
			// Replay the whole persisted tail from the previous scope's end onwards:
			// the most recently finished scope and the live turn stay byte-identical,
			// so their token prefix remains cacheable.
			const pinned = collectPinnedMessages(oldMessages, {
				start: begin.resultIndex + 1,
				end: endIndex,
				skipResultIds: beginIds,
			});
			let pinnedFlushed = pinned.length === 0;
			const flushPinned = () => {
				if (pinnedFlushed) return;
				pinnedFlushed = true;
				for (const message of pinned) manager.appendMessage(cloneMessage(message));
			};
			for (let index = endIndex; index < persistedEnd; index += 1) {
				if (index > endIndex && oldMessages[index]?.role !== "toolResult") {
					flushPinned();
				}
				manager.appendMessage(cloneMessage(oldMessages[index]));
			}
			flushPinned();
			this.needsRebase = true;
			return { ok: true };
		} catch (error) {
			return { ok: false, code: "FORK_FAILED", reason: String(error?.message ?? error) };
		}
	}

	/**
	 * Fold an elder sibling into its begin receipt when it is still visible.
	 *
	 * Folding is presentation only. A record whose begin is no longer on the
	 * current branch has already lost its interior, so mark it folded and let the
	 * close proceed instead of failing on a message that cannot be shown.
	 */
	foldElder({ elder, base, currentMessage, currentPersisted }) {
		const begin = findBegin(base, elder.beginToolCallId);
		const beginEntry = begin ? this.findBeginEntry(elder.beginToolCallId) : null;
		if (!begin || !beginEntry) {
			elder.collapsed = true;
			return { folded: false, report: null };
		}
		if (!isCollapsed(base, elder)) {
			const forked = this.forkCollapse({
				collapse: elder,
				begin,
				beginEntry,
				oldMessages: base,
				currentMessage: currentMessage ?? null,
				currentPersisted,
			});
			if (!forked.ok) {
				elder.collapsed = true;
				return { folded: false, report: null };
			}
		}
		elder.collapsed = true;
		return { folded: true, report: elder.report };
	}

	// -- Message processing ----------------------------------------------------

	processAssistantMessage(message, { persisted = false } = {}) {
		const controls = controlsIn(message);
		if (controls.length === 0) return;
		const key = processedKey(controls);
		if (this.processedMessages.has(key)) return;
		this.processedMessages.add(key);

		const existing = this.contextMessages();
		const firstIndex = findToolCallIndex(existing, controls[0].id);
		const currentPersisted = firstIndex >= 0;
		const base = currentPersisted ? existing : [...existing, message];
		const currentIndex = currentPersisted ? firstIndex : base.length - 1;
		const currentMessage = base[currentIndex] ?? message;

		let changed = false;
		for (const call of controls) {
			if (call.name !== "regret") continue;
			if (this.processedCalls.has(call.id)) continue;
			this.setHandled(call.id, this.handleRegretCall(call, base, currentIndex));
			changed = true;
		}

		const beginIds = new Set(
			controls
				.filter((call) => call.name === "scope" && parseArgs(call).begin != null)
				.map((call) => call.id),
		);

		for (const call of controls) {
			if (call.name === "regret") continue;
			if (this.processedCalls.has(call.id)) continue;
			if (call.name === "pin") {
				this.setHandled(call.id, this.handlePinCall());
				continue;
			}
			if (call.name === "defer") {
				this.setHandled(call.id, this.handleDeferCall(call));
				changed = true;
				continue;
			}
			this.setHandled(
				call.id,
				this.handleScopeCall(call, {
					base,
					currentMessage,
					currentPersisted,
					sameMessageBeginIds: beginIds,
				}),
			);
			changed = true;
		}

		for (const call of controls) this.processedCalls.add(call.id);
		if (changed) this.persist();
	}

	processControlsForTool(toolCallId) {
		const found = this.assistantForToolCall(toolCallId);
		if (!found) return;
		this.processAssistantMessage(found.message, { persisted: true });
	}

	// -- Execute cores (called by tickets) -------------------------------------

	executeScope(toolCallId, params) {
		const cached = this.handled.get(toolCallId);
		if (cached) return cached;
		this.processControlsForTool(toolCallId);
		const processed = this.handled.get(toolCallId);
		if (processed) return processed;
		return this.directScope(toolCallId, params);
	}

	executeRegret(toolCallId, params) {
		const cached = this.handled.get(toolCallId);
		if (cached) return cached;
		this.processControlsForTool(toolCallId);
		const processed = this.handled.get(toolCallId);
		if (processed) return processed;
		return this.directRegret(toolCallId, params);
	}

	executeDefer(toolCallId, params) {
		const cached = this.handled.get(toolCallId);
		if (cached) return cached;
		this.processControlsForTool(toolCallId);
		const processed = this.handled.get(toolCallId);
		if (processed) return processed;
		return this.directDefer(toolCallId, params);
	}

	executePin(toolCallId, params) {
		const cached = this.handled.get(toolCallId);
		if (cached) return cached;
		this.processControlsForTool(toolCallId);
		const processed = this.handled.get(toolCallId);
		if (processed) return processed;
		return this.directPin(toolCallId, params);
	}

	directScope(toolCallId, params) {
		const found = this.assistantForToolCall(toolCallId);
		if (found) {
			this.processAssistantMessage(found.message, { persisted: true });
			const cached = this.handled.get(toolCallId);
			if (cached) return cached;
		}
		const base = found?.messages ?? this.contextMessages();
		const currentMessage = found?.message ?? { role: "assistant", content: [], timestamp: Date.now() };
		const controls = currentMessage.role === "assistant" ? controlsIn(currentMessage) : [];
		const beginIds = new Set(
			controls
				.filter((call) => call.name === "scope" && parseArgs(call).begin != null)
				.map((call) => call.id),
		);
		const call = { id: toolCallId, name: "scope", arguments: params };
		const result = this.handleScopeCall(call, {
			base,
			currentMessage,
			currentPersisted: Boolean(found),
			sameMessageBeginIds: beginIds,
		});
		this.persist();
		return result;
	}

	directRegret(toolCallId, params) {
		const found = this.assistantForToolCall(toolCallId);
		if (found) {
			this.processAssistantMessage(found.message, { persisted: true });
			const cached = this.handled.get(toolCallId);
			if (cached) return cached;
		}
		const base = found?.messages ?? this.contextMessages();
		const index = found?.index ?? -1;
		if (index < 0) {
			return errorResult("NOT_IN_SCOPE", "regret is only allowed inside a scope with a visible beat history.");
		}
		const result = this.handleRegretCall(
			{ id: toolCallId, name: "regret", arguments: params },
			base,
			index,
		);
		this.persist();
		return result;
	}

	directDefer(toolCallId, params) {
		const found = this.assistantForToolCall(toolCallId);
		if (found) {
			this.processAssistantMessage(found.message, { persisted: true });
			const cached = this.handled.get(toolCallId);
			if (cached) return cached;
		}
		const result = this.handleDeferCall({ id: toolCallId, name: "defer", arguments: params });
		this.persist();
		return result;
	}

	directPin(toolCallId, params) {
		const found = this.assistantForToolCall(toolCallId);
		if (found) {
			this.processAssistantMessage(found.message, { persisted: true });
			const cached = this.handled.get(toolCallId);
			if (cached) return cached;
		}
		return this.handlePinCall();
	}

	// -- Nudge -----------------------------------------------------------------

	maybeNudge(message, ctx) {
		if (!message || message.role !== "assistant") return;
		if (this.policy(ctx) === READ_ONLY_SUBAGENT) return;
		if (toolCalls(message).length > 0) return;
		if (this.nudged.has(message)) return;
		this.nudged.add(message);
		if (currentScope(this.state)) {
			this.deliverSteer(insideScopeNudge(this.state));
			return;
		}
		const relay = this.state.relay;
		if (!relay) {
			this.deliverSteer(firstEvaluationNudge());
			return;
		}
		if (relay.canStop) return;
		if (relay.handoffPending) {
			// Do not steer here. A steering nudge keeps the turn alive and prevents
			// the host from emitting session_stop, which is the only place where the
			// real handoff runs. The todo result already tells the model to stop.
			return;
		}
		if (!relay.lastLedger) {
			this.deliverSteer(firstEvaluationNudge());
			return;
		}
		// After a handoff, lastLedger still holds the previous holder's empty
		// snapshot. The successor has not evaluated yet, so do not hand off again;
		// require its first todo evaluation first.
		if (relay.generation > 0 && relay.firstEvaluation === null) {
			this.deliverSteer(firstEvaluationNudge());
			return;
		}
		if (relay.lastLedger.empty) {
			this.deliverSteer(relayStatusText(relay, relay.lastLedger, { action: "handoff" }));
			this.markHandoffPending(ctx, { reason: "empty-ledger" });
			return;
		}
		this.deliverSteer(openLedgerNudge(relay, relay.lastLedger));
	}

	// -- Rebase -----------------------------------------------------------------

	maybeRebase(ctx, outbound) {
		if (!this.needsRebase) return;
		const tree = this.contextMessages();
		if (!sameTail(tree, outbound)) return;
		if (setAgentMessages(ctx, tree)) this.needsRebase = false;
	}

	// -- Context transform (sync) -----------------------------------------------

	transformContext(original, ctx) {
		try {
			let messages = filterRegrets(original, this.state.regrets);
			messages = applyCollapses(
				messages,
				this.state.collapses,
				this.state.epoch,
			);
			messages = messages.map(rewriteVibeMessage);
			this.maybeRebase(ctx, messages);
			messages = appendUserTail(messages, tailText(this.state));
			return { messages };
		} catch (error) {
			this.lastError = String(error?.message ?? error);
			try {
				return { messages: appendUserTail(original, tailText(this.state)) };
			} catch {
				return { messages: original };
			}
		}
	}

	// -- Handoff state transitions (sync) ---------------------------------------

	insideScopeText() {
		const scope = currentScope(this.state);
		if (!scope) return "";
		return `You are still inside scope level ${this.state.scopes.length}: ${JSON.stringify(scope.intent)}. Do not write the final user-facing conclusion. Continue the task or close the scope. todo is forbidden inside every scope; close every scope before evaluating the ledger.`;
	}

	armHandoff() {
		const relay = this.state.relay;
		this.handoffFocus = handoffFocus({ ...relay, handoffPending: true });
		this.handoffAdvanced = false;
		this.handoffSwitched = false;
		this.state.relay = { ...relay, handoffPending: true };
		this.persist();
	}

	advanceRelayForHandoff() {
		if (this.handoffAdvanced) return false;
		const relay = this.state.relay;
		if (!relay || !relay.handoffPending || relay.canStop) return false;
		this.state.relay = beginGenerationAfterHandoff(relay, {
			at: Date.now(),
			fromGeneration: relay.generation,
		});
		this.handoffAdvanced = true;
		this.relayPromptPendingFor = this.state.relay.generation;
		this.relayPromptSentFor = null;
		this.persist();
		return true;
	}

	recordLedgerEvaluation(phases, op, options = {}) {
		const applied = applyLedgerEvaluation(this.state.relay, phases, {
			op,
			...options,
		});
		this.state.relay = applied.relay;
		this.persist();
		return applied;
	}

	/** Record a failed handoff. The ticket owns the flow, the station owns state. */
	recordHandoffFailureAt(error, at) {
		this.state.relay = recordHandoffFailure(this.state.relay, error, { at });
		this.persist();
	}

	/** Finish an already-compacted handoff: advance once, clear pending, persist. */
	finishCompactedHandoff() {
		const advanced = this.advanceRelayForHandoff();
		if (this.state.relay?.handoffPending) {
			this.state.relay = {
				...this.state.relay,
				handoffPending: false,
				handoffError: null,
			};
		}
		this.persist();
		return {
			advanced,
			generation: this.state.relay?.generation ?? 0,
		};
	}

	markHandoffPending(ctx, options = {}) {
		const relay = this.state.relay;
		if (!relay) return { ok: false, error: "relay state is missing" };
		if (relay.canStop) {
			return { ok: true, skipped: "promoted", generation: relay.generation };
		}
		this.handoffFocus =
			options.focus ??
			handoffFocus({ ...relay, handoffPending: true });
		this.handoffSession = safeSessionFor(ctx) ?? this.handoffSession;
		this.registry.markPending(this);
		if (relay.handoffPending) {
			// applyLedgerEvaluation sets handoffPending itself. A new empty-ledger
			// decision arrives here with pending already true, so clear the previous
			// generation's completion flag before the stop gatekeeper advances.
			if (!this.handoffExecuting) {
				this.handoffAdvanced = false;
				this.handoffSwitched = false;
			}
			return {
				ok: true,
				pending: true,
				inProgress: true,
				generation: relay.generation,
			};
		}
		this.handoffAdvanced = false;
		this.handoffSwitched = false;
		this.state.relay = { ...relay, handoffPending: true, handoffError: null };
		this.persist();
		return {
			ok: true,
			pending: true,
			generation: this.state.relay.generation,
		};
	}

	// -- Gatekeepers (sync event entries) ---------------------------------------

	onAssistantMessage(message, ctx) {
		if (this.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
		try {
			this.rememberCallGroups(message);
			this.processAssistantMessage(message, { persisted: false });
			this.maybeNudge(message, ctx);
		} catch (error) {
			this.lastError = String(error?.message ?? error);
		}
		return undefined;
	}

	onMessageEnd(event, ctx) {
		if (event?.message?.role !== "assistant") return undefined;
		if (this.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
		const message = event.message;
		try {
			this.rememberCallGroups(message);
			const controls = controlsIn(message);
			if (controls.length > 0) {
				const found = this.assistantForToolCall(controls[0].id);
				this.processAssistantMessage(message, { persisted: Boolean(found) });
			}
			this.maybeNudge(message, ctx);
		} catch (error) {
			this.lastError = String(error?.message ?? error);
		}
	}

	onToolCall(event, ctx) {
		if (this.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
		try {
			// Controls are processed before tool dispatch so scope executes can
			// read their cached result. A handoff-pending begin must be stopped
			// before that processing, or the scope would open despite the block.
			if (event.toolName === "scope" && this.state.relay?.handoffPending) {
				const args = parseArgs({
					arguments: event.input ?? event.arguments ?? {},
				});
				if (args.begin !== undefined && args.begin !== null) {
					return {
						block: true,
						reason:
							"RELAY_HANDOFF_PENDING: a relay handoff is pending. Do not open a new scope; wait for the successor.",
					};
				}
			}
			this.processControlsForTool(event.toolCallId);
			if (event.toolName === "todo") {
				if (currentScope(this.state)) {
					return {
						block: true,
						reason:
							"TODO_OUTSIDE_SCOPE_ONLY: todo is forbidden inside any active scope. Close every scope first; todo only works outside all scopes.",
					};
				}
				if (
					this.state.relay?.handoffPending &&
					!isTodoView(event.input ?? event.arguments ?? {})
				) {
					return {
						block: true,
						reason:
							"RELAY_HANDOFF_PENDING: a relay handoff is pending. A todo view is allowed for diagnosis; do not change the ledger.",
					};
				}
				this.persist();
				return undefined;
			}
			if (CONTROL_TOOLS.has(event.toolName)) {
				if (event.toolName === "scope") {
					const args = parseArgs({
						arguments: event.input ?? event.arguments ?? {},
					});
					if (args.begin !== undefined && args.begin !== null) {
						if (this.state.relay?.handoffPending) {
							return {
								block: true,
								reason:
									"RELAY_HANDOFF_PENDING: a relay handoff is pending. Do not open a new scope; wait for the successor.",
							};
						}
						if (this.state.relay?.canStop) {
							this.state.relay = invalidatePromotion(this.state.relay);
							this.persist();
						}
					}
				}
				return undefined;
			}
			if (!currentScope(this.state)) {
				return {
					block: true,
					reason:
						"Not in a scope. Outside all scopes only todo and the free control tools (scope, regret, defer, pin) may be called. Open a scope with scope({ begin: { intent, budget } }) before using any other tool.",
				};
			}
			const found = this.assistantForToolCall(event.toolCallId);
			if (found) this.rememberCallGroups(found.message);
			const groupKey =
				this.callGroups.get(event.toolCallId) ??
				(found ? beatKey(found.message) : undefined);
			const beatTools = found
				? toolCalls(found.message).map((call) => call.name)
				: [];
			const charged = chargeTool(this.state, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				groupKey,
				beatTools,
			});
			if (!charged.ok) return { block: true, reason: charged.reason };
			this.persist();
			return undefined;
		} catch (error) {
			return {
				block: true,
				reason: `Scope accounting failed closed: ${String(error?.message ?? error)}`,
			};
		}
	}

	onContext(messages, ctx) {
		const original = Array.isArray(messages) ? messages : [];
		if (this.policy(ctx) === READ_ONLY_SUBAGENT) {
			return {
				messages: appendUserTail(
					original,
					`<system-reminder>${languageSkill}</system-reminder>`,
				),
			};
		}
		const boundaryKey = hostBoundaryKey(original);
		if (boundaryKey && boundaryKey !== this.hostBoundaryKey) {
			this.hostBoundaryKey = boundaryKey;
			truncateForHostBoundary(this.state);
			this.persist();
		}
		const relay = this.state.relay;
		const gen0FirstEmpty =
			relay?.generation === 0 &&
			relay?.firstEvaluation === "empty" &&
			relay?.lastLedger?.empty === true;
		if (relay?.handoffPending && relay.lastLedger?.empty && !gen0FirstEmpty) {
			// The context hook is the interrupt point: replacing this request's
			// messages with the post-handoff transcript means the provider sees the
			// successor's first turn. Do not call ctx.abort(): AgentSession.abort()
			// aborts the in-flight handoff, and the host then reports
			// "Handoff cancelled".
			return this.tickets.contextHandoff(this, ctx, original);
		}
		return this.transformContext(original, ctx);
	}

	onSessionStop(ctx) {
		if (this.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
		if (this.sessionStopRunning) {
			return continueFeedback("A session_stop pass is already running; wait.");
		}
		const scope = currentScope(this.state);
		if (scope) return continueFeedback(this.insideScopeText());
		const relay = this.state.relay;
		if (!relay) return continueFeedback(firstEvaluationNudge());
		if (relay.canStop) return undefined;
		if (relay.handoffPending) {
			return this.tickets.sessionStop(this, ctx);
		}
		if (!relay.lastLedger) {
			return continueFeedback(firstEvaluationNudge());
		}
		// The empty ledger after a handoff belongs to the previous generation.
		// The successor must evaluate first; only its result can trigger the
		// next handoff.
		if (relay.generation > 0 && relay.firstEvaluation === null) {
			return continueFeedback(firstEvaluationNudge());
		}
		if (relay.lastLedger.empty) {
			this.armHandoff();
			return this.tickets.sessionStop(this, ctx);
		}
		return continueFeedback(openLedgerNudge(relay, relay.lastLedger));
	}

	onSessionSwitch(event, ctx) {
		if (this.policy(ctx) === READ_ONLY_SUBAGENT) return;
		const reason = event?.reason ?? event?.handoffReason;
		if (reason !== "handoff" && event?.handoff !== true) return;
		truncateForHostBoundary(this.state);
		if (this.handoffExecuting) this.advanceRelayForHandoff();
		this.persist();
	}

	onSessionCompact(ctx) {
		if (this.policy(ctx) === READ_ONLY_SUBAGENT) return;
		truncateForHostBoundary(this.state);
		this.persist();
	}

	onAutoCompactionEnd(event, ctx) {
		if (!isHandoffCompaction(event)) return;
		if (!this.handoffExecuting) return;
		this.advanceRelayForHandoff();
		this.persist();
	}

	onBeforeAgentStart(event, ctx) {
		const policy = this.policy(ctx);
		const prompt = injectSystemPrompt(event?.systemPrompt);
		const promptChanged = prompt !== event?.systemPrompt;
		if (policy === READ_WRITE_SUBAGENT) {
			let active = [];
			let needActivate = false;
			try {
				active = this.pi.getActiveTools?.() ?? [];
				needActivate = !active.includes("todo");
			} catch {
				needActivate = false;
			}
			if (needActivate) {
				return this.tickets.activateTools(active, prompt, promptChanged);
			}
		}
		if (!promptChanged) return undefined;
		return { systemPrompt: prompt };
	}
}

// ---------------------------------------------------------------------------
// Station registry: WeakMap keyed by sessionManager, one station per session
// ---------------------------------------------------------------------------

const nullTickets = {
	steer: () => {},
	canSteer: false,
	contextHandoff: (station, ctx, messages) => station.transformContext(messages, ctx),
	sessionStop: (station, ctx) => undefined,
	activateTools: (activeTools, prompt, changed) =>
		changed ? { systemPrompt: prompt } : undefined,
};

export function createStationRegistry(pi, tickets = nullTickets) {
	const stations = new WeakMap();
	let orphanStation = null;
	let pendingStation = null;

	const registry = {
		stationFor(ctx) {
			const key = ctx?.sessionManager ?? ctx;
			if (!key || (typeof key !== "object" && typeof key !== "function")) {
				if (!orphanStation) {
					orphanStation = new SessionStation(null, pi, tickets, registry);
				}
				return orphanStation;
			}
			let station = stations.get(key);
			if (!station) {
				station = new SessionStation(ctx?.sessionManager ?? null, pi, tickets, registry);
				stations.set(key, station);
			}
			return station;
		},
		stationForStop(ctx) {
			const station = registry.stationFor(ctx);
			if (station.state.relay?.handoffPending) return station;
			if (pendingStation?.state.relay?.handoffPending) return pendingStation;
			return station;
		},
		markPending(station) {
			pendingStation = station;
		},
	};

	return registry;
}

// ---------------------------------------------------------------------------
// Module-level active registry (set by wiring, used by tests and tickets)
// ---------------------------------------------------------------------------

let activeRegistry = null;
let fallbackRegistry = null;

export function setActiveRegistry(registry) {
	activeRegistry = registry;
}

export function stationFor(ctx) {
	if (!activeRegistry) {
		if (!fallbackRegistry) fallbackRegistry = createStationRegistry(null);
		return fallbackRegistry.stationFor(ctx);
	}
	return activeRegistry.stationFor(ctx);
}

/** Alias kept for test compatibility: returns the SessionStation for ctx. */
export function stateFor(ctx) {
	return stationFor(ctx);
}
