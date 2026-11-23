import type { SessionSummary, UiMessage } from "./types";
import { isRecord } from "./guards";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unauthorized"
  | "offline";

export type SessionDetail = {
  session: SessionSummary & { messages?: UiMessage[] };
};

export type BridgeClient = {
  readonly state: ConnectionState;
  readonly token: string | null;
  sendCommand(type: string, payload?: Record<string, unknown>): void;
  submitCommand(payload: Record<string, unknown>): Promise<void>;
  requestHistory(before: string): Promise<Record<string, unknown>>;
  unlock(token: string): void;
  fetchBootstrap(): Promise<Record<string, unknown>>;
  fetchSessions(): Promise<unknown>;
  fetchSessionDetail(id: string): Promise<SessionDetail>;
  subscribe(
    listener: (frame: unknown, state: ConnectionState) => void,
  ): () => void;
};

const TOKEN_KEY = "herd.omp-ui.token";

export function createCommandRequest(type: string, payload: Record<string, unknown> = {}, requestId = crypto.randomUUID()): { requestId: string; frame: string } {
  // Interaction requestId identifies the dialog, not the command. Keep it intact.
  const body = type === "interaction.respond" ? { ...payload, commandId: requestId } : { ...payload, requestId };
  return { requestId, frame: JSON.stringify({ type, ts: Date.now(), payload: body }) };
}

function readToken(): string | null {
  try {
    const query = new URLSearchParams(location.search).get("token");
    if (query) {
      sessionStorage.setItem(TOKEN_KEY, query);
      const url = new URL(location.href);
      url.searchParams.delete("token");
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      return query;
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function rememberToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // A browser that refuses storage still works for this tab's lifetime.
  }
}

export function createBridgeClient(): BridgeClient {
  const listeners = new Set<
    (frame: unknown, state: ConnectionState) => void
  >();
  let token = readToken();
  let state: ConnectionState = token ? "connecting" : "unauthorized";
  let socket: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let reconnectTimer: number | undefined;
  let pending: unknown[] = [];
  let hydrated = false;
  let latestSnapshot: unknown = null;
  const commands = new Map<string, number>();
  const submissions = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: number }>();
  let historyRequest: { id: string; resolve: (page: Record<string, unknown>) => void; reject: (error: Error) => void; timer: number } | null = null;
  const cancelHistory = () => { if (historyRequest) { const p = historyRequest; historyRequest = null; clearTimeout(p.timer); p.reject(new Error("历史请求已取消")); } };
  const rejectSubmissions = () => {
    cancelHistory();
    for (const entry of submissions.values()) { clearTimeout(entry.timer); entry.reject(new Error("连接断开，提交结果未知")); }
    submissions.clear();
  };

  const emit = (frame?: unknown) => {
    if (frame !== undefined) {
      if (isRecord(frame) && frame.type === "snapshot") {
        latestSnapshot = frame;
        if (listeners.size === 0) pending = [frame];
      } else if (listeners.size === 0) {
        pending.push(frame);
        if (pending.length > 200) {
          const snapshotIndex = pending.findIndex(
            (item) => isRecord(item) && item.type === "snapshot",
          );
          pending = snapshotIndex >= 0
            ? [pending[snapshotIndex], ...pending.slice(snapshotIndex + 1).slice(-199)]
            : pending.slice(-200);
        }
      }
    }
    for (const listener of listeners) listener(frame, state);
  };

  const rejectCommands = () => {
    for (const [requestId, timer] of commands) {
      clearTimeout(timer);
      emit({ type: "command.result", requestId, ok: false, code: "result_unknown", message: "连接断开，操作结果未知" });
    }
    commands.clear();
  };

  const changeState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    emit();
  };

  const disconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const old = socket;
    socket = null;
    rejectSubmissions();
    rejectCommands();
    if (old) {
      try {
        old.close();
      } catch {
        // Already closed.
      }
    }
  };

  const probeAuth = async (probeToken: string): Promise<boolean | null> => {
    try {
      const response = await fetch("/api/bootstrap", {
        headers: { Authorization: `Bearer ${probeToken}` },
      });
      if (response.status === 401) {
        if (token === probeToken) changeState("unauthorized");
        return false;
      }
      return true;
    } catch {
      // The server may be restarting; an unreachable probe is not a bad token.
      return null;
    }
  };

  const connect = () => {
    if (!token || closed) return;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    changeState(attempt > 0 ? "reconnecting" : "connecting");
    const url = new URL("/ws", location.origin);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return;
      attempt = 0;
      changeState("connected");

    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (isRecord(frame) && frame.type === "command.result" && typeof frame.requestId === "string") {
          const timer = commands.get(frame.requestId);
          if (timer !== undefined) { clearTimeout(timer); commands.delete(frame.requestId); }
          const entry = submissions.get(frame.requestId);
          if (entry) { submissions.delete(frame.requestId); clearTimeout(entry.timer); if (frame.ok === true) entry.resolve(); else entry.reject(new Error(String(frame.code ?? "提交失败"))); }
        }
        if (isRecord(frame) && frame.type === "history.page" && (!historyRequest || frame.requestId !== historyRequest.id)) return;
        if (isRecord(frame) && historyRequest && frame.requestId === historyRequest.id) {
          const request = historyRequest;
          if (frame.type === "history.page") {
            historyRequest = null;
            clearTimeout(request.timer);
            emit(frame);
            request.resolve(frame);
            return;
          }
          if (frame.type === "command.result" && frame.ok === false) {
            historyRequest = null;
            clearTimeout(request.timer);
            request.reject(new Error(String(frame.message ?? frame.code ?? "历史请求失败")));
          }
        }
        emit(frame);
      } catch {
        // A malformed frame is dropped; the snapshot on reconnect repairs state.
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      rejectSubmissions();
    rejectCommands();
      if (closed) return;
      if (event.code === 4401 || event.code === 1008) {
        changeState("unauthorized");
        return;
      }
      const probeToken = token;
      if (!probeToken) return;
      // Browsers surface a rejected WebSocket handshake (HTTP 401) as 1006,
      // never as a useful auth code. Probe with the tokenized HTTP API so a
      // bad token stops the reconnect loop instead of retrying forever.
      void probeAuth(probeToken).then((authorized) => {
        if (closed || token !== probeToken) return;
        if (authorized === false) return;
        changeState("offline");
        scheduleReconnect();
      });
    };
    ws.onerror = () => {
      // `onclose` follows and owns reconnection.
    };
  };

  const scheduleReconnect = () => {
    if (closed || !token) return;
    changeState("offline");
    attempt += 1;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const request = async (path: string): Promise<unknown> => {
    const requestToken = token;
    const response = await fetch(path, {
      headers: requestToken
        ? { Authorization: `Bearer ${requestToken}` }
        : {},
    });
    if (response.status === 401) {
      if (token === requestToken) changeState("unauthorized");
      throw new Error("unauthorized");
    }
    if (!response.ok) throw new Error(`http ${response.status}`);
    return response.json();
  };

  const authed = async (path: string): Promise<Record<string, unknown>> => {
    const value = await request(path);
    return isRecord(value) ? value : { value };
  };

  const client: BridgeClient = {
    get state() {
      return state;
    },
    get token() {
      return token;
    },
    sendCommand(type, payload = {}) {
      if (type === "manager.select" || type === "manager.open_session" || type === "manager.new_session") cancelHistory();
      const { requestId, frame } = createCommandRequest(type, payload);
      // Interaction responses use their own request identity; the manager must
      // support commandId before they can have an independent receipt.
      const tracked = type !== "interaction.respond" && type !== "draft.update" && type !== "surface.keys" && type !== "manager.history";
      if (tracked) emit({ type: "command.pending", requestId, command: type });
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          if (tracked) {
            const timer = window.setTimeout(() => {
              commands.delete(requestId);
              emit({ type: "command.result", requestId, ok: false, code: "result_unknown", message: "操作超时，结果未知" });
            }, 30000);
            commands.set(requestId, timer);
          }
          socket.send(frame);
          return;
        } catch {
          const timer = commands.get(requestId);
          if (timer !== undefined) { clearTimeout(timer); commands.delete(requestId); }
          // A failed send is reported, never replayed after reconnection.
        }
      }
      if (tracked) emit({ type: "command.result", requestId, ok: false, code: "not_connected", message: "未连接，命令未发送" });
      else emit({ type: "client.error", code: "not_connected" });
    },
    requestHistory(before) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("未连接，未发送"));
      if (historyRequest) return Promise.reject(new Error("历史请求正在进行"));
      const { requestId, frame } = createCommandRequest("manager.history", { before });
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (historyRequest?.id === requestId) historyRequest = null;
          reject(new Error("历史请求超时"));
        }, 30000);
        historyRequest = { id: requestId, resolve, reject, timer };
        try { socket!.send(frame); } catch (error) {
          historyRequest = null;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    submitCommand(payload) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("未连接，未发送"));
      const requestId = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => { submissions.delete(requestId); reject(new Error("提交超时，结果未知")); }, 30000);
        submissions.set(requestId, { resolve, reject, timer });
        try { socket!.send(JSON.stringify({ type: "composer.submit", payload: { ...payload, requestId } })); }
        catch (error) { clearTimeout(timer); submissions.delete(requestId); reject(error); }
      });
    },
    unlock(next) {
      const clean = next.trim();
      if (!clean) return;
      token = clean;
      rememberToken(clean);
      attempt = 0;
      disconnect();
      changeState("connecting");
      connect();
    },
    fetchBootstrap: () => authed("/api/bootstrap"),
    fetchSessions: () => request("/api/sessions"),
    fetchSessionDetail: async (id) => {
      const value = await authed(`/api/sessions/${encodeURIComponent(id)}`);
      const nested = isRecord(value.session) ? value.session : undefined;
      const messages = nested?.messages ?? value.messages;
      const session = nested
        ? { ...nested, ...(messages !== undefined ? { messages } : {}) }
        : { ...value, messages };
      return { session: session as SessionDetail["session"] };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(undefined, state);
      if (!hydrated) {
        hydrated = true;
        const buffered = pending;
        pending = [];
        for (const frame of buffered) listener(frame, state);
      } else if (latestSnapshot !== null) {
        listener(latestSnapshot, state);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };

  if (token) connect();

  return client;
}
