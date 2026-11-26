// All branches share one display lease; child rendering never enters the root AgentSession.
// Running tools live in a one-row-per-tool active area above the editor so an
// unsettled call (scope_join, scope_return, or any slow tool) never pins the
// transcript retirement frontier; finished tools append at full size.
//
// In omp 19.2+, custom transcript messages settle immediately at mount time,
// which causes a live-mutated custom block to retire into scrollback (or drop
// reactive watchers in native mode) mid-stream. Live child thinking and prose
// therefore stream on the host's native `role: "assistant"` channel (headed by
// a settled one-line scope label), so thinking stays live with progressive
// stable-head retirement until `message_end`. Finished `todo` snapshots render
// as settled checklist cards so omp's displaceable-todo tracker never pins the
// transcript scrollback frontier across long fork/join turns.
import { record } from "./diagnostics.mjs";
import { getHostTui } from "./tui-runtime.mjs";
import {
	stripToolCalls,
	textBlocks,
	formatFallbackLine,
	assistantParts,
	updateAssistantStream,
	finalizeAssistantStream,
	buildChildAssistantMessage,
	buildChildAssistantDelta,
	buildTodoSnapshot,
	partsText,
	partsSignature,
} from "./activity.mjs";

// The engine's scope read model, bound once at activation. A display is a host
// surface; it reads DTOs and never a ledger.
let scopeView = null;
export function bindScopeView(view) {
	scopeView = view;
}
const scopes = () => scopeView ?? { of: () => null, status: () => null, label: () => null, activity: () => "" };

export const CHILD_ACTIVITY_TYPE = "herd.fork-activity";
export const ACTIVE_TOOLS_WIDGET_KEY = "herd-tools";
const CAPTURE = Symbol.for("herdchestra-lite2.transcript-subscribe.v1");
const STATE = Symbol.for("herdchestra-lite2.transcript-listeners.v1");
const transcript = globalThis[STATE] ??= new WeakMap();
const noopRepaint = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
// One stable identity: the host detach only clears the slot it installed.
const SUPPRESS_APPROVAL_PREVIEW = () => Promise.resolve();
let toolCardCtor = null;

export function registerToolCardComponent(Component) {
	toolCardCtor = typeof Component === "function" ? Component : null;
}

function stateFor(session) {
	let state = transcript.get(session);
	if (!state) {
		state = { listeners: new Set(), timestamp: 0, stop: null, route: null };
		transcript.set(session, state);
	}
	return state;
}

// Capture subscriptions before interactive mode subscribes. The arbiter owns
// presentation only; it never feeds child frames to the root AgentSession.
export function captureTranscriptSubscriptions(prototype) {
	if (typeof prototype?.subscribe !== "function" || Object.hasOwn(prototype, CAPTURE)) return;
	const subscribe = prototype.subscribe;
	Object.defineProperty(prototype, CAPTURE, { value: true });
	prototype.subscribe = function (listener) {
		const state = stateFor(this);
		const entry = { listener };
		state.listeners.add(entry);
		state.stop ??= subscribe.call(this, (event) => {
			if (state.route) state.route(event);
			else publish(state, event);
		});
		return () => {
			state.listeners.delete(entry);
			if (state.listeners.size === 0) {
				state.stop?.();
				state.stop = null;
			}
		};
	};
}

function resolveTool(session, toolName) {
	try {
		return session?.getToolByName?.(toolName);
	} catch {
		return undefined;
	}
}

function resolveCwd(session) {
	try {
		return session?.sessionManager?.getCwd?.();
	} catch {
		return undefined;
	}
}

function isBuiltInTool(session, toolName) {
	try {
		return typeof session?.hasBuiltInTool === "function" ? session.hasBuiltInTool(toolName) : undefined;
	} catch {
		return undefined;
	}
}

function buildToolCard(Card, tool, tui) {
	const options = tool.builtIn === undefined ? {} : { useBuiltInRenderer: tool.builtIn };
	const card = new Card(tool.toolName, tool.args, options, tool.definition, tui ?? noopRepaint, tool.cwd, tool.toolCallId);
	card.setArgsComplete?.(tool.toolCallId);
	card.setExecutionStarted?.(tool.toolCallId);
	return card;
}

function normalizeParts(parts) {
	return Array.isArray(parts)
		? parts.filter((part) => (part?.kind === "thinking" || part?.kind === "text") && typeof part.text === "string")
		: [];
}

function renderStaticPart(tui, part) {
	if (part.kind === "thinking") {
		return tui.jsx("section", {
			role: "omp.thinking",
			collapsible: false,
			collapsed: false,
			children: [tui.jsx("md", { text: part.text })],
		});
	}
	return tui.jsx("md", { text: part.text });
}

function renderTodoCard(tui, label, todo) {
	const spans = [];
	if (label) spans.push({ t: `${label} · `, s: "muted" });
	spans.push({ t: "Todo", s: "accent strong" });
	if (todo.total > 0) spans.push({ t: ` ${todo.closed}/${todo.total}`, s: "dim" });
	const header = tui.jsx("text", { spans, wrap: true });
	if (Array.isArray(todo.phases) && todo.phases.length > 0) {
		return tui.jsx("col", {
			children: [
				header,
				tui.jsx("checklist", { mode: "full", phases: todo.phases }),
			],
		});
	}
	const fallback = typeof todo.text === "string" && todo.text ? todo.text : "No todos";
	return tui.jsx("col", {
		children: [header, tui.jsx("text", { text: fallback, wrap: true })],
	});
}

/**
 * Render static, settled `herd.fork-activity` custom messages:
 * - scope header labels (1-line tag introducing a child's native assistant stream),
 * - settled todo checklists (preventing omp 19.2's displaceable-todo card from pinning scrollback),
 * - fallback static parts snapshots (for replayed or non-streamed entries).
 */
export function renderChildActivity(message, _options, _theme, tui = getHostTui()) {
	if (typeof tui?.jsx !== "function" || message?.details?.tool) return undefined;
	const details = message.details ?? {};
	const label = typeof details.label === "string" ? details.label : "";
	if (details.todo) {
		return renderTodoCard(tui, label, details.todo);
	}
	const parts = normalizeParts(details.parts);
	if (parts.length === 0) {
		return label
			? tui.jsx("text", { spans: [{ t: label, s: "accent" }], wrap: true })
			: undefined;
	}
	const assistant = tui.jsx("col", {
		role: "omp.assistant",
		children: parts.map((part) => renderStaticPart(tui, part)),
	});
	return tui.jsx("col", {
		children: label
			? [tui.jsx("text", { spans: [{ t: label, s: "accent" }], wrap: true }), assistant]
			: [assistant],
	});
}

function publish(state, event) {
	for (const entry of state.listeners) {
		try {
			const pending = entry.listener(event);
			pending?.catch?.((error) => record("fork", error, { phase: "child-display" }));
		} catch (error) {
			record("fork", error, { phase: "child-display" });
		}
	}
}

function createActiveToolTray(getUi, current) {
	const entries = new Map();
	let mounted = false;
	let hostTui = null;
	let hostTheme = null;
	let activeWidget = null;
	let tick = 0;

	function entryKey(source, toolCallId, toolName) {
		return typeof toolCallId === "string" && toolCallId !== "" ? toolCallId : `name:${toolName ?? "tool"}`;
	}

	function mapFor(source, create = false) {
		let map = entries.get(source);
		if (!map && create) {
			map = new Map();
			entries.set(source, map);
		}
		return map;
	}

	function totalCount() {
		let count = 0;
		for (const map of entries.values()) count += map.size;
		return count;
	}

	function disposeCard(entry) {
		try {
			entry.card?.seal?.();
			entry.card?.dispose?.();
		} catch {
			// Disposing a visual card must never break tool delivery.
		}
		entry.card = null;
	}

	function ensureCard(entry) {
		if (entry.card || !toolCardCtor || !hostTui) return entry.card;
		const card = buildToolCard(toolCardCtor, entry, hostTui);
		if (entry.partialResult) card.updateResult(entry.partialResult, true, entry.toolCallId);
		entry.card = card;
		return card;
	}

	function renderRow(entry, width, frame) {
		const safeWidth = Math.max(1, width);
		const tag = entry.label ? ` ${entry.label} ` : " ";
		const styledTag = entry.label && hostTheme?.fg ? ` ${hostTheme.fg("muted", entry.label)} ` : tag;
		const card = ensureCard(entry);
		if (card) {
			const innerWidth = Math.max(8, safeWidth - tag.length);
			card.setTranscriptAllocation?.(1, frame);
			const lines = card.render(innerWidth);
			const first = Array.isArray(lines) && lines.length > 0 ? lines[0] : "";
			if (first) return `${styledTag}${first}`;
		}
		const line = ` ${formatFallbackLine(entry, frame.now)}`;
		return line.length > safeWidth ? `${line.slice(0, Math.max(1, safeWidth - 1))}…` : line;
	}

	function buildWidget(tui, theme) {
		const previous = activeWidget;
		activeWidget = null;
		previous?.dispose?.();
		hostTui = tui;
		hostTheme = theme;
		const clock = setInterval(() => hostTui?.requestRender?.(), 250);
		clock.unref?.();
		const widget = {
			render(width) {
				tick += 1;
				const frame = { tick, now: performance.now() };
				const rows = [];
				for (const map of entries.values()) {
					for (const entry of map.values()) rows.push(renderRow(entry, width, frame));
				}
				return rows;
			},
			invalidate() {
				for (const map of entries.values()) {
					for (const entry of map.values()) entry.card?.invalidate?.();
				}
			},
			dispose() {
				clearInterval(clock);
				for (const map of entries.values()) {
					for (const entry of map.values()) disposeCard(entry);
				}
				if (activeWidget === widget) activeWidget = null;
				hostTui = null;
				hostTheme = null;
			},
		};
		activeWidget = widget;
		return widget;
	}

	function syncWidget() {
		const ui = getUi();
		if (!current() || typeof ui?.setWidget !== "function") return;
		const count = totalCount();
		if (count === 0) {
			if (!mounted) return;
			mounted = false;
			const widget = activeWidget;
			activeWidget = null;
			widget?.dispose?.();
			try {
				ui.setWidget(ACTIVE_TOOLS_WIDGET_KEY, undefined);
			} catch (error) {
				record("fork", error, { phase: "child-display" });
			}
			return;
		}
		if (!mounted) {
			mounted = true;
			try {
				ui.setWidget(ACTIVE_TOOLS_WIDGET_KEY, buildWidget, { placement: "aboveEditor" });
			} catch (error) {
				mounted = false;
				record("fork", error, { phase: "child-display" });
			}
			return;
		}
		hostTui?.requestRender?.();
	}

	return {
		start(source, label, session, event) {
			const map = mapFor(source, true);
			const key = entryKey(source, event.toolCallId, event.toolName);
			const previous = map.get(key);
			if (previous) disposeCard(previous);
			const entry = {
				label,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				definition: resolveTool(session, event.toolName),
				builtIn: isBuiltInTool(session, event.toolName),
				cwd: resolveCwd(session),
				startedAt: performance.now(),
				partialResult: null,
				partialText: "",
				card: null,
			};
			map.set(key, entry);
			syncWidget();
		},
		update(source, event) {
			const map = mapFor(source);
			if (!map) return;
			const entry = map.get(entryKey(source, event.toolCallId, event.toolName));
			if (!entry) return;
			entry.partialResult = event.partialResult ?? null;
			const text = textBlocks(event.partialResult?.content, "text", "text").split("\n", 1)[0]?.trim() ?? "";
			entry.partialText = text;
			if (entry.card && entry.partialResult) {
				entry.card.updateResult(entry.partialResult, true, entry.toolCallId);
			}
			syncWidget();
		},
		end(source, event) {
			const map = mapFor(source);
			const key = entryKey(source, event.toolCallId, event.toolName);
			const entry = map?.get(key) ?? null;
			if (entry) {
				disposeCard(entry);
				map.delete(key);
				if (map.size === 0) entries.delete(source);
				syncWidget();
			}
			return entry;
		},
		clearSource(source) {
			const map = mapFor(source);
			if (!map) return;
			for (const entry of map.values()) disposeCard(entry);
			entries.delete(source);
			syncWidget();
		},
		get activeCount() {
			return totalCount();
		},
	};
}

const ROOT = Symbol("root");

function displayArbiter(state, tray, suppressApprovalPreview) {
	let owner = null;
	const queue = [];
	const streams = new Map();
	const rootEvent = (event) => publish(state, event);

	function nextTimestamp() {
		state.timestamp = Math.max(Date.now(), state.timestamp + 1);
		return state.timestamp;
	}

	function emitCustom(label, content, details) {
		const message = {
			role: "custom",
			customType: CHILD_ACTIVITY_TYPE,
			attribution: "agent",
			content,
			display: true,
			excludeFromContext: true,
			timestamp: nextTimestamp(),
			details,
		};
		rootEvent({ type: "message_start", message });
		return message;
	}

	function emitLabelHeader(label) {
		if (!label) return;
		emitCustom(label, label, { label, body: "", parts: null, tool: null });
	}

	function emitTodoCard(label, todo) {
		const content = label ? `${label}\n${todo.text}` : todo.text;
		emitCustom(label, content, { label, body: todo.text, parts: null, tool: null, todo });
	}

	function emitChildAssistantStart(stream, parts) {
		emitLabelHeader(stream.label);
		stream.started = true;
		stream.timestamp = nextTimestamp();
		stream.emittedParts = parts;
		stream.signature = partsSignature(parts);
		const message = buildChildAssistantMessage(parts, {
			label: stream.label,
			timestamp: stream.timestamp,
		});
		rootEvent({ type: "message_start", message });
		rootEvent({
			type: "message_update",
			message,
			assistantMessageEvent: buildChildAssistantDelta([], parts, message),
		});
	}

	function emitChildAssistantUpdate(stream, parts) {
		const signature = partsSignature(parts);
		if (signature === stream.signature) return;
		const previous = stream.emittedParts;
		stream.emittedParts = parts;
		stream.signature = signature;
		const message = buildChildAssistantMessage(parts, {
			label: stream.label,
			timestamp: stream.timestamp,
		});
		rootEvent({
			type: "message_update",
			message,
			assistantMessageEvent: buildChildAssistantDelta(previous, parts, message),
		});
	}

	function emitChildAssistantComplete(label, parts) {
		if (parts.length === 0) return;
		emitLabelHeader(label);
		const message = buildChildAssistantMessage(parts, {
			label,
			timestamp: nextTimestamp(),
		});
		rootEvent({ type: "message_start", message });
		rootEvent({ type: "message_end", message });
	}

	function promoteNextLive() {
		if (owner !== null || streams.size === 0) return;
		// Prefer a waiting root stream so root prose regains the live slot first;
		// otherwise hand the lease to the earliest still-streaming child.
		const nextSource = streams.has(ROOT) ? ROOT : streams.keys().next().value;
		const next = streams.get(nextSource);
		if (!next) return;
		owner = nextSource;
		next.live = true;
		if (nextSource === ROOT) {
			rootEvent(next.start);
			if (next.lastUpdate) rootEvent(next.lastUpdate);
			return;
		}
		const parts = next.accumulated.parts;
		if (parts.length > 0) emitChildAssistantStart(next, parts);
	}

	function flush() {
		if (owner !== null) return;
		for (const show of queue.splice(0)) show();
		promoteNextLive();
	}

	function block(show) {
		if (owner === null) show();
		else queue.push(show);
	}

	function finish(source, event) {
		const stream = streams.get(source);
		if (!stream) return false;
		streams.delete(source);
		if (source === ROOT) {
			const end = event ? stripToolCalls(event) : (stream.last && { type: "message_end", message: stream.last });
			if (end) {
				const show = () => {
					if (!stream.live) rootEvent({ ...stream.start, message: end.message });
					rootEvent(end);
				};
				if (stream.live) show();
				else block(show);
			}
		} else {
			const finalStream = finalizeAssistantStream(
				stream.accumulated,
				event?.message ?? stream.last,
				event?.assistantMessageEvent,
			);
			const parts = finalStream.parts;
			if (stream.live && stream.started) {
				const message = buildChildAssistantMessage(parts, {
					label: stream.label,
					timestamp: stream.timestamp,
				});
				rootEvent({ type: "message_end", message });
			} else if (parts.length > 0) {
				if (stream.live) emitChildAssistantComplete(stream.label, parts);
				else block(() => emitChildAssistantComplete(stream.label, parts));
			}
		}
		if (owner === source) {
			owner = null;
			flush();
		}
		return true;
	}

	function accept(source, label, session, event) {
		const root = source === ROOT;
		const { type, message } = event;
		if (type === "tool_execution_start") {
			if (root) suppressApprovalPreview?.();
			tray.start(source, root ? null : label, session, event);
			return;
		}
		if (type === "tool_execution_update") {
			tray.update(source, event);
			return;
		}
		if (type === "tool_execution_end") {
			const active = tray.end(source, event);
			const todo = buildTodoSnapshot(event);
			if (todo) {
				block(() => emitTodoCard(root ? null : label, todo));
				return;
			}
			const completed = {
				...event,
				toolCallId: root ? event.toolCallId : `herd:${label ?? "child"}:${event.toolCallId ?? event.toolName}`,
				args: active?.args ?? event.args,
				definition: active?.definition ?? resolveTool(session, event.toolName),
				builtIn: active?.builtIn ?? isBuiltInTool(session, event.toolName),
				cwd: active?.cwd ?? resolveCwd(session),
			};
			block(() => {
				rootEvent({ ...completed, type: "tool_execution_start" });
				rootEvent(completed);
			});
			return;
		}
		if (message?.role === "assistant") {
			const shown = root ? stripToolCalls(event) : event;
			if (type === "message_start") {
				finish(source);
				const live = owner === null;
				if (live) owner = source;
				const accumulated = updateAssistantStream(null, shown.message, event.assistantMessageEvent);
				const stream = {
					label,
					live,
					started: false,
					start: shown,
					last: shown.message,
					lastUpdate: null,
					accumulated,
					emittedParts: [],
					signature: "",
					timestamp: 0,
				};
				streams.set(source, stream);
				if (root && live) rootEvent(shown);
				else if (!root && live && accumulated.parts.length > 0) {
					emitChildAssistantStart(stream, accumulated.parts);
				}
				return;
			}
			const stream = streams.get(source);
			if (type === "message_update" && stream) {
				stream.last = shown.message;
				if (root) {
					stream.lastUpdate = shown;
					if (stream.live) rootEvent(shown);
					return;
				}
				stream.accumulated = updateAssistantStream(stream.accumulated, message, event.assistantMessageEvent);
				if (stream.live) {
					const parts = stream.accumulated.parts;
					if (!stream.started && parts.length > 0) emitChildAssistantStart(stream, parts);
					else if (stream.started && parts.length > 0) emitChildAssistantUpdate(stream, parts);
				}
				return;
			}
			if (type === "message_end" && finish(source, shown)) return;
		}
		if (type === "agent_end" || type === "agent_pause") {
			finish(source);
			if (type === "agent_end") tray.clearSource(source);
		}
		if (root) {
			if (type === "message_end" && message?.role === "assistant") {
				const shown = stripToolCalls(event);
				block(() => {
					rootEvent({ type: "message_start", message: shown.message });
					rootEvent(shown);
				});
				return;
			}
			if (owner === ROOT) rootEvent(event);
			else block(() => rootEvent(event));
		} else if (type === "message_end" && message?.role === "assistant") {
			const parts = assistantParts(message, event.assistantMessageEvent);
			if (parts.length > 0) {
				block(() => emitChildAssistantComplete(label, parts));
			}
		}
	}

	function detach(source) {
		tray.clearSource(source);
		finish(source);
	}

	return { accept, detach };
}

/**
 * The host exposes one approval-preview waiter slot. Root tool events are
 * consumed into the herd-tools tray, so no native preview card exists to ask
 * for that waiter. Leaving the host's waiter in place would stall its gate.
 * The suppression belongs to one display lease: keep its detach and release it
 * when the lease ends. The host detach is identity-checked and cannot restore
 * a waiter installed before ours.
 */
function installApprovalPreviewSuppression(root, binding) {
	if (binding.approvalPreviewInstalled) return;
	const runner = root?.extensionRunner;
	if (typeof runner?.setToolApprovalPreviewWaiter !== "function") return;
	binding.approvalPreviewInstalled = true;
	try {
		const detach = runner.setToolApprovalPreviewWaiter(SUPPRESS_APPROVAL_PREVIEW);
		binding.approvalPreviewDetach = typeof detach === "function" ? detach : null;
	} catch (error) {
		binding.approvalPreviewInstalled = false;
		record("fork", error, { phase: "child-display" });
	}
}

function releaseApprovalPreviewSuppression(binding) {
	if (!binding) return;
	const detach = binding.approvalPreviewDetach;
	binding.approvalPreviewDetach = null;
	binding.approvalPreviewInstalled = false;
	if (typeof detach !== "function") return;
	try {
		detach();
	} catch (error) {
		record("fork", error, { phase: "child-display" });
	}
}

export function childDisplayFor(root, ui) {
	if (!root) return null;
	const manager = root.sessionManager;
	const sessionId = manager?.getSessionId?.();
	const state = stateFor(root);
	if (state.display && state.display.manager === manager && state.display.sessionId === sessionId) {
		if (ui) state.display.ui = ui;
		return state.display.port;
	}
	releaseApprovalPreviewSuppression(state.display);
	const binding = {
		manager,
		sessionId,
		ui,
		port: null,
		approvalPreviewInstalled: false,
		approvalPreviewDetach: null,
	};
	state.display = binding;
	const current = () => state.display === binding && !root.isSessionTransitioning && root.sessionManager === manager && manager?.getSessionId?.() === sessionId;
	let lastOwnerId = "root";
	let rootWaits = 0;
	const tray = createActiveToolTray(() => binding.ui, current);
	const suppressApprovalPreview = () => installApprovalPreviewSuppression(root, binding);
	const arbiter = displayArbiter(state, tray, suppressApprovalPreview);
	suppressApprovalPreview();
	state.route = (event) => {
		if (current()) arbiter.accept(ROOT, null, root, event);
		else publish(state, event);
	};
	return binding.port = {
		rootWait(delta) { rootWaits += delta; },
		request(_ledger, ownerId) {
			if (!current() || typeof binding.ui?.setWorkingMessage !== "function") return;
			lastOwnerId = ownerId ?? "root";
			binding.ui.setWorkingMessage(() => current() ? scopes().activity(lastOwnerId, root.isStreaming === true && rootWaits === 0) : "Working…");
		},
		attach(id, child) {
			const unsubscribe = child.subscribe((event) => {
				if (current()) arbiter.accept(child, id, child, event);
			});
			return () => {
				unsubscribe();
				if (current()) arbiter.detach(child);
			};
		},
		get activeTools() {
			return tray.activeCount;
		},
	};
}
