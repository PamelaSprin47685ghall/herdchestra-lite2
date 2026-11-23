import { describe, expect, test } from "bun:test";
import {
  completionSignature,
  normalizeCompletionState,
} from "../../host-omp-ui/src/station/domain/completion-mirror.mjs";

describe("completion mirror", () => {
  test("keeps the editor's filtered order and selected key", () => {
    const state = normalizeCompletionState({
      open: true,
      prefix: "lo",
      items: [
        { value: "loop", label: "loop", description: "Repeat work", hint: "loop" },
        { value: "local", label: "local", disabled: true },
      ],
      selectedIndex: 0,
      enterAccepts: true,
    });
    expect(state.items.map((item) => item.value)).toEqual(["loop", "local"]);
    expect(state.items[0].description).toBe("Repeat work");
    expect(state.items[1].disabled).toBe(true);
    expect(state.selectedIndex).toBe(0);
    expect(state.enterAccepts).toBe(true);
  });

  test("closes with an empty mirror instead of stale candidates", () => {
    const state = normalizeCompletionState({ open: false });
    expect(state).toEqual({
      open: false,
      prefix: "",
      items: [],
      selectedIndex: -1,
      enterAccepts: false,
    });
  });

  test("drops an out-of-range selection and caps the list", () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      value: `item-${index}`,
      label: `Item ${index}`,
    }));
    const state = normalizeCompletionState({ open: true, items, selectedIndex: 79 });
    expect(state.items).toHaveLength(50);
    expect(state.selectedIndex).toBe(-1);
  });

  test("signature changes only when the projection changes", () => {
    const a = normalizeCompletionState({ open: true, prefix: "l", items: [{ value: "loop" }] });
    const b = normalizeCompletionState({ open: true, prefix: "l", items: [{ value: "loop" }] });
    const c = normalizeCompletionState({ open: true, prefix: "lo", items: [{ value: "loop" }] });
    expect(completionSignature(a)).toBe(completionSignature(b));
    expect(completionSignature(a)).not.toBe(completionSignature(c));
  });
});
