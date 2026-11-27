// ManagerStation: the synchronous owner of manager state.
//
// Every mutable manager fact lives here: connected instances, browser clients,
// waiter tables, selections, and in-flight operations. Every method is a plain
// synchronous function. Anything that waits lives in manager/tickets/, which
// call back into these methods to commit. Frame delivery is delegated to the
// injected `send` capability, so this module never touches a socket itself.

const MAX_BARRIER_FRAMES = 4096;
const MAX_BARRIER_BYTES = 16 * 1024 * 1024;

export function createManagerStation({ send, clearTimer = clearTimeout, schedule = setTimeout } = {}) {
  if (typeof send !== "function") throw new TypeError("send is required");

  const agents = new Map();
  const clients = new Map();
  const knownSessionDirs = new Set();
  const pending = new Map(); // sessionId -> Set<finish>
  const opening = new Map(); // sessionId -> Promise (one launch per conversation)
  const launchPending = new Map(); // launchId -> Set<finish>
  let closed = false;
  let hadAgent = false;

  const say = (ws, frame) => void send(ws, frame);

  const result = (ws, requestId, ok, code, message) => {
    if (!requestId) return;
    say(ws, { type: "command.result", requestId, ok, ...(code ? { code } : {}), ...(message ? { message } : {}) });
  };

  const cwdOf = (agent) => agent?.session?.cwd;

  function list() {
    return [...agents.values()].map(({ instanceId, pid, session, mode, capabilities }) => ({ instanceId, pid, session, mode, capabilities }));
  }

  function rememberSessionDir(session) {
    if (typeof session?.sessionDir === "string" && session.sessionDir) knownSessionDirs.add(session.sessionDir);
  }

  function catalogOptions() {
    return { extraDirs: [...knownSessionDirs] };
  }

  function publish() {
    const frame = { type: "manager.instances", instances: list() };
    for (const client of clients.values()) say(client.ws, frame);
  }

  function cancelSelection(client) {
    if (client.operation) {
      result(client.ws, client.operation.requestId, false, "selection_superseded");
      client.operation = null;
    }
    if (client.awaitingSelection) {
      clearTimer(client.awaitingSelection.timer);
      result(client.ws, client.awaitingSelection.requestId, false, "selection_superseded");
      client.awaitingSelection = null;
    }
    if (client.barrier) {
      clearTimer(client.barrier.timer);
      result(client.ws, client.barrier.requestId, false, "selection_superseded");
      client.barrier = null;
    }
  }

  function select(client, instanceId, requestId) {
    const agent = agents.get(instanceId);
    if (!agent) {
      result(client.ws, requestId, false, "instance_gone");
      return false;
    }
    cancelSelection(client);
    if (!agent.session?.id) {
      const waiting = { instanceId, requestId, generation: ++client.generation, timer: null };
      client.awaitingSelection = waiting;
      waiting.timer = schedule(() => {
        if (client.awaitingSelection !== waiting) return;
        client.awaitingSelection = null;
        result(client.ws, requestId, false, "snapshot_timeout");
      }, 15000);
      return true;
    }
    const previous = agents.get(client.selected);
    if (previous && previous !== agent) say(previous.ws, { type: "manager.client_disconnected", clientId: client.id });
    const generation = ++client.generation;
    client.historyRequests?.clear();
    client.selected = instanceId;
    const barrier = { generation, requestId, frames: [], bytes: 0, timer: null, previousId: previous?.instanceId };
    barrier.restore = () => {
      const fallback = agents.get(barrier.previousId);
      if (fallback && fallback.instanceId !== instanceId) select(client, fallback.instanceId);
      else {
        client.selected = null;
        say(client.ws, { type: "manager.instance_gone", instanceId });
      }
    };
    client.barrier = barrier;
    barrier.timer = schedule(() => {
      if (client.barrier !== barrier) return;
      client.barrier = null;
      result(client.ws, requestId, false, "snapshot_timeout");
      say(agent.ws, { type: "manager.client_disconnected", clientId: client.id });
      barrier.restore();
    }, 15000);
    say(client.ws, { type: "session.select", sessionId: agent.session?.id, instanceId: agent.instanceId });
    say(agent.ws, { type: "manager.client_connected", clientId: client.id });
    say(agent.ws, { type: "manager.snapshot_request", clientId: client.id, generation });
    return true;
  }

  function openBrowser(ws) {
    const client = { id: ws.data.id, ws, selected: null, generation: 0 };
    clients.set(client.id, client);
    say(ws, { type: "manager.instances", instances: list() });
    const first = agents.values().next().value;
    if (first) select(client, first.instanceId);
    return client;
  }

  function disconnectBrowser(client) {
    if (client.barrier) clearTimer(client.barrier.timer);
    if (client.awaitingSelection) clearTimer(client.awaitingSelection.timer);
    client.operation = null;
    clients.delete(client.id);
    const agent = agents.get(client.selected);
    if (agent) say(agent.ws, { type: "manager.client_disconnected", clientId: client.id });
  }

  function registerAgent(ws, frame) {
    const duplicate = ws.data.instanceId || typeof frame.instanceId !== "string" || !frame.instanceId || agents.has(frame.instanceId);
    if (duplicate) {
      ws.close();
      return false;
    }
    hadAgent = true;
    ws.data.instanceId = frame.instanceId;
    const agent = { ws, instanceId: frame.instanceId, pid: frame.pid, session: frame.session, snapshot: frame.snapshot, launchId: frame.launchId, mode: frame.mode, capabilities: frame.capabilities };
    agents.set(agent.instanceId, agent);
    rememberSessionDir(agent.session);
    say(ws, { type: "manager.registered", instanceId: agent.instanceId });
    publish();
    for (const finish of pending.get(agent.session?.id) ?? []) finish(agent);
    if (agent.launchId) for (const finish of launchPending.get(agent.launchId) ?? []) finish(agent);
    for (const client of clients.values()) if (!client.selected) select(client, agent.instanceId);
    return true;
  }

  function forwardFrame(agent, frame) {
    for (const client of clients.values()) {
      if (client.selected !== agent.instanceId) continue;
      if (!client.barrier) {
        say(client.ws, frame.frame);
        continue;
      }
      const barrier = client.barrier;
      const bytes = JSON.stringify(frame.frame).length;
      if (barrier.frames.length < MAX_BARRIER_FRAMES && barrier.bytes + bytes <= MAX_BARRIER_BYTES) {
        barrier.frames.push({ revision: frame.revision, frame: frame.frame });
        barrier.bytes += bytes;
        continue;
      }
      clearTimer(barrier.timer);
      result(client.ws, barrier.requestId, false, "snapshot_overflow");
      client.barrier = null;
      say(agent.ws, { type: "manager.client_disconnected", clientId: client.id });
      barrier.restore();
    }
  }

  function agentFrame(agent, frame) {
    const payload = frame.frame;
    if (payload.type === "snapshot") {
      agent.snapshot = payload;
      if (payload.session) agent.session = payload.session;
      publish();
    }
    forwardFrame(agent, frame);
  }

  function clientFrame(agent, frame) {
    const client = clients.get(frame.clientId);
    if (client?.selected !== agent.instanceId) return;
    const payload = frame.frame;
    if (payload?.type === "snapshot") {
      const barrier = client.barrier;
      if (!barrier || frame.generation !== barrier.generation) return;
      clearTimer(barrier.timer);
      client.barrier = null;
      say(client.ws, payload);
      const snapshotSeq = typeof payload.seq === "number" ? payload.seq : typeof payload.payload?.seq === "number" ? payload.payload.seq : null;
      for (const waiting of barrier.frames) {
        const pendingSeq = typeof waiting.frame?.seq === "number" ? waiting.frame.seq : null;
        if (snapshotSeq !== null && pendingSeq !== null) {
          if (pendingSeq > snapshotSeq) say(client.ws, waiting.frame);
        } else if (typeof frame.revision !== "number" || typeof waiting.revision !== "number" || waiting.revision > frame.revision) {
          say(client.ws, waiting.frame);
        }
      }
      result(client.ws, barrier.requestId, true);
      return;
    }
    if (client.barrier) return;
    if (payload?.type === "history.page") {
      const request = client.historyRequests?.get(payload.requestId);
      client.historyRequests?.delete(payload.requestId);
      if (!request || request.generation !== client.generation || request.sessionId !== agent.session?.id) return;
    }
    if (payload?.type === "command.result" && payload.ok === false) client.historyRequests?.delete(payload.requestId);
    say(client.ws, payload);
  }

  function agentUpdate(agent, frame) {
    agent.session = frame.session ?? agent.session;
    rememberSessionDir(agent.session);
    if (frame.snapshot) agent.snapshot = frame.snapshot;
    publish();
    for (const client of clients.values()) {
      const waiting = client.awaitingSelection;
      if (waiting?.instanceId === agent.instanceId && waiting.generation === client.generation && agent.session?.id) {
        clearTimer(waiting.timer);
        client.awaitingSelection = null;
        select(client, agent.instanceId, waiting.requestId);
      }
    }
  }

  function disconnectAgent(ws) {
    const agent = agents.get(ws.data.instanceId);
    if (!agent || agent.ws !== ws) return { idle: false };
    agents.delete(agent.instanceId);
    for (const client of clients.values()) {
      const waiting = client.awaitingSelection;
      if (waiting?.instanceId === agent.instanceId) {
        clearTimer(waiting.timer);
        result(client.ws, waiting.requestId, false, "instance_gone");
        client.awaitingSelection = null;
      }
      if (client.selected !== agent.instanceId) continue;
      const barrier = client.barrier;
      if (barrier) {
        clearTimer(barrier.timer);
        result(client.ws, barrier.requestId, false, "instance_gone");
        client.barrier = null;
        barrier.restore();
      } else {
        client.selected = null;
        say(client.ws, { type: "manager.instance_gone", instanceId: agent.instanceId });
      }
    }
    publish();
    return { idle: hadAgent && !agents.size };
  }

  function closeAll() {
    if (closed) return false;
    closed = true;
    for (const waits of pending.values()) for (const waiter of waits) waiter(null);
    pending.clear();
    for (const waits of launchPending.values()) for (const waiter of waits) waiter(null);
    launchPending.clear();
    for (const client of clients.values()) {
      if (client.barrier) clearTimer(client.barrier.timer);
      if (client.awaitingSelection) clearTimer(client.awaitingSelection.timer);
      try { client.ws.close(); } catch {}
    }
    for (const agent of agents.values()) try { agent.ws.close(); } catch {}
    clients.clear();
    agents.clear();
    return true;
  }

  function waitForAgent(predicate, table, id, timeout = 15000) {
    const found = [...agents.values()].find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((done) => {
      let waiters = table.get(id);
      if (!waiters) table.set(id, waiters = new Set());
      let deadline = null;
      const finish = (agent) => {
        if (deadline !== null) clearTimer(deadline);
        waiters.delete(finish);
        if (!waiters.size) table.delete(id);
        done(agent);
      };
      waiters.add(finish);
      deadline = schedule(() => finish(null), timeout);
    });
  }

  function waitForSession(sessionId, timeout = 15000) {
    return waitForAgent((agent) => agent.session?.id === sessionId, pending, sessionId, timeout);
  }

  function waitForLaunch(launchId, timeout = 15000) {
    return waitForAgent((agent) => agent.launchId === launchId, launchPending, launchId, timeout);
  }

  return {
    list,
    catalogOptions,
    publish,
    select,
    cancelSelection,
    openBrowser,
    disconnectBrowser,
    registerAgent,
    agentFrame,
    clientFrame,
    agentUpdate,
    disconnectAgent,
    closeAll,
    waitForSession,
    waitForLaunch,

    clientById: (id) => clients.get(id),
    agentById: (instanceId) => agents.get(instanceId),
    agentBySessionId: (sessionId) => [...agents.values()].find((agent) => agent.session?.id === sessionId) ?? null,
    agentCount: () => agents.size,
    firstAgent: (exceptId) => [...agents.values()].find((candidate) => candidate.instanceId !== exceptId) ?? null,
    hasAgentWithCwd: (cwd) => [...agents.values()].some((agent) => cwdOf(agent) === cwd),

    // An operation token marks which request owns the client right now. Only the
    // owner may commit; a newer command supersedes the older one.
    beginOperation(client, requestId) {
      cancelSelection(client);
      const generation = ++client.generation;
      client.operation = { requestId };
      return { operation: client.operation, generation };
    },
    operationCurrent: (client, operation) => client.operation === operation,
    releaseOperation(client, operation) {
      if (client.operation !== operation) return false;
      client.operation = null;
      return true;
    },
    registered: (client) => clients.get(client.id) === client,
    generationOf: (client) => client.generation,

    openingFor: (sessionId) => opening.get(sessionId) ?? null,
    trackOpening(sessionId, task) {
      opening.set(sessionId, task);
      task.finally(() => { if (opening.get(sessionId) === task) opening.delete(sessionId); }).catch(() => {});
      return task;
    },

    result(client, requestId, ok, code, message) {
      result(client.ws, requestId, ok, code, message);
    },
    noteHistoryRequest(client, requestId, agent) {
      client.historyRequests ??= new Map();
      client.historyRequests.clear();
      client.historyRequests.set(requestId, { generation: client.generation, sessionId: agent.session?.id });
    },
    sendCommand(agent, client, command) {
      say(agent.ws, { type: "manager.command", clientId: client.id, command });
    },
    shutdown(agent, requestId) {
      say(agent.ws, { type: "manager.shutdown", requestId });
    },
    moveClients(fromId, toId) {
      if (!toId) return;
      for (const client of clients.values()) if (client.selected === fromId) select(client, toId);
    },
  };
}
