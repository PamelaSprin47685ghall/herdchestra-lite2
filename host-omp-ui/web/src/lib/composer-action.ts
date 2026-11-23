export type ComposerAction = "send" | "steer" | "stop" | "disabled";

/**
 * The footer has exactly one primary action.
 * - running with text/attachments -> steer
 * - running without text -> stop
 * - idle with text -> send
 * - idle without text -> disabled
 */
export function resolveComposerSubmit(input: {
  working: boolean;
  hasContent: boolean;
}): ComposerAction {
  if (input.working) return input.hasContent ? "steer" : "stop";
  return input.hasContent ? "send" : "disabled";
}
