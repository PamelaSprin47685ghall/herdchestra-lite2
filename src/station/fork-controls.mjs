// Fork/join control handlers: scope_fork, scope_join, scope_return.
//
// Plain synchronous functions. The bracket ledger arrives through a port and
// the child spawner arrives through another, so a station that has neither
// refuses instead of inventing one. Child agents are assembled by the host
// wiring, not here.

import {
  adoptFork,
  amendFork,
  annotateFork,
  forkOf,
  liveReceiverOf,
  markReady,
  openChildren,
  readyChildren,
  registerFork,
  reparentOrphans,
  reviveBlockedFork,
  supersedeFork,
  takeReady,
  unreceivedChildren,
} from "../scope/forkjoin.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { createClockOn } from "../scope/clock.mjs";
import { deriveTimeBudgetSeconds, modelSamples, sumBudgetPoints } from "../scope/turn-stats.mjs";
import {
  FORK_DEFAULT_DEPTH,
  FORK_DEFAULT_FANOUT,
  FORK_MAX_FANOUT,
  FORK_RECOMMENDED_DEPTH,
  SCOPE_DEFAULT_BUDGET_POINTS,
  SCOPE_MAX_BUDGET_POINTS,
} from "../scope/budget.mjs";
import {
  decideJoinAdmission,
  decideRegister,
  decideReady,
  decideReturn,
  validateForkBatch,
} from "./domain/fork-join.mjs";
import { processedOf } from "./domain/tool-call-ledger.mjs";
import { notifyWaiters } from "../scope/fork-registry.mjs";
import { targetsText } from "../scope/targets.mjs";
import { joinReceipt, renderChildRecord } from "../transcript/replay.mjs";
import { filterAmends } from "../transcript/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { parseArgs } from "./messages.mjs";

const F = loadDoc("tools/fork-join");
const S = loadDoc("receipts/scope");
const E = loadDoc("errors");

// The join receipt adds a header, the remaining list and the pending-report
// line. Pricing them keeps the admission estimate from assuming the record
// rides for free.
const JOIN_RECEIPT_OVERHEAD_CHARS = 600;

function ledgerOf(station) {
  if (typeof station.forkLedgerPort === "function") {
    const ledger = station.forkLedgerPort();
    if (ledger && typeof ledger === "object") return ledger;
  }
  return station.brackets ?? null;
}

function identityOf(station) {
  if (typeof station.forkIdentityPort !== "function") return null;
  const identity = station.forkIdentityPort();
  return identity && typeof identity === "object" ? identity : null;
}

/**
 * The level this station closes brackets at. A child's own level is its
 * forkId; a parent that is not itself a child owns the root level.
 */
function ownerIdOf(station) {
  const identity = identityOf(station);
  if (identity && typeof identity.forkId === "string" && identity.forkId !== "") {
    return identity.forkId;
  }
  if (typeof station.ownerId === "string" && station.ownerId !== "") {
    return station.ownerId;
  }
  return "root";
}

function depthOf(station) {
  if (typeof station.forkDepthPort === "function") {
    const depth = station.forkDepthPort();
    if (Number.isInteger(depth) && depth >= 0) return depth;
  }
  return typeof station.ownerId === "string" && station.ownerId !== "" ? 1 : 0;
}

const REFUSAL_KEY = {
  INVALID_SCOPE_ID: "invalid-scope-id",
  INVALID_FSM: "invalid-fsm",
  INVALID_PROFESSION: "invalid-profession",
  INVALID_BUDGET: "invalid-budget",
  INVALID_ARGUMENT: "invalid-argument",
  INVALID_TARGETS: "invalid-targets",
};

function budgetText(budget) {
  const parts = [];
  for (const key of Object.keys(budget ?? {})) parts.push(`${key} ${budget[key]}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** The record text a candidate would add to the parent's next request. */
function recordTextOf(station, record) {
  if (record && typeof record.record === "string") return record.record;
  const outcome =
    typeof station.childOutcomePort === "function"
      ? station.childOutcomePort(record.forkId)
      : null;
  return typeof outcome?.record === "string" ? outcome.record : "";
}

/**
 * The live model's input limit, or null when no exact window is known.
 *
 * A guessed alias window is not an exact fact, so it is not used. The live
 * model object is, because the host resolved it, and a catalog entry by the
 * persisted base key is the next best exact identity.
 */
function windowOf(station) {
  if (typeof station.forkWindowPort === "function") {
    const window = station.forkWindowPort();
    if (Number.isFinite(window) && window > 0) return window;
  }
  const live = station.usage?.lastCtxModel;
  if (Number.isFinite(live?.contextWindow) && live.contextWindow > 0) {
    return live.contextWindow;
  }
  const key = station.state?.baseModelKey;
  const catalog = station.pricingCatalog;
  if (catalog && typeof key === "string" && key !== "") {
    const entry = catalog.byFullId?.get?.(key) ?? catalog.byId?.get?.(key) ?? null;
    const window = entry?.contextWindow;
    if (Number.isFinite(window) && window > 0) return window;
  }
  return null;
}

/** The station's live outbound watermark, or Infinity when unmeasured. */
function measuredBase(station) {
  const messages =
    typeof station.contextMessages === "function" ? station.contextMessages() : [];
  // A station double may expose only a partial usage ledger. Missing evidence
  // is an unmeasured request, never a zero-sized one.
  try {
    if (typeof station.currentContextTokens === "function") {
      return station.currentContextTokens(messages);
    }
    if (typeof station.usage?.currentContextTokens === "function") {
      return station.usage.currentContextTokens(messages);
    }
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

/** The model's measured characters-per-token rate, defaulting to 0.3. */
function densityOf(station) {
  const key = station.usage?.lastUsageModelKey ?? null;
  try {
    if (typeof station.tokensPerCharFor === "function") {
      const value = station.tokensPerCharFor(key);
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    } else if (typeof station.usage?.tokensPerCharFor === "function") {
      const value = station.usage.tokensPerCharFor(key);
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
  } catch {
    return 0.3;
  }
  return 0.3;
}

/**
 * Admission for one candidate join. A refusal keeps the record ready; the
 * caller names the refusal and lets the model choose a larger window or a
 * smaller result.
 */
export function admitJoin(station, record, options = {}) {
  const recordChars =
    recordTextOf(station, record).length + JOIN_RECEIPT_OVERHEAD_CHARS;
  const window = options.window !== undefined ? options.window : windowOf(station);
  const reserve =
    options.reserve !== undefined
      ? options.reserve
      : typeof station.forkReservePort === "function"
        ? station.forkReservePort()
        : undefined;
  const margin =
    options.margin !== undefined
      ? options.margin
      : typeof station.forkMarginPort === "function"
        ? station.forkMarginPort()
        : undefined;
  return decideJoinAdmission({
    baseTokens: measuredBase(station),
    recordChars,
    tokensPerChar: densityOf(station),
    window,
    reserve,
    margin,
  });
}

/** The first line of a child receipt, as the child's context carries it. */
function childReceiptMarker(forkId) {
  return `You are the child of fork ${forkId},`;
}

function textOfUser(message) {
  if (!message || message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
}

function epochOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The first message of a branch's own work, as an index into `messages`.
 *
 * A child session is seeded with the parent's context, so the branch manager
 * returns the whole inherited transcript. Replaying it into the record would
 * hand the parent its own conversation back and defeat join admission. The
 * receipt the child reads at its start is the exact boundary: the first user
 * message that opens with {@link childReceiptMarker}. When that message is
 * absent (a host that rewrites it), the bracket's start time is the fallback;
 * a message without a parseable timestamp cannot prove it belongs to the
 * child, so the walk skips it. With neither marker nor timestamp the whole
 * context is returned: the old behaviour is never worse than a wrong cut.
 */
export function childRecordStart(messages, fork) {
  const source = Array.isArray(messages) ? messages : [];
  const forkId = fork && typeof fork.forkId === "string" ? fork.forkId : "";
  if (forkId !== "") {
    const marker = childReceiptMarker(fork.scopeId ?? forkId);
    for (let index = 0; index < source.length; index += 1) {
      if (textOfUser(source[index]).trimStart().startsWith(marker)) return index;
    }
  }
  const startedAt = fork ? epochOf(fork.startedAt) : null;
  if (startedAt !== null) {
    for (let index = 0; index < source.length; index += 1) {
      const at = epochOf(source[index]?.timestamp);
      if (at !== null && at >= startedAt) return index;
    }
  }
  return 0;
}

/** The receipt the child reads at its own start. */
export function childReceiptText(spec) {
  return [
    render(S["fork.child-status"], {
      marker: childReceiptMarker(spec.scopeId ?? spec.forkId),
      depth: spec.childDepth,
      defaultDepth: FORK_DEFAULT_DEPTH,
      recommendedDepth: FORK_RECOMMENDED_DEPTH,
      intent: spec.intent,
      budget: budgetText(spec.budget),
      targets: targetsText(spec.targets),
    }),
    S["fork.child-return"],
    S["fork.child-routing"],
  ].join("\n");
}

// The receipt's marker, return note and routing note are fixed lines above the
// rendered fsm. Pricing them keeps a fork start from looking as small as its
// state machine alone.
const FORK_RECEIPT_PREFIX_CHARS = 600;

/** Add two tool-count maps, dropping zeros. */
function sumBudgets(base, extra) {
  const out = {};
  for (const source of [base, extra]) {
    if (!source || typeof source !== "object") continue;
    for (const [tool, amount] of Object.entries(source)) {
      if (!Number.isFinite(amount) || amount <= 0) continue;
      out[tool] = (out[tool] ?? 0) + amount;
    }
  }
  return out;
}

/** Merge target lists without duplicates. */
function unionTargets(first, second) {
  const out = [];
  for (const list of [first, second]) {
    for (const target of Array.isArray(list) ? list : []) {
      const text = typeof target === "string" ? target.trim() : "";
      if (text !== "" && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/** Human-readable budget delta for a fork result line. */
function budgetDelta(added) {
  const points = Object.entries(added?.tools ?? {})
    .map(([tool, amount]) => `${amount} ${tool}`)
    .join(", ");
  const seconds = Number.isInteger(added?.seconds) && added.seconds > 0
    ? `${added.seconds}s`
    : "";
  return [points, seconds].filter(Boolean).join(" + ") || "no budget";
}

/** The text a later generation reads as its predecessor's history. */
function priorRecordText(record) {
  const text = typeof record.record === "string" ? record.record.trim() : "";
  if (text !== "") return text;
  if (record.outcome === "failed" && typeof record.reason === "string" && record.reason !== "") {
    return `Previous attempt failed: ${record.reason}`;
  }
  return "(the previous generation published no record)";
}

/** Receipt for a generation that continues an already closed scope. */
function generationReceiptText({ scopeId, childDepth, generation, standing, intent, budget, targets, prior }) {
  return [
    render(S["fork.child-status"], {
      marker: childReceiptMarker(scopeId),
      depth: childDepth,
      defaultDepth: FORK_DEFAULT_DEPTH,
      recommendedDepth: FORK_RECOMMENDED_DEPTH,
      intent: standing,
      budget: budgetText(budget),
      targets: targetsText(targets),
    }),
    `[Continuing scope ${scopeId} — generation ${generation}]`,
    "History only; do not re-execute it.",
    prior,
    ...(intent === "" ? [] : ["", "[New requirement]", intent]),
    S["fork.child-return"],
    S["fork.child-routing"],
  ].join("\n");
}

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
  const receiptChars = batch.items.map((item) => {
    if (item.blocked === true) return 0;
    const profession =
      typeof item.profession === "string" ? item.profession.trim() : "";
    const identityChars = profession === "" ? 0 : profession.length + 1;
    return childReceiptText({
      scopeId: item.scopeId,
      childDepth: depth + 1,
      intent: item.intent,
      budget: item.budget,
      targets: item.targets,
    }).length + FORK_RECEIPT_PREFIX_CHARS + identityChars;
  });
  const decision = decideRegister({
    items: batch.items,
    forks: ledger.order.map((id) => forkOf(ledger, id)),
    ownerId: ownerIdOf(station),
    models: options.models ?? station.host?.model?.query?.(options.ctx) ?? null,
    hasSpawner: typeof spawner === "function",
    receiptChars,
    baseTokens: measuredBase(station),
    tokensPerChar: densityOf(station),
    window: windowOf(station),
    reserve:
      typeof station.forkReservePort === "function"
        ? station.forkReservePort()
        : undefined,
    margin:
      typeof station.forkMarginPort === "function"
        ? station.forkMarginPort()
        : undefined,
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

  const blankIntent = decision.items.find(
    (item) => item.action === "create" && item.intent === "",
  );
  if (blankIntent) {
    return errorResult(
      "MISSING_FSM",
      render(E["missing-fsm"] || "A new scope needs an fsm.", { scopeId: blankIntent.scopeId }),
      { scopeId: blankIntent.scopeId },
    );
  }

  // The tool schema requires `profession` for model calls. Internal callers
  // (tests, programmatic spawns) may omit it; an empty identity is legal and
  // is simply not rendered into the child receipt.

  const parentOwnerId = ownerIdOf(station);
  const clock = typeof station.clockPort === "function" ? station.clockPort() : createClockOn();
  const totals = ledger.totals;
  // A model switch updates baseModelKey immediately; turnModelKey only moves
  // after the next request finishes. Prefer the live selection so a fork made
  // right after switching cannot borrow the previous model's speed.
  const budgetModelKey = station.state?.baseModelKey ?? station.turnModelKey;
  const timeOf = (budget) =>
    deriveTimeBudgetSeconds({
      samples: modelSamples(ledger, budgetModelKey),
      budget,
    });
  const baseId = typeof call.id === "string" && call.id !== "" ? call.id : `fork-${Date.now()}`;
  const started = [];
  const amended = [];
  const revived = [];
  const continued = [];
  const deferred = [];
  const failed = [];
  const pending = [];
  const forkIdByScope = new Map();

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

  const specOf = (fork, item, intent) => ({
    forkId: fork.forkId,
    scopeId: fork.scopeId,
    sourceToolCallId: baseId,
    childDepth: fork.childDepth,
    intent,
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

  const queueChild = (fork, item, intent, receipt, kind = "created") => {
    const spec = specOf(fork, item, intent);
    spec.receipt = withProfession(receipt, spec.profession);
    pending.push({
      forkId: fork.forkId,
      scopeId: item.scopeId,
      intent,
      childDepth: fork.childDepth,
      kind,
      spec,
    });
  };

  const noteFailure = (forkId, item, reason) => {
    failed.push({
      forkId,
      scopeId: item.scopeId,
      intent: item.intent,
      reason,
    });
  };

  for (let index = 0; index < decision.items.length; index += 1) {
    const item = decision.items[index];
    const key = item.scopeId.toLowerCase();

    if (item.action === "create") {
      const forkId = nextForkId(index, 1);
      const registered = registerFork(ledger, {
        forkId,
        scopeId: item.scopeId,
        ownerId: parentOwnerId,
        levelKey: levelKeyOf(station),
        intent: item.intent,
        depth,
        blocked: item.blocked === true,
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
      // through the ledger's annotate entry, which is also what wakes parked
      // joins: a bare field write would skip the change notification.
      const created = annotateFork(ledger, fork.forkId, {
        targets: item.targets,
        model: item.model,
      });
      if (!created.ok) {
        station.noteError?.("fork", new Error(created.reason ?? created.code), {
          forkId,
          phase: "fork",
        });
      }
      forkIdByScope.set(key, fork.forkId);
      if (item.blocked === true) {
        deferred.push({ forkId, scopeId: item.scopeId, intent: item.intent });
        continue;
      }
      queueChild(fork, item, item.intent, childReceiptText({
        scopeId: item.scopeId,
        childDepth: fork.childDepth,
        intent: item.intent,
        budget: fork.budget,
        targets: fork.targets,
      }));
      continue;
    }

    const targetForkId = item.targetStatus === "batch"
      ? forkIdByScope.get(key)
      : item.targetForkId;
    const target = targetForkId ? forkOf(ledger, targetForkId) : null;
    if (!target) {
      noteFailure(targetForkId ?? item.scopeId, item, "The earlier item in this batch left no record to amend.");
      continue;
    }
    if (target.status === "running" && item.blocked === true) {
      noteFailure(target.forkId, item, render(E["scope-running-blocked"] || "A running scope cannot be blocked.", {
        scopeId: item.scopeId,
      }));
      continue;
    }
    if (target.status === "running" || target.status === "blocked") {
      const before = Array.isArray(target.requirements) ? target.requirements.length : 0;
      const out = amendFork(ledger, target.forkId, {
        budget: item.budget,
        intent: item.intent,
        profession: item.profession,
        targets: item.targets,
      }, { clock });
      if (!out.ok) {
        noteFailure(target.forkId, item, out.code);
        continue;
      }
      forkIdByScope.set(key, target.forkId);
      const entry = {
        forkId: target.forkId,
        scopeId: item.scopeId,
        intent: item.intent,
        added: out.added,
        queued: Math.max(0, (Array.isArray(target.requirements) ? target.requirements.length : 0) - before),
        overLimit: out.overLimit === true,
        totalPoints: out.totalPoints,
      };
      if (target.status === "blocked" && item.blocked !== true) {
        if (typeof spawner !== "function") {
          noteFailure(target.forkId, item, E["child-spawner-unavailable"] || "No child spawner is wired.");
          continue;
        }
        const startedAt = Date.now();
        const revivedFork = reviveBlockedFork(ledger, target.forkId, startedAt);
        if (!revivedFork.ok) {
          noteFailure(target.forkId, item, revivedFork.code);
          continue;
        }
        if (clock && typeof clock.start === "function") {
          clock.start(target, target.timeBudgetMs, startedAt);
        }
        queueChild(target, item, target.intent, childReceiptText({
          scopeId: item.scopeId,
          childDepth: target.childDepth,
          intent: target.intent,
          budget: target.budget,
          targets: target.targets,
        }), "revived");
        revived.push(entry);
      } else {
        amended.push(entry);
      }
      continue;
    }

    // Decide the reuse budget before touching the old record. A reuse that can
    // never start must leave a ready generation deliverable: superseding first
    // and failing after would park the old scope in scope_return against a take
    // that no longer exists.
    const budget = sumBudgets(target.remaining, item.budget);
    if (Object.keys(budget).length === 0) {
      noteFailure(target.forkId, item, render(E["scope-reuse-empty"] || "This reuse adds no budget and the previous generation has none left.", {
        scopeId: item.scopeId,
      }));
      continue;
    }
    if (target.status === "ready") {
      const superseded = supersedeFork(ledger, target.forkId);
      if (!superseded.ok) {
        noteFailure(target.forkId, item, superseded.code);
        continue;
      }
      // The old generation may be parked in scope_return, waiting for a take
      // that reuse just cancelled. Wake it so it can close its bracket.
      const wait = station.forkWaitPort?.() ?? null;
      if (wait?.registry) notifyWaiters(wait.registry);
    }
    const generation = (Number.isInteger(target.generation) ? target.generation : 1) + 1;
    const forkId = nextForkId(index, generation);
    const standing = item.intent === "" ? target.intent : item.intent;
    const registered = registerFork(ledger, {
      forkId,
      scopeId: item.scopeId,
      ownerId: parentOwnerId,
      levelKey: levelKeyOf(station),
      intent: standing,
      depth,
      blocked: false,
      budget,
      time: timeOf(budget),
      startedAt: Date.now(),
      generation,
      continuesForkId: target.forkId,
    }, { clock });
    if (!registered.ok) {
      noteFailure(forkId, item, render(E["fork-register-failed"], { code: registered.code }));
      continue;
    }
    const fork = registered.fork;
    const continuedFork = annotateFork(ledger, fork.forkId, {
      targets: unionTargets(target.targets, item.targets),
      model: item.model ?? target.model ?? null,
    });
    if (!continuedFork.ok) {
      station.noteError?.("fork", new Error(continuedFork.reason ?? continuedFork.code), {
        forkId,
        phase: "fork",
      });
    }
    forkIdByScope.set(key, fork.forkId);
    queueChild(fork, item, standing, generationReceiptText({
      scopeId: item.scopeId,
      childDepth: fork.childDepth,
      generation,
      standing: target.intent,
      intent: item.intent,
      budget,
      targets: fork.targets,
      prior: priorRecordText(target),
    }), "continued");
    continued.push({
      forkId,
      scopeId: item.scopeId,
      intent: item.intent,
      generation,
      priorForkId: target.forkId,
      added: item.budget,
    });
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
          intent: entry.intent,
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
        intent: entry.intent,
        reason,
      });
      markReady(ledger, entry.forkId, { ok: false, reason: `did not start: ${reason}` });
      if (entry.kind !== "created") {
        const bucket = entry.kind === "revived" ? revived : continued;
        const at = bucket.findIndex((item) => item.forkId === entry.forkId);
        if (at >= 0) bucket.splice(at, 1);
      }
    }
  }

  const sections = [];
  if (started.length > 0) {
    sections.push(
      render(F["fork.batch-started"], {
        count: started.length,
        depth,
        lines: started
          .map((entry) =>
            render(F["fork.started-line"], {
              forkId: entry.scopeId,
              childDepth: entry.childDepth,
              intent: entry.intent,
            }),
          )
          .join("\n"),
      }),
    );
  }
  if (amended.length > 0) {
    sections.push([
      `Amended ${amended.length} existing scope${amended.length === 1 ? "" : "s"}:`,
      ...amended.map((entry) =>
        `- ${entry.scopeId}: ${budgetDelta(entry.added)}${entry.queued > 0 ? `, ${entry.queued} requirement${entry.queued === 1 ? "" : "s"} queued` : ""}.`,
      ),
    ].join("\n"));
  }
  if (revived.length > 0) {
    sections.push([
      `Revived ${revived.length} blocked scope${revived.length === 1 ? "" : "s"}:`,
      ...revived.map((entry) =>
        `- ${entry.scopeId}: ${budgetDelta(entry.added)}${entry.queued > 0 ? `, ${entry.queued} requirement${entry.queued === 1 ? "" : "s"} queued` : ""}.`,
      ),
    ].join("\n"));
  }
  if (continued.length > 0) {
    sections.push([
      `Continued ${continued.length} finished scope${continued.length === 1 ? "" : "s"}:`,
      ...continued.map((entry) =>
        `- ${entry.scopeId}: generation ${entry.generation}, after ${entry.priorForkId}, ${budgetDelta(entry.added)} added.`,
      ),
    ].join("\n"));
  }
  if (deferred.length > 0) {
    sections.push(
      render(F["fork.batch-deferred"], {
        count: deferred.length,
        lines: deferred
          .map((entry) =>
            render(F["fork.deferred-line"], {
              forkId: entry.scopeId,
              intent: entry.intent,
            }),
          )
          .join("\n"),
      }),
    );
  }
  if (failed.length > 0) {
    sections.push(
      render(F["fork.batch-failed"], {
        count: failed.length,
        lines: failed
          .map((entry) =>
            render(F["fork.failed-line"], {
              forkId: entry.scopeId,
              intent: entry.intent,
              reason: entry.reason,
            }),
          )
          .join("\n"),
      }),
    );
  }
  if (started.length === 0 && deferred.length > 0) {
    sections.push(render(F["fork.checkpoint-only"], { depth }));
  }
  // Keep every unreceived scope visible without repeating its assignment.
  const unreceived = unreceivedChildren(ledger, parentOwnerId)
    .map((id) => publicScopeId(forkOf(ledger, id)));
  if (unreceived.length > 0) {
    sections.push(render(F["fork.unreceived"], { children: unreceived.join(", ") }));
  }
  // Every over-cap batch already ran. The rebuke rides after the result so the
  // next split starts from the cap instead of rediscovering it.
  const overBudget = [];
  for (const entry of [...started, ...continued, ...deferred]) {
    const points = sumBudgetPoints(forkOf(ledger, entry.forkId)?.budget ?? {});
    if (points > SCOPE_MAX_BUDGET_POINTS) {
      overBudget.push(`${entry.scopeId} (${points} pts)`);
    }
  }
  for (const entry of [...amended, ...revived]) {
    if (entry.overLimit) {
      overBudget.push(`${entry.scopeId} (${entry.totalPoints} pts)`);
    }
  }
  if (overBudget.length > 0) {
    sections.push(render(F["fork.over-budget"], {
      defaultPoints: SCOPE_DEFAULT_BUDGET_POINTS,
      maxPoints: SCOPE_MAX_BUDGET_POINTS,
      offenders: overBudget.join(", "),
    }));
  }
  if (decision.items.length > FORK_MAX_FANOUT) {
    sections.push(render(F["fork.over-fanout"], {
      count: decision.items.length,
      defaultFanout: FORK_DEFAULT_FANOUT,
      maxFanout: FORK_MAX_FANOUT,
    }));
  }
  // A fourth layer still runs. The note is context, not a rebuke: unlike the
  // budget and the fan-out, depth has no floor to defend, so a deeper tree is
  // fine when the work needs it and needs no written justification. Only a
  // new child earns the note; amending a live fork does not.
  const born =
    started.length + continued.length + revived.length + deferred.length;
  if (born > 0 && depth + 1 > FORK_RECOMMENDED_DEPTH) {
    sections.push(render(F["fork.deep-nesting"], {
      childDepth: depth + 1,
      defaultDepth: FORK_DEFAULT_DEPTH,
      recommendedDepth: FORK_RECOMMENDED_DEPTH,
      defaultPoints: SCOPE_DEFAULT_BUDGET_POINTS,
    }));
  }
  return textResult(sections.join("\n\n"), {
    started: started.map((entry) => entry.forkId),
    amended: amended.map((entry) => entry.forkId),
    revived: revived.map((entry) => entry.forkId),
    continued: continued.map((entry) => entry.forkId),
    deferred: deferred.map((entry) => entry.forkId),
    failed: failed.map((entry) => entry.forkId),
  });
}

/** The level key that groups sibling brackets. */
function levelKeyOf(station) {
  const state = station.state ?? {};
  const parentId =
    typeof station.forkOwnerId === "function"
      ? (station.forkOwnerId() ?? "root")
      : "root";
  const boundary =
    Number.isInteger(state.relay?.generation) && state.relay.generation >= 0
      ? state.relay.generation
      : 0;
  const epoch = Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0;
  return `${parentId}|${boundary}|${epoch}`;
}

/**
 * Close one left bracket from the parent side. The child's record arrives as
 * this result's text. With no child ready the call refuses; the ticket layer
 * waits for one in the wired flow.
 */
export function handleJoinCall(station, call, options = {}) {
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  const ownerId = ownerIdOf(station);
  // With nothing running and nothing ready, no join can succeed. Answering
  // before the report gate keeps the model out of a loop that demands a
  // summary for a receipt no later join could ever archive.
  if (unreceivedChildren(ledger, ownerId).length === 0) {
    return errorResult("NO_READY_CHILD", E["no-ready-child"], {
      ownerId,
      active: 0,
      pending: null,
    });
  }
  // A reparented child closes at the receiver's level, not at the level of
  // the branch that gave birth to it. The explicit key is what puts it in the
  // grandparent's sibling chain. Admission runs before the take, so a record
  // the next request cannot hold stays ready and unconsumed.
  const taken = takeReady(ledger, {
    ownerId,
    levelKey: levelKeyOf(station),
    admit: (candidate) => admitJoin(station, candidate, options),
  });
  if (!taken.ok) {
    if (taken.code === "NO_ADMISSIBLE_CHILD") {
      const first = taken.blocked?.[0] ?? null;
      const detail = first
        ? `Fork ${publicScopeId(forkOf(ledger, first.forkId))} cannot be delivered: ${first.reason ?? "the next request would exceed the model window"}.`
        : "No ready child fits the model window.";
      return errorResult(
        "JOIN_CONTEXT_EXCEEDED",
        render(E["join-context-exceeded"], { detail }),
        {
          ownerId,
          active: unreceivedChildren(ledger, ownerId).length,
          blocked: taken.blocked ?? [],
        },
      );
    }
    return errorResult("NO_READY_CHILD", E["no-ready-child"], {
      ownerId,
      active: unreceivedChildren(ledger, ownerId).length,
    });
  }
  commitJoin(station, taken.fork, call.id);
  const persisted = confirmJoinPersistence(station);
  if (persisted === false) {
    station.noteError?.("fork", new Error("join receipt was not persisted"), {
      forkId: taken.fork.forkId,
      phase: "join",
    });
  }
  return renderJoinResult(station, taken.fork, {
    ledger,
    ownerId,
    closeToolCallId: call.id,
    persisted,
  });
}

/**
 * File one taken bracket in the receiver's receipt chain. Both the immediate
 * take and the ticket's later take use this one commit, so a waited join and
 * an immediate join leave the same persisted evidence.
 */
export function commitJoin(station, record) {
  return record;
}

/**
 * Confirm a just-filed join receipt reached the shared tree.
 *
 * `persist()` is the station's durable-write signal: false means the receipt
 * exists in memory but the tree was not written. A station double without the
 * method is not judged, so handlers that never wire persistence keep their
 * old result shape.
 */
export function confirmJoinPersistence(station) {
  if (typeof station.persist !== "function") return undefined;
  return station.persist() !== false;
}

/**
 * Render a record the caller already took. The waiting ticket takes the child
 * inside waitForReady, so it must not take again: a second take would find an
 * empty queue and report a failure for a join that already succeeded.
 */
export function renderJoinResult(station, record, options = {}) {
  const ledger = options.ledger ?? ledgerOf(station);
  const ownerId = options.ownerId ?? ownerIdOf(station);
  const remaining = unreceivedChildren(ledger, ownerId).map((id) => ({
    forkId: id,
    scopeId: publicScopeId(forkOf(ledger, id)),
  }));
  // The child's finished record lives in the outcome table, written when the
  // branch stopped. Rendering its messages again here would either duplicate
  // that work or, for a spawner that wrote no messages, hand the parent an
  // empty record. The message path stays as a fallback for direct handlers.
  const outcome =
    typeof station.childOutcomePort === "function"
      ? station.childOutcomePort(record.forkId)
      : null;
  // The record is frozen by the child's own return. A missing record means the
  // child produced no visible work; it is reported as empty instead of being
  // re-rendered from an array the ledger never carried.
  const rendered =
    typeof record.record === "string"
      ? record.record
      : typeof outcome?.record === "string"
        ? outcome.record
        : "";
  const childFailed = record.outcome === "failed" || outcome?.failed === true;
  const childReason = record.reason ?? outcome?.reason ?? null;
  const text = joinReceipt({
    forkId: publicScopeId(record),
    record: rendered,
    failed: childFailed,
    reason: childReason,
    remaining: remaining.map((entry) => entry.scopeId),
	});
  const persisted = options.persisted;
  const notes = [];
  if (persisted === false) {
    notes.push(
      "Persistence warning: this join receipt exists in memory, but the shared tree was not written.",
    );
  }
  const body = notes.length === 0 ? text : `${text}${text.endsWith("\n") ? "" : "\n"}${notes.join("\n")}`;
  return textResult(body, {
    forkId: record.forkId,
    joined: true,
    remaining,
    ...(persisted === undefined ? {} : { persisted }),
  });
}

/**
 * Close your own bracket from the child side. Every child you still hold is
 * reparented to the parent, so no bracket is orphaned.
 */
export function handleReturnCall(station, call) {
  const args = parseArgs(call);
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  const identity = identityOf(station);
  const selfForkId =
    identity && typeof identity.forkId === "string" ? identity.forkId : "";
  const record = selfForkId === "" ? null : forkOf(ledger, selfForkId);
  // Adoption follows the current receiver, never the birth parent: a branch
  // that was itself adopted must hand its unreceived children to the branch
  // that now answers for it. The current receiver may already have returned
  // too, so the whole chain is walked to the nearest live branch.
  const orphans = record
    ? [...openChildren(ledger, selfForkId), ...readyChildren(ledger, selfForkId)]
    : [];
  const receiverId = liveReceiverOf(ledger, record?.ownerId ?? "");
  const decision = decideReturn({
    identityForkId: selfForkId,
    record,
    receiverId,
    orphans,
  });
  if (!decision.ok) {
    if (decision.code === "NOT_A_CHILD") {
      return errorResult("NOT_A_CHILD", E["not-a-child"]);
    }
    if (decision.code === "UNKNOWN_FORK") {
      return errorResult("UNKNOWN_FORK", E["unknown-fork"]);
    }
    if (decision.code === "FORK_NOT_RUNNING") {
      return errorResult("FORK_NOT_RUNNING", render(E["fork-not-running"], {
        scopeId: publicScopeId(record),
        status: decision.status,
      }));
    }
    return errorResult("ORPHANS_WITHOUT_RECEIVER", E["orphans-without-receiver"]);
  }
  // Move this branch before it becomes ready: markReady queues the result
  // under the record's current owner. Changing the owner afterwards would
  // leave the queue and the record disagreeing, and the child would wait for
  // a take from a branch that can never join.
  const adopted = adoptFork(ledger, selfForkId, receiverId);
  if (!adopted.ok) return errorResult(adopted.code, adopted.reason);
  // Freeze this branch's own record before the bracket becomes ready. The
  // parent may take it in the same tick, and a parent that reads an empty
  // record cannot tell a silent child from a broken one. Amends are filtered
  // first: a withdrawn beat must never return through a replay.
  let renderedRecord = null;
  const markdown = typeof args.markdown === "string" ? args.markdown.trim() : "";
  if (typeof station.setChildOutcome === "function") {
    const messages =
      typeof station.contextMessages === "function" ? station.contextMessages() : [];
    const visible = filterAmends(messages, station.state?.amends ?? []);
    // The branch manager's context is the parent prefix plus this branch's
    // own work. Only the branch's work belongs in the record: the parent
    // already has the prefix, and replaying it back defeats join admission.
    renderedRecord = renderChildRecord(visible, {
      start: childRecordStart(visible, record),
    });
    // The optional markdown goes last: the child named it deliberately, so it
    // must survive the replay that keeps only assistant text and tool names.
    if (markdown !== "") {
      renderedRecord = renderedRecord === "" ? markdown : `${renderedRecord}\n\n${markdown}`;
    }
    station.setChildOutcome(selfForkId, {
      record: renderedRecord,
      failed: false,
      reason: null,
    });
  }
  // Mark the parent's own bracket first: its result must be queued ahead of
  // the children it hands over, so a grandparent reads the introduction
  // before their records. A failed mark changes no relationship.
  const readyDecision = decideReady({
    record,
    outcome:
      renderedRecord === null ? { ok: true } : { ok: true, record: renderedRecord },
  });
  if (!readyDecision.ok) {
    return errorResult(
      readyDecision.code,
      readyDecision.code === "FORK_NOT_RUNNING"
        ? render(E["fork-not-running"], {
            scopeId: publicScopeId(record),
            status: readyDecision.status,
          })
        : E["unknown-fork"],
    );
  }
  const ready = markReady(ledger, selfForkId, readyDecision.outcome);
  if (!ready.ok) return errorResult(ready.code, ready.reason);
  if (orphans.length > 0) reparentOrphans(ledger, selfForkId, receiverId);
  // The root branch owns the persisted tree. A child's own snapshot is not
  // what a reload restores, so the return is written to the root before the
  // parent is asked to take it. A failed write is not silent: the record is
  // still ready in memory, and the receipt says the tree was not written.
  let persisted = true;
  if (typeof station.persistLedger === "function") {
    persisted = station.persistLedger() !== false;
  }
  if (!persisted) {
    station.noteError?.("fork", new Error("ready record was not persisted"), {
      forkId: selfForkId,
      phase: "return",
    });
  }
  // The receipt names the receiver in the prose the model reads. A root
  // receiver stays "the parent"; an adopted branch also shows its identity,
  // so a child that moved between branches can name where it went.
  const receiverText = receiverId === "root" ? "Root" : publicScopeId(forkOf(ledger, receiverId));

  // The record is queued, not accepted. The ticket waits for the parent's
  // take and only then replaces this text with the accepted receipt; writing
  // "accepted" here would claim a commit that has not happened.
  const lines = [render(F["return.pending"], { forkId: publicScopeId(record), receiver: receiverText })];
  if (orphans.length > 0) {
    lines.push(`Reparented to ${receiverText}: ${orphans.map((id) => publicScopeId(forkOf(ledger, id))).join(", ")}.`);
  }
  if (!persisted) {
    lines.push(
      "Persistence warning: this ready record exists in memory, but the shared tree was not written.",
    );
  }
  return textResult(lines.join("\n"), {
    forkId: selfForkId,
    scopeId: publicScopeId(record),
    returned: true,
    reparented: orphans,
    receiver: receiverId,
    receiverText,
    awaitingReceipt: true,
  });
}

/** The receipt a child gets once the parent has taken its record. */
export function returnAcceptedText(forkId, receiver) {
  return render(F["return.receipt"], { forkId, receiver });
}

/** The receipt a child gets when a reused scope superseded its record. */
export function returnSupersededText(forkId) {
  return render(F["return.superseded"], { forkId });
}

export { levelKeyOf, ownerIdOf, depthOf };
