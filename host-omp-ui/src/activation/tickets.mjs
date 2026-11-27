import { DRAFT_FRAME, SERVER_FRAMES, toServerFrame } from "../station/domain/protocol-codec.mjs";
import { ticketResultOutcomes } from "../station/domain/ticket-result.mjs";

// A web draft has two effects and therefore one row: the editor write, and the
// mirror frame every other client sees (named in the codec).
const DRAFT_EVENT = "syncEditorDraft";

// Fire-and-forget safety shell and the single-hop capability bag. Every ticket
// invocation leaves through detach, so a rejected promise can never surface as
// an unhandled rejection inside omp's extension host.
const TICKET_BY_EVENT = {
	[DRAFT_EVENT]: "syncEditorDraftTicket",
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

export function buildBridgeCapabilities({ tickets, diagnostics, onResult } = {}) {
	const broadcast = (label, frame) =>
		detach(tickets?.broadcastFrameTicket?.(frame), (error) => diagnostics?.record?.(label, error));
	const decide = onResult ?? ticketResultOutcomes;
	const dispatch = (event) => {
		if (!event || typeof event.type !== "string") return;
		if (event.type === DRAFT_EVENT) {
			broadcast("broadcast:draft.sync", { type: DRAFT_FRAME, ...event.payload });
		}
		if (SERVER_FRAMES.has(event.type)) {
			broadcast(`broadcast:${event.type}`, toServerFrame(event));
		}
		const ticketName = TICKET_BY_EVENT[event.type];
		if (!ticketName) return;
		const ticket = tickets?.[ticketName];
		if (typeof ticket !== "function") return;
		const settle = (result) => {
			const { outcomes } = decide(event, result);
			for (const outcome of outcomes) {
				if (outcome.kind === "receipt") {
					detach(tickets?.sendClientFrameTicket?.({
						clientId: outcome.clientId,
						frame: { type: "command.result", requestId: outcome.requestId, ok: outcome.ok, code: outcome.code },
					}), (error) => diagnostics?.record?.("receipt", error));
				} else if (outcome.kind === "meta") {
					broadcast("broadcast:reported", { type: "meta.update", ...outcome.patch });
				} else if (outcome.kind === "toast") {
					broadcast("broadcast:ticket-error", { type: "toast", level: outcome.level, message: outcome.message });
				}
			}
		};
		const fail = (error) => {
			diagnostics?.record?.(`ticket:${event.type}`, error);
			settle({ ok: false, code: "failed" });
		};
		try {
			detach(Promise.resolve(ticket(event.payload ?? event)).then(settle, fail), fail);
		} catch (error) {
			fail(error);
		}
	};
	return { dispatch };
}
