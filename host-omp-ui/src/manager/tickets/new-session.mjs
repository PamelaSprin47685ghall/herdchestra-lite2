// new-session ticket: start one real omp in a trusted working directory and
// report success only after the new instance has registered with the manager.

export async function newSessionTicket({ station, client, command, newSession }) {
  const requestId = command.requestId;
  if (typeof newSession !== "function") {
    station.result(client, requestId, false, "unavailable");
    return;
  }
  if (typeof command.cwd !== "string" || !station.hasAgentWithCwd(command.cwd)) {
    station.result(client, requestId, false, "invalid_cwd");
    return;
  }

  const { operation, generation } = station.beginOperation(client, requestId);
  try {
    // One microtask hop keeps the launch out of the message handler itself, as
    // the socket callback must finish before the launcher touches the host.
    await Promise.resolve();
    const outcome = await newSession({ cwd: command.cwd }, station.waitForLaunch);
    if (!station.operationCurrent(client, operation) || !station.registered(client)) return;
    station.releaseOperation(client, operation);
    if (!outcome?.ok) {
      station.result(client, requestId, false, outcome?.code || "launch_failed", outcome?.message);
      return;
    }
    const agent = station.agentById(outcome.instanceId);
    if (!agent || !outcome.launchId || agent.launchId !== outcome.launchId) {
      station.result(client, requestId, false, "registration_failed");
      return;
    }
    if (station.generationOf(client) === generation) station.select(client, agent.instanceId, requestId);
    else station.result(client, requestId, false, "selection_superseded");
  } catch (error) {
    if (!station.operationCurrent(client, operation) || !station.registered(client)) return;
    station.releaseOperation(client, operation);
    throw error;
  }
}
