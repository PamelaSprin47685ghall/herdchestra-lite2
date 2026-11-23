import { getLastCapture, subscribeComposerCapture } from "./capture.mjs";

export function attachSurfaceWatcher({ tui, composer, ReconcilerClass, onFrame, context } = {}) {
	const Reconciler = typeof ReconcilerClass === "function" ? ReconcilerClass : FallbackReconciler;
	let reconciler;
	try {
		reconciler = new Reconciler("s:web");
	} catch {
		// A broken deep import must not take the terminal down with it.
		reconciler = new FallbackReconciler("s:web");
	}
	let boundTui = tui ?? null;
	let boundComposer = composer ?? null;
	let unsubscribePaint = null;
	let unsubscribeCapture = null;
	let paintBound = false;
	let pendingTick = false;
	let sequence = 0;
	let disposed = false;
	let lastOverlayKey = "";

	const makeContext = () => {
		if (context) return context;
		const columns = Number(boundTui?.terminal?.columns);
		const rows = Number(boundTui?.terminal?.rows);
		return {
			cols: Number.isFinite(columns) && columns > 0 ? columns : 120,
			rows: Number.isFinite(rows) && rows > 0 ? rows : 40,
			dark: boundTui?.terminal?.appearance !== "light",
			reduceMotion: false,
			supports: () => true,
			// `scroll` would ask the web renderer to scroll a document it owns; keep
			// the frame vocabulary minimal since the SPA is not a terminal.
			feature: () => false,
		};
	};

	const visibleOverlays = (cx) => {
		const entries = boundTui?.overlayStack ?? [];
		const visible = [];
		for (const [index, entry] of entries.entries()) {
			if (!entry || entry.hidden || entry.options?.hidden) continue;
			if (typeof entry.options?.visible === "function") {
				try {
					if (!entry.options.visible(cx.cols, cx.rows ?? 40)) continue;
				} catch {
					// A broken visibility predicate must not hide the live surface.
				}
			}
			if (!entry.component) continue;
			visible.push({ entry, index });
		}
		return visible;
	};

	// Overlay summaries cross a JSON boundary. The components themselves must
	// never leave the process: they hold TUI/theme graphs and JSON.stringify
	// either throws on cycles or ships megabytes to the browser.
	const summarizeOverlays = (visible) => {
		const seen = new Set();
		return visible.map(({ entry, index }) => {
			const component = entry.component;
			const baseId =
				(typeof component.debugId === "string" && component.debugId) ||
				(typeof component.id === "string" && component.id) ||
				`overlay-${index}`;
			let id = baseId;
			for (let suffix = 2; seen.has(id); suffix++) id = `${baseId}#${suffix}`;
			seen.add(id);
			const head = component.nativeOverlay?.head;
			const title = typeof head === "string" ? head : undefined;
			const kind = component.debugKind ?? component.constructor?.name ?? "component";
			return { id, kind, ...(title ? { title } : {}) };
		});
	};

	const tick = () => {
		if (disposed) return;
		const latest = getLastCapture();
		const composerNow =
			boundComposer ?? (latest?.tui === boundTui || !boundTui ? latest?.composer ?? null : null);
		if (composerNow?.started === false) return;
		try {
			const cx = makeContext();
			const surface = composerNow?.describeSurface ? composerNow.describeSurface(cx) : { main: [], dock: [] };
			const visible = visibleOverlays(cx);
			const overlays = summarizeOverlays(visible);
			const ops = reconciler.reconcile(
				{
					main: surface.main ?? [],
					dock: surface.dock ?? [],
					layer: visible.map(({ entry }) => entry.component),
				},
				cx,
			);
			const overlayKey = overlays.map((item) => `${item.id}:${item.kind}:${item.title ?? ""}`).join("|");
			const overlaysChanged = overlayKey !== lastOverlayKey;
			if (ops.length > 0 || overlaysChanged) {
				lastOverlayKey = overlayKey;
				onFrame?.({ sf: reconciler.surface ?? reconciler.id ?? "s:web", s: ++sequence, ops, overlays });
			}
		} catch {
			// A malformed surface must not break the paint loop.
		}
	};

	const schedule = () => {
		if (disposed || pendingTick) return;
		pendingTick = true;
		queueMicrotask(() => {
			pendingTick = false;
			if (!disposed) tick();
		});
	};

	const bindPaint = (nextTui) => {
		if (!nextTui || typeof nextTui.addPaintListener !== "function") return false;
		// Already bound: every capture would otherwise schedule a redundant
		// microtask tick next to the paint listener's own tick.
		if (nextTui === boundTui && paintBound) return false;
		if (paintBound && typeof unsubscribePaint === "function") unsubscribePaint();
		paintBound = false;
		unsubscribePaint = null;
		try {
			const off = nextTui.addPaintListener(tick);
			unsubscribePaint = typeof off === "function" ? off : null;
		} catch {
			return false;
		}
		paintBound = true;
		boundTui = nextTui;
		return true;
	};

	try {
		bindPaint(boundTui);
	} catch {
		// A paint listener is an optimisation; the capture hook still ticks.
	}
	// The editor slot may publish the TUI before the composer's first frame.
	// Follow new captures instead of pinning the watcher to a half-built host.
	unsubscribeCapture = subscribeComposerCapture((capture) => {
		if (disposed || !capture) return;
		if (capture.composer && capture.composer !== boundComposer) {
			boundComposer = capture.composer;
			schedule();
		}
		if (capture.tui && bindPaint(capture.tui)) schedule();
	});
	if (!boundComposer) {
		// A watcher created after the composer's last capture would otherwise
		// wait for a change that may never come (deduplicated captures).
		const initial = getLastCapture();
		if (initial?.composer && (!boundTui || initial.tui === boundTui)) boundComposer = initial.composer;
	}
	if (boundComposer) schedule();

	return {
		reconciler,
		tick,
		dispose() {
			disposed = true;
			if (typeof unsubscribePaint === "function") unsubscribePaint();
			if (typeof unsubscribeCapture === "function") unsubscribeCapture();
		},
	};
}

/**
 * Route one TSP event to the component that described the node, using the
 * exact `NativeUiEvent` shapes omp's native backend uses. The previous generic
 * `{ type, key, value, checked, text }` payload silently dropped selects,
 * toggles, actions and document edits.
 */
export function routeSurfaceEvent({ reconciler, tui, event } = {}) {
	if (!event || typeof event !== "object") return { ok: false };
	if (event.ev === "raw_keys" || event.ev === "keys") {
		if (typeof event.data !== "string" || typeof tui?.injectDebugInput !== "function") return { ok: false };
		tui.injectDebugInput(event.data);
		// Arrow keys move the autocomplete selection inside the editor; that
		// path does not go through handleInput, so the mirrored completion
		// state must be re-read here or the web highlight never moves.
		const editor = getLastCapture()?.editor;
		editor?.__herdPushCompletion?.();
		clearTimeout(editor?.__herdCompletionTimer);
		if (editor) editor.__herdCompletionTimer = setTimeout(() => editor.__herdPushCompletion?.({ fresh: true }), 180);
		return { ok: true };
	}
	if (event.ev === "focus") {
		const owners = reconciler?.owners?.(event.id) ?? [];
		const component = owners.findLast((owner) => owner.handleInput && reconciler.focusTarget?.(owner) === event.id);
		if (!component || typeof tui?.setFocus !== "function") return { ok: false };
		tui.setFocus(component);
		tui.requestRender?.();
		return { ok: true };
	}
	const target = reconciler?.target?.(event.id);
	if (!target?.component || typeof target.component.handleNativeEvent !== "function") return { ok: false };
	const component = target.component;
	const key = target.keypath ?? "";
	const item = (id) => {
		const raw = typeof id === "string" ? id : event.id;
		if (raw.startsWith(`${event.id}/`) || raw.startsWith(`${event.id}.`) || !raw.includes(".")) {
			return reconciler?.itemKey ? reconciler.itemKey(raw) : raw;
		}
		return raw;
	};
	let ui;
	switch (event.ev) {
		case "toggle":
			ui = { type: "toggle", key, collapsed: Boolean(event.collapsed) };
			break;
		case "select":
			ui = { type: "select", key, item: item(event.item) };
			break;
		case "activate":
			ui = { type: "activate", key, item: item(event.item) };
			break;
		case "action":
			ui = {
				type: "action",
				key,
				act: String(event.act ?? ""),
				value: event.value,
				mods: Array.isArray(event.mods) ? event.mods : [],
			};
			break;
		case "change":
			if (typeof event.text === "string") {
				ui = { type: "docChange", key, text: event.text };
			} else {
				ui = { type: "change", key, item: item(event.item), value: event.value ?? null };
			}
			break;
		case "edit":
			ui = {
				type: "edit",
				key,
				from: Number(event.from ?? 0),
				to: Number(event.to ?? 0),
				text: String(event.text ?? ""),
				cursor: Number(event.cursor ?? 0),
				len: Number(event.len ?? 0),
			};
			break;
		case "undo":
			ui = { type: "undo", key };
			break;
		case "comment":
			ui =
				typeof event.comment === "string"
					? { type: "commentNote", key, comment: event.comment, note: String(event.note ?? "") }
					: {
							type: "comment",
							key,
							quote: String(event.quote ?? ""),
							at: Number(event.at ?? 0),
							note: String(event.note ?? ""),
						};
			break;
		case "uncomment":
			ui = { type: "uncomment", key, comment: String(event.comment ?? "") };
			break;
		case "send":
			if (typeof event.text !== "string") return { ok: false };
			if (reconciler.focusTarget?.(component) !== event.id) return { ok: false };
			ui = { type: "send", key, text: event.text };
			break;
		default:
			return { ok: false };
	}
	component.handleNativeEvent(ui);
	tui?.requestRender?.();
	return { ok: true };
}

export class FallbackReconciler {
	constructor(id = "s:web") {
		this.id = id;
	}

	reconcile(regions) {
		return [{ op: "set", id: "surface", props: { snapshot: describeValue(regions, "surface") } }];
	}

	target() {
		return null;
	}

	focusTarget() {
		return null;
	}
}

function describeValue(value, id, depth = 0, seen = new Set()) {
	if (value == null || typeof value !== "object") return { id, text: value == null ? "" : String(value) };
	if (depth > 6 || seen.has(value)) return { id, text: value.constructor?.name ?? "component" };
	seen.add(value);
	if (typeof value.describe === "function") {
		try {
			return describeValue(
				value.describe({ cols: 120, dark: true, reduceMotion: false, supports: () => true, feature: () => true }),
				id,
				depth + 1,
				seen,
			);
		} catch {
			return { id, text: value.constructor?.name ?? "component" };
		}
	}
	const children = Array.isArray(value.children) ? value.children : Array.isArray(value) ? value : [];
	return {
		id: typeof value.id === "string" ? value.id : id,
		text: typeof value.text === "string" ? value.text : typeof value.kind === "string" ? value.kind : "",
		props: { kind: value.kind ?? value.type ?? null },
		children: children.map((child, index) => describeValue(child, `${id}.${index}`, depth + 1, seen)),
	};
}
