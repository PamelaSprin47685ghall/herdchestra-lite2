// Pure TUI fence decisions: which surface needs a fence, and who owns the
// editor slot. The answers are values, so the activation layer can stay a
// composition root and every decision is testable without a terminal.
//
// No imports: this module is a value function over a context shape, and the
// station domain must stay free of host and transport dependencies.

/** A main interactive TUI session is the only surface that carries a fence. */
export function isTuiSurface(ctx) {
	return Boolean(ctx) && ctx.mode === "tui" && Boolean(ctx.hasUI) && ctx.agent?.kind !== "sub";
}

/**
 * Who owns the editor slot.
 *
 * omp calls an editor factory synchronously at the moment another extension
 * installs it, so a wrapper installed after the fact never sees the editor and
 * never attaches its completion observer. Reading the slot first is therefore
 * part of the decision, not an implementation detail: an owned slot is left
 * alone, a free slot is ours to fill.
 */
export function editorSlotDecision({ ctx, base }) {
	if (!base) return { kind: "unavailable", reason: "custom-editor-unavailable" };
	const owned = ctx?.ui?.getEditorComponent?.();
	if (owned) return { kind: "owned", reason: "editor-slot-owned" };
	return { kind: "install", reason: null };
}

/** The empty fence record a fresh runtime starts from. */
export function initialFence(modules) {
	return {
		composerCaptured: false,
		tuiCaptured: false,
		editorInstalled: false,
		uiDecorated: false,
		surfaceWatcherActive: false,
		moduleErrors: modules?.errors ?? ["tui-modules-unavailable"],
	};
}

/** Fold a fresh capture into the fence record. Returns the same object. */
export function applyCapture(fence, captured) {
	if (!fence) return fence;
	fence.composerCaptured = Boolean(captured?.composer);
	fence.tuiCaptured = Boolean(captured?.tui);
	fence.editorInstalled = fence.editorInstalled || Boolean(captured?.editorBound || captured?.editor);
	return fence;
}
