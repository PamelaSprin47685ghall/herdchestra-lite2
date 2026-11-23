import { describe, test, expect } from "bun:test";

// Red contract for host-omp-ui/src/host/tui-fence.mjs.
// Do not run Red. The module is expected to be implemented by the Green slice.
const MODULE = "../../host-omp-ui/src/host/tui-fence.mjs";

async function load() {
	try {
		return await import(MODULE);
	} catch (error) {
		throw new Error(`Red contract: ${MODULE} is not implemented yet (${error.message})`);
	}
}

function spy(impl = () => {}) {
	const calls = [];
	const fn = (...args) => {
		calls.push(args);
		return impl(...args);
	};
	fn.calls = calls;
	fn.called = () => calls.length > 0;
	return fn;
}

function makeUiTarget() {
	return {
		select: async () => "native-select",
		confirm: async () => true,
		input: async () => "native-input",
		editor: async () => "native-editor",
		askDialog: async () => ({ answers: [] }),
		formDialog: async () => ({ data: { native: "1" } }),
		approve: async () => "once",
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		setTitle: () => {},
		setWorkingMessage: () => {},
	};
}

// trackUserWaits exposes only a get trap; defineProperty must reach the target.
function trackedProxy(target) {
	return new Proxy(target, {
		get(t, key) {
			return t[key];
		},
	});
}

class FakeComposer {
	constructor(tui, editor) {
		this.ui = tui;
		this.editor = editor;
	}
	renderFrame(_viewport) {
		return { viewport: [] };
	}
	setEditor(editor) {
		this.editor = editor;
	}
}

describe("loadTuiModules", () => {
	test("keeps pi-tui deep imports literal so omp's extension loader can rewrite them", async () => {
		const source = await Bun.file(new URL(MODULE, import.meta.url)).text();
		for (const specifier of [
			"@oh-my-pi/pi-tui/prompt/composer",
			"@oh-my-pi/pi-tui/prompt/custom-editor",
			"@oh-my-pi/pi-tui/native/reconcile",
		]) {
			expect(source).toContain(`import("${specifier}")`);
		}
		// A computed specifier reaches the compiled omp resolver unrewritten and
		// fails with "Cannot find package".
		expect(source).not.toMatch(/import\(\s*specifier\s*\)/);
	});
});

describe("installComposerCapture", () => {
	test("captures an already-constructed composer on its next frame", async () => {
		const { installComposerCapture } = await load();
		const tui = { id: "tui" };
		const editor = { id: "editor" };
		const composer = new FakeComposer(tui, editor);
		const captures = [];

		installComposerCapture({
			ComposerClass: FakeComposer,
			onCaptured: (value) => captures.push(value),
		});

		composer.renderFrame({ cols: 80 });

		expect(captures).toHaveLength(1);
		expect(captures[0].composer).toBe(composer);
		expect(captures[0].tui).toBe(tui);
		expect(captures[0].editor).toBe(editor);
	});

	test("also captures through setEditor and is idempotent", async () => {
		const { installComposerCapture } = await load();
		const composer = new FakeComposer({ id: "tui" }, { id: "editor-1" });
		const captures = [];

		installComposerCapture({ ComposerClass: FakeComposer, onCaptured: (v) => captures.push(v) });
		installComposerCapture({ ComposerClass: FakeComposer, onCaptured: (v) => captures.push(v) });

		composer.setEditor({ id: "editor-2" });
		composer.renderFrame({ cols: 80 });

		expect(captures).toHaveLength(2);
		expect(captures[0].editor.id).toBe("editor-2");
		expect(captures[1].editor.id).toBe("editor-2");
	});

	test("notifies subscribers once per distinct host, not on every paint", async () => {
		const { installComposerCapture, subscribeComposerCapture } = await load();
		class QuietComposer extends FakeComposer {}
		const composer = new QuietComposer({ id: "tui-quiet" }, { id: "editor-quiet" });
		const seen = [];
		installComposerCapture({ ComposerClass: QuietComposer });
		const unsubscribe = subscribeComposerCapture((value) => seen.push(value));

		composer.renderFrame({ cols: 80 });
		composer.renderFrame({ cols: 80 });
		unsubscribe();
		composer.renderFrame({ cols: 80 });

		expect(seen).toHaveLength(1);
		expect(seen[0].composer).toBe(composer);
	});
});

describe("decorateUiContext", () => {
	test("dispose restores native methods without overwriting a newer wrapper", async () => {
		const { decorateUiContext } = await load();
		const ui = makeUiTarget();
		const original = ui.formDialog;
		const first = decorateUiContext({ ui, mode: "tui", bridge: {} });
		const second = decorateUiContext({ ui, mode: "tui", bridge: {} });
		const newer = ui.formDialog;
		first.dispose();
		expect(ui.formDialog).toBe(newer);
		second.dispose();
		expect(ui.formDialog).toBe(original);
	});
	test("defineProperty reaches a shared target through a get-only proxy", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		const first = trackedProxy(target);
		const second = trackedProxy(target);
		const original = second.formDialog;
		const bridge = {
			hasClient: () => false,
			request: async () => ({ data: { web: "1" } }),
			cancel: () => {},
		};

		decorateUiContext({ ui: first, mode: "tui", isSubagent: false, bridge });

		expect(second.formDialog).not.toBe(original);
		expect(Object.getOwnPropertyDescriptor(target, "formDialog").value).toBe(second.formDialog);
	});

	test("does not decorate outside tui mode or in subagents", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		const ui = trackedProxy(target);
		const original = ui.formDialog;
		const bridge = { hasClient: () => false, request: async () => ({}), cancel: () => {} };

		decorateUiContext({ ui, mode: "rpc", isSubagent: false, bridge });
		expect(ui.formDialog).toBe(original);

		decorateUiContext({ ui, mode: "tui", isSubagent: true, bridge });
		expect(ui.formDialog).toBe(original);
	});

	test("skips a non-writable, non-configurable descriptor without throwing", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		const original = target.formDialog;
		Object.defineProperty(target, "formDialog", {
			value: original,
			writable: false,
			configurable: false,
		});
		const ui = trackedProxy(target);
		const bridge = { hasClient: () => false, request: async () => ({}), cancel: () => {} };

		expect(() => decorateUiContext({ ui, mode: "tui", isSubagent: false, bridge })).not.toThrow();
		expect(ui.formDialog).toBe(original);
	});

	test("with no web client, formDialog calls the native method", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		const native = spy(async () => ({ data: { native: "1" } }));
		target.formDialog = native;
		const ui = trackedProxy(target);
		const bridge = { hasClient: () => false, request: async () => ({ data: { web: "1" } }), cancel: () => {} };

		decorateUiContext({ ui, mode: "tui", isSubagent: false, bridge });
		const result = await ui.formDialog("<form></form>", {});

		expect(result).toEqual({ data: { native: "1" } });
		expect(native.called()).toBe(true);
	});

	test("a web answer aborts the native formDialog signal and returns the web result", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		let nativeSignal;
		target.formDialog = (_html, options) =>
			new Promise((resolve) => {
				nativeSignal = options.signal;
				options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		const ui = trackedProxy(target);
		const bridge = {
			hasClient: () => true,
			request: async () => ({ data: { choice: "web" } }),
			cancel: () => {},
		};

		decorateUiContext({ ui, mode: "tui", isSubagent: false, bridge });
		const result = await ui.formDialog("<form></form>", {});

		expect(result).toEqual({ data: { choice: "web" } });
		expect(nativeSignal.aborted).toBe(true);
	});

	test("a web rejection keeps waiting for the native formDialog result", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		target.formDialog = async () => ({ data: { native: "1" } });
		const ui = trackedProxy(target);
		const bridge = {
			hasClient: () => true,
			request: async () => {
				throw new Error("web offline");
			},
			cancel: () => {},
		};

		decorateUiContext({ ui, mode: "tui", isSubagent: false, bridge });
		const result = await ui.formDialog("<form></form>", {});

		expect(result).toEqual({ data: { native: "1" } });
	});

	test("a native answer aborts only this web interaction and returns the native result", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		target.formDialog = async () => ({ data: { native: "1" } });
		const ui = trackedProxy(target);
		const pendingWeb = new Promise(() => {});
		let webSignal;
		const bridge = {
			hasClient: () => true,
			request: (_kind, _args, options) => {
				webSignal = options?.signal;
				return pendingWeb;
			},
			cancel: spy(),
		};

		decorateUiContext({ ui, mode: "tui", isSubagent: false, bridge });
		const result = await ui.formDialog("<form></form>", {});

		expect(result).toEqual({ data: { native: "1" } });
		expect(webSignal?.aborted).toBe(true);
		// A blanket cancel would reject a second dialog merely queued behind this one.
		expect(bridge.cancel.called()).toBe(false);
	});

	test("decorating twice reuses the original method instead of nesting wrappers", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		const native = spy(async () => "native-select");
		target.select = native;
		const ui = trackedProxy(target);
		const bridge = { hasClient: () => false, request: async () => ({}), cancel: () => {} };

		decorateUiContext({ ui, mode: "tui", isSubagent: false, bridge });
		decorateUiContext({ ui, mode: "tui", isSubagent: false, bridge });

		expect(await ui.select("pick", [], {})).toBe("native-select");
		expect(native.calls).toHaveLength(1);
	});

	test("approve participates in the same race and returns the web answer", async () => {
		const { decorateUiContext } = await load();
		const target = makeUiTarget();
		let nativeSignal;
		target.approve = (_request, options) =>
			new Promise((resolve) => {
				nativeSignal = options.signal;
				options.signal.addEventListener("abort", () => resolve("deny"), { once: true });
			});
		const ui = trackedProxy(target);
		const bridge = {
			hasClient: () => true,
			request: async () => "once",
			cancel: () => {},
		};

		decorateUiContext({ ui, mode: "tui", isSubagent: false, bridge });
		const result = await ui.approve({ toolName: "bash" }, {});

		expect(result).toBe("once");
		expect(nativeSignal.aborted).toBe(true);
	});
});

class FakeBaseEditor {
	constructor() {
		this.text = "";
		this.cursor = { line: 0, col: 0 };
		this.pendingImages = [];
		this.pendingTexts = [];
		this.onSubmit = null;
		this.onChange = null;
	}
	getText() {
		return this.text;
	}
	setText(text) {
		this.text = text;
	}
	getCursor() {
		return this.cursor;
	}
	handleInput(data) {
		this.text += data;
	}
	submit() {
		if (this.onSubmit) this.onSubmit(this.text);
	}
	setDraft(text) {
		this.text = text;
	}
	clearDraft() {
		this.text = "";
	}
	insertTextAttachment(content) {
		this.pendingTexts.push(content);
	}
	composerState() {
		return { running: false };
	}
}

describe("createBridgeEditorClass", () => {
	test("mirrors drafts and submits through the host onSubmit without overriding it", async () => {
		const { createBridgeEditorClass } = await load();
		const BridgeEditor = createBridgeEditorClass(FakeBaseEditor);
		const bridge = { draft: spy() };
		const editor = new BridgeEditor(bridge, {}, {}, {});
		const hostSubmit = spy();
		const hostChange = spy();

		editor.onSubmit = hostSubmit;
		editor.onChange = hostChange;
		editor.handleInput("a");

		expect(editor.getText()).toBe("a");
		expect(bridge.draft.called()).toBe(true);
		expect(bridge.draft.calls.at(-1)[0].text).toBe("a");
		expect(editor.onSubmit).toBe(hostSubmit);

		editor.submit();

		expect(hostSubmit.calls.at(-1)[0]).toBe("a");
		expect(editor.onChange).toBe(hostChange);
	});

	test("rebinding an existing editor sends drafts only to the new session bridge", async () => {
		const { createBridgeEditorClass } = await load();
		const BridgeEditor = createBridgeEditorClass(FakeBaseEditor);
		const oldBridge = { draft: spy() };
		const newBridge = { draft: spy() };
		const editor = new BridgeEditor(oldBridge, {}, {}, {});
		editor.setBridge(newBridge);
		editor.handleInput("new session");
		expect(oldBridge.draft.called()).toBe(false);
		expect(newBridge.draft.calls.at(-1)[0].text).toBe("new session");
	});

	test("applying a remote draft does not echo back to the bridge", async () => {
		const { createBridgeEditorClass } = await load();
		const BridgeEditor = createBridgeEditorClass(FakeBaseEditor);
		const bridge = { draft: spy() };
		const editor = new BridgeEditor(bridge, {}, {}, {});

		editor.applyRemoteDraft({ text: "from web", cursor: { line: 0, col: 8 }, rev: 2 });

		expect(editor.getText()).toBe("from web");
		expect(bridge.draft.called()).toBe(false);
	});

	test("a remote slash token is retyped through handleInput so autocomplete can trigger", async () => {
		const { createBridgeEditorClass } = await load();
		const typed = [];
		class RecordingEditor extends FakeBaseEditor {
			handleInput(data) {
				typed.push(data);
				super.handleInput(data);
			}
		}
		const BridgeEditor = createBridgeEditorClass(RecordingEditor);
		const bridge = { draft: spy() };
		const editor = new BridgeEditor(bridge, {}, {}, {});

		editor.applyRemoteDraft({ text: "/mo", rev: 3 });

		expect(editor.getText()).toBe("/mo");
		expect(typed).toEqual(["/", "m", "o"]);
		expect(bridge.draft.called()).toBe(false);
	});

	test("publishes the TUI handed to the editor factory", async () => {
		const { createBridgeEditorClass, getLastCapture } = await load();
		class TuiAwareEditor extends FakeBaseEditor {
			constructor(...args) {
				super();
				this.tui = args[0];
				this.tuiClass = args[0]?.constructor?.name;
			}
		}
		const BridgeEditor = createBridgeEditorClass(TuiAwareEditor);
		const tui = { constructor: { name: "FakeTui" } };
		const editor = new BridgeEditor({ draft: spy() }, tui, {}, {});

		expect(getLastCapture()?.tui).toBe(tui);
		expect(getLastCapture()?.editor).toBe(editor);
	});
});

describe("captureHostFromEditorSlot", () => {
	test("observes the next editor factory without replacing the installed one", async () => {
		const { captureHostFromEditorSlot, getLastCapture } = await load();
		let installed;
		let nativeCalls = 0;
		const ui = {
			setEditorComponent(factory) {
				nativeCalls += 1;
				installed = factory;
			},
			getEditorComponent() {
				return installed;
			},
		};
		const bridge = { draft: spy() };

		const result = captureHostFromEditorSlot(ui, bridge);
		expect(result.ok).toBe(true);
		// The destructive `setEditorComponent(() => undefined)` self-probe is gone.
		expect(nativeCalls).toBe(0);
		expect(installed).toBeUndefined();

		const tui = { id: "tui-slot", children: [] };
		const created = new FakeBaseEditor();
		let factoryTui;
		ui.setEditorComponent((t, _theme, _keybindings) => {
			factoryTui = t;
			return created;
		});
		const editor = installed(tui, {}, {});

		expect(editor).toBe(created);
		expect(factoryTui).toBe(tui);
		expect(getLastCapture()?.tui).toBe(tui);
		expect(getLastCapture()?.editor).toBe(created);

		created.handleInput("x");
		expect(bridge.draft.calls.at(-1)[0].text).toBe("x");
	});

	test("re-wraps for a new bridge without stacking factories", async () => {
		const { captureHostFromEditorSlot } = await load();
		let installed;
		const ui = {
			setEditorComponent(factory) {
				installed = factory;
			},
		};
		const firstBridge = { draft: spy() };
		const secondBridge = { draft: spy() };
		captureHostFromEditorSlot(ui, firstBridge);
		captureHostFromEditorSlot(ui, secondBridge);

		let factoryCalls = 0;
		ui.setEditorComponent(() => {
			factoryCalls += 1;
			return new FakeBaseEditor();
		});
		const tui = { children: [] };
		const editor = installed(tui, {}, {});
		expect(factoryCalls).toBe(1);

		editor.handleInput("y");
		expect(secondBridge.draft.calls.at(-1)[0].text).toBe("y");
		expect(firstBridge.draft.called()).toBe(false);
	});

	test("skips a missing or locked editor slot without throwing", async () => {
		const { captureHostFromEditorSlot } = await load();
		expect(captureHostFromEditorSlot(undefined, {})).toEqual({ ok: false });
		expect(captureHostFromEditorSlot({}, {})).toEqual({ ok: false });
		const target = {};
		Object.defineProperty(target, "setEditorComponent", {
			value: () => {},
			writable: false,
			configurable: false,
		});
		expect(() => captureHostFromEditorSlot(target, {})).not.toThrow();
	});
});

describe("attachSurfaceWatcher", () => {
	test("reconciles main, dock and visible overlays on paint and emits only non-empty frames", async () => {
		const { attachSurfaceWatcher } = await load();
		const listeners = new Set();
		const tui = {
			addPaintListener(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			overlayStack: [
				{ options: { hidden: false }, component: { id: "overlay-1" } },
				{ options: { hidden: true }, component: { id: "overlay-2" } },
			],
		};
		const composer = {
			describeSurface: () => ({ main: [{ kind: "text" }], dock: [] }),
		};
		class FakeReconciler {
			reconcile(regions) {
				this.regions = regions;
				return [{ op: "add", id: "n1" }];
			}
		}
		const frames = [];
		const watcher = attachSurfaceWatcher({
			tui,
			composer,
			ReconcilerClass: FakeReconciler,
			onFrame: (frame) => frames.push(frame),
		});

		for (const listener of listeners) listener();

		expect(frames).toHaveLength(1);
		expect(frames[0].ops).toHaveLength(1);
		expect(frames[0].overlays).toHaveLength(1);
		expect(frames[0].overlays[0].id).toBe("overlay-1");

		watcher.dispose();
		expect(listeners.size).toBe(0);
	});

	test("ships JSON-safe overlay summaries instead of live component graphs", async () => {
		const { attachSurfaceWatcher } = await load();
		const listeners = new Set();
		const tui = {
			addPaintListener(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			overlayStack: [
				{
					hidden: false,
					options: {},
					component: {
						id: "picker-1",
						debugKind: "picker",
						nativeOverlay: { head: "Choose a model" },
						children: [],
					},
				},
				{ hidden: true, options: {}, component: { id: "hidden-1" } },
				{ hidden: false, options: { visible: () => false }, component: { id: "narrow-only" } },
			],
		};
		const composer = { describeSurface: () => ({ main: [], dock: [] }) };
		class OneOpReconciler {
			reconcile() {
				return [{ op: "add", id: "n" }];
			}
		}
		const frames = [];
		const watcher = attachSurfaceWatcher({
			tui,
			composer,
			ReconcilerClass: OneOpReconciler,
			onFrame: (frame) => frames.push(frame),
		});

		for (const listener of listeners) listener();

		expect(frames).toHaveLength(1);
		expect(frames[0].overlays).toEqual([{ id: "picker-1", kind: "picker", title: "Choose a model" }]);
		expect(() => JSON.stringify(frames[0])).not.toThrow();
		expect(JSON.stringify(frames[0])).not.toContain("children");
		watcher.dispose();
	});

	test("does not emit when reconcile returns no ops", async () => {
		const { attachSurfaceWatcher } = await load();
		const listeners = new Set();
		const tui = {
			addPaintListener(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			overlayStack: [],
		};
		const composer = { describeSurface: () => ({ main: [], dock: [] }) };
		class EmptyReconciler {
			reconcile() {
				return [];
			}
		}
		const frames = [];
		attachSurfaceWatcher({
			tui,
			composer,
			ReconcilerClass: EmptyReconciler,
			onFrame: (frame) => frames.push(frame),
		});

		for (const listener of listeners) listener();
		expect(frames).toHaveLength(0);
	});
});

describe("routeSurfaceEvent", () => {
	test("routes send to the focused component and raw keys to injectDebugInput", async () => {
		const { routeSurfaceEvent } = await load();
		const handleNativeEvent = spy();
		const component = { handleNativeEvent };
		const reconciler = {
			target: () => ({ component, keypath: "line/input" }),
			focusTarget: () => "editor-1",
		};
		const injectDebugInput = spy();
		const tui = { injectDebugInput };

		routeSurfaceEvent({
			reconciler,
			tui,
			event: { ev: "send", id: "editor-1", text: "hello" },
		});

		expect(handleNativeEvent.calls.at(-1)[0]).toEqual({
			type: "send",
			key: "line/input",
			text: "hello",
		});

		routeSurfaceEvent({ reconciler, tui, event: { ev: "raw_keys", data: "\u001b[A" } });
		expect(injectDebugInput.calls.at(-1)[0]).toBe("\u001b[A");
	});

	test("reports unavailable raw input instead of claiming success", async () => {
		const { routeSurfaceEvent } = await load();
		expect(routeSurfaceEvent({ event: { ev: "raw_keys", data: "x" } }).ok).toBe(false);
	});

	test("does not deliver send when focusTarget does not match the event id", async () => {
		const { routeSurfaceEvent } = await load();
		const handleNativeEvent = spy();
		const reconciler = {
			target: () => ({ component: { handleNativeEvent }, keypath: "line/input" }),
			focusTarget: () => "other-editor",
		};
		const tui = { injectDebugInput: spy() };

		routeSurfaceEvent({ reconciler, tui, event: { ev: "send", id: "editor-1", text: "hello" } });
		expect(handleNativeEvent.called()).toBe(false);
	});

	test("rebuilds the NativeUiEvent shapes omp's components actually handle", async () => {
		const { routeSurfaceEvent } = await load();
		const handleNativeEvent = spy();
		const reconciler = {
			target: () => ({ component: { handleNativeEvent }, keypath: "list" }),
			focusTarget: () => "list",
			itemKey: (id) => `key:${id}`,
		};
		const last = () => handleNativeEvent.calls.at(-1)[0];

		routeSurfaceEvent({ reconciler, event: { ev: "select", id: "list", item: "list/2" } });
		expect(last()).toEqual({ type: "select", key: "list", item: "key:list/2" });

		routeSurfaceEvent({ reconciler, event: { ev: "select", id: "list" } });
		expect(last()).toEqual({ type: "select", key: "list", item: "key:list" });

		routeSurfaceEvent({ reconciler, event: { ev: "toggle", id: "list", collapsed: true } });
		expect(last()).toEqual({ type: "toggle", key: "list", collapsed: true });

		routeSurfaceEvent({
			reconciler,
			event: { ev: "action", id: "list", act: "menu.pick", value: "m1", mods: ["shift"], checked: true },
		});
		expect(last()).toEqual({
			type: "action",
			key: "list",
			act: "menu.pick",
			value: "m1",
			mods: ["shift"],
		});

		routeSurfaceEvent({ reconciler, event: { ev: "change", id: "list", item: "list/1", value: "new" } });
		expect(last()).toEqual({ type: "change", key: "list", item: "key:list/1", value: "new" });

		routeSurfaceEvent({ reconciler, event: { ev: "change", id: "list", text: "full source" } });
		expect(last()).toEqual({ type: "docChange", key: "list", text: "full source" });

		routeSurfaceEvent({
			reconciler,
			event: { ev: "edit", id: "list", from: 1, to: 2, text: "x", cursor: 2, len: 9 },
		});
		expect(last()).toEqual({ type: "edit", key: "list", from: 1, to: 2, text: "x", cursor: 2, len: 9 });

	});

	test("native actions repaint the terminal and focus targets are validated", async () => {
		const { routeSurfaceEvent } = await load();
		const component = { handleInput() {}, handleNativeEvent: spy() };
		const tui = { requestRender: spy(), setFocus: spy() };
		const reconciler = { target: () => ({ component, keypath: "choice" }), owners: () => [component], focusTarget: () => "choice" };
		expect(routeSurfaceEvent({ reconciler, tui, event: { ev: "focus", id: "choice" } }).ok).toBe(true);
		expect(tui.setFocus.calls[0][0]).toBe(component);
		routeSurfaceEvent({ reconciler, tui, event: { ev: "action", id: "choice", act: "choose" } });
		expect(tui.requestRender.called()).toBe(true);
		expect(routeSurfaceEvent({ reconciler, tui, event: { ev: "focus", id: "stale" } }).ok).toBe(false);
	});
});
