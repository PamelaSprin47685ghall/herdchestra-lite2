import { toServerFrame } from "../station/domain/protocol-codec.mjs";

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

export function buildBridgeCapabilities({ tickets, diagnostics, onReported } = {}) {
	const broadcast = (label, frame) =>
		detach(tickets?.broadcastFrameTicket?.(frame), (error) => diagnostics?.record?.(label, error));
	const dispatch = (event) => {
		if (!event || typeof event.type !== "string") return;
		if (event.type === "syncEditorDraft") {
			broadcast("broadcast:draft.sync", { type: "draft.sync", ...event.payload });
		}
		if (SERVER_FRAMES.has(event.type)) {
			broadcast(`broadcast:${event.type}`, toServerFrame(event));
		}
		const ticketName = TICKET_BY_EVENT[event.type];
		if (!ticketName) return;
		const ticket = tickets?.[ticketName];
		if (typeof ticket !== "function") return;
		const report = (code) => {
			if (typeof tickets?.broadcastFrameTicket !== "function") return;
			broadcast("broadcast:ticket-error", { type: "toast", level: "error", message: `${event.type}: ${code}` });
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
						broadcast("broadcast:reported", { type: "meta.update", ...result.reported });
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
