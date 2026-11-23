// The TUI fence. omp constructs its startup Composer before extension factories
// run, so setFrameProvider is already spent; renderFrame is the first prototype
// method the live instance still calls, and patching it captures the real
// Composer for every later frame. All deep imports stay dynamic so a missing
// package degrades only the web surface, never omp startup.
const CAPTURE = Symbol.for("herd.omp.ui.composerCapture");
const DIALOG_OPTION_INDEX = {
	select: 2,
	confirm: 2,
	input: 2,
	editor: 2,
	askDialog: 1,
	formDialog: 1,
	approve: 1,
};
const ONE_WAY = ["notify", "setStatus", "setWidget", "setTitle", "setWorkingMessage"];

let lastCapture = null;
let lastNotified = null;
let realCustomEditor = null;
const captureListeners = new Set();

export function getLastCapture() {
	return lastCapture;
}

export function setRealCustomEditor(CustomEditor) {
	realCustomEditor = CustomEditor ?? null;
}

export function getRealCustomEditor() {
	return realCustomEditor;
}

export function subscribeComposerCapture(listener) {
	captureListeners.add(listener);
	return () => captureListeners.delete(listener);
}

function publishCapture(value) {
	lastCapture = value;
	const changed =
		lastNotified?.composer !== value?.composer ||
		lastNotified?.tui !== value?.tui ||
		lastNotified?.editor !== value?.editor;
	if (changed) {
		lastNotified = value;
		for (const listener of captureListeners) {
			try {
				listener(value);
			} catch {
				// A listener must not break the render path.
			}
		}
	}
	try {
		const state = value?.composer?.constructor?.prototype?.[CAPTURE];
		state?.callback?.(value);
	} catch {
		// An onCaptured hook must not break the render path either.
	}
}

export function installComposerCapture({ ComposerClass, onCaptured } = {}) {
	if (!ComposerClass?.prototype) return { installed: false };
	const proto = ComposerClass.prototype;
	let state = proto[CAPTURE];
	if (!state) {
		state = { callback: undefined, installed: true };
		Object.defineProperty(proto, CAPTURE, { value: state, configurable: true });
		const originalRender = proto.renderFrame;
		const originalSetEditor = proto.setEditor;
		proto.renderFrame = function (...args) {
			const result = originalRender?.apply(this, args);
			publishCapture({ composer: this, tui: this.ui, editor: this.editor });
			return result;
		};
		if (typeof originalSetEditor === "function") {
			proto.setEditor = function (...args) {
				const result = originalSetEditor.apply(this, args);
				publishCapture({ composer: this, tui: this.ui, editor: this.editor });
				return result;
			};
		}
	}
	state.callback = onCaptured;
	return {
		installed: true,
		uninstall() {
			state.callback = undefined;
		},
	};
}

const DIALOG_WRAPPER = Symbol.for("herd.omp.ui.dialogWrapper");
const ONE_WAY_WRAPPER = Symbol.for("herd.omp.ui.oneWayWrapper");

function combineSignal(...signals) {
	const present = signals.filter(Boolean);
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	return AbortSignal.any(present);
}

/**
 * Race the TUI dialog against the web one. Only the loser is aborted: the
 * native caller gets an abort signal combined with the original one, while the
 * web request gets its own signal. Cancelling every pending interaction (as a
 * blanket `bridge.cancel()` would) breaks a second dialog that is merely
 * queued behind this one.
 */
function wrapDialog(name, optionIndex, native, bridge) {
	return async function herdDialog(...args) {
		if (!bridge?.hasClient?.()) return native.apply(this, args);
		const options = args[optionIndex];
		if (options?.signal?.aborted) return native.apply(this, args);
		const nativeAbort = new AbortController();
		const webAbort = new AbortController();
		const nativeArgs = args.slice();
		nativeArgs[optionIndex] = {
			...(options ?? {}),
			signal: combineSignal(options?.signal, nativeAbort.signal),
		};
		const nativePromise = Promise.resolve()
			.then(() => native.apply(this, nativeArgs))
			.then(
				(value) => ({ source: "native", ok: true, value }),
				(error) => ({ source: "native", ok: false, error }),
			);
		const webPromise = Promise.resolve()
			.then(() => bridge.request(name, args, { signal: combineSignal(options?.signal, webAbort.signal) }))
			.then(
				(value) => ({ source: "web", ok: true, value }),
				(error) => ({ source: "web", ok: false, error }),
			);
		const first = await Promise.race([nativePromise, webPromise]);
		if (first.ok) {
			if (first.source === "web") nativeAbort.abort();
			else webAbort.abort();
			return first.value;
		}
		const second = await (first.source === "web" ? nativePromise : webPromise);
		if (second.ok) {
			if (second.source === "web") nativeAbort.abort();
			else webAbort.abort();
			return second.value;
		}
		nativeAbort.abort();
		webAbort.abort();
		throw first.error ?? second.error;
	};
}

function unwrap(value, marker) {
	return value?.[marker] ?? value;
}

export function decorateUiContext({ ui, mode, isSubagent, bridge } = {}) {
	if (!ui || mode !== "tui" || isSubagent) return { installed: false };
	const installed = [];
	const restores = [];
	for (const [name, optionIndex] of Object.entries(DIALOG_OPTION_INDEX)) {
		const descriptor = Object.getOwnPropertyDescriptor(ui, name);
		if (!descriptor || typeof descriptor.value !== "function") continue;
		if (!descriptor.writable && !descriptor.configurable) continue;
		const native = unwrap(descriptor.value, DIALOG_WRAPPER);
		const wrapped = wrapDialog(name, optionIndex, native, bridge);
		Object.defineProperty(wrapped, DIALOG_WRAPPER, { value: native });
		Object.defineProperty(ui, name, { ...descriptor, value: wrapped });
		restores.push(() => {
			if (Object.getOwnPropertyDescriptor(ui, name)?.value === wrapped) {
				Object.defineProperty(ui, name, { ...descriptor, value: native });
			}
		});
		installed.push(name);
	}
	for (const name of ONE_WAY) {
		const descriptor = Object.getOwnPropertyDescriptor(ui, name);
		if (!descriptor || typeof descriptor.value !== "function") continue;
		if (!descriptor.writable && !descriptor.configurable) continue;
		const native = unwrap(descriptor.value, ONE_WAY_WRAPPER);
		const wrapped = function herdOneWay(...args) {
			const result = native.apply(this, args);
			try {
				bridge?.mirror?.(name, args);
			} catch {
				// Mirroring is best-effort.
			}
			return result;
		};
		Object.defineProperty(wrapped, ONE_WAY_WRAPPER, { value: native });
		Object.defineProperty(ui, name, { ...descriptor, value: wrapped });
		restores.push(() => {
			if (Object.getOwnPropertyDescriptor(ui, name)?.value === wrapped) {
				Object.defineProperty(ui, name, { ...descriptor, value: native });
			}
		});
		installed.push(name);
	}
	return { installed, ok: true, dispose() { for (const restore of restores) restore(); } };
}

/**
 * A remote draft that is a bare slash token must reach the editor through its
 * input path. `setText` replaces the buffer silently and never refreshes the
 * autocomplete state machine, so the mirrored `/` would sit there without a
 * popup; retyping it makes the editor enter the same slash mode a TUI user
 * enters. Any other text keeps the atomic setText write.
 */
function writeRemoteText(editor, text) {
	const slashToken = /^\/(?!\/)\S*$/.test(text);
	if (slashToken && typeof editor.handleInput === "function" && typeof editor.setText === "function") {
		editor.setText("");
		for (const char of text) editor.handleInput(char);
		return;
	}
	editor.setText?.(text);
}

export function createBridgeEditorClass(BaseCustomEditor = class {}) {
	return class BridgeEditor extends BaseCustomEditor {
		constructor(bridge, ...rest) {
			super(...rest);
			this.__bridge = bridge;
			this.__remote = false;
			// CustomEditor captures the TUI passed by the factory convention. Publish
			// it immediately so the surface watcher can attach before the first paint
			// and so tickets have a real terminal handle.
			if (this.tui) {
				const previous = getLastCapture();
				publishCapture({
					composer: previous?.tui === this.tui ? previous.composer ?? null : null,
					tui: this.tui,
					editor: this,
				});
			}
		}

		setBridge(bridge) {
			this.__bridge = bridge;
		}

		__pushDraft() {
			if (this.__remote || !this.__bridge) return;
			try {
				this.__bridge.draft?.({
					text: this.getText?.() ?? "",
					cursor: this.getCursor?.() ?? { line: 0, col: 0 },
					images: this.pendingImages ?? [],
					texts: this.pendingTexts ?? [],
					composer: this.composerState?.() ?? {},
				});
			} catch {
				// Draft mirroring must never break editing.
			}
		}

		handleInput(data) {
			super.handleInput?.(data);
			this.__pushDraft();
		}

		setText(text, options) {
			super.setText?.(text, options);
			this.__pushDraft();
		}

		setDraft(text, images) {
			super.setDraft?.(text, images);
			this.__pushDraft();
		}

		clearDraft(historyText) {
			super.clearDraft?.(historyText);
			this.__pushDraft();
		}

		insertTextAttachment(content, expansion) {
			super.insertTextAttachment?.(content, expansion);
			this.__pushDraft();
		}

		submit() {
			this.__pushDraft();
			super.submit?.();
			// The editor resets its text before invoking the host's onSubmit. Mirror
			// that reset so a submitted terminal draft clears the web composer too.
			this.__pushDraft();
		}

		applyRemoteDraft({ text } = {}) {
			if (typeof text !== "string") return false;
			const write =
				typeof super.setText === "function"
					? super.setText
					: typeof super.setDraft === "function"
						? super.setDraft
						: null;
			if (!write) return false;
			this.__remote = true;
			try {
				if (typeof this.handleInput === "function") writeRemoteText(this, text);
				else write.call(this, text);
			} finally {
				this.__remote = false;
			}
			this.tui?.requestRender?.();
			this.bridge?.tui?.requestRender?.();
			if (typeof this.getText === "function") return this.getText() === text;
			return true;
		}

		submitRemote(text) {
			if (typeof text === "string" && this.getText?.() !== text) {
				this.__remote = true;
				try {
					super.setText?.(text);
				} finally {
					this.__remote = false;
				}
			}
			super.submit?.();
			// The host editor resets on submit; let the terminal mirror the empty
			// draft so the web composer does not keep the submitted prompt.
			this.__pushDraft();
		}
	};
}

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
		const editor = lastCapture?.editor;
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


function findDescriber(node, seen = new Set(), depth = 0) {
	if (!node || typeof node !== "object" || seen.has(node) || depth > 5) return null;
	seen.add(node);
	if (typeof node.describeSurface === "function") return node;
	for (const child of node.children ?? []) {
		const found = findDescriber(child, seen, depth + 1);
		if (found) return found;
	}
	return null;
}

const COMPLETION_THROTTLE_MS = 80;

/**
 * Mirror the host editor's autocomplete state. The TUI owns the slash
 * completion state machine; the web must never reimplement its matching or
 * selection rules. `pickerView()` is the native picker projection of the live
 * SelectList, so both sides read the same filtered items and selected key.
 *
 * `enterAccepts` is best-effort: `descriptionMatch` lives on the private
 * autocomplete item, not on the SelectItem that pickerView exposes. The web
 * still forwards Enter to the TUI, so the host applies the real decision.
 */
export function captureCompletionState(editor) {
	if (!editor) return null;
	const open = typeof editor.isShowingAutocomplete === "function"
		? editor.isShowingAutocomplete() === true
		: false;
	if (!open) return { open: false, prefix: "", items: [], selectedIndex: -1, enterAccepts: false };
	const children = Array.isArray(editor.debugChildren) ? editor.debugChildren : [];
	const list = children.find((child) => child && typeof child.pickerView === "function");
	if (!list) return { open: true, prefix: "", items: [], selectedIndex: -1, enterAccepts: false };
	let view;
	try {
		view = list.pickerView();
	} catch {
		return null;
	}
	const rawItems = Array.isArray(view?.items) ? view.items : [];
	const items = rawItems.slice(0, 50).map((item) => ({
		value: String(item?.value ?? ""),
		label: String(item?.label ?? item?.value ?? ""),
		description: typeof item?.description === "string" ? item.description : undefined,
		hint: typeof item?.hint === "string" ? item.hint : undefined,
		disabled: item?.disabled === true,
	}));
	const selected = typeof view?.selected === "string" ? view.selected : null;
	const selectedIndex = selected == null ? -1 : items.findIndex((item) => item.value === selected);
	return {
		open: true,
		prefix: typeof view?.query === "string" ? view.query : "",
		items,
		selectedIndex,
		enterAccepts: true,
	};
}

const COMPLETION_OBSERVER = Symbol.for("herd.omp.ui.completionObserver");

/**
 * Mirror the editor's autocomplete state. This observer is separate from
 * draft mirroring because our own BridgeEditor already has `__bridge` and
 * therefore never enters `bindLiveEditor`; without this, remote drafts can
 * open the TUI slash popup while the web side never hears about it.
 */
function bindCompletionObserver(editor, bridge, tui) {
	if (!editor) return false;
	if (tui) editor.__herdTui = tui;
	editor.__herdBridge = bridge;
	if (editor[COMPLETION_OBSERVER]) return true;
	editor[COMPLETION_OBSERVER] = true;
	let lastAt = 0;
	const push = ({ fresh = false } = {}) => {
		const now = Date.now();
		if (!fresh && now - lastAt < COMPLETION_THROTTLE_MS) return;
		lastAt = now;
		const completion = captureCompletionState(editor);
		if (!completion) return;
		try {
			editor.__herdBridge?.completion?.(completion);
		} catch {
			// Completion mirroring must not break the live editor.
		}
	};
	editor.__herdPushCompletion = push;
	for (const name of ["handleInput", "insertTextAttachment", "setText", "setDraft", "clearDraft", "submit"]) {
		const original = editor[name];
		if (typeof original !== "function") continue;
		editor[name] = function (...args) {
			const result = original.apply(this, args);
			push();
			// Suggestions resolve asynchronously; re-read once the provider settled.
			clearTimeout(editor.__herdCompletionTimer);
			editor.__herdCompletionTimer = setTimeout(() => push({ fresh: true }), 180);
			return result;
		};
	}
	return true;
}

function bindLiveEditor(editor, bridge, tui) {
	if (!editor) return false;
	if (tui) editor.__herdTui = tui;
	if (editor.__herdBound) {
		editor.__herdBridge = bridge;
		bindCompletionObserver(editor, bridge, tui);
		return true;
	}
	editor.__herdBound = true;
	editor.__herdBridge = bridge;
	bindCompletionObserver(editor, bridge, tui);
	const push = () => {
		if (editor.__herdRemote) return;
		try {
			editor.__herdBridge?.draft?.({
				text: editor.getText?.() ?? "",
				cursor: editor.getCursor?.() ?? { line: 0, col: 0 },
				images: editor.pendingImages ?? [],
				texts: editor.pendingTexts ?? [],
				composer: editor.composerState?.() ?? {},
			});
		} catch {
			// Draft mirroring must not break the live editor.
		}
	};
	for (const name of ["handleInput", "insertTextAttachment", "setText", "setDraft", "clearDraft", "submit"]) {
		const original = editor[name];
		if (typeof original !== "function") continue;
		editor[name] = function (...args) {
			const result = original.apply(this, args);
			push();
			return result;
		};
	}
	editor.applyRemoteDraft = ({ text } = {}) => {
		if (typeof text !== "string") return false;
		if (typeof editor.setText !== "function" && typeof editor.setDraft !== "function") return false;
		// Two wrappers guard the same editor: this live binding uses __herdRemote,
		// BridgeEditor's own push checks __remote. Setting only one lets the other
		// wrapper echo the remote write straight back to the host.
		const previousHerdRemote = editor.__herdRemote;
		const previousRemote = editor.__remote;
		editor.__herdRemote = true;
		editor.__remote = true;
		try {
			writeRemoteText(editor, text);
		} finally {
			editor.__herdRemote = previousHerdRemote;
			editor.__remote = previousRemote;
		}
		editor.__herdPushCompletion?.({ fresh: true });
		if (typeof editor.getText === "function") return editor.getText() === text;
		(editor.__herdTui ?? editor.__herdBridge?.tui)?.requestRender?.();
		return true;
	};
	return true;
}

const EDITOR_SLOT = Symbol.for("herd.omp.ui.editorSlot");

/**
 * Observe the host's editor slot without ever touching it. omp's
 * `setEditorComponent(factory)` invokes the factory synchronously with the live
 * TUI and installs the returned editor; an earlier version called
 * `setEditorComponent(() => undefined)` here and replaced the extension's own
 * BridgeEditor with an empty proxy, which left the terminal editor inert.
 *
 * Later installs (another extension, a session rebuild) are observed and the
 * created editor is bound for draft mirroring, but the slot itself is never
 * mutated.
 */
export function captureHostFromEditorSlot(ui, bridge) {
	if (!ui) return { ok: false };
	const descriptor = Object.getOwnPropertyDescriptor(ui, "setEditorComponent");
	if (!descriptor || typeof descriptor.value !== "function" || (!descriptor.writable && !descriptor.configurable)) {
		return { ok: false };
	}
	// Keep a handle on the real method across sessions, but rebuild the wrapper
	// so a new bridge/runtime is observed instead of the first one forever.
	const native = descriptor.value[EDITOR_SLOT] ?? descriptor.value;
	const wrapped = function (factory) {
		const observed =
			typeof factory === "function"
				? function (tui, theme, keybindings) {
						const created = factory.call(this, tui, theme, keybindings);
						const editor = created ?? null;
						if (editor) bindCompletionObserver(editor, bridge, tui);
						if (editor && !editor.__bridge) bindLiveEditor(editor, bridge, tui);
						if (tui) {
							const composer =
								(getLastCapture()?.tui === tui ? getLastCapture()?.composer : null) ??
								findDescriber(tui) ??
								findDescriber(editor);
							publishCapture({ composer, tui, editor, editorBound: Boolean(editor) });
						}
						return created;
					}
				: factory;
		return native.call(this, observed);
	};
	if (native.calls) {
		wrapped.calls = native.calls;
		wrapped.called = native.called;
	}
	Object.defineProperty(wrapped, EDITOR_SLOT, { value: native });
	Object.defineProperty(ui, "setEditorComponent", { ...descriptor, value: wrapped });
	return { ok: true, captured: lastCapture };
}

function hostCodingAgent(pi) {
	try {
		return pi?.pi ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the TUI classes the fence needs.
 *
 * `pi.pi` is the host's own coding-agent barrel (the full `../index`, not the
 * legacy shim), so `Composer` and `CustomEditor` are the exact classes running
 * in this process. `Reconciler` is not re-exported there and must come from the
 * deep pi-tui module.
 *
 * omp's extension loader rewrites **literal** `import()` specifiers to the
 * host-bundled pi-tui modules. A computed specifier (`import(name)`) is
 * invisible to that rewrite and fails with "Cannot find package" inside a
 * compiled omp, so every deep import below stays a literal.
 */
export async function loadTuiModules(pi) {
	const errors = [];
	const host = hostCodingAgent(pi);
	const HostComposer = typeof host?.Composer === "function" ? host.Composer : null;
	const HostCustomEditor = typeof host?.CustomEditor === "function" ? host.CustomEditor : null;
	const load = async (specifier, importer) => {
		try {
			return { module: await importer(), error: null };
		} catch (error) {
			return { module: null, error: `${specifier}: ${error instanceof Error ? error.message : String(error)}` };
		}
	};
	const nothing = Promise.resolve({ module: null, error: null });
	const [composerImport, editorImport, reconcileImport] = await Promise.all([
		HostComposer
			? nothing
			: load("@oh-my-pi/pi-tui/prompt/composer", () => import("@oh-my-pi/pi-tui/prompt/composer")),
		HostCustomEditor
			? nothing
			: load("@oh-my-pi/pi-tui/prompt/custom-editor", () => import("@oh-my-pi/pi-tui/prompt/custom-editor")),
		load("@oh-my-pi/pi-tui/native/reconcile", () => import("@oh-my-pi/pi-tui/native/reconcile")),
	]);
	const Composer = HostComposer ?? composerImport.module?.Composer;
	const CustomEditor = HostCustomEditor ?? editorImport.module?.CustomEditor;
	const Reconciler = reconcileImport.module?.Reconciler;
	if (!Composer && composerImport.error) errors.push(composerImport.error);
	if (!CustomEditor && editorImport.error) errors.push(editorImport.error);
	if (!Reconciler && reconcileImport.error) errors.push(reconcileImport.error);
	return { Composer, CustomEditor, Reconciler, errors };
}
