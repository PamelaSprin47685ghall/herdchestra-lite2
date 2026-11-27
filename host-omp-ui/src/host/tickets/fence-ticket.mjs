// The TUI fence ticket: everything the web surface installs into another
// extension's terminal. Waiting, dynamic loading and graceful degradation live
// here; the decisions they answer live in `station/domain/fence-lifecycle.mjs`
// and the wiring that calls them lives in `activation/index.mjs`.

import {
	applyCapture,
	editorSlotDecision,
} from "../../station/domain/fence-lifecycle.mjs";
import {
	captureHostFromEditorSlot,
	createBridgeEditorClass,
	decorateUiContext,
	getRealCustomEditor,
	subscribeComposerCapture,
} from "../tui-fence.mjs";

function noteFenceError(runtimeRef, record, domain, error) {
	runtimeRef.fence?.moduleErrors.push(error instanceof Error ? error.message : String(error));
	record?.(domain, error);
}

/**
 * Install the fence a live TUI session needs, in the one order that works.
 *
 * Capture subscribes first: the editor slot must be observed before we install
 * our own editor, because omp invokes a factory synchronously and a later
 * wrapper never sees it. The editor, the UI context decoration and the capture
 * probe follow, each behind its own boundary so one missing seam degrades to a
 * module error instead of losing the surface.
 */
export function mountTuiFence({
	ctx,
	modules,
	bridge,
	runtimeRef,
	station,
	record,
	isCurrent,
	ensureSurfaceWatcher,
}) {
	runtimeRef.unsubscribeCapture = subscribeComposerCapture((capture) => {
		if (!isCurrent() || runtimeRef.disposed) return;
		runtimeRef.capture = capture;
		capture?.editor?.setBridge?.(runtimeRef.bridge);
		applyCapture(runtimeRef.fence, capture);
		runtimeRef.station?.onMetaUpdate?.({ fence: runtimeRef.fence });
		void ensureSurfaceWatcher(runtimeRef).then(() => {
			if (!isCurrent() || runtimeRef.disposed || !runtimeRef.fence) return;
			runtimeRef.fence.surfaceWatcherActive = Boolean(runtimeRef.watcher);
			runtimeRef.station?.onMetaUpdate?.({ fence: runtimeRef.fence });
		}).catch((error) => record?.("capture-watcher", error));
	});

	try {
		captureHostFromEditorSlot(ctx.ui, bridge);
		const decision = editorSlotDecision({ ctx, base: modules?.CustomEditor ?? getRealCustomEditor() });
		if (decision.kind === "install") {
			const BridgeEditor = createBridgeEditorClass(modules?.CustomEditor ?? getRealCustomEditor());
			ctx.ui?.setEditorComponent?.(
				(tui, theme, keybindings) => new BridgeEditor(bridge, tui, theme, keybindings),
			);
			runtimeRef.fence.editorInstalled = true;
		} else {
			runtimeRef.fence.moduleErrors.push(decision.reason);
		}
	} catch (error) {
		noteFenceError(runtimeRef, record, "editor", error);
	}
	try {
		const decorated = decorateUiContext({ ui: ctx.ui, mode: ctx.mode, isSubagent: false, bridge });
		runtimeRef.uiDecoration = decorated;
		runtimeRef.fence.uiDecorated = Boolean(decorated?.ok);
	} catch (error) {
		noteFenceError(runtimeRef, record, "decorate-ui", error);
	}
	try {
		const captured = captureHostFromEditorSlot(ctx.ui, bridge);
		applyCapture(runtimeRef.fence, captured.captured);
		if (!captured.captured?.composer && captured.captured?.tui) {
			const names = Object.getOwnPropertyNames(captured.captured.tui).slice(0, 30).join(",");
			runtimeRef.fence.moduleErrors.push(`tui-own:${names}`);
		}
		if (captured.error) runtimeRef.fence.moduleErrors.push(String(captured.error?.message ?? captured.error));
		runtimeRef.capture = captured.captured ?? runtimeRef.capture;
	} catch (error) {
		noteFenceError(runtimeRef, record, "capture-host", error);
	}
	station.onMetaUpdate?.({ fence: runtimeRef.fence });
}
