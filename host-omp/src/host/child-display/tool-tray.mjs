// The active-tool tray: one row per unsettled tool call, above the editor.
//
// A slow call (scope_join, scope_return, any long tool) must not pin the
// transcript retirement frontier, so it lives here until it settles and then
// appends at full size. The tray owns its own widget lifecycle, its own card
// cache and its own clock; the display arbiter only asks it to start, update,
// end or clear. The host's widget key and card component are supplied by the
// caller: this module owns the tray, not the host's naming or the class.

import { record } from "../diagnostics.mjs";

import { formatFallbackLine, textBlocks } from "../activity.mjs";

const noopRepaint = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };

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

export { isBuiltInTool, resolveCwd, resolveTool };

function buildToolCard(Card, tool, tui) {
	const options = tool.builtIn === undefined ? {} : { useBuiltInRenderer: tool.builtIn };
	const card = new Card(tool.toolName, tool.args, options, tool.definition, tui ?? noopRepaint, tool.cwd, tool.toolCallId);
	card.setArgsComplete?.(tool.toolCallId);
	card.setExecutionStarted?.(tool.toolCallId);
	return card;
}

/**
 * Build the tray for one display binding.
 *
 * `options.widgetKey` names the host widget; `options.cardComponent` is read at
 * render time, so a component registered after this tray exists is still used.
 */
export function createActiveToolTray(getUi, current, options = {}) {
	const widgetKey = options.widgetKey ?? "herd-tools";
	const cardComponent = options.cardComponent ?? (() => null);
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
		const Card = cardComponent();
		if (entry.card || !Card || !hostTui) return entry.card;
		const card = buildToolCard(Card, entry, hostTui);
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
				ui.setWidget(widgetKey, undefined);
			} catch (error) {
				record("fork", error, { phase: "child-display" });
			}
			return;
		}
		if (!mounted) {
			mounted = true;
			try {
				ui.setWidget(widgetKey, buildWidget, { placement: "aboveEditor" });
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
