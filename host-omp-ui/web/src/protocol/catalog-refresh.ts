import type { ConnectionState } from "./client";

export function extractCatalogSessions(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "sessions" in result && Array.isArray(result.sessions)) {
    return result.sessions;
  }
  throw new Error("Invalid session catalog");
}

export type CatalogStatus = "idle" | "loading" | "ready" | "stale";

type Dependencies = {
  fetchSessions: () => Promise<unknown>;
  apply: (sessions: unknown[]) => void;
  error: (reason?: "offline") => void;
  busy: (value: boolean) => void;
  status?: (value: CatalogStatus) => void;
};

export interface CatalogRefresh {
  handleConnection(state: ConnectionState, hasToken: boolean): void;
  refresh(options?: { manual?: boolean }): Promise<void>;
  dispose(): void;
}

export function createCatalogRefresh(deps: Dependencies): CatalogRefresh {
  let generation = 0;
  let connected = false;
  let disposed = false;
  let pending = false;

  async function refresh(options: { manual?: boolean } = {}): Promise<void> {
    if (disposed) return;
    if (!connected) {
      if (options.manual) deps.error("offline");
      return;
    }
    const request = ++generation;
    pending = true;
    deps.busy(true);
    deps.status?.("loading");
    try {
      const sessions = extractCatalogSessions(await deps.fetchSessions());
      if (!disposed && request === generation) {
        deps.apply(sessions);
        deps.status?.("ready");
      }
    } catch {
      if (!disposed && request === generation) {
        deps.status?.("stale");
        if (options.manual) deps.error();
      }
    } finally {
      if (!disposed && request === generation) {
        pending = false;
        deps.busy(false);
      }
    }
  }

  function handleConnection(state: ConnectionState, hasToken: boolean): void {
    if (disposed) return;
    const ready = state === "connected" && hasToken;
    if (!ready) {
      connected = false;
      generation++;
      if (pending) {
        pending = false;
        deps.busy(false);
      }
    } else if (!connected) {
      connected = true;
      void refresh();
    }
  }

  function dispose(): void {
    disposed = true;
    generation++;
    pending = false;
  }

  return { handleConnection, refresh, dispose };
}
