// One pending dialog, two writers. The first answer settles it; the other side
// gets a refusal, not a second resolution. Closing removes the entry entirely,
// so a late answer after a TUI-side close is a clean `not_found`.

export function createInteractionLedger() {
  return { open: new Map() };
}

export function openInteraction(ledger, request) {
  if (!request?.id) return { ok: false, code: "invalid_request" };
  if (ledger.open.has(request.id)) return { ok: false, code: "already_open" };
  ledger.open.set(request.id, {
    id: request.id,
    kind: request.kind,
    payload: request.payload ?? {},
    settledBy: null,
  });
  return { ok: true };
}

export function resolveInteraction(ledger, id, source, value) {
  const entry = ledger.open.get(id);
  if (!entry) return { ok: false, code: "not_found" };
  if (entry.settledBy) return { ok: false, code: "already_settled" };
  entry.settledBy = source;
  entry.value = value;
  return { accepted: true, winner: source };
}

export function closeInteraction(ledger, id) {
  return ledger.open.delete(id);
}

export function listOpenInteractions(ledger) {
  return Array.from(ledger.open.values()).filter((entry) => !entry.settledBy);
}
