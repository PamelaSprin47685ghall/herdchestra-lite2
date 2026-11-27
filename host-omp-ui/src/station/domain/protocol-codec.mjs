// Fail-closed client command parsing. A malformed frame must produce a typed
// refusal, never an exception; the browser is untrusted input.

const REQUIRED = {
  "composer.draft": ["text"],
  "composer.submit": ["text"],
  "session.abort": [],
  "session.set_model": ["provider", "modelId"],
  "session.set_thinking": ["level"],
  "session.set_mode": ["mode", "action"],
  "interaction.respond": ["requestId"],
  "manager.history": ["before"],
  "surface.event": ["ev", "sf", "id"],
  "surface.keys": ["data"],
};

export function parseClientCommand(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "invalid_payload" };
  }
  const type = value.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(REQUIRED, type)) {
    return { ok: false, code: "unknown_type" };
  }
  for (const field of REQUIRED[type]) {
    if (value[field] === undefined || value[field] === null ||
      (value[field] === "" && !(field === "text" && (type === "composer.draft" || (type === "composer.submit" && Array.isArray(value.attachments) && value.attachments.length > 0))))) {
      return { ok: false, code: "invalid_payload" };
    }
  }
  const { type: _type, ...payload } = value;
  return { ok: true, type, payload };
}

// A web draft reaches the browser as this frame; the TUI editor write travels as
// its own event, so the pair is named here once.
export const DRAFT_FRAME = "draft.sync";

// Every frame this plugin may broadcast to a browser client. One set, in the
// domain layer, so the wiring and the frame-vocabulary test read the same
// declaration; a name added here without a web case is now a test failure.
export const SERVER_FRAMES = new Set([
  "snapshot",
  "transcript.delta",
  "todo.update",
  "usage.update",
  "meta.update",
  DRAFT_FRAME,
  "completion.state",
  "interaction.open",
  "interaction.close",
  "interaction.error",
  "toast",
  "widget.update",
  "surface.frame",
  "session.switched",
]);

// Station events share one outbound shape; interaction.open nests its request.
export function toServerFrame(event) {
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
