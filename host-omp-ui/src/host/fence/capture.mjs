// The TUI fence captures the live Composer and decorates the host UI methods.
// omp constructs its startup Composer before extension factories run, so
// setFrameProvider is already spent; renderFrame is the first prototype method
// the live instance still calls, and patching it captures the real Composer for
// every later frame.
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
const captureListeners = new Set();

export function getLastCapture() {
	return lastCapture;
}

export function subscribeComposerCapture(listener) {
	captureListeners.add(listener);
	return () => captureListeners.delete(listener);
}

export function publishCapture(value) {
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

export function findDescriber(node, seen = new Set(), depth = 0) {
	if (!node || typeof node !== "object" || seen.has(node) || depth > 5) return null;
	seen.add(node);
	if (typeof node.describeSurface === "function") return node;
	for (const child of node.children ?? []) {
		const found = findDescriber(child, seen, depth + 1);
		if (found) return found;
	}
	return null;
}
