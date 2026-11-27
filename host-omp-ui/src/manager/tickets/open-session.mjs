// open-session ticket: attach a browser to a conversation, launching one omp
// when no live instance serves it. The single flight lives in the station's
// `opening` table, so two clicks on one conversation still start one process.

export async function openSessionTicket({ station, client, command, ensureSession }) {
  const id = command.sessionId ?? command.payload?.sessionId;
  const requestId = command.requestId ?? command.payload?.requestId;
  const { operation, generation } = station.beginOperation(client, requestId);

  if (typeof id !== "string" || !id || id.includes("/") || id.includes("\\")) {
    station.releaseOperation(client, operation);
    station.result(client, requestId, false, "unknown_session");
    return;
  }

  try {
    let agent = station.agentBySessionId(id);
    if (!agent) {
      if (typeof ensureSession !== "function") {
        station.releaseOperation(client, operation);
        station.result(client, requestId, false, "unavailable");
        return;
      }
      let task = station.openingFor(id);
      if (!task) task = station.trackOpening(id, launchAndAwait({ station, id, ensureSession }));
      const resolved = await task;
      if (!station.operationCurrent(client, operation)) return;
      if (!resolved.outcome?.ok) {
        station.releaseOperation(client, operation);
        station.result(client, requestId, false, resolved.outcome?.code ?? "launch_failed", resolved.outcome?.message);
        return;
      }
      agent = resolved.agent;
    }

    if (!station.operationCurrent(client, operation)) return;
    station.releaseOperation(client, operation);
    if (!agent) {
      station.result(client, requestId, false, "registration_timeout");
      return;
    }
    if (station.registered(client) && station.generationOf(client) === generation) station.select(client, agent.instanceId, requestId);
  } catch (error) {
    if (!station.operationCurrent(client, operation)) return;
    station.releaseOperation(client, operation);
    throw error;
  }
}

async function launchAndAwait({ station, id, ensureSession }) {
  const outcome = await ensureSession(id, station.catalogOptions());
  if (!outcome?.ok) return { outcome };
  return { outcome, agent: station.agentById(outcome.instanceId) ?? (await station.waitForSession(id)) };
}
