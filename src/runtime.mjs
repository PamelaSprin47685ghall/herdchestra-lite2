/**
 * Herdchestra Lite 2.0 runtime: scope state, budget enforcement, regret,
 * defer, and the in-place conversation fork.
 *
 * Host contract (omp 18.20.x):
 * - `pi.on("assistant_message", ...)` runs before persistence, agent context,
 *   and tool dispatch. Scope transitions are processed there.
 * - `pi.on("tool_call", ...)` can block a call with `{ block, reason }`.
 * - `pi.on("context", ...)` returns the outbound message list only. It never
 *   changes persisted history.
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
import { setAgentMessages } from "./runner-capture.mjs";
import {
	installHandoffHooks,
	requestHandoff,
} from "./handoff.mjs";
import {
	firstEvaluationNudge,
	invalidatePromotion,
	openLedgerNudge,
	relayStatusText,
} from "./relay.mjs";

const CONTROL_TOOLS = new Set(["scope", "regret", "defer", "pin"]);
const SESSION_STATE_TYPE = "scope.state";
const records = new WeakMap();
const orphanRecord = makeRecord(null);

function makeRecord(manager) {
	const created = {
		manager,
		state: restoreState(manager),
		handled: new Map(),
		processedCalls: new Set(),
		processedMessages: new Set(),
		callGroups: new Map(),
		nudged: new WeakSet(),
		needsRebase: false,
		lastError: null,
		relayPromptPendingFor: null,
		relayPromptSentFor: null,
		handoffInFlight: false,
		handoffTimer: null,
		handoffPolls: 0,
		handoffSwitched: false,
	};
	created.persist = () => persist(created);
	return created;
}

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

/** The per-session runtime record. */
export function stateFor(ctx) {
	const key = ctx?.sessionManager ?? ctx;
	if (!key || (typeof key !== "object" && typeof key !== "function")) return orphanRecord;
	const existing = records.get(key);
	if (existing) return existing;
	const created = makeRecord(ctx?.sessionManager ?? null);
	records.set(key, created);
	return created;
}

function persist(rec) {
	const manager = rec.manager;
	if (!manager || typeof manager.appendCustomEntry !== "function") return;
	try {
		manager.appendCustomEntry(SESSION_STATE_TYPE, serializeState(rec.state));
	} catch (error) {
		rec.lastError = String(error?.message ?? error);
	}
}

/** Persist a record from another module without exposing the WeakMap. */
export function persistRecord(rec) {
	persist(rec);
}

function setHandled(rec, toolCallId, result) {
	rec.handled.set(toolCallId, result);
	if (rec.handled.size > 512) {
		const oldest = rec.handled.keys().next().value;
		rec.handled.delete(oldest);
	}
}

function textResult(text, details) {
	return details === undefined
		? { content: [{ type: "text", text }] }
		: { content: [{ type: "text", text }], details };
}

function errorResult(code, message, details) {
	return {
		isError: true,
		content: [{ type: "text", text: `${code}: ${message}` }],
		details: { code, ...(details ?? {}) },
	};
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

function rememberCallGroups(rec, message) {
	if (!message || message.role !== "assistant") return;
	const key = beatKey(message);
	for (const call of toolCalls(message)) {
		if (!rec.callGroups.has(call.id)) rec.callGroups.set(call.id, key);
	}
	if (rec.callGroups.size > 1024) {
		for (const id of rec.callGroups.keys()) {
			rec.callGroups.delete(id);
			if (rec.callGroups.size <= 512) break;
		}
	}
}

function contextMessages(rec) {
	try {
		const context = rec.manager?.buildSessionContext?.();
		return Array.isArray(context?.messages) ? context.messages : [];
	} catch {
		return [];
	}
}

function assistantForToolCall(rec, toolCallId) {
	const messages = contextMessages(rec);
	const index = findToolCallIndex(messages, toolCallId);
	if (index < 0) return null;
	return { messages, index, message: messages[index] };
}

function findBeginEntry(manager, beginToolCallId) {
	try {
		const branch = manager?.getBranch?.() ?? [];
		for (const entry of branch) {
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			if (toolCalls(entry.message).some((call) => call.id === beginToolCallId)) return entry;
		}
	} catch {
		// A manager without getBranch cannot fork; the caller reports the error.
	}
	return null;
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
		"Only the innermost scope's budget is used. A tool not listed in the budget has zero calls. scope, regret, defer, and pin are free.",
		"todo is free but forbidden inside any active scope. Close every scope before updating the ledger; a natural stop requires a successful todo evaluation outside all scopes.",
		"Calls to the same tool in one assistant message are one simultaneous batch and consume one unit of that tool's budget. Budget and spend by batches, not individual calls.",
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
	return `You are inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Remaining budget (innermost scope only): ${budgetLine(scope)}. Only the innermost scope's budget is used; scope, regret, defer, and pin are free. todo is free but forbidden inside any active scope; close every scope before updating the ledger. Calls to the same tool in one assistant message are one simultaneous batch and consume one unit of that tool's budget; budget and spend by batches. Do not write the final user-facing answer while inside a scope. When this task is complete, call scope({ end: { return_markdown: "<report for your future self>" } }). If an enclosing scope remains, you are back inside it; close it too before answering the user. Only outside all scopes may you write the final answer as ordinary assistant text, and only after todo evaluates the ledger: a non-empty ledger forbids stopping, while an empty ledger triggers a real /handoff to a successor whose first todo evaluation must also be empty. return_markdown is a self-delivery report, not the user-facing answer. If you stop inside a scope, a nudge will remind you of this rule. Finishing is not a tool call.`;
}

/** The exact outbound user tail: additional-system-instructions + language skill. */
export function tailText(state) {
	return [
		`<additional-system-instructions><skill version="1.0">${scopeTailInstruction(state)}</skill></additional-system-instructions>`,
		`<system-reminder>${languageSkill}</system-reminder>`,
	].join("\n\n");
}

function queueSteer(pi, text) {
	if (!text) return false;
	try {
		const pending = pi?.sendUserMessage?.(text, { deliverAs: "steer" });
		if (pending && typeof pending.catch === "function") {
			pending.catch(() => {});
		}
		return typeof pi?.sendUserMessage === "function";
	} catch {
		return false;
	}
}

function insideScopeNudge(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	return `You are still inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Do not write the final user-facing conclusion yet. Continue the task; when it is complete, close this scope with scope({ end: { return_markdown: "<report for your future self>" } }). todo is forbidden inside every scope, so close this scope and every enclosing scope before updating the ledger. Only outside all scopes may you write the final answer as ordinary assistant text, and only after a promoted empty-ledger successor evaluation. If you are permanently blocked, close the scope with a return_markdown report explaining the block, then answer outside only after the relay evaluation.`;
}

function maybeNudge(rec, pi, message, ctx) {
	if (!message || message.role !== "assistant") return;
	if (toolCalls(message).length > 0) return;
	if (rec.nudged.has(message)) return;
	rec.nudged.add(message);
	if (currentScope(rec.state)) {
		queueSteer(pi, insideScopeNudge(rec.state));
		return;
	}
	const relay = rec.state.relay;
	if (!relay) {
		queueSteer(pi, firstEvaluationNudge());
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
		queueSteer(pi, firstEvaluationNudge());
		return;
	}
	// After a handoff, lastLedger still holds the previous holder's empty
	// snapshot. The successor has not evaluated yet, so do not hand off again;
	// require its first todo evaluation first.
	if (relay.generation > 0 && relay.firstEvaluation === null) {
		queueSteer(pi, firstEvaluationNudge());
		return;
	}
	if (relay.lastLedger.empty) {
		queueSteer(pi, relayStatusText(relay, relay.lastLedger, { action: "handoff" }));
		requestHandoff(ctx, pi, rec, { reason: "empty-ledger" });
		return;
	}
	queueSteer(pi, openLedgerNudge(relay, relay.lastLedger));
}

function forkCollapse(rec, { collapse, begin, beginEntry, oldMessages, currentMessage, currentPersisted }) {
	const manager = rec.manager;
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
		// Replay the whole persisted tail from the previous scope's end onwards:
		// the most recently finished scope and the live turn stay byte-identical,
		// so their token prefix remains cacheable.
		for (let index = endIndex; index < persistedEnd; index += 1) {
			if (index > endIndex && oldMessages[index]?.role !== "toolResult") {
				flushPinned();
			}
			manager.appendMessage(cloneMessage(oldMessages[index]));
		}
		flushPinned();
		rec.needsRebase = true;
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
function foldElder(rec, options) {
	const { elder, base, currentMessage, currentPersisted } = options;
	const begin = findBegin(base, elder.beginToolCallId);
	const beginEntry = begin ? findBeginEntry(rec.manager, elder.beginToolCallId) : null;
	if (!begin || !beginEntry) {
		elder.collapsed = true;
		return { folded: false, report: null };
	}
	if (!isCollapsed(base, elder)) {
		const forked = forkCollapse(rec, {
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

function handleRegretCall(rec, call, base, currentIndex) {
	const args = parseArgs(call);
	const reflection = trimText(args.reflection);
	if (!reflection) {
		return errorResult("INVALID_ARGUMENT", "regret.reflection must be a non-empty string.", {
			field: "reflection",
		});
	}
	const scope = currentScope(rec.state);
	if (!scope) {
		return errorResult("NOT_IN_SCOPE", "regret is only allowed inside a scope.");
	}
	const target = findRegretTarget(rec.state, base, currentIndex, scope);
	if (!target.ok) return errorResult(target.code, target.reason);
	const applied = applyRegret(rec.state, {
		scopeId: scope.id,
		beat: target.beat,
		toolCalls: target.toolCalls,
	});
	if (!applied.ok) return errorResult(applied.code, applied.reason);
	applied.scope = currentScope(rec.state);
	return textResult(regretText(applied), { refunded: applied.refunded });
}

function handleDeferCall(rec, call) {
	const args = parseArgs(call);
	const intent = trimText(args.intent);
	if (!intent) {
		return errorResult("INVALID_ARGUMENT", "defer.intent must be a non-empty string.", { field: "intent" });
	}
	const out = deferIntent(rec.state, { toolCallId: call.id, intent });
	if (!out.ok) return errorResult(out.code, out.reason);
	return textResult("OK");
}

function handlePinCall() {
	return textResult("OK");
}

function handleScopeCall(rec, pi, call, { base, currentMessage, currentPersisted, sameMessageBeginIds }) {
	const args = parseArgs(call);
	const hasBegin = args.begin !== undefined && args.begin !== null;
	const hasEnd = args.end !== undefined && args.end !== null;
	if (!hasBegin && !hasEnd) {
		return errorResult("INVALID_ARGUMENT", "Provide begin, end, or both.");
	}
	// The assistant_message hook processes controls before tool dispatch. A
	// handoff-pending begin must be rejected here, otherwise the scope would
	// open even though the tool result is blocked.
	if (hasBegin && rec.state.relay?.handoffPending) {
		return errorResult(
			"RELAY_HANDOFF_PENDING",
			"A relay handoff is pending. Do not open a new scope; wait for the successor.",
		);
	}
	if (hasBegin && !hasEnd) {
		const begin = args.begin;
		const out = beginScope(rec.state, {
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
	const scope = currentScope(rec.state);
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
		findBeginEntry(rec.manager, scope.beginToolCallId) !== null;

	// A closing scope collapses its immediately elder sibling at the same
	// level. The closing scope itself stays fully visible until a younger
	// sibling closes. This keeps collapse local to one sibling chain instead of
	// reaching into a parent's interior.
	const parentId =
		rec.state.scopes.length > 1
			? rec.state.scopes[rec.state.scopes.length - 2].id
			: null;
	const order = scopeOrder(scope);
	const elder = findElderSibling(rec.state, parentId, order);
	let foldedReport = null;
	if (elder) {
		const folded = foldElder(rec, {
			elder,
			base,
			currentMessage,
			currentPersisted,
		});
		if (folded.folded) foldedReport = folded.report;
	}
	const closed = closeScope(rec.state, { toolCallId: call.id, report });
	if (!closed.ok) return errorResult(closed.code, closed.reason);
	if (selfVisible) {
		rec.state.collapses.push({
			beginToolCallId: scope.beginToolCallId,
			endToolCallId: call.id,
			report,
			parentId,
			order,
			collapsed: false,
			createdAt: Date.now(),
		});
	}
	const deferred = closed.defers ?? [];
	const steerSent = queueSteer(pi, closed.steerText);
	const remainingScope = currentScope(rec.state);
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
		const opened = beginScope(rec.state, {
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

function processAssistantMessage(rec, pi, message, { persisted = false } = {}) {
	const controls = controlsIn(message);
	if (controls.length === 0) return;
	const key = processedKey(controls);
	if (rec.processedMessages.has(key)) return;
	rec.processedMessages.add(key);

	const existing = contextMessages(rec);
	const firstIndex = findToolCallIndex(existing, controls[0].id);
	const currentPersisted = firstIndex >= 0;
	const base = currentPersisted ? existing : [...existing, message];
	const currentIndex = currentPersisted ? firstIndex : base.length - 1;
	const currentMessage = base[currentIndex] ?? message;

	let changed = false;
	for (const call of controls) {
		if (call.name !== "regret") continue;
		if (rec.processedCalls.has(call.id)) continue;
		setHandled(rec, call.id, handleRegretCall(rec, call, base, currentIndex));
		changed = true;
	}

	const beginIds = new Set(
		controls
			.filter((call) => call.name === "scope" && parseArgs(call).begin != null)
			.map((call) => call.id),
	);

	for (const call of controls) {
		if (call.name === "regret") continue;
		if (rec.processedCalls.has(call.id)) continue;
		if (call.name === "pin") {
			setHandled(rec, call.id, handlePinCall());
			continue;
		}
		if (call.name === "defer") {
			setHandled(rec, call.id, handleDeferCall(rec, call));
			changed = true;
			continue;
		}
		setHandled(
			rec,
			call.id,
			handleScopeCall(rec, pi, call, {
				base,
				currentMessage,
				currentPersisted,
				sameMessageBeginIds: beginIds,
			}),
		);
		changed = true;
	}

	for (const call of controls) rec.processedCalls.add(call.id);
	if (changed) persist(rec);
}

function processControlsForTool(rec, pi, toolCallId) {
	const found = assistantForToolCall(rec, toolCallId);
	if (!found) return;
	processAssistantMessage(rec, pi, found.message, { persisted: true });
}

function directScope(rec, pi, toolCallId, params) {
	const found = assistantForToolCall(rec, toolCallId);
	if (found) {
		processAssistantMessage(rec, pi, found.message, { persisted: true });
		const cached = rec.handled.get(toolCallId);
		if (cached) return cached;
	}
	const base = found?.messages ?? contextMessages(rec);
	const currentMessage = found?.message ?? { role: "assistant", content: [], timestamp: Date.now() };
	const controls = currentMessage.role === "assistant" ? controlsIn(currentMessage) : [];
	const beginIds = new Set(
		controls
			.filter((call) => call.name === "scope" && parseArgs(call).begin != null)
			.map((call) => call.id),
	);
	const call = { id: toolCallId, name: "scope", arguments: params };
	const result = handleScopeCall(rec, pi, call, {
		base,
		currentMessage,
		currentPersisted: Boolean(found),
		sameMessageBeginIds: beginIds,
	});
	persist(rec);
	return result;
}

function directRegret(rec, toolCallId, params) {
	const found = assistantForToolCall(rec, toolCallId);
	if (found) {
		processAssistantMessage(rec, rec.pi, found.message, { persisted: true });
		const cached = rec.handled.get(toolCallId);
		if (cached) return cached;
	}
	const base = found?.messages ?? contextMessages(rec);
	const index = found?.index ?? -1;
	if (index < 0) {
		return errorResult("NOT_IN_SCOPE", "regret is only allowed inside a scope with a visible beat history.");
	}
	const result = handleRegretCall(
		rec,
		{ id: toolCallId, name: "regret", arguments: params },
		base,
		index,
	);
	persist(rec);
	return result;
}

function directDefer(rec, toolCallId, params) {
	const found = assistantForToolCall(rec, toolCallId);
	if (found) {
		processAssistantMessage(rec, rec.pi, found.message, { persisted: true });
		const cached = rec.handled.get(toolCallId);
		if (cached) return cached;
	}
	const result = handleDeferCall(rec, { id: toolCallId, name: "defer", arguments: params });
	persist(rec);
	return result;
}

function directPin(rec, toolCallId, params) {
	const found = assistantForToolCall(rec, toolCallId);
	if (found) {
		processAssistantMessage(rec, rec.pi, found.message, { persisted: true });
		const cached = rec.handled.get(toolCallId);
		if (cached) return cached;
	}
	return handlePinCall();
}

/** Execute body for the scope tool. */
export function createScopeExecute(pi) {
	return async (toolCallId, params, _signal, _onUpdate, ctx) => {
		const rec = stateFor(ctx);
		rec.pi = pi;
		const cached = rec.handled.get(toolCallId);
		if (cached) return cached;
		try {
			processControlsForTool(rec, pi, toolCallId);
			const processed = rec.handled.get(toolCallId);
			if (processed) return processed;
			return directScope(rec, pi, toolCallId, params);
		} catch (error) {
			return errorResult("SCOPE_INTERNAL_ERROR", String(error?.message ?? error));
		}
	};
}

/** Execute body for the regret tool. */
export function createRegretExecute(pi) {
	return async (toolCallId, params, _signal, _onUpdate, ctx) => {
		const rec = stateFor(ctx);
		rec.pi = pi;
		const cached = rec.handled.get(toolCallId);
		if (cached) return cached;
		try {
			processControlsForTool(rec, pi, toolCallId);
			const processed = rec.handled.get(toolCallId);
			if (processed) return processed;
			return directRegret(rec, toolCallId, params);
		} catch (error) {
			return errorResult("REGRET_INTERNAL_ERROR", String(error?.message ?? error));
		}
	};
}

/** Execute body for the defer tool. */
export function createDeferExecute(pi) {
	return async (toolCallId, params, _signal, _onUpdate, ctx) => {
		const rec = stateFor(ctx);
		rec.pi = pi;
		const cached = rec.handled.get(toolCallId);
		if (cached) return cached;
		try {
			processControlsForTool(rec, pi, toolCallId);
			const processed = rec.handled.get(toolCallId);
			if (processed) return processed;
			return directDefer(rec, toolCallId, params);
		} catch (error) {
			return errorResult("DEFER_INTERNAL_ERROR", String(error?.message ?? error));
		}
	};
}

/** Execute body for the pin tool. It always returns OK. */
export function createPinExecute(pi) {
	return async (toolCallId, params, _signal, _onUpdate, ctx) => {
		const rec = stateFor(ctx);
		rec.pi = pi;
		const cached = rec.handled.get(toolCallId);
		if (cached) return cached;
		try {
			processControlsForTool(rec, pi, toolCallId);
			const processed = rec.handled.get(toolCallId);
			if (processed) return processed;
			return directPin(rec, toolCallId, params);
		} catch {
			return textResult("OK");
		}
	};
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

function sameTail(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return false;
	return tailKey(a[a.length - 1]) === tailKey(b[b.length - 1]);
}

function maybeRebase(ctx, rec, outbound) {
	if (!rec.needsRebase) return;
	const tree = contextMessages(rec);
	if (!sameTail(tree, outbound)) return;
	if (setAgentMessages(ctx, tree)) rec.needsRebase = false;
}

/** Register the three hooks and the outbound transform. */
export function installHooks(pi) {
	let assistantMessageRegistered = false;
	try {
		pi.on("assistant_message", async (event, ctx) => {
			const rec = stateFor(ctx);
			rec.pi = pi;
			try {
				rememberCallGroups(rec, event.message);
				processAssistantMessage(rec, pi, event.message, { persisted: false });
				maybeNudge(rec, pi, event.message, ctx);
			} catch (error) {
				rec.lastError = String(error?.message ?? error);
			}
			return undefined;
		});
		assistantMessageRegistered = true;
	} catch {
		assistantMessageRegistered = false;
	}

	if (!assistantMessageRegistered) {
		try {
			pi.on("message_end", async (event, ctx) => {
				if (event.message?.role !== "assistant") return;
				const rec = stateFor(ctx);
				rec.pi = pi;
				try {
					rememberCallGroups(rec, event.message);
					const controls = controlsIn(event.message);
					if (controls.length > 0) {
						const found = assistantForToolCall(rec, controls[0].id);
						processAssistantMessage(rec, pi, event.message, { persisted: Boolean(found) });
					}
					maybeNudge(rec, pi, event.message, ctx);
				} catch (error) {
					rec.lastError = String(error?.message ?? error);
				}
			});
		} catch {
			// The host has neither hook; tool_call fallback still processes controls.
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		const rec = stateFor(ctx);
		rec.pi = pi;
		try {
			// Controls are processed before tool dispatch so scope executes can
			// read their cached result. A handoff-pending begin must be stopped
			// before that processing, or the scope would open despite the block.
			if (event.toolName === "scope" && rec.state.relay?.handoffPending) {
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
			processControlsForTool(rec, pi, event.toolCallId);
			if (event.toolName === "todo") {
				if (currentScope(rec.state)) {
					return {
						block: true,
						reason:
							"TODO_OUTSIDE_SCOPE_ONLY: todo is forbidden inside any active scope. Close every scope first; todo only works outside all scopes.",
					};
				}
				if (rec.state.relay?.handoffPending) {
					return {
						block: true,
						reason:
							"RELAY_HANDOFF_PENDING: a relay handoff is pending. Do not change the ledger; wait for the successor.",
					};
				}
				persist(rec);
				return undefined;
			}
			if (CONTROL_TOOLS.has(event.toolName)) {
				if (event.toolName === "scope") {
					const args = parseArgs({
						arguments: event.input ?? event.arguments ?? {},
					});
					if (args.begin !== undefined && args.begin !== null) {
						if (rec.state.relay?.handoffPending) {
							return {
								block: true,
								reason:
									"RELAY_HANDOFF_PENDING: a relay handoff is pending. Do not open a new scope; wait for the successor.",
							};
						}
						if (rec.state.relay?.canStop) {
							rec.state.relay = invalidatePromotion(rec.state.relay);
							persist(rec);
						}
					}
				}
				return undefined;
			}
			if (!currentScope(rec.state)) {
				return {
					block: true,
					reason:
						"Not in a scope. Outside all scopes only todo and the free control tools (scope, regret, defer, pin) may be called. Open a scope with scope({ begin: { intent, budget } }) before using any other tool.",
				};
			}
			const found = assistantForToolCall(rec, event.toolCallId);
			if (found) rememberCallGroups(rec, found.message);
			const groupKey =
				rec.callGroups.get(event.toolCallId) ??
				(found ? beatKey(found.message) : undefined);
			const charged = chargeTool(rec.state, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				groupKey,
			});
			if (!charged.ok) return { block: true, reason: charged.reason };
			persist(rec);
			return undefined;
		} catch (error) {
			return {
				block: true,
				reason: `Scope accounting failed closed: ${String(error?.message ?? error)}`,
			};
		}
	});

	pi.on("context", async (event, ctx) => {
		const rec = stateFor(ctx);
		const original = Array.isArray(event?.messages) ? event.messages : [];
		try {
			let messages = filterRegrets(original, rec.state.regrets);
			messages = applyCollapses(messages, rec.state.collapses);
			messages = messages.map(rewriteVibeMessage);
			maybeRebase(ctx, rec, messages);
			messages = appendUserTail(messages, tailText(rec.state));
			return { messages };
		} catch (error) {
			rec.lastError = String(error?.message ?? error);
			try {
				return { messages: appendUserTail(original, tailText(rec.state)) };
			} catch {
				return { messages: original };
			}
		}
	});

	// Completion events and the idle fallback live in handoff.mjs. The lookup
	// keeps that module free of a runtime import cycle.
	installHandoffHooks(pi, { stateFor });
}

/** Inject the retained English repo-aware prompt. */
export function installSystemPrompt(pi) {
	pi.on("before_agent_start", (event) => {
		const prompt = injectSystemPrompt(event?.systemPrompt);
		if (prompt === event?.systemPrompt) return undefined;
		return { systemPrompt: prompt };
	});
}
