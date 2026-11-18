// Station control handlers: scope, regret, defer, and pin arguments.
// Plain synchronous functions. The station owns the state; this module owns
// the argument validation and the resulting text.

import {
  applyRegret,
  beginScope,
  closeScope,
  createState,
  currentScope,
  findElderSibling,
  scopeOrder,
} from "../scope/index.mjs";
import { findBegin } from "../transcript/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { parseArgs, trimText } from "./messages.mjs";
import { beginText, endText, regretText } from "./texts.mjs";

function handleRegretCall(station, call, base, currentIndex) {
  const state = station.state;
  const args = parseArgs(call);
  const reflection = trimText(args.reflection);
  if (!reflection) {
    return errorResult("INVALID_ARGUMENT", "regret.reflection must be a non-empty string.", {
      field: "reflection",
    });
  }
  const scope = currentScope(state);
  if (!scope) {
    return errorResult("NOT_IN_SCOPE", "regret is only allowed inside a scope.");
  }
  const target = station.findRegretTarget(base, currentIndex, scope);
  if (!target.ok) return errorResult(target.code, target.reason);
  const applied = applyRegret(state, {
    scopeId: scope.id,
    beat: target.beat,
    toolCalls: target.toolCalls,
  });
  if (!applied.ok) return errorResult(applied.code, applied.reason);
  applied.scope = currentScope(state);
  return textResult(regretText(applied), { refunded: applied.refunded });
}

function handleDeferCall(station, call) {
  const args = parseArgs(call);
  const intent = trimText(args.intent);
  if (!intent) {
    return errorResult("INVALID_ARGUMENT", "defer.intent must be a non-empty string.", { field: "intent" });
  }
  const out = station.deferIntent(call.id, intent);
  if (!out.ok) return errorResult(out.code, out.reason);
  return textResult("OK");
}

function handlePinCall() {
  return textResult("OK");
}

function handleScopeCall(station, call, { base, currentMessage, currentPersisted, sameMessageBeginIds }) {
  const state = station.state;
  const args = parseArgs(call);
  const hasBegin = args.begin !== undefined && args.begin !== null;
  const hasEnd = args.end !== undefined && args.end !== null;
  if (!hasBegin && !hasEnd) {
    return errorResult("INVALID_ARGUMENT", "Provide begin, end, or both.");
  }
  // The assistant_message hook processes controls before tool dispatch. A
  // handoff-pending begin must be rejected here, otherwise the scope would
  // open even though the tool result is blocked.
  if (hasBegin && state.relay?.handoffPending) {
    return errorResult(
      "RELAY_HANDOFF_PENDING",
      "A relay handoff is pending. Do not open a new scope; wait for the successor.",
    );
  }
  if (hasBegin && !hasEnd) {
    const begin = args.begin;
    const out = beginScope(state, {
      toolCallId: call.id,
      intent: begin?.intent,
      budget: begin?.budget,
    });
    if (!out.ok) return errorResult(out.code, out.reason);
    return textResult(beginText(out.scope));
  }

  if (hasBegin) {
    const validation = beginScope(createState(), {
      toolCallId: call.id,
      intent: args.begin?.intent,
      budget: args.begin?.budget,
    });
    if (!validation.ok) return errorResult(validation.code, validation.reason);
  }
  const endArg = args.end;
  const report = trimText(
    typeof endArg === "string" ? endArg : endArg?.return_markdown,
  );
  if (!report) {
    return errorResult(
      "INVALID_ARGUMENT",
      "scope.end.return_markdown must be a non-empty self-delivery report.",
    );
  }
  const scope = currentScope(state);
  if (!scope) {
    return errorResult("NOT_IN_SCOPE", "scope end is only allowed inside a scope.");
  }
  if (sameMessageBeginIds?.has(scope.beginToolCallId)) {
    return errorResult(
      "SAME_MESSAGE_BOUNDARY",
      "A scope cannot begin and end in the same assistant message. Begin it in one message, do the work, then end it in a later message.",
    );
  }
  // A close is a state transition, not a history edit. The begin may be gone
  // after compaction, restore, or an earlier fork; close anyway and record a
  // collapse only when its begin is still addressable.
  const selfVisible =
    findBegin(base, scope.beginToolCallId) !== null &&
    station.findBeginEntry(scope.beginToolCallId) !== null;

  // A closing scope collapses its immediately elder sibling at the same
  // level. The closing scope itself stays fully visible until a younger
  // sibling closes. This keeps collapse local to one sibling chain instead of
  // reaching into a parent's interior.
  const parentId =
    state.scopes.length > 1
      ? state.scopes[state.scopes.length - 2].id
      : null;
  const order = scopeOrder(scope);
  const elder = findElderSibling(
    state,
    parentId,
    order,
    scope.boundary ?? 0,
    scope.epoch ?? 0,
  );
  let foldedReport = null;
  if (elder) {
    const folded = station.foldElder({
      elder,
      base,
      currentMessage,
      currentPersisted,
    });
    if (folded.folded) foldedReport = folded.report;
  }
  const closed = closeScope(state, { toolCallId: call.id, report });
  if (!closed.ok) return errorResult(closed.code, closed.reason);
  if (selfVisible) {
    state.collapses.push({
      beginToolCallId: scope.beginToolCallId,
      endToolCallId: call.id,
      report,
      parentId,
      order,
      boundary: scope.boundary ?? 0,
      epoch: scope.epoch ?? 0,
      collapsed: false,
      createdAt: Date.now(),
    });
  }
  const deferred = closed.defers ?? [];
  const steerSent = station.deliverSteer(closed.steerText);
  const remainingScope = currentScope(state);
  let text = endText(
    report,
    foldedReport,
    deferred.length,
    closed.steerText,
    steerSent,
    hasBegin,
    remainingScope,
    station.relayReady(),
  );
  if (hasBegin) {
    const opened = beginScope(state, {
      toolCallId: call.id,
      intent: args.begin.intent,
      budget: args.begin.budget,
    });
    text += `\n\n${beginText(opened.scope)}`;
  }
  return textResult(text, {
    scopeId: scope.id,
    deferred: deferred.length,
  });
}

export { handleRegretCall, handleDeferCall, handlePinCall, handleScopeCall };
