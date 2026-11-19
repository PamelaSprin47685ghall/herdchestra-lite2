// Station control handlers: scope, regret, defer, and pin arguments.
// Plain synchronous functions. The station owns the state; this module owns
// the argument validation and the resulting text.

import {
  applyRegret,
  beginScope,
  closeScope,
  createState,
  currentScope,
  findActivePools,
  findFoldablePool,
  findPendingReportElder,
  sealClosedParentChildren,
  scopeOrder,
} from "../scope/index.mjs";
import { DECISION_FRAMING, NORMAL_STAGES } from "../scope/stages.mjs";
import { applyCollapses, findBegin, findToolCallIndex } from "../transcript/index.mjs";
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
  sliceChars,
} from "./fold.mjs";
import { modelChoice, queueModelSwitch } from "./models.mjs";

import { loadDoc, render } from "../prompts/index.mjs";
import { applyStageBegin, missingStages } from "../scope/stage-flags.mjs";

const E = loadDoc("errors");
const L = loadDoc("labels");

function handleRegretCall(station, call, base, currentIndex) {
  const state = station.state;
  const args = parseArgs(call);
  const reflection = trimText(args.reflection);
  if (!reflection) {
    return errorResult("INVALID_ARGUMENT", E["regret-reflection"], {
      field: "reflection",
    });
  }
  const scope = currentScope(state);
  if (!scope) {
    return errorResult("NOT_IN_SCOPE", E["regret-scope"]);
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
    return errorResult("INVALID_ARGUMENT", E["defer-intent"], { field: "intent" });
  }
  const out = station.deferIntent(call.id, intent);
  if (!out.ok) return errorResult(out.code, out.reason);
  return textResult("OK");
}

function handlePinCall(station, call) {
  const args = parseArgs(call);
  const lines = [];
  for (const label of ["Assumption", "Deduction", "Induction", "Finding", "Conclusion"]) {
    const text = trimText(args[label.toLowerCase()]);
    if (text) lines.push(`**${label}:** ${text}`);
  }
  if (lines.length > 0) {
    station.state.pins.push(lines.join("\n\n"));
    station.persist();
  }
  return textResult("OK");
}

function handleScopeCall(station, call, { base, currentMessage, currentPersisted, sameMessageBeginIds, ctx }) {
  const state = station.state;
  const args = parseArgs(call);
  const hasBegin = args.begin !== undefined && args.begin !== null;
  const endPresent = args.end !== undefined && args.end !== null;
  const hasEnd = args.end === true;
  const rawModel = hasBegin ? args.begin?.model : null;
  if (rawModel != null && (typeof rawModel !== "string" || !rawModel.trim())) {
    return errorResult("INVALID_ARGUMENT", E["scope-model"], { field: "model" });
  }
  // Only a non-boolean end is illegal. `end: false` means "do not close" and
  // is valid alongside begin; without begin it simply does nothing.
  if (endPresent && typeof args.end !== "boolean") {
    return errorResult(
      "INVALID_ARGUMENT",
      E["scope-end-type"],
    );
  }
  if (!hasBegin && !hasEnd) {
    return errorResult(
      "INVALID_ARGUMENT",
      endPresent ? E["scope-end-false"] : E["scope-neither"],
    );
  }
  const elderReport = hasBegin ? args.begin?.elder_report : undefined;
  if (hasBegin && elderReport !== undefined && elderReport !== null && typeof elderReport !== "string") {
    return errorResult(
      "INVALID_ARGUMENT",
      E["scope-elder-report"],
      { field: "elder_report" },
    );
  }
  // A preceding todo can request handoff after batch preflight.
  if (hasBegin && !state.herdMode && state.relay?.handoffPending) {
    return errorResult(
      "RELAY_HANDOFF_PENDING",
      E["scope-handoff-pending"],
    );
  }

  // Poka-yoke only: "rw" means the scope may write; "ro" is a trusted
  // declaration and is never enforced. An omitted (or null) permission is
  // treated as "rw", because forgetting to declare is exactly the mistake this
  // gate exists to catch; the handler must not depend on host-side schema
  // validation. The guard runs before any state transition, so a refused begin
  // cannot damage the open scope.
  if (hasBegin) {
    const rawPermission = args.begin?.permission;
    if (rawPermission !== undefined && rawPermission !== null && rawPermission !== "ro" && rawPermission !== "rw") {
      return errorResult(
        "INVALID_ARGUMENT",
        E["scope-permission"],
        { field: "permission" },
      );
    }
    const declared = rawPermission ?? "rw";
    if (declared === "rw" && args.begin?.stage === DECISION_FRAMING) {
      return errorResult(
        "RW_IN_DECISION_FRAMING",
        E["rw-decision-framing"],
        { field: "permission", stage: args.begin?.stage },
      );
    }
    if (declared === "rw" && station.relayOn(ctx) && state.relay?.firstEvaluation === null) {
      return errorResult(
        "RW_BEFORE_LEDGER",
        E["rw-before-ledger"],
        {
          field: "permission",
          generation: state.relay?.generation ?? 0,
          firstEvaluation: state.relay?.firstEvaluation ?? null,
        },
      );
    }
  }

  const stage = args.begin?.stage;
  // Pre-validate an opening scope without touching live state so a failed
  // begin cannot damage the scope being closed in a combined call.
  if (hasBegin) {
    if (state.herdMode && stage !== DECISION_FRAMING) {
      return errorResult(
        "INVALID_STAGE",
        render(E["herd-only-framing"], { stage: DECISION_FRAMING }),
      );
    }
    if (!state.herdMode && !NORMAL_STAGES.includes(stage)) {
      return errorResult(
        "INVALID_STAGE",
        render(E["normal-stage"], { stages: NORMAL_STAGES.join(" | ") }),
      );
    }
    if (stage === "direct-execution") {
      const missing = missingStages(state.stageFlags);
      if (missing.length > 0) {
        return errorResult(
          "STAGE_FLAGS_UNMET",
          render(E["stage-flags-unmet"], { missing: missing.join(", ") }),
        );
      }
    }
    const validation = beginScope(createState(), {
      toolCallId: call.id,
      intent: args.begin?.intent,
      stage,
      budget: args.begin?.budget,
    });
    if (!validation.ok) return errorResult(validation.code, validation.reason);
  }

  station.observeActualModel(ctx);
  const current = currentScope(state);
  const from = modelChoice(station, ctx, current?.modelSpec ?? state.baseModelSpec, current?.modelKey ?? state.baseModelKey);
  const parent = state.scopes.at(-2);
  const outer = hasEnd && current
    ? modelChoice(station, ctx, parent?.modelSpec ?? current.previousModelSpec ?? state.baseModelSpec,
      parent?.modelKey ?? current.previousModelKey ?? state.baseModelKey)
    : from;
  const target = rawModel == null ? outer : modelChoice(station, ctx, rawModel);
  const changingModel = target.spec !== from.spec && (!target.key || !from.key || target.key !== from.key);
  const projectedTokens = target.window > 0 ? station.currentContextTokens(base, target.key) : null;
  const beginFlood = hasBegin && target.window > 0 && projectedTokens >= 0.82 * target.window;
  const returnFlood = hasEnd && !hasBegin && changingModel && target.window > 0 &&
    (!from.window || target.window < from.window) && projectedTokens >= 0.82 * target.window;
  const foldContext = { state, args, base, currentMessage, currentPersisted, target, ctx };
  // The level whose siblings are archived is the parent of the active scope:
  // for a begin-only call it is the current scope id (the new scope is nested);
  // for closing it is the parent level of the closing scope.
  const beginParentId = current?.id ?? null;
  const boundary = state.relay?.generation ?? 0;
  const epoch = state.epoch ?? 0;

  // --- Begin only ---------------------------------------------------------
  if (hasBegin && !hasEnd) {
    const pending = findPendingReportElder(state, beginParentId, boundary, epoch);
    let visible = false;
    if (pending) {
      visible =
        findBegin(base, pending.beginToolCallId) !== null &&
        station.findBeginEntry(pending.beginToolCallId) !== null;
      if (visible) {
        if (!(typeof elderReport === "string" && trimText(elderReport))) {
          return errorResult(
            "MISSING_ELDER_REPORT",
            E["missing-elder-report"],
            { intent: pending.intent },
          );
        }
      }
    }
    if (beginFlood) {
      const overflow = prepareWindow(station, foldContext, projectedTokens, state);
      if (overflow) return overflow;
    }
    if (pending) {
      if (visible) {
        pending.report = trimText(elderReport);
        pending.sealed = false;
      } else {
        // The pending elder's interior left the branch; never ask for a
        // report about a scope the model cannot see.
        pending.sealed = true;
      }
    }
    if (!beginFlood) foldEligiblePool(station, { ...foldContext, parentId: beginParentId, boundary, epoch });
    const out = beginScope(state, {
      toolCallId: call.id,
      intent: args.begin?.intent,
      stage,
      budget: args.begin?.budget,
    });
    if (!out.ok) return errorResult(out.code, out.reason);
    state.stageFlags = applyStageBegin(state.stageFlags, stage);
    if (!state.herdMode) state.relay = invalidatePromotion(state.relay);
    attachModel(station, out.scope, target, outer, from);
    out.scope.preBeginInputTokens =
      Number.isFinite(station.lastTotalInput) ? station.lastTotalInput : null;
    return textResult(beginText(out.scope));
  }

  // --- End (only or combined) ---------------------------------------------
  const scope = currentScope(state);
  if (!scope) {
    return errorResult("NOT_IN_SCOPE", E["scope-end-outside"]);
  }
  if (sameMessageBeginIds?.has(scope.beginToolCallId)) {
    return errorResult(
      "SAME_MESSAGE_BOUNDARY",
      E["same-message"],
    );
  }
  // In a combined call the elder report must be valid before anything closes.
  const selfVisible = findBegin(base, scope.beginToolCallId) !== null &&
    station.findBeginEntry(scope.beginToolCallId) !== null;
  if (hasBegin) {
    if (selfVisible && !(typeof elderReport === "string" && trimText(elderReport))) {
      return errorResult(
        "MISSING_ELDER_REPORT",
        E["missing-elder-report"],
        { intent: scope.intent },
      );
    }
  }

  const parentId = state.scopes.at(-2)?.id ?? null;
  const order = scopeOrder(scope);
  if (beginFlood) {
    const preview = { ...state, scopes: state.scopes.slice(0, -1), collapses: state.collapses.slice() };
    if (selfVisible) preview.collapses.push({ parentId, order, boundary: scope.boundary, epoch: scope.epoch, collapsed: false });
    const overflow = prepareWindow(station, foldContext, projectedTokens, preview);
    if (overflow) return overflow;
  }

  sealClosedParentChildren(state, scope.id);

  const measured = measureScopeInterior(
    base,
    scope.beginToolCallId,
    call.id,
    state.regrets,
    station.tokensPerCharFor(station.lastUsageModelKey ?? from.key),
  );
  const baseTokens = Number.isFinite(scope.baseInputTokens) ? scope.baseInputTokens : null;
  const usageArrived = station.usageArrivedFor?.(currentMessage) ?? Boolean(currentMessage?.usage);
  let interiorTokens = null;
  const endInputTokens = usageArrived && Number.isFinite(station.lastTotalInput) ? station.lastTotalInput : null;
  const endPending = !usageArrived;
  const measuredModelKey = usageArrived ? station.lastUsageModelKey : from.key;
  if (measuredModelKey && endInputTokens !== null && baseTokens !== null && scope.baseModelKey === measuredModelKey) {
    interiorTokens = Math.max(0, endInputTokens - baseTokens);
  } else {
    interiorTokens = Math.ceil(charsToTokens(measured.interiorChars, station.tokensPerCharFor(measuredModelKey)));
  }

  // A close is a state transition, not a history edit. The begin may be gone
  // after compaction, restore, or an earlier fork; close anyway and record a
  // collapse only when its begin is still addressable.
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
      measuredModelKey,
      baseModelKey: scope.baseModelKey,
      interiorChars: measured.interiorChars,
      pinTokens: measured.pinTokens,
      pinChars: measured.pinChars,
      userChars: measured.userChars,
      paidRentCost: 0,
      baseInputTokens: baseTokens,
      preBeginInputTokens:
        Number.isFinite(scope.preBeginInputTokens) ? scope.preBeginInputTokens : null,
      endInputTokens,
      endInputTokensPending: endPending,
      createdAt: Date.now(),
    });
  }

  if (returnFlood) {
    floodPools(station, foldContext);
  } else if (!beginFlood && (hasBegin || changingModel)) {
    foldEligiblePool(station, {
      ...foldContext,
      parentId,
      boundary: scope.boundary ?? 0,
      epoch: scope.epoch ?? 0,
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
    station.relayReady() && !state.herdMode,
    state.herdMode,
  );
  if (hasBegin) {
    const opened = beginScope(state, {
      toolCallId: call.id,
      intent: args.begin.intent,
      stage,
      budget: args.begin.budget,
    });
    text += `\n\n${beginText(opened.scope)}`;
    if (opened.ok) {
      state.stageFlags = applyStageBegin(state.stageFlags, stage);
      if (!state.herdMode) state.relay = invalidatePromotion(state.relay);
      attachModel(station, opened.scope, target, outer, from);
      opened.scope.preBeginInputTokens =
        Number.isFinite(station.lastTotalInput) ? station.lastTotalInput : null;
    }
  } else queueModelSwitch(station, target, from, remainingScope?.id ?? null);
  return textResult(text, {
    scopeId: scope.id,
    deferred: deferred.length,
  });
}

function attachModel(station, scope, target, outer, from) {
  scope.modelSpec = target.spec;
  scope.modelKey = target.key;
  scope.previousModelSpec = outer.spec;
  scope.previousModelKey = outer.key;
  queueModelSwitch(station, target, from, scope.id);
}

function floodBatch(state) {
  return findActivePools(state).flatMap(({ pool }) => pool).sort((a, b) => a.order - b.order);
}

function prepareWindow(station, { base, target, state, currentMessage, currentPersisted }, projected, preview) {
  const cut = currentPersisted === false && base.at(-1) === currentMessage ? base.length - 1 : base.length;
  const batch = floodBatch(preview).filter((rec) => {
    const begin = findBegin(base, rec.beginToolCallId);
    const end = findToolCallIndex(base, rec.endToolCallId);
    return begin && end > begin.resultIndex && end < cut && station.findBeginEntry(rec.beginToolCallId);
  });
  const after = applyCollapses(base, batch.map((rec) => ({ ...rec, collapsed: true })), state.epoch);
  const removedChars = Math.max(0, sliceChars(base) - sliceChars(after));
  const postFoldTokens = Math.max(0, projected - charsToTokens(removedChars, station.tokensPerCharFor(target.key)));
  if (postFoldTokens >= 0.95 * target.window) return windowError(target, postFoldTokens);
  if (batch.length === 0) return;
  const folded = station.foldBatch({ batch, base, currentMessage, currentPersisted, epoch: state.epoch });
  if (folded.rebased) station.rebaseBaselines(folded);
  const actuallyRemoved = folded.rebased ? folded.savedChars ?? removedChars : 0;
  const actualTokens = Math.max(0, projected - charsToTokens(actuallyRemoved, station.tokensPerCharFor(target.key)));
  if (actualTokens >= 0.95 * target.window) return windowError(target, actualTokens);
}

function windowError(target, postFoldTokens) {
  return errorResult(
    "MODEL_CONTEXT_EXCEEDED",
    render(E["context-exceeded"], {
      tokens: postFoldTokens,
      model: target.spec ?? L["target-model"],
      window: target.window,
    }),
    { postFoldTokens, contextWindow: target.window },
  );
}

function floodPools(station, { state, base, currentMessage, currentPersisted }) {
  const batch = floodBatch(state);
  if (batch.length === 0) return;
  const folded = station.foldBatch({ batch, base, currentMessage, currentPersisted, epoch: state.epoch });
  if (folded.rebased) station.rebaseBaselines(folded);
}

/** Fold a whole eligible elder pool in one decision, when economics allow. */
function foldEligiblePool(station, { state, parentId, boundary, epoch, args, base, currentMessage, currentPersisted, target, ctx }) {
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
          modelKey: station.lastUsageModelKey,
        };
  const pricing = target.pricing ?? resolveModelPolicy(
    station.pricingCatalog,
    target.key === station.lastUsageModelKey && station.lastCtxModel ? { model: station.lastCtxModel } : undefined,
    target.key === station.lastUsageModelKey ? station.usagePricingHint() : undefined,
  );
  const decision = shouldFoldPool({
    pool,
    state,
    base,
    budget: args.begin?.budget,
    usageSnapshot,
    pricing,
    contextTokens: station.currentContextTokens(base, target.key),
    tokensPerChar: station.tokensPerCharFor(target.key),
    modelKey: target.key,
    outerModels: [
      modelChoice(station, ctx, state.baseModelSpec, state.baseModelKey),
      ...state.scopes.map((scope) => modelChoice(station, ctx, scope.modelSpec, scope.modelKey)),
    ],
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
