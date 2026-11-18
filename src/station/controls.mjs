// Station control handlers: scope, regret, defer, and pin arguments.
// Plain synchronous functions. The station owns the state; this module owns
// the argument validation and the resulting text.

import {
  applyRegret,
  beginScope,
  closeScope,
  createState,
  currentScope,
  findFoldablePool,
  findPendingReportElder,
  sealClosedParentChildren,
  scopeOrder,
} from "../scope/index.mjs";
import { findBegin } from "../transcript/index.mjs";
import { invalidatePromotion } from "../relay/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { parseArgs, trimText } from "./messages.mjs";
import { beginText, endText, regretText } from "./texts.mjs";
import {
  charsToTokens,
  resolveModelPolicy,
} from "../host/pricing.mjs";
import {
  measureScopeInterior,
  shouldFoldPool,
} from "./fold.mjs";

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
  const endPresent = args.end !== undefined && args.end !== null;
  const hasEnd = args.end === true;
  // Only a non-boolean end is illegal. `end: false` means "do not close" and
  // is valid alongside begin; without begin it simply does nothing.
  if (endPresent && typeof args.end !== "boolean") {
    return errorResult(
      "INVALID_ARGUMENT",
      "scope.end must be the boolean true; closing a scope no longer takes a report.",
    );
  }
  if (!hasBegin && !hasEnd) {
    return errorResult(
      "INVALID_ARGUMENT",
      endPresent
        ? "scope.end:false does not close a scope; provide begin or end:true."
        : "Provide begin, end, or both.",
    );
  }
  const elderReport = hasBegin ? args.begin?.elder_report : undefined;
  if (hasBegin && elderReport !== undefined && elderReport !== null && typeof elderReport !== "string") {
    return errorResult(
      "INVALID_ARGUMENT",
      "scope.begin.elder_report must be a non-empty string or null.",
      { field: "elder_report" },
    );
  }
  // A preceding todo can request handoff after batch preflight.
  if (hasBegin && state.relay?.handoffPending) {
    return errorResult(
      "RELAY_HANDOFF_PENDING",
      "A relay handoff is pending. Do not open a new scope; wait for the successor.",
    );
  }

  // Pre-validate an opening scope without touching live state so a failed
  // begin cannot damage the scope being closed in a combined call.
  if (hasBegin) {
    const validation = beginScope(createState(), {
      toolCallId: call.id,
      intent: args.begin?.intent,
      budget: args.begin?.budget,
    });
    if (!validation.ok) return errorResult(validation.code, validation.reason);
  }

  const current = currentScope(state);
  // The level whose siblings are archived is the parent of the active scope:
  // for a begin-only call it is the current scope id (the new scope is nested);
  // for closing it is the parent level of the closing scope.
  const beginParentId = current?.id ?? null;
  const boundary = state.relay?.generation ?? 0;
  const epoch = state.epoch ?? 0;

  // --- Begin only ---------------------------------------------------------
  if (hasBegin && !hasEnd) {
    const pending = findPendingReportElder(state, beginParentId, boundary, epoch);
    if (pending) {
      const visible =
        findBegin(base, pending.beginToolCallId) !== null &&
        station.findBeginEntry(pending.beginToolCallId) !== null;
      if (visible) {
        if (!(typeof elderReport === "string" && trimText(elderReport))) {
          return errorResult(
            "MISSING_ELDER_REPORT",
            "An unarchived elder scope is pending at this level. Pass its summary in begin.elder_report.",
            { intent: pending.intent },
          );
        }
        pending.report = trimText(elderReport);
        pending.sealed = false;
      } else {
        // The pending elder's interior left the branch; never ask for a
        // report about a scope the model cannot see.
        pending.sealed = true;
      }
    }
    foldEligiblePool(station, {
      state,
      parentId: beginParentId,
      boundary,
      epoch,
      args,
      base,
      currentMessage,
      currentPersisted,
    });
    const out = beginScope(state, {
      toolCallId: call.id,
      intent: args.begin?.intent,
      budget: args.begin?.budget,
    });
    if (!out.ok) return errorResult(out.code, out.reason);
    state.relay = invalidatePromotion(state.relay);
    out.scope.preBeginInputTokens =
      Number.isFinite(station.lastTotalInput) ? station.lastTotalInput : null;
    return textResult(beginText(out.scope));
  }

  // --- End (only or combined) ---------------------------------------------
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
  // In a combined call the elder report must be valid before anything closes.
  if (hasBegin) {
    const visible =
      findBegin(base, scope.beginToolCallId) !== null &&
      station.findBeginEntry(scope.beginToolCallId) !== null;
    if (visible && !(typeof elderReport === "string" && trimText(elderReport))) {
      return errorResult(
        "MISSING_ELDER_REPORT",
        "An unarchived elder scope is pending at this level. Pass its summary in begin.elder_report.",
        { intent: scope.intent },
      );
    }
  }

  sealClosedParentChildren(state, scope.id);

  const measured = measureScopeInterior(
    base,
    scope.beginToolCallId,
    call.id,
    state.regrets,
    station.tokensPerChar?.() ?? 0.3,
  );
  const baseTokens = Number.isFinite(scope.baseInputTokens) ? scope.baseInputTokens : null;
  const usageArrived = station.usageArrivedFor?.(currentMessage) ?? Boolean(currentMessage?.usage);
  let interiorTokens = null;
  let endInputTokens = null;
  let endPending = false;
  if (baseTokens !== null && Number.isFinite(station.lastTotalInput)) {
    endInputTokens = station.lastTotalInput;
    interiorTokens = Math.max(0, endInputTokens - baseTokens);
  } else {
    interiorTokens = charsToTokens(measured.interiorChars);
    endPending = !usageArrived;
  }

  // A close is a state transition, not a history edit. The begin may be gone
  // after compaction, restore, or an earlier fork; close anyway and record a
  // collapse only when its begin is still addressable.
  const selfVisible =
    findBegin(base, scope.beginToolCallId) !== null &&
    station.findBeginEntry(scope.beginToolCallId) !== null;

  const parentId =
    state.scopes.length > 1
      ? state.scopes[state.scopes.length - 2].id
      : null;
  const order = scopeOrder(scope);
  const closed = closeScope(state, { toolCallId: call.id });
  if (!closed.ok) return errorResult(closed.code, closed.reason);

  // The closed scope becomes a pending elder at its parent level. In a
  // combined call begin.elder_report archives it immediately, so it opens as
  // the hot workbench; an end-only close leaves report null (pending).
  const archivedReport = hasBegin && selfVisible ? trimText(elderReport) : null;
  const report = archivedReport;
  if (selfVisible) {
    state.collapses.push({
      scopeId: scope.id,
      intent: scope.intent,
      beginToolCallId: scope.beginToolCallId,
      endToolCallId: call.id,
      report,
      parentId,
      order,
      boundary: scope.boundary ?? 0,
      epoch: scope.epoch ?? 0,
      collapsed: false,
      sealed: false,
      interiorTokens,
      interiorChars: measured.interiorChars,
      pinTokens: measured.pinTokens,
      paidRentCost: 0,
      baseInputTokens: baseTokens,
      preBeginInputTokens:
        Number.isFinite(scope.preBeginInputTokens) ? scope.preBeginInputTokens : null,
      endInputTokens,
      endInputTokensPending: endPending,
      createdAt: Date.now(),
    });
  }

  // Folding only happens on an opening call (begin-only or combined), never
  // on an end-only close. Archiving the current elder above makes the pool
  // eligibility advance by one sibling.
  if (hasBegin) {
    const poolParentId = parentId;
    foldEligiblePool(station, {
      state,
      parentId: poolParentId,
      boundary: scope.boundary ?? 0,
      epoch: scope.epoch ?? 0,
      args,
      base,
      currentMessage,
      currentPersisted,
    });
  }

  const deferred = closed.defers ?? [];
  const steerSent = station.deliverSteer(closed.steerText);
  const remainingScope = currentScope(state);
  let text = endText(
    "",
    null,
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
    if (opened.ok) {
      state.relay = invalidatePromotion(state.relay);
      opened.scope.preBeginInputTokens =
        Number.isFinite(station.lastTotalInput) ? station.lastTotalInput : null;
    }
  }
  return textResult(text, {
    scopeId: scope.id,
    deferred: deferred.length,
  });
}

/** Fold a whole eligible elder pool in one decision, when economics allow. */
function foldEligiblePool(station, { state, parentId, boundary, epoch, args, base, currentMessage, currentPersisted }) {
  const pool = findFoldablePool(state, parentId, boundary, epoch);
  if (pool.length === 0) return { foldedCount: 0 };
  const lastIn = Number.isFinite(station.lastTotalInput) ? station.lastTotalInput : null;
  const usageSnapshot =
    lastIn === null
      ? null
      : {
          lastTotalInput: lastIn,
          lastOutput: Number.isFinite(station.lastOutputTokens) ? station.lastOutputTokens : 0,
          cost: station.lastUsageCost ?? null,
        };
  const pricing = resolveModelPolicy(
    station.pricingCatalog,
    station.lastCtxModel ? { model: station.lastCtxModel } : undefined,
    { usage: station.lastUsageCost ? { cost: station.lastUsageCost } : undefined },
  );
  const decision = shouldFoldPool({
    pool,
    state,
    base,
    budget: args.begin?.budget,
    usageSnapshot,
    pricing,
    contextTokens: station.currentContextTokens?.() ?? lastIn,
    tokensPerChar: station.tokensPerChar?.() ?? 0.3,
    emergency: false,
  });
  if (!decision.fold) return { foldedCount: 0 };
  const folded = station.foldBatch({
    batch: pool,
    base,
    currentMessage,
    currentPersisted,
    epoch,
  });
  if (folded.rebased) station.rebaseBaselines?.(folded);
  return folded;
}

export { handleRegretCall, handleDeferCall, handlePinCall, handleScopeCall };
