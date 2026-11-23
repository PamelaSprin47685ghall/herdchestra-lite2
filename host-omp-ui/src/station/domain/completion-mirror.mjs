// Pure projection for the TUI editor's slash-completion mirror.
//
// The TUI owns the autocomplete state machine: matching, ordering and the
// selected key all live in its SelectList. host-omp only reads that state and
// the web only renders it. Keeping the normalization here makes the wire
// shape unit-testable without an editor.

const MAX_ITEMS = 50;

function text(value) {
  return typeof value === "string" ? value : "";
}

function optionalText(value) {
  return typeof value === "string" ? value : undefined;
}

export function normalizeCompletionItem(item) {
  return {
    value: text(item?.value),
    label: text(item?.label ?? item?.value),
    description: optionalText(item?.description),
    hint: optionalText(item?.hint),
    disabled: item?.disabled === true,
  };
}

export function normalizeCompletionState(input) {
  const items = Array.isArray(input?.items)
    ? input.items.slice(0, MAX_ITEMS).map(normalizeCompletionItem)
    : [];
  const selectedIndex = Number.isInteger(input?.selectedIndex) ? input.selectedIndex : -1;
  return {
    open: input?.open === true,
    prefix: text(input?.prefix),
    items,
    selectedIndex: selectedIndex >= 0 && selectedIndex < items.length ? selectedIndex : -1,
    enterAccepts: input?.enterAccepts === true,
  };
}

export function completionSignature(state) {
  return JSON.stringify(state);
}
