// Host adaptation for browser commands. The interaction.respond special case
// chooses between the plan-review ticket and the ordinary interaction bridge;
// every other command is a single hop into the Station. The composition root
// passes live getters so late-bound runtime fields stay observable.
export function createClientCommandHandler({ getStation, getTickets, getBridge, getServer, record }) {
	return async (command, clientId) => {
		if (command?.type === "interaction.respond") {
			const payload = command.payload ?? {};
			let result;
			try {
				const station = getStation();
				if (station.pendingInteractionKind(payload.requestId) === "plan_review") {
					result = await getTickets().resolvePlanReviewTicket({
						reviewId: payload.requestId,
						choice: payload.choice ?? payload.value,
						input: payload.input,
					});
				} else {
					result = getBridge().resolve(payload.requestId, payload);
					if (result.ok) station.resolveInteraction(payload.requestId, "web", payload);
				}
			} catch (error) {
				record("interaction-response", error);
				result = { ok: false, code: "failed" };
			}
			const server = getServer();
			if (payload.commandId) {
				server.sendToClient(clientId, {
					type: "command.result",
					requestId: payload.commandId,
					ok: Boolean(result?.ok),
					...(!result?.ok ? { code: result?.code ?? "failed", errors: result?.errors ?? null } : {}),
				});
			}
			if (!result?.ok) {
				server.sendToClient(clientId, {
					type: "interaction.error",
					requestId: payload.requestId,
					code: result?.code ?? "failed",
					errors: result?.errors ?? null,
				});
			}
			return;
		}
		getStation()?.onClientCommand?.(clientId, command);
	};
}
