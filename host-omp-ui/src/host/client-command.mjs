// Host adaptation for browser commands. The Station decides which route an
// interaction takes; this module executes that route and frames the answer. It
// holds no opinion about interaction kinds. Every other command is a single hop
// into the Station. The composition root passes live getters so late-bound
// runtime fields stay observable.
export function createClientCommandHandler({ getStation, getTickets, getBridge, getServer, record }) {
	const ROUTE_HANDLERS = {
		// A plan review belongs to the host ticket that owns the host's own
		// pending promise; the browser sends labels, the ticket re-measures them.
		ticket: ({ route, payload }) =>
			getTickets()?.[route.ticket]?.({
				reviewId: route.reviewId,
				choice: payload.choice ?? payload.value,
				input: payload.input,
			}),
		bridge: ({ station, payload }) => {
			const result = getBridge().resolve(payload.requestId, payload);
			if (result.ok) station.resolveInteraction(payload.requestId, "web", payload);
			return result;
		},
	};

	return async (command, clientId) => {
		if (command?.type === "interaction.respond") {
			const payload = command.payload ?? {};
			const station = getStation();
			const route = station?.interactionRoute?.(payload.requestId) ?? { route: "bridge" };
			let result;
			try {
				result = await ROUTE_HANDLERS[route.route]?.({ station, route, payload });
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
