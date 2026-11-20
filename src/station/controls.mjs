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
import { findBegin, toolCalls } from "../transcript/index.mjs";
import { invalidatePromotion } from "../relay/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { parseArgs, trimText } from "./messages.mjs";
import { amendText, endText } from "./texts.mjs";
import {
  charsToTokens,
  preparseModelSpec,
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
 * Resolve the model, price, and window each flow will actually read the pool
 * with. A flow that names no model inherits its parent scope (or the base
 * model); a named one is preparsed so its pricing and window are known before
 * any flow starts.
 *
 * Using only `state.baseModelSpec` was wrong twice: a nested batch runs under a
 * different model than the base one, and every per-flow model was ignored, so
 * the economics priced the pool against a model no flow would use.
 */
function fissionTargets(station, ctx, items, parentScope, state) {
  const inherited = modelChoice(
    station,
    ctx,
    parentScope?.modelSpec ?? state.baseModelSpec,
    parentScope?.modelKey ?? state.baseModelKey,
  );
  return (Array.isArray(items) ? items : []).map((item) => {
    const budget = item?.budget ?? null;
    const spec = typeof item?.model === "string" ? item.model.trim() : "";
    if (!spec) return { ...inherited, budget };
    let parsed = null;
    try {
      parsed = preparseModelSpec(station.pricingCatalog, ctx, spec);
    } catch {
      parsed = null;
    }
    const key = parsed?.canonicalKey || spec;
    return {
      spec,
      key,
      window: Number.isFinite(parsed?.contextWindow) ? parsed.contextWindow : 0,
      pricing:
        parsed?.pricing ??
        resolveModelPolicy(station.pricingCatalog, { model: spec }),
      budget,
    };
  });
}

/**
 * A flow whose projected request no longer fits 95% of its window must not
 * open. The 82% mark only triggers the fold, which already ran; this check
 * judges the context the flows will actually send after that fold.
 */
function windowOverflow(station, base, targets, savedTokens = 0) {
  const reclaimed = Number.isFinite(savedTokens) ? Math.max(0, savedTokens) : 0;
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target?.key || !(target.window > 0)) continue;
    const projected =
      station.currentContextTokens(base, target.key) - reclaimed;
    if (projected >= 0.95 * target.window) return { target, projected };
  }
  return null;
}

/**
 * Register one effective fission batch with the injected scheduler and reserve
 * its budgets. Validation is complete before the first mutation. The owner
 * retires from the `tool_result` hook, which runs inside the tool execute
 * before the receipt is emitted; the loop still commits this tool's result
 * afterwards, so this handler never claims the flows started.
 */
function handleFissionBegin(station, call, { args, ctx, base, currentMessage, currentPersisted }) {
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

  // The elder transition runs before registration, not after it.
  //
  // Two reasons. The economics decision below is *about* the elder that just
  // received its report, so the report has to be committed first, exactly as
  // the pre-fission begin path ordered it. And a fold rewrites the branch from
  // the elder's begin, so performing it after `registerBatch` wrote the batch
  // boundary would leave that boundary dangling off the rebased branch.
  //
  // A refused registration therefore leaves the elder archived. That is the
  // lesser harm: the model did give its report, and the next begin must not
  // demand it a second time.
  if (pendingElder !== null) {
    if (elderVisible) pendingElder.report = elderReport;
    else pendingElder.sealed = true;
  }
  // The economics decision belongs to the begin path. Fission used to drop
  // this call entirely, so `shouldFoldPool` only ever ran on a model change at
  // scope end: pools kept accruing rent and never reached a decision.
  // Each flow reads the pool with its own model and pays its own budget's
  // worth of rent, so the decision is made per flow and any one of them may
  // justify the fold.
  const targets = fissionTargets(station, ctx, validation.items, parentScope, state);
  const folded = foldEligiblePool(station, {
    state,
    parentId: parentScope?.id ?? null,
    boundary,
    epoch,
    base,
    currentMessage,
    currentPersisted,
    targets,
    ctx,
  });
  const overflow = windowOverflow(station, base, targets, folded.savedTokens ?? 0);
  if (overflow) {
    return errorResult("CONTEXT_EXCEEDED", E["context-exceeded"], {
      model: overflow.target.key,
      projectedTokens: Math.round(overflow.projected),
      contextWindow: overflow.target.window,
    });
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
  if (options.mainAgent) state.stageFlags = applyStageBegin(state.stageFlags, stage);
  if (!state.herdMode) state.relay = invalidatePromotion(state.relay);
  // The scope call is an execution barrier, not only a gate: every call listed
  // after it in the same assistant message runs once in the owner's context,
  // and its result is copied to every flow in the batch. The owner must stay
  // alive until the last of those results arrives; only then may it retire.
  const beginCalls = toolCalls(currentMessage);
  const barrierIndex = beginCalls.findIndex((entry) => entry.id === call.id);
  const trailingCalls = barrierIndex >= 0 ? beginCalls.slice(barrierIndex + 1) : [];
  const trailingCallIds = trailingCalls.map((entry) => entry.id);
  station.pendingFission = {
    batchId: registered.batchId,
    toolCallId: call.id,
    stage,
    flows: split.items,
    retired: false,
    totals: validation.totals,
    trailingCallIds,
    remainingTrailingIds: new Set(trailingCallIds),
    trailingExecuted: [],
    scopeResultSeen: false,
    deadlineAt: Date.now() + Math.round(begin.time * 1000),
  };
  // The caller persists after this handler returns, before the tool_result hook
  // retires the owner, so the reserved budgets are on disk either way.
  return textResult(fissionBeginText(registered, split.items, stage), {
    batchId: registered.batchId,
    flows: split.items.length,
  });
}

function fissionBeginText(registered, flows, stage) {
  const T = loadDoc("receipts/scope");
  const flowLines = flows
    .map((flow, index) =>
      render(T["fission.flow-lines"], { index, intent: flow.intent }),
    )
    .join("\n");
  return render(T["fission.begin"], {
    batch: registered.batchId,
    flows: flows.length,
    stage,
    flow_lines: flowLines,
  });
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
  if (fissionBegin) {
    return handleFissionBegin(station, call, { args, ctx, base, currentMessage, currentPersisted });
  }
  if (station.fissionFlow) {
    if (hasEnd && !hasBegin) {
      const scheduler = station.registry?.fissionScheduler?.();
      if (typeof scheduler?.requestFlowEnd !== "function") {
        return errorResult("FISSION_SCHEDULER_UNAVAILABLE", "The flow scheduler is unavailable.");
      }
      try {
        scheduler.requestFlowEnd(station.fissionFlow.id);
        station.fissionFlow.endToolCallId = call.id;
        return textResult(loadDoc("receipts/scope")["fission.flow-end-declared"]);
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
    station.tokensPerCharFor(station.usage.lastUsageModelKey ?? from.key),
  );
  const baseTokens = Number.isFinite(scope.baseInputTokens) ? scope.baseInputTokens : null;
  const usageArrived = station.usageArrivedFor?.(currentMessage) ?? Boolean(currentMessage?.usage);
  let interiorTokens = null;
  const endInputTokens = usageArrived && Number.isFinite(station.usage.lastTotalInput) ? station.usage.lastTotalInput : null;
  const endPending = !usageArrived;
  const measuredModelKey = usageArrived ? station.usage.lastUsageModelKey : from.key;
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
      // The closing scope's own budget is the best available estimate of how
      // many further reads follow: without it budgetSteps() answers one step
      // and every decision becomes short-sighted.
      budget: scope.budget ?? null,
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
    station.relayReady() && !state.herdMode && state.relay?.fullFlow === true,
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

/**
 * Fold a whole eligible elder pool in one decision, when economics allow.
 *
 * `targets` names every model that will read the pool and the budget it will
 * read it with. Each one is judged separately: a flow's own model, cache
 * state, and remaining steps decide whether folding pays, and one flow that
 * pays is enough because the fold removes the same bytes for every reader.
 * `target`/`budget` keep the single-reader call sites unchanged.
 */
function foldEligiblePool(station, { state, parentId, boundary, epoch, base, currentMessage, currentPersisted, target, targets, ctx, budget }) {
  const pool = findFoldablePool(state, parentId, boundary, epoch);
  if (pool.length === 0) return { foldedCount: 0, savedTokens: 0 };
  const lastIn = Number.isFinite(station.usage.lastTotalInput) ? station.usage.lastTotalInput : null;
  const usageSnapshot =
    lastIn === null
      ? null
      : {
          lastTotalInput: lastIn,
          lastOutput: Number.isFinite(station.usage.lastOutputTokens) ? station.usage.lastOutputTokens : 0,
          cost: station.usage.lastUsageCost ?? null,
          modelKey: station.usage.lastUsageModelKey,
        };
  const list =
    Array.isArray(targets) && targets.length > 0
      ? targets
      : [{ ...(target ?? {}), budget: budget ?? target?.budget ?? null }];
  // Every model still on the stack holds its own provider cache and pays the
  // rebuild penalty when the fold rewrites the branch. Sibling flow targets
  // are outer models for each other for the same reason.
  const stackModels = [
    modelChoice(station, ctx, state.baseModelSpec, state.baseModelKey),
    ...state.scopes.map((scope) => modelChoice(station, ctx, scope.modelSpec, scope.modelKey)),
  ].map((choice) => ({ key: choice?.key ?? null, pricing: choice?.pricing ?? null }));
  let decided = false;
  for (const entry of list) {
    if (!entry?.key) continue;
    const sameAsMeasured =
      entry.key === station.usage.lastUsageModelKey && station.usage.lastCtxModel;
    const pricing = entry.pricing ?? resolveModelPolicy(
      station.pricingCatalog,
      sameAsMeasured ? { model: station.usage.lastCtxModel } : undefined,
      sameAsMeasured ? station.usagePricingHint() : undefined,
    );
    const decision = shouldFoldPool({
      pool,
      state,
      base,
      budget: entry.budget ?? budget,
      usageSnapshot,
      pricing,
      contextTokens: station.currentContextTokens(base, entry.key),
      tokensPerChar: station.tokensPerCharFor(entry.key),
      modelKey: entry.key,
      outerModels: [
        ...stackModels.filter((choice) => choice.key && choice.key !== entry.key),
        ...list
          .filter((sibling) => sibling?.key && sibling.key !== entry.key)
          .map((sibling) => ({ key: sibling.key, pricing: sibling.pricing ?? null })),
      ],
      emergency: false,
    });
    if (decision.fold) {
      decided = true;
      break;
    }
  }
  if (!decided) return { foldedCount: 0, savedTokens: 0 };
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
