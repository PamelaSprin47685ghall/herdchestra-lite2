// All branches share one display lease; child rendering never enters the root AgentSession.
// Running tools live in a one-row-per-tool active area above the editor so an
// unsettled call (scope_join, scope_return, or any slow tool) never pins the
// transcript retirement frontier; finished tools append at full size.
import { record } from "./diagnostics.mjs";
import {
	stripToolCalls,
	textBlocks,
	toolSummaryText,
	formatFallbackLine,
	formatToolTarget,
	assistantParts,
	partsText,
	partsSignature,
} from "./activity.mjs";
import { createActivityStore, renderActiveToolTray, renderChildActivity } from "./activity-render.mjs";
import { createReactiveSignal, getHostTui } from "./tui-runtime.mjs";

export { renderChildActivity };

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
// One stable identity: the host detach only clears the slot it installed.
const SUPPRESS_APPROVAL_PREVIEW = () => Promise.resolve();

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

function createActiveToolTray(getUi, current, getTui) {
	const entries = new Map();
	const entriesSignal = createReactiveSignal(getTui(), []);
	let mounted = false;

	function entryKey(toolCallId, toolName) {
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

	function snapshot() {
		const list = [];
		for (const map of entries.values()) {
			for (const [key, entry] of map) {
				list.push({
					key,
					label: entry.label,
					toolCallId: entry.toolCallId,
					toolName: entry.toolName,
					target: formatToolTarget(entry.toolName, entry.args),
					partialText: entry.partialText,
				});
			}
		}
		return list;
	}

	function syncWidget() {
		const ui = getUi();
		if (!current() || typeof ui?.setWidget !== "function") return;
		const list = snapshot();
		if (list.length === 0) {
			entriesSignal.set([]);
			if (!mounted) return;
			mounted = false;
			try {
				ui.setWidget(ACTIVE_TOOLS_WIDGET_KEY, undefined);
			} catch (error) {
				record("fork", error, { phase: "child-display" });
			}
			return;
		}
		entriesSignal.set(list);
		const tui = getTui();
		if (typeof tui?.jsx === "function") {
			if (mounted) return;
			mounted = true;
			try {
				ui.setWidget(ACTIVE_TOOLS_WIDGET_KEY, () => renderActiveToolTray(entriesSignal, tui), { placement: "aboveEditor" });
			} catch (error) {
				mounted = false;
				record("fork", error, { phase: "child-display" });
			}
			return;
		}
		mounted = true;
		try {
			ui.setWidget(
				ACTIVE_TOOLS_WIDGET_KEY,
				list.map((item) => formatFallbackLine({
					label: item.label,
					toolName: item.toolName,
					partialText: item.partialText,
					startedAt: Date.now(),
				}, Date.now())),
				{ placement: "aboveEditor" },
			);
		} catch (error) {
			record("fork", error, { phase: "child-display" });
		}
	}

	return {
		start(source, label, _session, event) {
			const map = mapFor(source, true);
			const key = entryKey(event.toolCallId, event.toolName);
			map.set(key, {
				label,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialText: "",
			});
			syncWidget();
		},
		update(source, event) {
			const entry = mapFor(source)?.get(entryKey(event.toolCallId, event.toolName));
			if (!entry) return;
			const text = textBlocks(event.partialResult?.content, "text", "text").split("\n", 1)[0]?.trim() ?? "";
			if (text === entry.partialText) return;
			entry.partialText = text;
			syncWidget();
		},
		end(source, event) {
			const map = mapFor(source);
			const key = entryKey(event.toolCallId, event.toolName);
			const entry = map?.get(key) ?? null;
			if (entry) {
				map.delete(key);
				if (map.size === 0) entries.delete(source);
				syncWidget();
			}
			return entry;
		},
		clearSource(source) {
			if (!mapFor(source)) return;
			entries.delete(source);
			syncWidget();
		},
		get activeCount() {
			let count = 0;
			for (const map of entries.values()) count += map.size;
			return count;
		},
	};
}

const ROOT = Symbol("root");

function displayArbiter(state, tray, suppressApprovalPreview, getTui) {
	let owner = null;
	const queue = [];
	const streams = new Map();
	const rootEvent = (event) => publish(state, event);

	function row(label, text, tool = null, parts = null, live = false) {
		state.timestamp = Math.max(Date.now(), state.timestamp + 1);
		const store = tool ? null : createActivityStore(parts ?? (text ? [{ kind: "text", text }] : []), live, getTui());
		const message = {
			role: "custom", customType: CHILD_ACTIVITY_TYPE, attribution: "agent",
			content: label ? `${label}\n${text}` : text, display: true, excludeFromContext: true,
			timestamp: state.timestamp,
			details: { label, body: text, parts, tool, ...(store ? { store } : {}) },
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
		stream.row.details.store?.update(parts, true);
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
			const parts = assistantParts(event?.message ?? stream.last, event?.assistantMessageEvent);
			const text = partsText(parts);
			if (stream.live && stream.row) {
				if (parts.length > 0) {
					stream.row.content = `${stream.label}\n${text}`;
					stream.row.details.body = text;
					stream.row.details.parts = parts;
					stream.row.details.store?.update(parts, false);
				} else {
					stream.row.details.store?.update(stream.row.details.parts ?? [], false);
				}
			} else if (parts.length > 0 || text) {
				const show = () => row(stream.label, text, null, parts, false);
				if (stream.live) show();
				else block(show);
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
			const completed = {
				...event,
				args: active?.args ?? event.args,
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
						const parts = assistantParts(message, event.assistantMessageEvent);
						if (stream.row === null && parts.length > 0) {
							stream.row = row(label, partsText(parts), null, parts, true);
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
			const parts = assistantParts(message, event.assistantMessageEvent);
			if (parts.length > 0) block(() => row(label, partsText(parts), null, parts, false));
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

export function childDisplayFor(root, ui, options = {}) {
	if (!root) return null;
	const manager = root.sessionManager;
	const sessionId = manager?.getSessionId?.();
	const state = stateFor(root);
	if (state.display && state.display.manager === manager && state.display.sessionId === sessionId) {
		if (ui) state.display.ui = ui;
		if (options?.tui) state.display.tui = options.tui;
		return state.display.port;
	}
	releaseApprovalPreviewSuppression(state.display);
	const binding = {
		manager,
		sessionId,
		ui,
		tui: options?.tui ?? getHostTui(),
		port: null,
		approvalPreviewInstalled: false,
		approvalPreviewDetach: null,
	};
	state.display = binding;
	const current = () => state.display === binding && !root.isSessionTransitioning && root.sessionManager === manager && manager?.getSessionId?.() === sessionId;
	let lastOwnerId = "root";
	let rootWaits = 0;
	const tray = createActiveToolTray(() => binding.ui, current, () => binding.tui);
	const suppressApprovalPreview = () => installApprovalPreviewSuppression(root, binding);
	const arbiter = displayArbiter(state, tray, suppressApprovalPreview, () => binding.tui);
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
