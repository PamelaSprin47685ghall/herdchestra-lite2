// The outbound frontier is the highest branch position the provider saw. The
// walk that computes it pairs each outbound entry with its position in one
// forward pass; `indexOf` reported the *first* occurrence of an entry, so the
// two answers differ exactly when a message object occurs twice in the branch.
// These tests pin the reference answer `indexOf` gave, on the cases where the
// fast walk would otherwise report a later position.

import { describe, expect, test } from "bun:test";

import { projectContext } from "../../../src/station/domain/context.mjs";
import { beatKey } from "../../../src/transcript/messages.mjs";

function referenceFrontier(original, messages) {
  let best = -1;
  for (const message of messages) {
    const at = original.indexOf(message);
    if (at > best) best = at;
  }
  return best >= 0 ? best + 1 : messages.length;
}

function frontierOf(original, amends = []) {
  const result = projectContext(
    { amends },
    { original, modelKey: "model" },
  );
  expect(result.usage.frontier).toBe(referenceFrontier(original, result.messages));
  return result.usage.frontier;
}

describe("projectContext frontier", () => {
  test("reports the position of the last entry actually sent", () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "a1", name: "read", arguments: {} }],
      timestamp: 1,
    };
    const result = { role: "toolResult", toolCallId: "a1", content: "out" };
    const keep = { role: "user", content: "keep", timestamp: 2 };
    const later = { role: "user", content: "later", timestamp: 3 };
    expect(frontierOf([call, result, keep, later], [beatKey(call)])).toBe(4);
  });

  test("a message object that occurs twice keeps its first position", () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "a1", name: "read", arguments: {} }],
      timestamp: 1,
    };
    const result = { role: "toolResult", toolCallId: "a1", content: "out" };
    const shared = { role: "user", content: "same object", timestamp: 2 };
    // The outbound list is [shared, shared]: both occurrences are sent, and
    // `indexOf` reported the first. The forward walk must not report the second.
    const original = [call, shared, result, shared];
    const frontier = frontierOf(original, [beatKey(call)]);
    expect(frontier).toBe(2);
  });

  test("a repeated primitive keeps its first position", () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "a1", name: "read", arguments: {} }],
      timestamp: 1,
    };
    const result = { role: "toolResult", toolCallId: "a1", content: "out" };
    const original = [call, "same", result, "same"];
    expect(frontierOf(original, [beatKey(call)])).toBe(2);
  });

  test("an empty outbound list reports its own length", () => {
    expect(frontierOf([])).toBe(0);
  });

  test("randomized drops and repetitions agree with the reference", () => {
    let seed = 11;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round += 1) {
      const pool = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, index) => ({
        role: "user",
        content: `message ${index}`,
        timestamp: index,
      }));
      const original = [];
      for (let index = 0; index < pool.length; index += 1) {
        original.push(pool[Math.floor(next() * pool.length)]);
      }
      frontierOf(original);
    }
  });
});
