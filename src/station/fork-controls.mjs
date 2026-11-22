// Fork/join control handlers: scope_fork, scope_join, scope_return.
//
// Plain synchronous functions. The bracket ledger arrives through a port and
// the child spawner arrives through another, so a station that has neither
// refuses instead of inventing one. Child agents are assembled by the host
// wiring, not here.

import {
  forkOf,
  markReady,
  openChildren,
  readyChildren,
  registerFork,
  reparentOrphans,
  takeReady,
  unreceivedChildren,
} from "../scope/forkjoin.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { createClockOn } from "../scope/clock.mjs";
import { deriveTimeBudgetSeconds } from "../scope/turn-stats.mjs";
import {
  decideJoinAdmission,
  decideJoinBinding,
  decidePendingReport,
  decideRegister,
  decideReady,
  decideReturn,
  validateForkBatch,
} from "./domain/fork-join.mjs";
import { processedOf } from "./domain/tool-call-ledger.mjs";
import { targetsText } from "../scope/targets.mjs";
import { joinReceipt, renderChildRecord } from "../transcript/replay.mjs";
import { filterAmends } from "../transcript/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { parseArgs } from "./messages.mjs";
import { elderReportProblem } from "../scope/elder-report.mjs";

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
  INVALID_INTENT: "invalid-intent",
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
export function childReceiptMarker(forkId) {
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
      intent: spec.intent,
      budget: budgetText(spec.budget),
      targets: targetsText(spec.targets),
    }),
    S["fork.child-return"],
    S["fork.child-routing"],
  ].join("\n");
}

// The receipt's marker, return note and routing note are fixed lines above the
// rendered intent. Pricing them keeps a fork start from looking as small as
// its intent alone.
const FORK_RECEIPT_PREFIX_CHARS = 600;

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
    return childReceiptText({
      scopeId: item.scopeId,
      childDepth: depth + 1,
      intent: item.intent,
      budget: item.budget,
      targets: item.targets,
    }).length + FORK_RECEIPT_PREFIX_CHARS;
  });
  const decision = decideRegister({
    items: batch.items,
    forks: ledger.order.map((id) => forkOf(ledger, id)),
    models: options.ctx?.models ?? null,
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
    if (decision.code === "DUPLICATE_SCOPE_ID") {
      return errorResult(decision.code, render(E["duplicate-scope-id"], {
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

  const parentOwnerId = ownerIdOf(station);
  const clock = typeof station.clockPort === "function" ? station.clockPort() : createClockOn();
  const totals = ledger.totals;
  const timeOf = (budget) => deriveTimeBudgetSeconds({ totals, budget });
  const baseId = typeof call.id === "string" && call.id !== "" ? call.id : `fork-${Date.now()}`;
  const started = [];
  const deferred = [];
  const failed = [];
  const pending = [];
  for (let index = 0; index < decision.items.length; index += 1) {
    const item = decision.items[index];
    const forkId = decision.items.length === 1 ? baseId : `${baseId}:${index}`;
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
      failed.push({
        forkId,
        scopeId: item.scopeId,
        intent: item.intent,
        reason: render(E["fork-register-failed"], { code: registered.code }),
      });
      continue;
    }
    const fork = registered.fork;
    // `registerFork` is the only place a budget is born, and it copies the
    // input into both `budget` and `remaining`. Assigning the budget here
    // after the fact would leave `remaining` at the empty object the ledger
    // started with, and the child's first normal tool call would be refused
    // as exhausted.
    fork.targets = item.targets;
    fork.model = item.model;
    if (item.blocked === true) {
      deferred.push({ forkId, scopeId: item.scopeId, intent: item.intent });
      continue;
    }
    const spec = {
      forkId,
      scopeId: item.scopeId,
      sourceToolCallId: baseId,
      childDepth: fork.childDepth,
      intent: item.intent,
      budget: item.budget,
      time: fork.timeBudgetMs == null ? null : fork.timeBudgetMs / 1000,
      targets: item.targets,
      model: item.model,
      modelOverride: item.modelOverride,
      thinkingLevel: item.thinkingLevel,
      parentOwnerId,
      parentDepth: depth,
    };
    spec.receipt = childReceiptText(spec);
    pending.push({
      forkId,
      scopeId: item.scopeId,
      intent: item.intent,
      childDepth: fork.childDepth,
      spec,
    });
  }

  // Register the whole batch before any child starts. A spawner that throws,
  // and a child that inspects the ledger from its first synchronous beat, both
  // see a complete batch: no later fork can be left unregistered by an earlier
  // start.
  for (const entry of pending) {
    try {
      spawner(entry.spec);
      started.push({
        forkId: entry.forkId,
        scopeId: entry.scopeId,
        intent: entry.intent,
        childDepth: entry.childDepth,
      });
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
  return textResult(sections.join("\n\n"), {
    started: started.map((entry) => entry.forkId),
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
  const args = parseArgs(call);
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  if (args.elder_report !== undefined && args.elder_report !== null &&
      typeof args.elder_report !== "string") {
    return errorResult("INVALID_ARGUMENT", E["elder-report-type"]);
  }
  // A summary is evidence, not whitespace. Accepting "  " would pass the gate
  // while the receipt writer refuses to store it: the join would look
  // successful, the obligation would survive, and the next refusal would ask
  // for a report the model already believed it had given.
  if (typeof args.elder_report === "string" && args.elder_report.trim() === "") {
    return errorResult("INVALID_ARGUMENT", E["elder-report-empty"]);
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
  // The previous successful receipt must be reported before this join takes
  // another child. Checking before takeReady keeps the refusal free of side
  // effects: a rejected call leaves the queue exactly as it found it.
  //
  // The obligation is derived from the persisted receipt chain first, then
  // from the in-memory owner map. A reload restores `state.receipts`, so the
  // first join after a restart still demands the summary instead of silently
  // dropping the fold gate. The map remains for fixtures that drive the
  // handlers without a persistence layer.
  const pendingReport = pendingReportOf(station, ownerId);
  const elderReportRaw =
    typeof args.elder_report === "string" ? args.elder_report : null;
  const elderReport = elderReportRaw === null ? null : elderReportRaw.trim();
  if (pendingReport !== null && elderReport === null) {
    const named = publicScopeId(forkOf(ledger, pendingReport.forkId));
    return errorResult(
      "INVALID_ELDER_REPORT",
      render(E["elder-report-missing"], { scopeId: named }),
      { pendingReceipt: pendingReport.closeToolCallId ?? pendingReport.forkId },
    );
  }
  // A report with nothing to archive is harmless. Refusing it would cost the
  // model a whole turn for an argument the join can ignore, so the result says
  // it was not needed instead.
  const elderUnneeded = pendingReport === null && elderReport !== null;
  if (pendingReport !== null && elderReport !== null) {
    // The stored report is trimmed, so the bound applies to its trimmed
    // length. The schema's pattern measures the same span on the raw string.
    const problem = elderReportProblem(elderReportRaw);
    if (problem !== null) {
      const message = problem.details?.minimum
        ? render(E["elder-report-too-short"], problem.details)
        : problem.details?.maximum
          ? render(E["elder-report-too-long"], problem.details)
          : problem.message;
      return errorResult(problem.code, message, {
        pendingReceipt: pendingReport.closeToolCallId ?? pendingReport.forkId,
        ...problem.details,
      });
    }
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
          active: openChildren(ledger, ownerId).length,
          pending: pendingReport,
          blocked: taken.blocked ?? [],
        },
      );
    }
    return errorResult("NO_READY_CHILD", E["no-ready-child"], {
      ownerId,
      active: openChildren(ledger, ownerId).length,
      // The waiting ticket commits with exactly this binding. Recomputing it
      // after the take would let the summary land on a receipt the model never
      // read.
      pending: pendingReport,
    });
  }
  commitJoin(station, taken.fork, call.id, elderReport, pendingReport);
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
    elderUnneeded,
  });
}

/**
 * Re-check the elder binding a waiting join was admitted with.
 *
 * The summary belongs to the receipt the model read when it called. If another
 * join commits while this one waits, the pending receipt moves on. Committing
 * now would attach the summary to a receipt the model never read, and would
 * leave the newly pending receipt with no summary that can ever be filed. The
 * check runs before the take, so a refusal leaves both the child and the
 * receipt chain exactly as they were.
 */
export function checkJoinBinding(station, expected) {
  const current = pendingReportOf(station, ownerIdOf(station));
  const decision = decideJoinBinding({ expected, current });
  if (decision.ok) return { ok: true };
  const named = publicScopeId(forkOf(ledgerOf(station), decision.forkId));
  return {
    ok: false,
    code: decision.code,
    reason: render(
      E[decision.side === "cleared" ? "stale-elder-reported" : "stale-elder-uncommitted"],
      { scopeId: named },
    ),
  };
}

/**
 * File one taken bracket in the receiver's receipt chain. Both the immediate
 * take and the ticket's later take use this one commit, so a waited join and
 * an immediate join leave the same persisted evidence.
 */
export function commitJoin(station, record, closeToolCallId, elderReport, pending = undefined) {
  const ownerId = ownerIdOf(station);
  const pendingReport = pending === undefined ? pendingReportOf(station, ownerId) : pending;
  const ledger = ledgerOf(station);
  if (pendingReport !== null) {
    const elder = ledger ? forkOf(ledger, pendingReport.forkId) : null;
    if (elder) elder.elderReport = elderReport;
  }
  if (typeof station.recordJoinReceipt === "function") {
    // The receipt chain is a persisted domain fact, not a render detail.
    // Write it before the result leaves, so a reload keeps the order.
    station.recordJoinReceipt({
      forkId: record.forkId,
      scopeId: publicScopeId(record),
      closeToolCallId,
      levelKey: record.levelKey,
      closedOrder: record.closedOrder,
      elderReport,
      pending: pendingReport,
    });
  }
  reportsOf(station).set(ownerId, {
    forkId: record.forkId,
    closeToolCallId,
  });
  return record;
}

/** The receipt the next join must summarize, or null when none is pending. */
function pendingReportOf(station, ownerId) {
  return decidePendingReport({
    receipts: Array.isArray(station.state?.receipts) ? station.state.receipts : [],
    levelKey: levelKeyOf(station),
    reports: reportsOf(station),
    ownerId,
  });
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

function reportsOf(station) {
  if (!(station.forkReports instanceof Map)) station.forkReports = new Map();
  return station.forkReports;
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
    pendingReceipt: publicScopeId(record),
	});
  const persisted = options.persisted;
  const notes = [];
  if (options.elderUnneeded === true) notes.push(F["join.elder-unneeded"]);
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
    ...(options.elderUnneeded === true ? { elderUnneeded: true } : {}),
    ...(persisted === undefined ? {} : { persisted }),
  });
}

/**
 * Settle a join that a queued user message interrupted while it waited.
 *
 * The wait took no child, but the summary the model supplied belongs to the
 * receipt it read before calling. Filing it here discharges that obligation,
 * so the next join may pass `elder_report: null`. The binding is re-checked
 * first: a concurrent join may have moved the chain, and a report the model
 * never read must not be attached to the receipt that replaced it.
 */
export function settleInterruptedJoin(station, toolCallId, params, pending = null) {
  const ledger = ledgerOf(station);
  const ownerId = ownerIdOf(station);
  const raw = typeof params?.elder_report === "string" ? params.elder_report : null;
  const elderReport = raw === null ? null : raw.trim();
  const binding = checkJoinBinding(station, pending);
  let consumed = false;
  if (binding.ok && pending !== null && elderReport !== null) {
    if (typeof station.recordElderReport === "function") {
      station.recordElderReport({
        closeToolCallId: pending.closeToolCallId,
        report: elderReport,
      });
    }
    reportsOf(station).delete(ownerId);
    consumed = true;
  }
  const persisted = consumed ? confirmJoinPersistence(station) : undefined;
  if (persisted === false) {
    station.noteError?.("fork", new Error("interrupted join report was not persisted"), {
      forkId: pending?.forkId ?? null,
      phase: "join",
    });
  }
  const next = pendingReportOf(station, ownerId);
  const elderLine = consumed
    ? F["join.interrupted-elder-consumed"]
    : pending !== null && elderReport === null
      ? F["join.interrupted-elder-missing"]
      : binding.ok
        ? F["join.interrupted-elder-unneeded"]
        : F["join.interrupted-elder-stale"];
  const nextLine =
    next === null
      ? F["join.interrupted-next-null"]
      : render(F["join.interrupted-next-report"], {
          scopeId: publicScopeId(forkOf(ledger, next.forkId)),
        });
  const remaining = unreceivedChildren(ledger, ownerId).map((id) =>
    publicScopeId(forkOf(ledger, id)),
  );
  const result = textResult(
    render(F["join.interrupted"], {
      elder: elderLine,
      next: nextLine,
      remaining: remaining.length === 0 ? "none" : remaining.join(", "),
    }),
    {
      interrupted: true,
      joined: false,
      elderConsumed: consumed,
      nextElderReport: next === null ? null : next.forkId,
      remaining,
      ...(persisted === undefined ? {} : { persisted }),
    },
  );
  // The interruption is this tool call's final answer. Caching it keeps a
  // replay from filing the same report twice.
  processedOf(station)?.setHandled?.(toolCallId, result);
  processedOf(station)?.markCall?.(toolCallId);
  station.persist?.();
  return result;
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
  // that now answers for it.
  const orphans = record
    ? [...openChildren(ledger, selfForkId), ...readyChildren(ledger, selfForkId)]
    : [];
  const decision = decideReturn({
    identityForkId: selfForkId,
    record,
    receiverId: record?.ownerId ?? "",
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
  const receiverId = decision.receiverId;
  // Freeze this branch's own record before the bracket becomes ready. The
  // parent may take it in the same tick, and a parent that reads an empty
  // record cannot tell a silent child from a broken one. Amends are filtered
  // first: a withdrawn beat must never return through a replay.
  let renderedRecord = null;
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

export { levelKeyOf, ownerIdOf, depthOf };
