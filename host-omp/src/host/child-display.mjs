// All branches share one display lease; child rendering never enters the root AgentSession.
// Running tools live in a one-row-per-tool active area above the editor so an
// unsettled call (scope_join, scope_return, or any slow tool) never pins the
// transcript retirement frontier; finished tools append at full size.
import { record } from "./diagnostics.mjs";
import { forkOf, RUNNING, READY } from "herdchestra-lite2";
import { publicScopeId, scopeTitle } from "herdchestra-lite2";

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

function stripToolCalls(event) {
	const message = event?.message;
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return event;
	const kept = message.content.filter((block) => block?.type !== "toolCall");
	return kept.length === message.content.length ? event : { ...event, message: { ...message, content: kept } };
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

function buildMarkdownBlock(Markdown, getMarkdownTheme, theme, part) {
	if (part.kind === "thinking") {
		return new Markdown(part.text, 1, 0, getMarkdownTheme(), {
			color: (value) => theme.fg("thinkingText", value),
			italic: true,
		});
	}
	return new Markdown(part.text, 1, 0, getMarkdownTheme());
}

export function renderChildActivity(ui, message, options, theme, ToolExecutionComponent = toolCardCtor) {
	const { Container, Markdown, Spacer, Text, getMarkdownTheme } = ui ?? {};
	if (![Container, Markdown, Text, getMarkdownTheme].every((value) => typeof value === "function")) return undefined;
	const frame = new Container();
	const { label, body, parts, tool } = message.details ?? {};
	const header = label ? new Text(theme.fg("muted", label), 1, 0) : null;
	if (header) frame.addChild(header);
	if (tool?.type === "tool_execution_end" && typeof ToolExecutionComponent === "function") {
		const card = buildToolCard(ToolExecutionComponent, tool, noopRepaint);
		card.setExpanded?.(options?.expanded === true);
		card.updateResult({ ...(tool.result ?? { content: [] }), isError: tool.isError === true }, false, tool.toolCallId);
		card.seal?.();
		frame.addChild(card);
		return frame;
	}
	const slots = [];
	const syncParts = (nextParts) => {
		const list = Array.isArray(nextParts) && nextParts.length > 0
			? nextParts
			: [{ kind: "text", text: body ?? message.content ?? "" }];
		let compatible = list.length >= slots.length;
		for (let i = 0; compatible && i < slots.length; i += 1) {
			if (slots[i].kind !== list[i].kind) compatible = false;
		}
		if (!compatible) {
			frame.clear?.();
			slots.length = 0;
			if (header) frame.addChild(header);
		}
		for (let i = 0; i < list.length; i += 1) {
			const part = list[i];
			if (i < slots.length) {
				slots[i].md.setText(part.text);
				continue;
			}
			if (slots.length > 0 && typeof Spacer === "function") frame.addChild(new Spacer(1));
			const md = buildMarkdownBlock(Markdown, getMarkdownTheme, theme, part);
			slots.push({ kind: part.kind, md });
			frame.addChild(md);
		}
	};
	syncParts(parts);
	if (message.details) message.details.syncParts = syncParts;
	return frame;
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

function textBlocks(content, type, field) {
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block.type === type && block[field]?.trim() ? [block[field]] : []).join("\n");
}

function toolSummaryText(event) {
	if (event.type === "tool_execution_end") {
		const output = textBlocks(event.result?.content, "text", "text");
		return `${event.toolName} · ${event.isError ? "failed" : "completed"}${output ? `\n${output}` : ""}`;
	}
	return `${event.toolName} · running`;
}

function formatFallbackLine(entry, now) {
	const elapsed = Math.max(0, Math.floor((now - entry.startedAt) / 1000));
	const title = entry.definition?.label ?? entry.toolName;
	const prefix = entry.label ? `${entry.label} ` : "";
	const tail = entry.partialText ? ` · ${entry.partialText}` : " · running";
	return `${prefix}• ${title}${tail} ${elapsed}s`;
}

function createActiveToolTray(getUi, current) {
	const entries = new Map();
	let mounted = false;
	let hostTui = null;
	let hostTheme = null;
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
		hostTui = tui;
		hostTheme = theme;
		return {
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
				for (const map of entries.values()) {
					for (const entry of map.values()) disposeCard(entry);
				}
				hostTui = null;
				hostTheme = null;
			},
		};
	}

	function syncWidget() {
		const ui = getUi();
		if (!current() || typeof ui?.setWidget !== "function") return;
		const count = totalCount();
		if (count === 0) {
			if (!mounted) return;
			mounted = false;
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

export function scopeActivity(ledger, lastOwnerId, rootBusy, clock = null) {
	let busy = Number(rootBusy);
	let idle = Number(!rootBusy);
	for (const id of ledger.order) {
		const branch = forkOf(ledger, id);
		const paused = branch?.clockPausedAt != null &&
			(!clock || clock.info(branch).bounded !== false);
		if (branch?.status === RUNNING && !paused) busy++;
		else if (branch?.status === READY || branch?.status === RUNNING) idle++;
	}
	const lineage = [];
	const seen = new Set();
	for (let id = lastOwnerId; id && id !== "root" && !seen.has(id);) {
		seen.add(id);
		const branch = forkOf(ledger, id);
		if (!branch) break;
		lineage.push(scopeTitle(publicScopeId(branch)));
		id = branch.ownerId;
	}
	lineage.reverse();
	return `[Busy: ${busy}, Idle: ${idle}]${lineage.length ? ` ${lineage.join(" > ")}` : ""}`;
}

const ROOT = Symbol("root");

function assistantParts(message) {
	if (!Array.isArray(message?.content)) return [];
	const parts = [];
	for (const block of message.content) {
		if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
			parts.push({ kind: "thinking", text: block.thinking });
		} else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			parts.push({ kind: "text", text: block.text });
		}
	}
	return parts;
}

function partsText(parts) {
	return parts.map((part) => part.text).join("\n");
}

function partsSignature(parts) {
	return parts.map((part) => `${part.kind}:${part.text}`).join("\0");
}

function displayArbiter(state, tray, suppressApprovalPreview) {
	let owner = null;
	const queue = [];
	const streams = new Map();
	const rootEvent = (event) => publish(state, event);

	function row(label, text, tool = null, parts = null) {
		state.timestamp = Math.max(Date.now(), state.timestamp + 1);
		const message = {
			role: "custom", customType: CHILD_ACTIVITY_TYPE, attribution: "agent",
			content: label ? `${label}\n${text}` : text, display: true, excludeFromContext: true,
			timestamp: state.timestamp, details: { label, body: text, parts, tool },
		};
		rootEvent({ type: "message_start", message });
		return message;
	}

	function flush() {
		if (owner !== null) return;
		for (const show of queue.splice(0)) show();
	}

	function block(show) {
		if (owner === null) show();
		else queue.push(show);
	}

	function updateLive(stream, parts) {
		const signature = partsSignature(parts);
		if (stream.row === null || stream.signature === signature) return;
		const text = partsText(parts);
		stream.signature = signature;
		stream.row.content = `${stream.label}\n${text}`;
		stream.row.details.body = text;
		stream.row.details.parts = parts;
		stream.row.details.syncParts?.(parts);
		// This is a custom row, not an assistant frame. Omp's message_end
		// handler requests a repaint without touching the assistant slot.
		rootEvent({ type: "message_end", message: stream.row });
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
			const parts = assistantParts(event?.message ?? stream.last);
			const text = partsText(parts);
			if (stream.live && stream.row !== null && parts.length > 0) updateLive(stream, parts);
			else if (stream.live && text) row(stream.label, text, null, parts);
			else if (text) block(() => row(stream.label, text, null, parts));
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
			const completed = {
				...event,
				args: active?.args ?? event.args,
				definition: active?.definition ?? resolveTool(session, event.toolName),
				builtIn: active?.builtIn ?? isBuiltInTool(session, event.toolName),
				cwd: active?.cwd ?? resolveCwd(session),
			};
			block(() => row(root ? null : label, toolSummaryText(event), completed));
			return;
		}
		if (message?.role === "assistant") {
			const shown = root ? stripToolCalls(event) : event;
			if (type === "message_start") {
				finish(source);
				const live = owner === null;
				if (live) owner = source;
				const stream = { label, live, start: shown, last: shown.message, row: null, signature: "" };
				streams.set(source, stream);
				if (root && live) rootEvent(shown);
				return;
			}
			const stream = streams.get(source);
			if (type === "message_update" && stream) {
				stream.last = shown.message;
				if (stream.live) {
					if (root) rootEvent(shown);
					else {
						const parts = assistantParts(message);
						if (stream.row === null && parts.length > 0) {
							stream.row = row(label, partsText(parts), null, parts);
							stream.signature = partsSignature(parts);
						} else if (parts.length > 0) {
							updateLive(stream, parts);
						}
					}
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
			const parts = assistantParts(message);
			if (parts.length > 0) block(() => row(label, partsText(parts), null, parts));
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
		request(ledger, ownerId) {
			if (!current() || typeof binding.ui?.setWorkingMessage !== "function") return;
			lastOwnerId = ownerId ?? "root";
			binding.ui.setWorkingMessage(() => current() ? scopeActivity(ledger, lastOwnerId, root.isStreaming === true && rootWaits === 0) : "Working…");
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
