import type { KeyboardEvent } from "react";
type IMEKeyboardEvent = KeyboardEvent<HTMLElement>;
export function isIMEComposing(event: IMEKeyboardEvent, isComposing = false): boolean {
  return isComposing || event.nativeEvent.isComposing || event.keyCode === 229;
}
export const COMPOSITION_CONFIRM_ENTER_MS = 50;
export function isCompositionConfirmEnter(event: IMEKeyboardEvent, compositionEndedAt: number, now = Date.now()): boolean {
  if (event.key !== "Enter" || event.shiftKey || isIMEComposing(event)) return false;
  const elapsed = now - compositionEndedAt;
  return elapsed >= 0 && elapsed < COMPOSITION_CONFIRM_ENTER_MS;
}
