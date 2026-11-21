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
import { validScopeId, publicScopeId } from "../scope/scope-id.mjs";
import { estimateJoinTokens, joinAdmission } from "../scope/admission.mjs";
import { latestReceiptOf } from "../scope/receipts.mjs";
import { normalizeBudget, validBudget } from "../scope/budget.mjs";
import { joinReceipt, renderChildRecord } from "../transcript/replay.mjs";
import { filterAmends } from "../transcript/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { parseArgs, trimText } from "./messages.mjs";

const F = loadDoc("tools/fork-join");
const S = loadDoc("receipts/scope");

// A summary is archive material. The runtime cannot prove that it names what
// the successor still needs, but a one-word value can guide no later decision,
// and an unbounded value is a second copy of the record. Both are refused
// before any child is consumed.
const MIN_ELDER_REPORT_CHARS = 24;
const MAX_ELDER_REPORT_CHARS = 4000;
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

/**
 * Check every fork argument without changing state. Returns the normalized
 * budget on success so the caller never normalizes twice.
 */
export function validateFork(state, args, options = {}) {
  const intent = trimText(args?.intent);
  if (intent === "") return { ok: false, code: "INVALID_INTENT" };
  // The write gate is the only admission rule left on permission: a full-flow
  // generation that has not submitted a ledger may not declare `rw`.
  if (
    args?.permission === "rw" &&
    options.relayOn === true &&
    state?.relay?.fullFlow === true &&
    state?.relay?.firstEvaluation === null
  ) {
    return { ok: false, code: "RW_BEFORE_LEDGER" };
  }
  if (!Object.hasOwn(args ?? {}, "budget") || !validBudget(args.budget)) {
    return { ok: false, code: "INVALID_BUDGET" };
  }
  const budget = normalizeBudget(args.budget);
  if (!validBudget(budget)) return { ok: false, code: "INVALID_BUDGET" };
  if (typeof args?.time !== "number" || !Number.isFinite(args.time) || args.time <= 0) {
    return { ok: false, code: "INVALID_TIME" };
  }
  if (args?.permission !== "ro" && args?.permission !== "rw") {
    return { ok: false, code: "INVALID_ARGUMENT" };
  }
  if (args.model !== undefined && args.model !== null) {
    if (typeof args.model !== "string" || args.model.trim() === "") {
      return { ok: false, code: "INVALID_ARGUMENT" };
    }
  }
  if (args.blocked !== undefined && typeof args.blocked !== "boolean") {
    return { ok: false, code: "INVALID_ARGUMENT" };
  }
  if (!validScopeId(args?.scopeId) || args.scopeId.toLowerCase() === "root") {
    return { ok: false, code: "INVALID_SCOPE_ID" };
  }
  return {
    ok: true,
    scopeId: args.scopeId,
    intent,
    budget,
    time: args.time,
    permission: args.permission,
    model: typeof args.model === "string" ? args.model.trim() : null,
    blocked: args.blocked === true,
  };
}

/**
 * Validate a whole fork batch before any state changes. One bad item rejects
 * the batch: a half-open batch would leave the model unsure which brackets it
 * owns.
 */
export function validateForkBatch(state, args, options = {}) {
  if (!Array.isArray(args?.forks) || args.forks.length === 0) {
    return { ok: false, code: "INVALID_FORKS", index: -1 };
  }
  const items = [];
  for (let index = 0; index < args.forks.length; index += 1) {
    const item = validateFork(state, args.forks[index], options);
    if (!item.ok) return { ok: false, code: item.code, index };
    items.push(item);
  }
  return { ok: true, items };
}

const REFUSAL_TEXT = {
  INVALID_SCOPE_ID: "scopeId is required: use a short ASCII identifier other than root.",
  INVALID_INTENT: "intent must be a non-empty string.",
  INVALID_BUDGET: "budget must be a plain object of non-negative integer tool budgets.",
  INVALID_TIME: "time is required and must be a positive number of seconds.",
  INVALID_ARGUMENT: "permission must be ro or rw, and model must be a string or null.",
  RW_BEFORE_LEDGER: "Write permission requires the first ledger evaluation.",
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

/**
 * Admission for one candidate join. A refusal keeps the record ready; the
 * caller names the refusal and lets the model choose a larger window or a
 * smaller result.
 */
export function admitJoin(station, record, options = {}) {
  const messages =
    typeof station.contextMessages === "function" ? station.contextMessages() : [];
  // A station double may expose only a partial usage ledger. Missing evidence
  // is an unmeasured request, never a zero-sized one.
  let base = Number.POSITIVE_INFINITY;
  try {
    if (typeof station.currentContextTokens === "function") {
      base = station.currentContextTokens(messages);
    } else if (typeof station.usage?.currentContextTokens === "function") {
      base = station.usage.currentContextTokens(messages);
    }
  } catch {
    base = Number.POSITIVE_INFINITY;
  }
  const recordChars =
    recordTextOf(station, record).length + JOIN_RECEIPT_OVERHEAD_CHARS;
  const key = station.usage?.lastUsageModelKey ?? null;
  let density = 0.3;
  try {
    if (typeof station.tokensPerCharFor === "function") {
      const value = station.tokensPerCharFor(key);
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        density = value;
      }
    } else if (typeof station.usage?.tokensPerCharFor === "function") {
      const value = station.usage.tokensPerCharFor(key);
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        density = value;
      }
    }
  } catch {
    density = 0.3;
  }
  const projected = estimateJoinTokens({
    baseTokens: base,
    recordChars,
    tokensPerChar: density,
  });
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
  return joinAdmission({ window, projected, reserve, margin });
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
      permission: spec.permission,
    }),
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
  const batch = validateForkBatch(station.state, args, options);
  if (!batch.ok) {
    const where = batch.index >= 0 ? ` (forks[${batch.index}])` : "";
    return errorResult(
      batch.code,
      `${REFUSAL_TEXT[batch.code] ?? "Invalid fork arguments."}${where}`,
    );
  }
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", "No bracket ledger is attached.");
  }
  const names = new Set(ledger.order.map((id) => forkOf(ledger, id))
    .filter((entry) => entry?.status !== "blocked").map((entry) => publicScopeId(entry).toLowerCase()));
  for (const item of batch.items) {
    const key = item.scopeId.toLowerCase();
    if (names.has(key)) return errorResult("DUPLICATE_SCOPE_ID", `Scope ${item.scopeId} is already declared.`);
    names.add(key);
  }
  // A pure checkpoint starts nothing, so it needs no spawner. Only a batch
  // that actually promises running children requires one.
  const needsSpawn = batch.items.some((item) => item.blocked !== true);
  const spawner =
    typeof station.childSpawnPort === "function" ? station.childSpawnPort() : null;
  if (needsSpawn && typeof spawner !== "function") {
    return errorResult("CHILD_SPAWNER_UNAVAILABLE", "No child spawner is attached.");
  }

  const parentOwnerId = ownerIdOf(station);
  const depth = depthOf(station);
  const baseId = typeof call.id === "string" && call.id !== "" ? call.id : `fork-${Date.now()}`;
  const started = [];
  const deferred = [];
  const failed = [];
  for (let index = 0; index < batch.items.length; index += 1) {
    const item = batch.items[index];
    const forkId = batch.items.length === 1 ? baseId : `${baseId}:${index}`;
    const registered = registerFork(ledger, {
      forkId,
      scopeId: item.scopeId,
      ownerId: parentOwnerId,
      levelKey: levelKeyOf(station),
      intent: item.intent,
      depth,
      blocked: item.blocked === true,
      budget: item.budget,
      time: item.time,
      startedAt: Date.now(),
    });
    if (!registered.ok) {
      failed.push({ forkId, scopeId: item.scopeId, intent: item.intent, reason: registered.reason });
      continue;
    }
    const fork = registered.fork;
    // `registerFork` is the only place a budget is born, and it copies the
    // input into both `budget` and `remaining`. Assigning the budget here
    // after the fact would leave `remaining` at the empty object the ledger
    // started with, and the child's first normal tool call would be refused
    // as exhausted.
    fork.permission = item.permission;
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
      time: item.time,
      permission: item.permission,
      model: item.model,
      parentOwnerId,
      parentDepth: depth,
    };
    spec.receipt = childReceiptText(spec);
    try {
      spawner(spec);
      started.push({ forkId, scopeId: item.scopeId, intent: item.intent, childDepth: fork.childDepth });
    } catch (error) {
      const reason = String(error?.message ?? error);
      // The bracket stays registered as running so the parent can still see
      // that this fork exists; it is reported as failed to start.
      failed.push({ forkId, scopeId: item.scopeId, intent: item.intent, reason });
      markReady(ledger, forkId, { ok: false, reason: `did not start: ${reason}` });
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
    return errorResult("FORK_LEDGER_UNAVAILABLE", "No bracket ledger is attached.");
  }
  if (args.elder_report !== undefined && args.elder_report !== null &&
      typeof args.elder_report !== "string") {
    return errorResult("INVALID_ARGUMENT", "elder_report must be a string or null.");
  }
  // A summary is evidence, not whitespace. Accepting "  " would pass the gate
  // while the receipt writer refuses to store it: the join would look
  // successful, the obligation would survive, and the next refusal would ask
  // for a report the model already believed it had given.
  if (typeof args.elder_report === "string" && args.elder_report.trim() === "") {
    return errorResult(
      "INVALID_ARGUMENT",
      "elder_report must be a non-empty string or null.",
    );
  }
  const ownerId = ownerIdOf(station);
  // With nothing running and nothing ready, no join can succeed. Answering
  // before the report gate keeps the model out of a loop that demands a
  // summary for a receipt no later join could ever archive.
  if (unreceivedChildren(ledger, ownerId).length === 0) {
    return errorResult("NO_READY_CHILD", "No child has returned yet.", {
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
  const elderReport =
    typeof args.elder_report === "string" ? args.elder_report.trim() : null;
  if (pendingReport !== null && elderReport === null) {
    const named = publicScopeId(forkOf(ledger, pendingReport.forkId));
    return errorResult(
      "INVALID_ELDER_REPORT",
      `Receipt ${named} is still unreported. Summarize it in elder_report, or this join cannot proceed.`,
      { pendingReceipt: pendingReport.closeToolCallId ?? pendingReport.forkId },
    );
  }
  if (pendingReport === null && elderReport !== null) {
    return errorResult(
      "ELDER_REPORT_UNEXPECTED",
      "No receipt needs a summary. Pass elder_report: null.",
    );
  }
  if (pendingReport !== null && elderReport !== null) {
    if (elderReport.length < MIN_ELDER_REPORT_CHARS) {
      return errorResult(
        "INVALID_ELDER_REPORT",
        `elder_report needs at least ${MIN_ELDER_REPORT_CHARS} characters. Say what the successor still needs from that record; the content decides its format.`,
        {
          pendingReceipt: pendingReport.closeToolCallId ?? pendingReport.forkId,
          minimum: MIN_ELDER_REPORT_CHARS,
        },
      );
    }
    if (elderReport.length > MAX_ELDER_REPORT_CHARS) {
      return errorResult(
        "INVALID_ELDER_REPORT",
        `elder_report exceeds ${MAX_ELDER_REPORT_CHARS} characters. Shorten it to what a successor cannot recover elsewhere.`,
        {
          pendingReceipt: pendingReport.closeToolCallId ?? pendingReport.forkId,
          maximum: MAX_ELDER_REPORT_CHARS,
        },
      );
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
      return errorResult(
        "JOIN_CONTEXT_EXCEEDED",
        first
          ? `Fork ${publicScopeId(forkOf(ledger, first.forkId))} cannot be delivered: ${first.reason ?? "the next request would exceed the model window"}. The record stays ready; use a model with a larger window or reduce the record, then join again.`
          : "No ready child fits the model window. The records stay ready.",
        {
          ownerId,
          active: openChildren(ledger, ownerId).length,
          pending: pendingReport,
          blocked: taken.blocked ?? [],
        },
      );
    }
    return errorResult("NO_READY_CHILD", "No child has returned yet.", {
      ownerId,
      active: openChildren(ledger, ownerId).length,
      // The waiting ticket commits with exactly this binding. Recomputing it
      // after the take would let the summary land on a receipt the model never
      // read.
      pending: pendingReport,
    });
  }
  commitJoin(station, taken.fork, call.id, elderReport, pendingReport);
  return renderJoinResult(station, taken.fork, {
    ledger,
    ownerId,
    closeToolCallId: call.id,
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
  const want = expected && typeof expected === "object" ? expected : null;
  const current = pendingReportOf(station, ownerIdOf(station));
  if (want === null && current === null) return { ok: true };
  if (
    want !== null &&
    current !== null &&
    (want.closeToolCallId ?? want.forkId) === (current.closeToolCallId ?? current.forkId)
  ) {
    return { ok: true };
  }
  if (current === null) {
    const named = publicScopeId(forkOf(ledgerOf(station), want?.forkId));
    return {
      ok: false,
      code: "STALE_ELDER_REPORT",
      reason: `Receipt ${named} already has a summary. This join took no result. Retry with elder_report: null.`,
    };
  }
  const named = publicScopeId(forkOf(ledgerOf(station), current.forkId));
  return {
    ok: false,
    code: "STALE_ELDER_REPORT",
    reason: `This join took no result; its summary was not committed. Retry with an elder_report for ${named}.`,
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
  const receipts = Array.isArray(station.state?.receipts) ? station.state.receipts : [];
  // The level key carries the relay generation and epoch, so a handoff or a
  // promotion changes it. The obligation itself does not disappear with the
  // key: an unreported receipt still names the elder the next join must
  // summarize, so fall back to the chain itself.
  const latest =
    latestReceiptOf(receipts, levelKeyOf(station)) ?? lastUnreportedReceipt(receipts);
  if (latest) {
    // A receipt that already carries a report has discharged its obligation.
    // Without this check a persisted chain whose youngest receipt was reported
    // would demand the same summary forever.
    if (typeof latest.report === "string" && latest.report.trim() !== "") return null;
    return { forkId: latest.forkToolCallId, closeToolCallId: latest.closeToolCallId };
  }
  return pendingOf(reportsOf(station).get(ownerId));
}

/**
 * The youngest receipt anywhere in the chain that still owes a report.
 *
 * Used when no receipt belongs to the current level key: the previous
 * generation's last join is still the elder the next join has to summarize.
 */
function lastUnreportedReceipt(receipts) {
  let best = null;
  for (const entry of receipts) {
    if (!entry || typeof entry.closeToolCallId !== "string") continue;
    if (typeof entry.report === "string" && entry.report.trim() !== "") continue;
    if (!best || entry.closedOrder >= best.closedOrder) best = entry;
  }
  return best;
}

/** Accept the legacy string form as well as the record written now. */
function pendingOf(value) {
  if (typeof value === "string" && value !== "") {
    return { forkId: value, closeToolCallId: null };
  }
  if (value && typeof value === "object" && typeof value.forkId === "string") {
    return value;
  }
  return null;
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
  return textResult(text, {
    forkId: record.forkId,
    joined: true,
    remaining,
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
    return errorResult("FORK_LEDGER_UNAVAILABLE", "No bracket ledger is attached.");
  }
  const identity = identityOf(station);
  const selfForkId =
    identity && typeof identity.forkId === "string" ? identity.forkId : "";
  if (selfForkId === "") {
    return errorResult(
      "NOT_A_CHILD",
      "scope_return belongs to a forked child. The parent receives work with scope_join.",
    );
  }
  const record = forkOf(ledger, selfForkId);
  if (!record) {
    return errorResult("UNKNOWN_FORK", "This scope is not registered.");
  }
  if (record.status !== "running") {
    return errorResult("FORK_NOT_RUNNING", `Fork ${publicScopeId(record)} is ${record.status}.`);
  }
  // Adoption follows the current receiver, never the birth parent: a branch
  // that was itself adopted must hand its unreceived children to the branch
  // that now answers for it.
  const receiverId = record.ownerId;
  if (typeof receiverId !== "string" || receiverId === "") {
    return errorResult(
      "ORPHANS_WITHOUT_RECEIVER",
      "No receiving branch owns this fork. Join its children first.",
    );
  }
  const orphans = [
    ...openChildren(ledger, selfForkId),
    ...readyChildren(ledger, selfForkId),
  ];
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
  const ready = markReady(
    ledger,
    selfForkId,
    renderedRecord === null ? { ok: true } : { ok: true, record: renderedRecord },
  );
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
