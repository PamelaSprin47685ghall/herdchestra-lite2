// All branches share one display lease; child rendering never enters the root AgentSession.
import { record } from "./diagnostics.mjs";
import { forkOf, RUNNING, READY } from "../scope/forkjoin.mjs";
import { publicScopeId, scopeTitle } from "../scope/scope-id.mjs";

export const CHILD_ACTIVITY_TYPE = "herd.fork-activity";
const CAPTURE = Symbol.for("herdchestra-lite2.transcript-subscribe.v1");
const STATE = Symbol.for("herdchestra-lite2.transcript-listeners.v1");
const transcript = globalThis[STATE] ??= new WeakMap();

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

export function renderChildActivity(ui, message, options, theme, ToolExecutionComponent) {
	const { Container, Markdown, Text, getMarkdownTheme } = ui ?? {};
	if (![Container, Markdown, Text, getMarkdownTheme].every((value) => typeof value === "function")) return undefined;
	const frame = new Container();
	const { label, body, tool } = message.details;
	frame.addChild(new Text(theme.fg("muted", label), 1, 0));
	if (tool?.type === "tool_execution_end" && typeof ToolExecutionComponent === "function") {
		const repaint = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
		const card = new ToolExecutionComponent(tool.toolName, tool.args, {}, undefined, repaint);
		card.setExpanded(options.expanded);
		card.updateResult({ ...tool.result, isError: tool.isError }, false);
		card.seal();
		frame.addChild(card);
	} else {
		const content = new Markdown(body, 1, 0, getMarkdownTheme());
		message.details.component = content;
		frame.addChild(content);
	}
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

function activityOf(event) {
	switch (event.type) {
		case "message_end":
			return event.message?.role === "assistant" ? textBlocks(event.message.content, "text", "text") : "";
		case "tool_execution_start":
			return `${event.toolName} · started`;
		case "tool_execution_end": {
			const output = textBlocks(event.result?.content, "text", "text");
			return `${event.toolName} · ${event.isError ? "failed" : "completed"}${output ? `\n${output}` : ""}`;
		}
		default:
			return "";
	}
}

export function scopeActivity(ledger, lastOwnerId, rootBusy) {
	let busy = Number(rootBusy);
	let idle = Number(!rootBusy);
	for (const id of ledger.order) {
		const branch = forkOf(ledger, id);
		if (branch?.status === RUNNING && branch.clockPausedAt == null) busy++;
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

function assistantText(message) {
	if (!Array.isArray(message?.content)) return "";
	return message.content.flatMap((block) => {
		const value = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : null;
		return typeof value === "string" && value.trim() ? [value] : [];
	}).join("\n");
}

function displayArbiter(state) {
	let owner = null;
	const queue = [];
	const streams = new Map();
	const rootEvent = (event) => publish(state, event);

	function row(label, text, tool = null) {
		state.timestamp = Math.max(Date.now(), state.timestamp + 1);
		const message = {
			role: "custom", customType: CHILD_ACTIVITY_TYPE, attribution: "agent",
			content: `${label}\n${text}`, display: true, excludeFromContext: true,
			timestamp: state.timestamp, details: { label, body: text, tool },
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

	function updateLive(stream, text) {
		if (stream.row === null || stream.text === text) return;
		stream.text = text;
		stream.row.content = `${stream.label}\n${text}`;
		stream.row.details.body = text;
		stream.row.details.component?.setText(text);
		// This is a custom row, not an assistant frame. Omp's message_end
		// handler requests a repaint without touching the assistant slot.
		rootEvent({ type: "message_end", message: stream.row });
	}

	function finish(source, event) {
		const stream = streams.get(source);
		if (!stream) return false;
		streams.delete(source);
		if (source === ROOT) {
			const end = event ?? (stream.last && { type: "message_end", message: stream.last });
			if (end) {
				const show = () => {
					if (!stream.live) rootEvent({ ...stream.start, message: end.message });
					rootEvent(end);
					for (const trailing of stream.trailing ?? []) rootEvent(trailing);
				};
				if (stream.live) show();
				else block(show);
			}
		} else {
			const text = assistantText(event?.message ?? stream.last);
			if (stream.live && stream.row !== null) updateLive(stream, text);
			else if (stream.live && text) row(stream.label, text);
			else if (text) block(() => row(stream.label, text));
		}
		if (owner === source) {
			owner = null;
			flush();
		}
		return true;
	}

	function accept(source, label, event) {
		const root = source === ROOT;
		const { type, message } = event;
		if (message?.role === "assistant") {
			if (type === "message_start") {
				finish(source);
				const live = owner === null;
				if (live) owner = source;
				const stream = { label, live, start: event, last: message, row: null, text: "" };
				streams.set(source, stream);
				if (root && live) rootEvent(event);
				return;
			}
			const stream = streams.get(source);
			if (type === "message_update" && stream) {
				stream.last = message;
				if (stream.live) {
					if (root) rootEvent(event);
					else {
						const text = assistantText(message);
						if (stream.row === null && text) {
							stream.row = row(label, text);
							stream.text = text;
						} else updateLive(stream, text);
					}
				}
				return;
			}
			if (type === "message_end" && finish(source, event)) return;
		}
		if (type === "agent_end" || type === "agent_pause") finish(source);
		if (root) {
			if (type === "message_end" && message?.role === "assistant") {
				block(() => {
					rootEvent({ type: "message_start", message });
					rootEvent(event);
				});
				return;
			}
			// Once a root reply is deferred, its tool events and end must also
			// follow that complete frame, never arrive ahead of it.
			if (owner === ROOT) rootEvent(event);
			else {
				const deferred = streams.get(ROOT);
				if (deferred && type.startsWith("tool_")) (deferred.trailing ??= []).push(event);
				else block(() => rootEvent(event));
			}
		} else {
			const text = activityOf(event);
			if (text) block(() => row(label, text, type.startsWith("tool_") ? event : null));
		}
	}
	return { accept, finish };
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
	const binding = { manager, sessionId, ui, port: null };
	state.display = binding;
	const current = () => state.display === binding && !root.isSessionTransitioning && root.sessionManager === manager && manager?.getSessionId?.() === sessionId;
	let lastOwnerId = "root";
	let rootWaits = 0;
	const arbiter = displayArbiter(state);
	state.route = (event) => {
		if (current()) arbiter.accept(ROOT, "Root", event);
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
				if (current()) arbiter.accept(child, id, event);
			});
			return () => {
				unsubscribe();
				if (current()) arbiter.finish(child);
			};
		},
	};
}
