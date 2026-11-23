import { test, expect } from "bun:test";
import { resolveComposerSubmit } from "../../host-omp-ui/web/src/lib/composer-action";

test("running without content maps to stop", () => {
  expect(resolveComposerSubmit({ working: true, hasContent: false })).toBe("stop");
});

test("running with content maps to steer", () => {
  expect(resolveComposerSubmit({ working: true, hasContent: true })).toBe("steer");
});

test("idle with content maps to send", () => {
  expect(resolveComposerSubmit({ working: false, hasContent: true })).toBe("send");
});

test("idle without content maps to disabled", () => {
  expect(resolveComposerSubmit({ working: false, hasContent: false })).toBe("disabled");
});
