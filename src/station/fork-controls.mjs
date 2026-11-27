// Fork control handler: scope_fork.
//
// Plain synchronous function. The bracket ledger arrives through a port and the
// child spawner arrives through another, so a station that has neither refuses
// instead of inventing one. Child agents are assembled by the host wiring, not
// here. The join, return, and abandon handlers live in their own files; the
// exported names below keep the split invisible to callers.

import {
  annotateFork,
  forkOf,
  markReady,
  registerFork,
  unreceivedChildren,
} from "../scope/forkjoin.mjs";
import { allocateSiblingScopeId, childScopePath } from "../scope/path.mjs";
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
 * Open one child scope. Never blocks: the parent keeps its depth, its model,
 * and its own work. Several forks may share one assistant message.
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
  // The address a child is born under: the caller's own path, and the caller's
  // fork id scopes the sibling namespace. The root has neither, so it sits at
  // `/` and owns the first level of names.
  const parentForkId = identityOf(station)?.forkId ?? null;
  const parentRecord = parentForkId === null ? null : forkOf(ledger, parentForkId);
  const parentPath = parentRecord?.path ?? "/";
  // Pricing mirrors the send loop: one number per receipt-sending path, and
  // zero for a path that sends nothing. The domain picks the number with the
  // same action it resolves, so every fork is priced by the text its child
  // actually reads. A price taken from a different record than the one sent is
  // a defect, not an approximation.
  const identityCharsOf = (item) => {
    const profession = typeof item.profession === "string" ? item.profession.trim() : "";
    return profession === "" ? 0 : profession.length + 1;
  };
  // Every fork creates, so the child's own start receipt is the only text this
  // call sends. The revive and generation keys stay zero: nothing spends them,
  // and admission must never price a receipt that no path will deliver.
  // Every name is allocated once, before anything is priced. The price must be
  // the length of the receipt that will actually be sent, and that receipt
  // names the final path; pricing a different name would under-count by the
  // prefix and by any rename suffix, admitting a receipt that does not fit.
  const allocations = [];
  {
    const taken = new Set();
    for (const item of batch.items) {
      const scopeId = allocateSiblingScopeId(ledger, parentForkId, item.scopeId, taken);
      taken.add(scopeId);
      allocations.push({ scopeId, path: childScopePath(parentPath, scopeId) });
    }
  }
  const pricedChars = batch.items.map((item, index) => {
    const path = allocations[index].path;
    const fresh =
      childReceiptText({
        scopeId: path,
        childDepth: depth + 1,
        fsm: item.fsm,
        budget: item.budget,
        targets: item.targets,
      }).length + identityCharsOf(item);
    return { fresh, revive: 0, generation: 0 };
  });
  const decision = decideRegister({
    items: batch.items,
    forks: ledger.order.map((id) => forkOf(ledger, id)),
    ownerId: ownerIdOf(station),
    parentForkId: identityOf(station)?.forkId ?? null,
    parentPath: parentPath,
    models: options.models ?? station.host?.model?.query?.(options.ctx) ?? null,
    hasSpawner: typeof spawner === "function",
    pricedChars,
    baseTokens: measuredBase(station),
    tokensPerChar: densityOf(station),
    window: windowOf(station),
    reserve: station.forkReservePort?.(),
    margin: station.forkMarginPort?.(),
  });
  if (!decision.ok) {
    if (decision.code === "FOREIGN_SCOPE_ID") {
      return errorResult(decision.code, render(E["foreign-scope-id"] || "That scope id belongs to another owner.", {
        scopeId: decision.scopeId,
      }));
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

  const blankFsm = decision.items.find(
    (item) => item.action === "create" && item.fsm === "",
  );
  if (blankFsm) {
    return errorResult(
      "MISSING_FSM",
      render(E["missing-fsm"] || "A new scope needs an fsm.", { scopeId: blankFsm.scopeId }),
      { scopeId: blankFsm.scopeId },
    );
  }

  // The tool schema requires `profession` for model calls. Internal callers
  // (tests, programmatic spawns) may omit it; an empty identity is legal and
  // is simply not rendered into the child receipt.

  const parentOwnerId = ownerIdOf(station);
  const clock = typeof station.clockPort === "function" ? station.clockPort() : createClockOn();
  // A model switch updates baseModelKey immediately; turnModelKey only moves
  // after the next request finishes. Prefer the live selection so a fork made
  // right after switching cannot borrow the previous model's speed.
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

  const nextForkId = (index, generation) => {
    const base = decision.items.length === 1 ? baseId : `${baseId}:${index}`;
    if (!Object.hasOwn(ledger.forks, base)) return base;
    return `${base}:g${generation}`;
  };

  /** Insert the child's identity statement directly under the receipt marker. */
  function withProfession(receipt, profession) {
    if (typeof profession !== "string" || profession.trim() === "") return receipt;
    const lines = receipt.split("\n");
    lines.splice(1, 0, profession.trim());
    return lines.join("\n");
  }

  const specOf = (fork, item, fsm) => ({
    forkId: fork.forkId,
    scopeId: fork.scopeId,
    // The child's address, so its own station can name itself to the parent
    // and to any sibling without a second lookup.
    path: fork.path ?? null,
    sourceToolCallId: frameOf(call),
    childDepth: fork.childDepth,
    fsm,
    profession: item.profession ?? fork.profession ?? "",
    budget: fork.budget,
    time: fork.timeBudgetMs == null ? null : fork.timeBudgetMs / 1000,
    targets: fork.targets,
    model: fork.model,
    modelOverride: item.modelOverride,
    thinkingLevel: item.thinkingLevel,
    parentOwnerId,
    parentDepth: depth,
  });

  const queueChild = (fork, item, fsm, receipt, kind = "created") => {
    const spec = specOf(fork, item, fsm);
    spec.receipt = withProfession(receipt, spec.profession);
    pending.push({
      forkId: fork.forkId,
      // The path is what every receipt shows: it is the address, and the name
      // is only its last segment.
      scopeId: fork.path ?? fork.scopeId,
      fsm,
      childDepth: fork.childDepth,
      kind,
      spec,
    });
  };

  const noteFailure = (forkId, item, reason) => {
    failed.push({
      forkId,
      scopeId: item.scopeId,
      fsm: item.fsm,
      reason,
    });
  };

  for (let index = 0; index < decision.items.length; index += 1) {
    const item = decision.items[index];

    // The name and its address were fixed before pricing, so the receipt the
    // child reads is the exact text admission measured.
    const { path } = allocations[index];
    const scopeId = allocations[index].scopeId;
    const forkId = nextForkId(index, 1);
    const registered = registerFork(ledger, {
      forkId,
      scopeId,
      ownerId: parentOwnerId,
      levelKey: levelKeyOf(station),
      fsm: item.fsm,
      depth,
      budget: item.budget,
      time: timeOf(item.budget),
      startedAt: Date.now(),
    }, { clock });
    if (!registered.ok) {
      noteFailure(forkId, item, render(E["fork-register-failed"], { code: registered.code }));
      continue;
    }
    const fork = registered.fork;
    // `registerFork` is the only place a budget is born, and it copies the
    // input into both `budget` and `remaining`. The remaining fields go
    // through the ledger's annotate entry, which is also what wakes waiters:
    // a bare field write would skip the change notification.
    const created = annotateFork(ledger, fork.forkId, {
      targets: item.targets,
      model: item.model,
      path,
      parentForkId,
    });
    if (!created.ok) {
      station.noteError?.("fork", new Error(created.reason ?? created.code), {
        forkId,
        phase: "fork",
      });
    }
    queueChild(fork, item, item.fsm, childReceiptText({
      scopeId: path,
      childDepth: fork.childDepth,
      fsm: item.fsm,
      budget: fork.budget,
      targets: fork.targets,
    }));

    // One item, one scope. Nothing here reuses or extends an existing record:
    // a later message is a `scope_request`, not a second fork of the same name.
  }

  // Register the whole batch before any child starts. A spawner that throws,
  // and a child that inspects the ledger from its first synchronous beat, both
  // see a complete batch: no later fork can be left unregistered by an earlier
  // start.
  for (const entry of pending) {
    try {
      spawner(entry.spec);
      if (entry.kind === "created") {
        started.push({
          forkId: entry.forkId,
          scopeId: entry.scopeId,
          fsm: entry.fsm,
          childDepth: entry.childDepth,
        });
      }
    } catch (error) {
      const reason = String(error?.message ?? error);
      // The bracket stays registered as running so the parent can still see
      // that this fork exists; it is reported as failed to start.
      failed.push({
        forkId: entry.forkId,
        scopeId: entry.scopeId,
        fsm: entry.fsm,
        reason,
      });
      markReady(ledger, entry.forkId, { ok: false, reason: `did not start: ${reason}` });
    }
  }

  // Opening a new fork on Root starts new work, so any prior promotion
  // (`canStop`) or first seal review streak is cleared synchronously.
  if (started.length > 0 && parentOwnerId === "root" && station.state?.relay) {
    const reset = resetRootPromotion(station.state.relay);
    if (reset.changed) station.state.relay = reset.relay;
  }

  // Plain summaries only. The model reads `details.result`; the prose receipt
  // templates retired with the mailbox, and restating the object in markdown
  // would spend the reader's attention on a second copy.
  const sections = [];
  if (started.length > 0) {
    sections.push(
      [
        `Started (${started.length}) at depth ${depth}:`,
        ...started.map(
          (entry) =>
            `- ${publicScopeId(forkOf(ledger, entry.forkId))} (depth ${entry.childDepth}): ${entry.fsm}`,
        ),
      ].join("\n"),
    );
  }
  if (failed.length > 0) {
    sections.push(
      [
        `Failed to start (${failed.length}):`,
        ...failed.map((entry) => `- ${entry.scopeId}: ${entry.fsm} — ${entry.reason}`),
      ].join("\n"),
    );
  }
  // Keep every unreceived scope visible without repeating its assignment.
  const unreceived = unreceivedChildren(ledger, parentOwnerId)
    .map((id) => publicScopeId(forkOf(ledger, id)));
  if (unreceived.length > 0) {
    sections.push(
      `Still unreceived: ${unreceived.join(", ")}. Join them with scope_join before returning.`,
    );
  }
  // The model reads the object, not the prose: `details.result` is the
  // info-rich channel the js runtime unwraps. `content` stays a short human
  // summary for the TUI and for legacy readers.
  return textResult(sections.join("\n\n"), {
    started: started.map((entry) => entry.forkId),
    failed: failed.map((entry) => entry.forkId),
    result: {
      ok: failed.length === 0,
      started: started.map((entry) => ({
        path: entry.scopeId,
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

// The handlers split by family; the public control surface keeps every name so
// callers (tickets, execute, tests) never learn the split.
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
