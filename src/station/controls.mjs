// Station control handlers: scope, amend, defer, and pin arguments.
// Plain synchronous functions. The station owns the state; this module owns
// the argument validation and the resulting text.

import {
  applyAmend,
  closeScope,
  currentScope,
  findActivePools,
  findFoldablePool,
  findPendingReportElder,
  sealClosedParentChildren,
  scopeOrder,
  splitFissionBudget,
  validateFission,
} from "../scope/index.mjs";
import { MAIN_AGENT } from "../host/policy.mjs";
import { findBegin } from "../transcript/index.mjs";
import { invalidatePromotion } from "../relay/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { parseArgs, trimText } from "./messages.mjs";
import { amendText, endText } from "./texts.mjs";
import {
  charsToTokens,
  resolveModelPolicy,
} from "../host/pricing.mjs";
import {
  measureScopeInterior,
  shouldFoldPool,
} from "./fold.mjs";
import { modelChoice, queueModelSwitch } from "./models.mjs";
import { ownerRetirement, retiredOwnerReason } from "./retirement.mjs";

import { loadDoc, render } from "../prompts/index.mjs";
import { applyStageBegin, missingStages } from "../scope/stage-flags.mjs";
import { DECISION_FRAMING, NORMAL_STAGES } from "../scope/stages.mjs";

const E = loadDoc("errors");

function handleAmendCall(station, call, base, currentIndex) {
  const state = station.state;
  if (station.fissionFlow) {
    return errorResult("AMEND_UNAVAILABLE_IN_FISSION", "Amend is unavailable in fission because rewriting shared history can overwrite another flow's entries.");
  }
  const args = parseArgs(call);
  const reflection = trimText(args.reflection);
  if (!reflection) {
    return errorResult("INVALID_ARGUMENT", E["amend-reflection"], {
      field: "reflection",
    });
  }
  const scope = currentScope(state);
  if (!scope) {
    return errorResult("NOT_IN_SCOPE", E["amend-scope"]);
  }
  const target = station.findAmendTarget(base, currentIndex, scope);
  if (!target.ok) return errorResult(target.code, target.reason);
  const applied = applyAmend(state, {
    scopeId: scope.id,
    beat: target.beat,
    toolCalls: target.toolCalls,
  });
  if (!applied.ok) return errorResult(applied.code, applied.reason);
  applied.scope = currentScope(state);
  return textResult(amendText(applied, reflection), { refunded: applied.refunded });
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

/** True when the model can still see the elder's begin on the branch. */
function elderBeginVisible(station, record) {
  if (typeof station.findBeginEntry !== "function") return false;
  const entry = station.findBeginEntry(record.beginToolCallId);
  return entry !== null && entry !== undefined;
}

/**
 * Stage refusals carry the concrete stage names. The scope domain answers
 * with a bare code, so this layer renders the prompt text: the stage the
 * model may choose, or the stages still missing before execution.
 */
function fissionRefusalText(state, validation) {
  if (validation.code === "INVALID_STAGE") {
    return state.herdMode
      ? render(E["herd-only-framing"], { stage: DECISION_FRAMING })
      : render(E["normal-stage"], { stages: NORMAL_STAGES.join(" | ") });
  }
  if (validation.code === "STAGE_FLAGS_UNMET") {
    const missing = missingStages(state.stageFlags);
    return render(E["stage-flags-unmet"], { missing: missing.join(", ") });
  }
  return validation.reason;
}

/**
 * Register one effective fission batch with the injected scheduler and reserve
 * its budgets. Validation is complete before the first mutation. The owner
 * retires from the `tool_result` hook, which runs inside the tool execute
 * before the receipt is emitted; the loop still commits this tool's result
 * afterwards, so this handler never claims the flows started.
 */
function handleFissionBegin(station, call, { args, ctx }) {
  const state = station.state;
  if (args.end === true) {
    return errorResult("INVALID_ARGUMENT", "A fission begin cannot also close a scope.");
  }
  // Retirement is a permanent fact for this owner identity. A started turn
  // that arrives after the receipt must not open a second batch; only the
  // batch's flows or its adopted heir may act again.
  const retirement = ownerRetirement(station, ctx);
  if (retirement) return errorResult(retirement.code, retirement.reason);
  if (station.pendingFission) {
    if (station.pendingFission.retired === true) {
      return errorResult("OWNER_RETIRED", retiredOwnerReason(station.pendingFission.batchId));
    }
    return errorResult("FISSION_BATCH_PENDING", "A fission batch from this agent has not retired yet; wait for its receipt.");
  }
  const begin = args.begin;
  const options = {
    mainAgent: station.policy(ctx) === MAIN_AGENT,
    relayOn: station.relayOn(ctx),
  };
  const validation = validateFission(state, begin, options);
  if (!validation.ok) {
    return errorResult(validation.code, fissionRefusalText(state, validation));
  }
  // A preceding todo can request a handoff after batch preflight. From then
  // on the handoff owns the session, so the opening is refused before any
  // scheduler or retirement check can answer with a lesser error.
  if (!state.herdMode && state.relay?.handoffPending) {
    return errorResult("RELAY_HANDOFF_PENDING", E["scope-handoff-pending"]);
  }

  // An unarchived elder at the level this batch will occupy must be reported
  // before any flow opens: the flows begin beneath this receipt, no later
  // sibling comes back for the elder, and a report given to an unseen scope
  // would only be invented. The elder whose begin already left the branch is
  // sealed instead, exactly as a host boundary retires it.
  const elderReport =
    typeof begin.elder_report === "string" ? trimText(begin.elder_report) : null;
  const parentScope = currentScope(state);
  const boundary =
    Number.isInteger(state.relay?.generation) && state.relay.generation >= 0
      ? state.relay.generation
      : 0;
  const epoch = Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0;
  const pendingElder = findPendingReportElder(
    state,
    parentScope?.id ?? null,
    boundary,
    epoch,
  );
  const elderVisible = pendingElder !== null && elderBeginVisible(station, pendingElder);
  if (elderVisible && !elderReport) {
    return errorResult("MISSING_ELDER_REPORT", E["missing-elder-report"], {
      field: "elder_report",
    });
  }

  // Retirement has two halves: the scheduler must know the batch, and the
  // host context must expose the abort that ends this agent's run. `ctx.agent`
  // is only an identity object, so the abort is the context's own operation.
  if (!ctx || typeof ctx.abort !== "function") {
    return errorResult("FISSION_UNAVAILABLE", "Fission cannot start: the host context exposes no abort() for owner retirement.");
  }
  const scheduler = station.registry?.fissionScheduler?.();
  if (!scheduler || typeof scheduler.registerBatch !== "function" || typeof scheduler.retireOwner !== "function") {
    return errorResult("FISSION_UNAVAILABLE", "Fission cannot start: no fission scheduler is attached to the station registry.");
  }

  const stage = begin.stage;
  let registered;
  try {
    registered = scheduler.registerBatch({
      toolCallId: call.id,
      sessionManager: station.manager,
      identity: ctx.agent ?? null,
      station,
      ctx,
      begin,
      flows: validation.items,
      totals: validation.totals,
      stage,
      elderReport,
      mainAgent: options.mainAgent,
      nested: Boolean(station.fissionFlow),
    });
  } catch (error) {
    return errorResult(error?.code ?? "FISSION_UNAVAILABLE", `Fission could not be registered: ${error?.message ?? error}`);
  }
  if (!registered || registered.ok !== true) {
    return errorResult(registered?.code ?? "FISSION_UNAVAILABLE", registered?.reason ?? "The fission scheduler refused the batch.");
  }

  // Reserving after registration keeps the scheduler able to cancel a batch
  // that never reserved a unit. A split failure here is a bug, not a path.
  const split = splitFissionBudget(state, begin, options);
  if (!split.ok) {
    try {
      scheduler.cancelBatch?.(registered.batchId);
    } catch {
      // The split refusal is the answer; a cancel failure adds nothing.
    }
    return errorResult(split.code, split.reason);
  }
  // The elder transition commits only after the batch is registered and its
  // budget is reserved: a refused batch must not archive or seal anything.
  if (pendingElder !== null) {
    if (elderVisible) pendingElder.report = elderReport;
    else pendingElder.sealed = true;
  }
  if (options.mainAgent) state.stageFlags = applyStageBegin(state.stageFlags, stage);
  if (!state.herdMode) state.relay = invalidatePromotion(state.relay);
  station.pendingFission = {
    batchId: registered.batchId,
    toolCallId: call.id,
    stage,
    flows: split.items,
    retired: false,
  };
  // The caller persists after this handler returns, before the tool_result hook
  // retires the owner, so the reserved budgets are on disk either way.
  return textResult(fissionBeginText(registered, split.items, stage), {
    batchId: registered.batchId,
    flows: split.items.length,
  });
}

function fissionBeginText(registered, flows, stage) {
  const lines = [
    `Fission batch ${registered.batchId} registered with ${flows.length} flow(s) in ${stage}.`,
  ];
  for (const [index, flow] of flows.entries()) {
    lines.push(`- flow ${index}: ${flow.intent}`);
  }
  lines.push(
    "The owner retires after this receipt. Each flow will open its own scope beneath the receipt, and the batch ends when every flow has closed.",
  );
  return lines.join("\n");
}

function handleScopeCall(station, call, { base, currentMessage, currentPersisted, sameMessageBeginIds, ctx }) {
  const state = station.state;
  const args = parseArgs(call);
  const hasBegin = args.begin !== undefined && args.begin !== null;
  const endPresent = args.end !== undefined && args.end !== null;
  const hasEnd = args.end === true;
  // Only a non-boolean end is illegal. `end: false` means "do not close" and
  // is valid alongside begin; without begin it simply does nothing. This runs
  // before the fission branch so a malformed end cannot skip the guard.
  if (endPresent && typeof args.end !== "boolean") {
    return errorResult("INVALID_ARGUMENT", E["scope-end-type"]);
  }
  const fissionBegin = hasBegin && Object.hasOwn(args.begin, "fission");
  if (fissionBegin) return handleFissionBegin(station, call, { args, ctx });
  if (station.fissionFlow) {
    if (hasEnd && !hasBegin) {
      const scheduler = station.registry?.fissionScheduler?.();
      if (typeof scheduler?.requestFlowEnd !== "function") {
        return errorResult("FISSION_SCHEDULER_UNAVAILABLE", "The flow scheduler is unavailable.");
      }
      try {
        scheduler.requestFlowEnd(station.fissionFlow.id);
        station.fissionFlow.endToolCallId = call.id;
        return textResult("Flow completion declared. The scheduler will close this scope after the tool result is persisted.");
      } catch (error) {
        return errorResult(error.code ?? "FISSION_END_FAILED", String(error.message ?? error));
      }
    }
    return errorResult(
      "SCOPE_UNAVAILABLE_IN_FISSION",
      "Use scope({ end: true }) to finish the flow, or open a nested fission batch.",
    );
  }
  if (hasBegin) {
    return errorResult(
      "INVALID_BEGIN_SHAPE",
      "A begin requires stage, elder_report, and fission. The single-flow begin shape no longer exists; to open one flow, pass a one-item fission array.",
    );
  }
  if (!hasEnd) {
    return errorResult(
      "INVALID_ARGUMENT",
      endPresent ? E["scope-end-false"] : E["scope-neither"],
    );
  }

  station.observeActualModel(ctx);
  const scope = currentScope(state);
  if (!scope) {
    return errorResult("NOT_IN_SCOPE", E["scope-end-outside"]);
  }
  const from = modelChoice(station, ctx, scope.modelSpec ?? state.baseModelSpec, scope.modelKey ?? state.baseModelKey);
  const parent = state.scopes.at(-2);
  const outer = modelChoice(station, ctx, parent?.modelSpec ?? scope.previousModelSpec ?? state.baseModelSpec,
    parent?.modelKey ?? scope.previousModelKey ?? state.baseModelKey);
  const target = outer;
  const changingModel = target.spec !== from.spec && (!target.key || !from.key || target.key !== from.key);
  const projectedTokens = target.window > 0 ? station.currentContextTokens(base, target.key) : null;
  const returnFlood = changingModel && target.window > 0 &&
    (!from.window || target.window < from.window) && projectedTokens >= 0.82 * target.window;
  const foldContext = { state, base, currentMessage, currentPersisted, target, ctx };

  // --- End -----------------------------------------------------------------
  if (sameMessageBeginIds?.has(scope.beginToolCallId)) {
    return errorResult(
      "SAME_MESSAGE_BOUNDARY",
      E["same-message"],
    );
  }
  const selfVisible = findBegin(base, scope.beginToolCallId) !== null &&
    station.findBeginEntry(scope.beginToolCallId) !== null;

  const parentId = state.scopes.at(-2)?.id ?? null;
  const order = scopeOrder(scope);

  sealClosedParentChildren(state, scope.id);

  const measured = measureScopeInterior(
    base,
    scope.beginToolCallId,
    call.id,
    state.amends,
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

  // The closed scope becomes a pending elder at its parent level. A close
  // writes no report; report stays null until a later begin archives it.
  const report = null;
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
  } else if (changingModel) {
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
  const text = endText(
    "",
    null,
    deferred.length,
    closed.steerText,
    steerSent,
    false,
    remainingScope,
    station.relayReady() && !state.herdMode,
    state.herdMode,
  );
  queueModelSwitch(station, target, from, remainingScope?.id ?? null);
  return textResult(text, {
    scopeId: scope.id,
    deferred: deferred.length,
  });
}

function floodBatch(state) {
  return findActivePools(state).flatMap(({ pool }) => pool).sort((a, b) => a.order - b.order);
}

function floodPools(station, { state, base, currentMessage, currentPersisted }) {
  const batch = floodBatch(state);
  if (batch.length === 0) return;
  const folded = station.foldBatch({ batch, base, currentMessage, currentPersisted, epoch: state.epoch });
  if (folded.rebased) station.rebaseBaselines(folded);
}

/** Fold a whole eligible elder pool in one decision, when economics allow. */
function foldEligiblePool(station, { state, parentId, boundary, epoch, base, currentMessage, currentPersisted, target, ctx }) {
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

export { handleAmendCall, handleDeferCall, handlePinCall, handleScopeCall };
