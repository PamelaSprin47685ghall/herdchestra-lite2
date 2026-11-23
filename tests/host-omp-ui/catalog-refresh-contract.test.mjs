import { describe, expect, test } from "bun:test";
import {
  createCatalogRefresh,
  extractCatalogSessions,
} from "../../host-omp-ui/web/src/protocol/catalog-refresh.ts";

// The real RPC browser run showed repeated "刷新会话列表失败" toasts while the
// last instance was exiting: AppShell refreshed on every connection transition,
// including offline/reconnecting, and every failed automatic refresh notified.
// These contracts pin the user-visible behavior of the controller that owns
// catalog refresh, independent of React.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const calls = { fetch: 0, applied: [], errors: 0, busy: [] };
  const queue = options.queue ?? [];
  const controller = createCatalogRefresh({
    fetchSessions: () => {
      calls.fetch += 1;
      if (queue.length > 0) return queue.shift().promise;
      return Promise.resolve(options.result ?? []);
    },
    apply: (sessions) => calls.applied.push(sessions),
    error: () => {
      calls.errors += 1;
    },
    busy: (value) => calls.busy.push(value),
  });
  return { calls, controller };
}

const flush = () => Promise.resolve();

describe("extractCatalogSessions", () => {
  test("accepts the manager array and its sessions envelope", () => {
    expect(extractCatalogSessions([{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(extractCatalogSessions({ sessions: [{ id: "b" }] })).toEqual([
      { id: "b" },
    ]);
  });

  test("rejects malformed payloads instead of silently clearing the catalog", () => {
    expect(() => extractCatalogSessions({ sessions: "nope" })).toThrow();
    expect(() => extractCatalogSessions(null)).toThrow();
  });
});

describe("automatic catalog refresh", () => {
  test("fetches only while connected with a token", async () => {
    const { calls, controller } = harness();
    controller.handleConnection("connecting", true);
    controller.handleConnection("offline", true);
    controller.handleConnection("reconnecting", true);
    controller.handleConnection("unauthorized", false);
    await flush();
    expect(calls.fetch).toBe(0);

    controller.handleConnection("connected", true);
    await flush();
    expect(calls.fetch).toBe(1);
  });

  test("does not fetch without a token even when connected", async () => {
    const { calls, controller } = harness();
    controller.handleConnection("connected", false);
    await flush();
    expect(calls.fetch).toBe(0);
  });

  test("does not repeat while the connection stays connected", async () => {
    const { calls, controller } = harness();
    controller.handleConnection("connected", true);
    await flush();
    controller.handleConnection("connected", true);
    await flush();
    expect(calls.fetch).toBe(1);
  });

  test("refreshes again after leaving and returning to connected", async () => {
    const { calls, controller } = harness();
    controller.handleConnection("connected", true);
    await flush();
    controller.handleConnection("offline", true);
    controller.handleConnection("reconnecting", true);
    controller.handleConnection("connected", true);
    await flush();
    expect(calls.fetch).toBe(2);
  });

  test("a failed automatic refresh keeps the current catalog and stays silent", async () => {
    const first = deferred();
    const { calls, controller } = harness({ queue: [first] });
    controller.handleConnection("connected", true);
    first.reject(new Error("manager gone"));
    await flush();
    expect(calls.applied).toEqual([]);
    expect(calls.errors).toBe(0);
    expect(calls.busy.at(-1)).toBe(false);
  });
});

describe("manual catalog refresh", () => {
  test("reports exactly one visible error on failure", async () => {
    const first = deferred();
    const initial = deferred();
    const { calls, controller } = harness({ queue: [initial, first] });
    controller.handleConnection("connected", true);
    initial.resolve([]);
    await flush();
    const pending = controller.refresh({ manual: true });
    first.reject(new Error("http 500"));
    await pending;
    expect(calls.errors).toBe(1);
  });

  test("applies the returned catalog", async () => {
    const { calls, controller } = harness({
      result: [{ id: "a" }, { id: "b" }],
    });
    controller.handleConnection("connected", true);
    await flush();
    calls.applied.length = 0;
    await controller.refresh({ manual: true });
    expect(calls.applied).toEqual([[{ id: "a" }, { id: "b" }]]);
  });
});

describe("request generations", () => {
  test("a stale response cannot overwrite a newer catalog", async () => {
    const auto = deferred();
    const manual = deferred();
    const { calls, controller } = harness({ queue: [auto, manual] });

    controller.handleConnection("connected", true);
    const manualDone = controller.refresh({ manual: true });
    auto.resolve([{ id: "old" }]);
    await flush();
    expect(calls.applied).toEqual([]);
    expect(calls.errors).toBe(0);
    expect(calls.busy.at(-1)).toBe(true);

    manual.resolve([{ id: "new" }]);
    await manualDone;
    expect(calls.applied).toEqual([[{ id: "new" }]]);
    expect(calls.busy.at(-1)).toBe(false);
  });

  test("a stale automatic failure cannot notify after a newer manual refresh starts", async () => {
    const auto = deferred();
    const manual = deferred();
    const { calls, controller } = harness({ queue: [auto, manual] });

    controller.handleConnection("connected", true);
    const manualDone = controller.refresh({ manual: true });
    auto.reject(new Error("late"));
    await flush();
    expect(calls.errors).toBe(0);

    manual.resolve([]);
    await manualDone;
    expect(calls.applied).toEqual([[]]);
  });

  test("going offline invalidates an in-flight refresh and settles busy", async () => {
    const auto = deferred();
    const { calls, controller } = harness({ queue: [auto] });
    controller.handleConnection("connected", true);
    controller.handleConnection("offline", true);
    auto.resolve([{ id: "stale" }]);
    await flush();
    expect(calls.applied).toEqual([]);
    expect(calls.errors).toBe(0);
    expect(calls.busy.at(-1)).toBe(false);
  });

  test("dispose prevents late apply, error, and busy updates", async () => {
    const auto = deferred();
    const { calls, controller } = harness({ queue: [auto] });
    controller.handleConnection("connected", true);
    const before = { ...calls, applied: [...calls.applied], busy: [...calls.busy] };
    controller.dispose();
    auto.reject(new Error("late"));
    await flush();
    expect(calls.applied).toEqual(before.applied);
    expect(calls.errors).toBe(0);
    expect(calls.busy).toEqual(before.busy);
  });
});

// A successful connection can still fail its first catalog fetch (for example a
// transient /api/sessions error while the WebSocket stays open). Silence keeps
// the UI clean, but the user must be able to tell "no history" apart from "the
// catalog did not load", retry by hand, and see the stale marker clear.
function statusHarness(options = {}) {
  const calls = { fetch: 0, applied: [], errors: 0, status: [] };
  const queue = options.queue ?? [];
  const controller = createCatalogRefresh({
    fetchSessions: () => {
      calls.fetch += 1;
      if (queue.length > 0) return queue.shift().promise;
      return Promise.resolve(options.result ?? []);
    },
    apply: (sessions) => calls.applied.push(sessions),
    error: () => {
      calls.errors += 1;
    },
    busy: () => {},
    status: (value) => calls.status.push(value),
  });
  return { calls, controller };
}

describe("catalog status and retry", () => {
  test("a failed first automatic refresh publishes stale without a toast", async () => {
    const first = deferred();
    const { calls, controller } = statusHarness({ queue: [first] });
    controller.handleConnection("connected", true);
    first.reject(new Error("sessions 500"));
    await flush();
    expect(calls.fetch).toBe(1);
    expect(calls.applied).toEqual([]);
    expect(calls.errors).toBe(0);
    expect(calls.status.at(-1)).toBe("stale");
  });

  test("does not retry automatically while the connection stays connected", async () => {
    const first = deferred();
    const { calls, controller } = statusHarness({ queue: [first] });
    controller.handleConnection("connected", true);
    first.reject(new Error("sessions 500"));
    await flush();
    controller.handleConnection("connected", true);
    await flush();
    expect(calls.fetch).toBe(1);
  });

  test("a manual retry turns stale into ready and applies the catalog", async () => {
    const first = deferred();
    const { calls, controller } = statusHarness({
      queue: [first],
      result: [{ id: "recovered" }],
    });
    controller.handleConnection("connected", true);
    first.reject(new Error("sessions 500"));
    await flush();
    expect(calls.status.at(-1)).toBe("stale");

    await controller.refresh({ manual: true });
    expect(calls.applied).toEqual([[{ id: "recovered" }]]);
    expect(calls.status.at(-1)).toBe("ready");
  });

  test("a manual refresh while offline reports the connection instead of fetching", async () => {
    const { calls, controller } = statusHarness();
    controller.handleConnection("offline", true);
    await controller.refresh({ manual: true });
    expect(calls.fetch).toBe(0);
    expect(calls.errors).toBe(1);
  });

  test("returning to connected refreshes once and clears stale", async () => {
    const first = deferred();
    const second = deferred();
    const { calls, controller } = statusHarness({
      queue: [first, second],
      result: [{ id: "fresh" }],
    });
    controller.handleConnection("connected", true);
    first.reject(new Error("sessions 500"));
    await flush();
    expect(calls.status.at(-1)).toBe("stale");

    controller.handleConnection("offline", true);
    controller.handleConnection("connected", true);
    second.resolve([{ id: "fresh" }]);
    await flush();
    expect(calls.fetch).toBe(2);
    expect(calls.applied).toEqual([[{ id: "fresh" }]]);
    expect(calls.status.at(-1)).toBe("ready");
  });

  test("a late failure from an older request cannot mark a newer success stale", async () => {
    const auto = deferred();
    const manual = deferred();
    const { calls, controller } = statusHarness({ queue: [auto, manual] });
    controller.handleConnection("connected", true);
    const manualDone = controller.refresh({ manual: true });
    manual.resolve([{ id: "new" }]);
    await manualDone;
    expect(calls.status.at(-1)).toBe("ready");

    auto.reject(new Error("late"));
    await flush();
    expect(calls.status.at(-1)).toBe("ready");
    expect(calls.errors).toBe(0);
  });
});
