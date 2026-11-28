// Fork control handler: scope_fork.
//
// Plain synchronous function. The bracket ledger arrives through a port and the
// child spawner arrives through another, so a station that has neither refuses
// instead of inventing one. Every refusal comes from `./errors.mjs`: the code,
// its documentation entry and its structured details are one table there, so a
// handler never holds a second copy of the wording.

import { forkOf } from "../scope/ledger-charge.mjs";
import {
  markReady,
  registerFork,
  unreceivedChildren,
} from "../scope/ledger-brackets.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { createClockOn } from "../scope/clock.mjs";
import { deriveTimeBudgetSeconds, modelSamples } from "../scope/turn-stats.mjs";
import { decideRegister, validateForkBatch } from "./domain/fork-join.mjs";
import { resetRootPromotion } from "./domain/handoff.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { batchRefusal, refusal } from "./errors.mjs";
import { parseArgs } from "./messages.mjs";
import {
  childReceiptText,
  depthOf,
  densityOf,
  frameOf,
  identityOf,
  ledgerOf,
  levelKeyOf,
  measuredBase,
  ownerIdOf,
  windowOf,
} from "./fork-reads.mjs";

const E = loadDoc("errors");

/**
 * Open one or more subscopes. Never blocks: the caller keeps its depth, its
 * model, and its own work.
 */
export function handleForkCall(station, call, options = {}) {
  const args = parseArgs(call);
  const batch = validateForkBatch(args);
  if (!batch.ok) {
    const denied = batchRefusal(batch);
    return errorResult(denied.code, denied.message);
  }
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  const depth = depthOf(station);
  const spawner =
    typeof station.childSpawnPort === "function" ? station.childSpawnPort() : null;
  const callerForkId = identityOf(station)?.forkId ?? null;
  const callerRecord = callerForkId === null ? null : forkOf(ledger, callerForkId);
  const callerPath = callerRecord?.path ?? "/";

  // One receipt per item, rendered once and read twice. Pricing the receipt and
  // then re-rendering it for the spawn made the two texts the same only by luck;
  // the identity line is part of the text, so a renderer that grew a line would
  // have changed the price without changing what the child reads.
  const receipts = new Map();
  const receiptFor = (item) => {
    let text = receipts.get(item);
    if (text === undefined) {
      text = childReceiptText({
        path: item.path,
        upscopePath: item.upscopePath,
        callerPath: item.callerPath,
        childDepth: depth + 1,
        fsm: item.fsm,
        profession: item.profession ?? "",
        budget: item.budget,
        targets: item.targets,
      });
      receipts.set(item, text);
    }
    return text;
  };

  const priceFor = (item) => ({ fresh: receiptFor(item).length, revive: 0, generation: 0 });

  const decision = decideRegister({
    items: batch.items,
    forks: ledger.order.map((id) => forkOf(ledger, id)),
    root: ledger.root ?? null,
    ownerId: ownerIdOf(station),
    callerPath,
    models: options.models ?? station.host?.model?.query?.(options.ctx) ?? null,
    hasSpawner: typeof spawner === "function",
    priceFor,
    baseTokens: measuredBase(station),
    tokensPerChar: densityOf(station),
    window: windowOf(station),
    reserve: station.forkReservePort?.(),
    margin: station.forkMarginPort?.(),
  });

  if (!decision.ok) {
    const denied = refusal(decision, { callerPath });
    return errorResult(denied.code, denied.message, denied.details);
  }

  const callerOwnerId = ownerIdOf(station);
  const clock = typeof station.clockPort === "function" ? station.clockPort() : createClockOn();
  const turnModelKey = station.state?.baseModelKey ?? station.turnModelKey;
  const timeOf = (budget, n) =>
    deriveTimeBudgetSeconds({
      samples: modelSamples(ledger, turnModelKey),
      budget,
      n,
    });
  const baseId = typeof call.id === "string" && call.id !== "" ? call.id : `fork-${Date.now()}`;
  const started = [];
  const failed = [];
  const pending = [];

  const nextForkId = (index) => {
    const base = decision.items.length === 1 ? baseId : `${baseId}:${index}`;
    if (!Object.hasOwn(ledger.forks, base)) return base;
    return `${base}:${ledger.seq + index + 1}`;
  };

  const specOf = (fork, item) => ({
    forkId: fork.forkId,
    ownScopeId: fork.scopeId,
    scopeId: fork.scopeId,
    path: fork.path,
    upscopeId: fork.upscopeId,
    upscopePath: fork.upscopePath,
    callerId: callerOwnerId,
    callerPath: fork.callerPath,
    parentOwnerId: callerOwnerId,
    parentDepth: depth,
    childDepth: fork.childDepth,
    sourceToolCallId: item.sameCallerAsUpscope ? frameOf(call) : null,
    upscopeSnapshotLeafId: item.sameCallerAsUpscope ? null : item.upscopeSnapshotLeafId,
    fsm: fork.fsm,
    profession: item.profession ?? fork.profession ?? "",
    budget: fork.budget,
    time: fork.timeBudgetMs == null ? null : fork.timeBudgetMs / 1000,
    targets: fork.targets,
    model: fork.resolvedModel,
    modelOverride: item.modelOverride,
    thinkingLevel: item.thinkingLevel,
  });

  for (let index = 0; index < decision.items.length; index += 1) {
    const item = decision.items[index];
    const forkId = nextForkId(index);
    const registered = registerFork(ledger, {
      forkId,
      scopeId: item.scopeId,
      path: item.path,
      upscopeId: item.upscopeId,
      upscopePath: item.upscopePath,
      ownerId: callerOwnerId,
      callerPath: item.callerPath,
      levelKey: levelKeyOf(station),
      fsm: item.fsm,
      profession: item.profession,
      depth,
      budget: item.budget,
      time: timeOf(item.budget, item.n),
      startedAt: Date.now(),
      targets: item.targets,
      birthContextTokens: item.birthContextTokens,
      contextWindow: item.contextWindow,
      resolvedModel: item.resolvedModel,
      resolvedThinking: item.resolvedThinking,
    }, { clock });
    if (!registered.ok) {
      failed.push({
        index,
        forkId,
        reason: render(E["fork-register-failed"], { code: registered.code }),
      });
      continue;
    }
    const fork = registered.fork;
    const spec = specOf(fork, item);
    spec.receipt = receiptFor(item);
    pending.push({
      index,
      forkId: fork.forkId,
      childDepth: fork.childDepth,
      spec,
    });
  }

  for (const entry of pending) {
    try {
      spawner(entry.spec);
      started.push({
        index: entry.index,
        forkId: entry.forkId,
        childDepth: entry.childDepth,
      });
    } catch (error) {
      const reason = String(error?.message ?? error);
      failed.push({
        index: entry.index,
        forkId: entry.forkId,
        reason,
      });
      markReady(ledger, entry.forkId, { ok: false, reason: `did not start: ${reason}` });
    }
  }

  if (started.length > 0 && callerOwnerId === "root" && station.state?.relay) {
    const reset = resetRootPromotion(station.state.relay);
    if (reset.changed) station.state.relay = reset.relay;
  }

  const unreceived = unreceivedChildren(ledger, callerOwnerId)
    .map((id) => publicScopeId(forkOf(ledger, id)));
  return textResult("scope_fork processed.", {
    result: {
      ...(started.length > 0 ? { depth: started[0].childDepth } : {}),
      started: started.map((entry) => entry.index),
      failed: failed.map((entry) => ({
        index: entry.index,
        error: entry.reason,
      })),
      unreceived,
    },
  });
}

export {
  admitJoin,
  childReceiptText,
  childRecordStart,
  depthOf,
  levelKeyOf,
  ownerIdOf,
} from "./fork-reads.mjs";
export {
  confirmJoinPersistence,
  finalizeJoinRecord,
  handleJoinCall,
  renderJoinResult,
} from "./join-controls.mjs";
export { handleReturnCall } from "./return-controls.mjs";
export { handleAbandonCall } from "./abandon-controls.mjs";
