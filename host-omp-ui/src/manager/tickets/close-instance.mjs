// close-instance ticket: close a live instance without taking the manager down.
// With a survivor the browser moves to it; closing the last instance launches
// one keepalive omp, waits for its registration, and only then shuts the old
// one down.

export async function closeInstanceTicket({ station, client, command, newSession, keepaliveCwd }) {
  const requestId = command.requestId;
  const target = station.agentById(command.instanceId);
  if (!target) {
    station.result(client, requestId, false, "instance_gone");
    return;
  }

  if (station.agentCount() > 1) {
    const survivor = station.firstAgent(command.instanceId);
    station.moveClients(command.instanceId, survivor?.instanceId);
    station.shutdown(target, requestId);
    station.publish();
    station.result(client, requestId, true);
    return;
  }

  if (typeof newSession !== "function") {
    station.result(client, requestId, false, "unavailable");
    return;
  }

  // One microtask hop keeps the launch out of the message handler itself.
  await Promise.resolve();
  const outcome = await newSession({ cwd: keepaliveCwd }, station.waitForLaunch);
  if (!outcome?.ok) {
    station.result(client, requestId, false, outcome?.code || "launch_failed", outcome?.message);
    return;
  }

  const keepalive = await awaitRegistration(station, { instanceId: outcome.instanceId, exceptId: command.instanceId });
  if (!keepalive || keepalive.instanceId === command.instanceId) {
    station.result(client, requestId, false, "registration_failed");
    return;
  }

  station.moveClients(command.instanceId, keepalive.instanceId);
  if (client.selected !== keepalive.instanceId) station.select(client, keepalive.instanceId);
  station.shutdown(target, requestId);
  station.publish();
  station.result(client, requestId, true);
}

function awaitRegistration(station, { instanceId, exceptId, timeout = 5000 }) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const tick = () => {
      const candidate = instanceId ? station.agentById(instanceId) : station.firstAgent(exceptId);
      if (candidate) return resolve(candidate);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, 10);
    };
    tick();
  });
}
