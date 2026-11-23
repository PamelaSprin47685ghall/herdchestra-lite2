// The TUI fence. omp constructs its startup Composer before extension factories
// run, so setFrameProvider is already spent; renderFrame is the first prototype
// method the live instance still calls, and patching it captures the real
// Composer for every later frame. All deep imports stay dynamic so a missing
// package degrades only the web surface, never omp startup.
//
// The capture, editor, and watcher seams live in ./fence/*.mjs; this file is
// the stable extension-facing surface plus the loader whose literal specifiers
// omp's extension loader rewrites.
export {
	getLastCapture,
	subscribeComposerCapture,
	installComposerCapture,
	decorateUiContext,
} from "./fence/capture.mjs";
export {
	setRealCustomEditor,
	getRealCustomEditor,
	createBridgeEditorClass,
	captureCompletionState,
	captureHostFromEditorSlot,
} from "./fence/editor.mjs";
export {
	attachSurfaceWatcher,
	routeSurfaceEvent,
	FallbackReconciler,
} from "./fence/watcher.mjs";

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
