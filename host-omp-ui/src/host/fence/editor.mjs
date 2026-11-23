import { findDescriber, getLastCapture, publishCapture } from "./capture.mjs";

let realCustomEditor = null;

export function setRealCustomEditor(CustomEditor) {
	realCustomEditor = CustomEditor ?? null;
}

export function getRealCustomEditor() {
	return realCustomEditor;
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
	// An empty remote draft must also leave slash mode. `setText` is silent and
	// never refreshes autocomplete, so the popup would stay open after the web
	// user deletes "/". Dismiss it through the same input path a TUI user uses.
	if (text === "" && typeof editor.handleInput === "function"
		&& typeof editor.isShowingAutocomplete === "function"
		&& editor.isShowingAutocomplete()) {
		editor.handleInput("\u001b");
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
			const canSetText = typeof super.setText === "function";
			const canSetDraft = typeof super.setDraft === "function";
			if (!canSetText && !canSetDraft) return false;
			this.__remote = true;
			try {
				// `this.handleInput` always exists on BridgeEditor, so the writer must
				// follow the base editor's actual capability, not the wrapper's shape.
				if (canSetText && typeof this.handleInput === "function") writeRemoteText(this, text);
				else if (canSetDraft) super.setDraft.call(this, text);
				else super.setText.call(this, text);
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
	return { ok: true, captured: getLastCapture() };
}
