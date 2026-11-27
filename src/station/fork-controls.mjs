// Fork control handler: scope_fork.
//
// Plain synchronous function. The bracket ledger arrives through a port and the
// child spawner arrives through another, so a station that has neither refuses
// instead of inventing one.

import {
  forkOf,
  markReady,
  registerFork,
  unreceivedChildren,
} from "../scope/forkjoin.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { createClockOn } from "../scope/clock.mjs";
import { deriveTimeBudgetSeconds, modelSamples } from "../scope/turn-stats.mjs";
import { decideRegister, validateForkBatch } from "./domain/fork-join.mjs";
import { resetRootPromotion } from "./domain/handoff.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { parseArgs } from "./messages.mjs";
import {
  REFUSAL_KEY,
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
    const where = batch.index >= 0 ? ` (forks[${batch.index}])` : "";
    return errorResult(
      batch.code,
      `${E[REFUSAL_KEY[batch.code]] ?? "Invalid fork arguments."}${where}`,
    );
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

  const identityCharsOf = (item) => {
    const profession = typeof item.profession === "string" ? item.profession.trim() : "";
    return profession === "" ? 0 : profession.length + 1;
  };

  const priceFor = (item) => {
    const fresh =
      childReceiptText({
        path: item.path,
        upscopePath: item.upscopePath,
        callerPath: item.callerPath,
        childDepth: depth + 1,
        fsm: item.fsm,
        budget: item.budget,
        targets: item.targets,
      }).length + identityCharsOf(item);
    return { fresh, revive: 0, generation: 0 };
  };

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
    if (decision.code === "INVALID_PATH") {
      const where = decision.index >= 0 ? ` (forks[${decision.index}])` : "";
      return errorResult(
        decision.code,
        `${E["invalid-path"] ?? "Pass a valid scope `path`."}${where}`,
        { index: decision.index, path: decision.path },
      );
    }
    if (decision.code === "DUPLICATE_SCOPE_PATH") {
      return errorResult(
        decision.code,
        render(E["duplicate-scope-path"], {
          path: decision.path,
          status: decision.status ?? "existing",
        }),
        { index: decision.index, path: decision.path, status: decision.status },
      );
    }
    if (decision.code === "UNKNOWN_UPSCOPE") {
      return errorResult(
        decision.code,
        render(E["unknown-upscope"], { upscopePath: decision.upscopePath }),
        { index: decision.index, upscopePath: decision.upscopePath },
      );
    }
    if (decision.code === "UPSCOPE_NOT_READY") {
      return errorResult(
        decision.code,
        render(E["upscope-not-ready"], { upscopePath: decision.upscopePath }),
        { index: decision.index, upscopePath: decision.upscopePath },
      );
    }
    if (decision.code === "CHILD_SPAWNER_UNAVAILABLE") {
      return errorResult(decision.code, E["child-spawner-unavailable"]);
    }
    if (decision.code === "FORK_CONTEXT_EXCEEDED") {
      return errorResult(decision.code, render(E["fork-context-exceeded"], {
        index: decision.index,
        reason: decision.reason,
      }), {
        index: decision.index,
        admission: decision.admission,
        source: "measured",
        limit: decision.limit,
        projected: decision.projected,
        reserve: decision.reserve,
        margin: decision.margin,
        overBy: decision.overBy,
      });
    }
    const named = Array.isArray(decision.available) ? decision.available : [];
    const total = Number.isInteger(decision.availableTotal)
      ? decision.availableTotal
      : named.length;
    const available = named.length === 0
      ? "none"
      : `${named.join(", ")}${total > named.length ? `, and ${total - named.length} more` : ""}`;
    return errorResult(decision.code, render(E["model-unknown"], {
      index: decision.index,
      selector: decision.selector,
      available,
    }), {
      index: decision.index,
      selector: decision.selector,
      available: decision.available,
      availableTotal: decision.availableTotal,
    });
  }

  const callerOwnerId = ownerIdOf(station);
  const clock = typeof station.clockPort === "function" ? station.clockPort() : createClockOn();
  const turnModelKey = station.state?.baseModelKey ?? station.turnModelKey;
  const timeOf = (budget) =>
    deriveTimeBudgetSeconds({
      samples: modelSamples(ledger, turnModelKey),
      budget,
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

  function withProfession(receipt, profession) {
    if (typeof profession !== "string" || profession.trim() === "") return receipt;
    const lines = receipt.split("\n");
    lines.splice(1, 0, profession.trim());
    return lines.join("\n");
  }

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
      time: timeOf(item.budget),
      startedAt: Date.now(),
      targets: item.targets,
      birthContextTokens: item.birthContextTokens,
      contextWindow: item.contextWindow,
      resolvedModel: item.resolvedModel,
      resolvedThinking: item.resolvedThinking,
    }, { clock });
    if (!registered.ok) {
      failed.push({
        forkId,
        path: item.path,
        fsm: item.fsm,
        reason: render(E["fork-register-failed"], { code: registered.code }),
      });
      continue;
    }
    const fork = registered.fork;
    const spec = specOf(fork, item);
    spec.receipt = withProfession(
      childReceiptText({
        path: fork.path,
        upscopePath: fork.upscopePath,
        callerPath: fork.callerPath,
        childDepth: fork.childDepth,
        fsm: item.fsm,
        budget: fork.budget,
        targets: fork.targets,
      }),
      spec.profession,
    );
    pending.push({
      forkId: fork.forkId,
      path: fork.path,
      upscope: fork.upscopePath,
      fsm: item.fsm,
      childDepth: fork.childDepth,
      spec,
    });
  }

  for (const entry of pending) {
    try {
      spawner(entry.spec);
      started.push({
        forkId: entry.forkId,
        path: entry.path,
        upscope: entry.upscope,
        fsm: entry.fsm,
        childDepth: entry.childDepth,
      });
    } catch (error) {
      const reason = String(error?.message ?? error);
      failed.push({
        forkId: entry.forkId,
        path: entry.path,
        fsm: entry.fsm,
        reason,
      });
      markReady(ledger, entry.forkId, { ok: false, reason: `did not start: ${reason}` });
    }
  }

  if (started.length > 0 && callerOwnerId === "root" && station.state?.relay) {
    const reset = resetRootPromotion(station.state.relay);
    if (reset.changed) station.state.relay = reset.relay;
  }

  const sections = [];
  if (started.length > 0) {
    sections.push(
      [
        `Started (${started.length}) at depth ${depth}:`,
        ...started.map(
          (entry) =>
            `- ${publicScopeId(forkOf(ledger, entry.forkId))} (upscope ${entry.upscope}, depth ${entry.childDepth}): ${entry.fsm}`,
        ),
      ].join("\n"),
    );
  }
  if (failed.length > 0) {
    sections.push(
      [
        `Failed to start (${failed.length}):`,
        ...failed.map((entry) => `- ${entry.path}: ${entry.fsm} — ${entry.reason}`),
      ].join("\n"),
    );
  }
  const unreceived = unreceivedChildren(ledger, callerOwnerId)
    .map((id) => publicScopeId(forkOf(ledger, id)));
  if (unreceived.length > 0) {
    sections.push(
      `Still unreceived: ${unreceived.join(", ")}. Join them with scope_join before returning.`,
    );
  }

  return textResult(sections.join("\n\n"), {
    started: started.map((entry) => entry.forkId),
    failed: failed.map((entry) => entry.forkId),
    result: {
      ok: failed.length === 0,
      started: started.map((entry) => ({
        path: entry.path,
        upscope: entry.upscope,
        depth: entry.childDepth,
        fsm: entry.fsm,
      })),
      failed: failed.map((entry, index) => ({
        index,
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
  handleJoinCall,
  renderJoinResult,
} from "./join-controls.mjs";
export { handleReturnCall } from "./return-controls.mjs";
export { handleAbandonCall } from "./abandon-controls.mjs";
