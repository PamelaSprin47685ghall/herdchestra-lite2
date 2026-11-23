// Fire-and-forget safety shell and the single-hop capability bag. Every ticket
// invocation leaves through detach, so a rejected promise can never surface as
// an unhandled rejection inside omp's extension host.
const TICKET_BY_EVENT = {
	syncEditorDraft: "syncEditorDraftTicket",
	submitComposer: "submitComposerTicket",
	abort: "abortSessionTicket",
	setModel: "setModelTicket",
	setThinking: "setThinkingTicket",
	setMode: "setModeTicket",
	surfaceEvent: "routeSurfaceEventTicket",
	surfaceKeys: "injectSurfaceKeysTicket",
	resolvePlanReview: "resolvePlanReviewTicket",
	broadcastFrame: "broadcastFrameTicket",
	sendClientFrame: "sendClientFrameTicket",
	refreshSessions: "refreshSessionsTicket",
	startServer: "startServerTicket",
	stopServer: "stopServerTicket",
};

export function detach(promise, onError) {
	const fail = (error) => {
		try {
			onError?.(error);
		} catch {
			// A diagnostic sink must not throw.
		}
	};
	try {
		Promise.resolve(promise).catch(fail);
	} catch (error) {
		fail(error);
	}
}

const SERVER_FRAMES = new Set([
	"snapshot",
	"transcript.delta",
	"todo.update",
	"usage.update",
	"meta.update",
	"draft.sync",
	"completion.state",
	"interaction.open",
	"interaction.close",
	"interaction.error",
	"toast",
	"widget.update",
	"surface.frame",
	"session.switched",
]);

function toServerFrame(event) {
	if (event.type === "interaction.open") {
		const { id, requestId, kind, payload } = event.payload ?? {};
		return { type: event.type, request: { id: id ?? requestId, kind, payload } };
	}
	const payload = event.payload ?? {};
	if (event.type === "transcript.delta") {
		return { ...payload, type: event.type, kind: payload.type ?? payload.kind };
	}
	return { ...payload, type: event.type };
}

export function buildBridgeCapabilities({ tickets, diagnostics, onReported } = {}) {
	const dispatch = (event) => {
		if (!event || typeof event.type !== "string") return;
		if (event.type === "syncEditorDraft") {
			detach(tickets?.broadcastFrameTicket?.({ type: "draft.sync", ...event.payload }), (error) =>
				diagnostics?.record?.("broadcast:draft.sync", error),
			);
		}
		if (SERVER_FRAMES.has(event.type)) {
			detach(tickets?.broadcastFrameTicket?.(toServerFrame(event)), (error) =>
				diagnostics?.record?.(`broadcast:${event.type}`, error),
			);
		}
		const ticketName = TICKET_BY_EVENT[event.type];
		if (!ticketName) return;
		const ticket = tickets?.[ticketName];
		if (typeof ticket !== "function") return;
		const report = (code) => {
			if (typeof tickets?.broadcastFrameTicket !== "function") return;
			detach(tickets.broadcastFrameTicket({ type: "toast", level: "error", message: `${event.type}: ${code}` }),
				(error) => diagnostics?.record?.("broadcast:ticket-error", error));
		};
		const receipt = (result) => {
			const { clientId, requestId } = event.payload ?? {};
			if (clientId && requestId) {
				detach(tickets?.sendClientFrameTicket?.({ clientId, frame: { type: "command.result", requestId, ok: result?.ok !== false, code: result?.code } }), (error) => diagnostics?.record?.("receipt", error));
			}
		};
		try {
			detach(Promise.resolve(ticket(event.payload ?? event)).then((result) => {
				if (result?.ok !== false && result?.reported) {
					if (typeof onReported === "function") onReported(result.reported);
					else if (typeof tickets?.broadcastFrameTicket === "function") {
						detach(tickets.broadcastFrameTicket({ type: "meta.update", ...result.reported }), (error) => diagnostics?.record?.("broadcast:reported", error));
					}
				}
				receipt(result);
				if (result?.ok === false) report(result.code ?? "failed");
			}), (error) => { receipt({ ok: false, code: "failed" }); diagnostics?.record?.(`ticket:${event.type}`, error); report("failed"); });
		} catch (error) {
			receipt({ ok: false, code: "failed" });
			diagnostics?.record?.(`ticket:${event.type}`, error);
			report("failed");
		}
	};
	return { dispatch };
}
