// Fork/join control handlers: scope_fork, scope_join, scope_return.
//
// Plain synchronous functions. The bracket ledger arrives through a port and
// the child spawner arrives through another, so a station that has neither
// refuses instead of inventing one. Child agents are assembled by the host
// wiring, not here.

import {
  abandon,
  abandonDescendants,
  adoptFork,
  annotateFork,
  forkOf,
  liveReceiverOf,
  markReady,
  openChildren,
  readyChildren,
  registerFork,
  reparentOrphans,
  takeReady,
  unreceivedChildren,
} from "../scope/forkjoin.mjs";
import { allocateSiblingScopeId, childScopePath, findScopeByPath, normalizeScopePath } from "../scope/path.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { setRecordFields } from "../scope/record-mutation.mjs";
import { releaseRecordText } from "../scope/forkjoin.mjs";
import { createClockOn } from "../scope/clock.mjs";
import { deriveTimeBudgetSeconds, modelSamples } from "../scope/turn-stats.mjs";
import {
  decideJoinAdmission,
  decideRegister,
  decideReady,
  decideReturn,
  validateForkBatch,
} from "./domain/fork-join.mjs";
import {
  decideScopeReturn,
  formatGenerationReport,
  resetRootPromotion,
} from "./domain/handoff.mjs";
import { processedOf } from "./domain/tool-call-ledger.mjs";
import { notifyWaiters, pulse, setOutcome } from "../scope/fork-registry.mjs";
import { rejectPendingRequests } from "../scope/request-queue.mjs";
import { targetsText } from "../scope/targets.mjs";
import { joinReceipt } from "../transcript/replay.mjs";
import { toolCalls } from "../transcript/messages.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { parseArgs } from "./messages.mjs";

const F = loadDoc("tools/fork-join");
const S = loadDoc("receipts/scope");
const E = loadDoc("errors");

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

function budgetText(turns) {
  const parts = [];
  for (const key of Object.keys(turns ?? {})) parts.push(`${key} ${turns[key]}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * The journal frame that carries this call.
 *
 * The js runtime mints a synthetic call id (`<frameId>#<index>`) so one script
 * can issue several control calls; only the frame id exists as a tool call in
 * the parent's assistant message, so that is the id the journal lookup, the
 * branch session, and the UI attribution all read. A native call has no frame
 * of its own and falls back to its own id.
 */
function frameOf(call) {
  if (typeof call?.frameId === "string" && call.frameId !== "") return call.frameId;
  return typeof call?.id === "string" ? call.id : "";
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
 * A guessed alias window is not an exact fact, so it is not used. The station
 * owns the resolution order; this reader keeps a station double that predates
 * the method working, and returns null the same way.
 */
function windowOf(station) {
  if (typeof station.contextWindowTokens === "function") {
    const window = station.contextWindowTokens();
    return Number.isFinite(window) && window > 0 ? window : null;
  }
  // A station double predates the method, so this branch repeats the same
  // order the station uses. Keeping it here is the price of allowing a double
  // that was never wired to a host; the live path has one owner.
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
 * The characters a join receipt adds to the parent's next request.
 *
 * The model reads `content[0].text` of the tool result, so the price is the
 * rendered receipt itself: header, preamble, the record and the unreceived
 * note. `details` is host metadata and never enters the conversation. The
 * remaining list is measured after the take, because the candidate leaves the
 * unreceived set the moment it is accepted.
 */
function joinReceiptChars(station, record) {
  const ledger = ledgerOf(station);
  const ownerId = ownerIdOf(station);
  const remaining =
    ledger === null
      ? []
      : unreceivedChildren(ledger, ownerId)
          .filter((id) => id !== record.forkId)
          .map((id) => publicScopeId(forkOf(ledger, id)));
  const outcome =
    typeof station.childOutcomePort === "function"
      ? station.childOutcomePort(record.forkId)
      : null;
  return joinReceipt({
    forkId: publicScopeId(record),
    record: recordTextOf(station, record),
    failed: record.outcome === "failed" || outcome?.failed === true,
    reason: record.reason ?? outcome?.reason ?? null,
    remaining,
  }).length;
}

/**
 * Admission for one candidate join. A refusal keeps the record ready; the
 * caller names the refusal and lets the model choose a larger window or a
 * smaller result.
 */
export function admitJoin(station, record, options = {}) {
  const recordChars = joinReceiptChars(station, record);
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

/** The first line of a forked scope's receipt, as its context carries it. */
function scopeReceiptMarker(scopeId) {
  return `You are now in the scope ${scopeId},`;
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
 * receipt the scope reads at its start is the exact boundary: the latest user
 * message that opens with {@link scopeReceiptMarker}. Scanning backwards binds
 * to the current generation's birth receipt even if an earlier message shared
 * the prefix. When that message is absent (a host that rewrites it), the
 * bracket's start time is the fallback; a message without a parseable
 * timestamp cannot prove it belongs to the scope, so the walk skips it. With
 * neither marker nor timestamp the whole context is returned.
 *
 * Receipts written by earlier builds still open with the legacy marker, so the
 * scan accepts both. Only the current marker is ever generated.
 */
export function childRecordStart(messages, fork) {
  const source = Array.isArray(messages) ? messages : [];
  const forkId = fork && typeof fork.forkId === "string" ? fork.forkId : "";
  if (forkId !== "") {
    // A receipt names the scope by its path; older receipts name the bare
    // scope id, and a restored transcript still has to cut at the right line.
    const names = [fork.path, fork.scopeId, forkId].filter(
      (name) => typeof name === "string" && name !== "",
    );
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const text = textOfUser(source[index]).trimStart();
      for (const name of names) {
        if (
          text.startsWith(scopeReceiptMarker(name)) ||
          text.startsWith(`You are the child of fork ${name},`)
        ) {
          return index;
        }
      }
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
      marker: scopeReceiptMarker(spec.scopeId ?? spec.forkId),
      depth: spec.childDepth,
      fsm: spec.fsm,
      remaining: budgetText(spec.budget),
      targets: targetsText(spec.targets),
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
  const firstItemByScope = new Map();
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
  const totals = ledger.totals;
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
    const key = item.scopeId.toLowerCase();

    // The name and its address were fixed before pricing, so the receipt the
    // child reads is the exact text admission measured.
    const { scopeId, path } = allocations[index];
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
  // (`canStop`) or first big-oath review streak is cleared synchronously.
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
  const unreceivedPaths = unreceivedChildren(ledger, parentOwnerId).map((id) =>
    publicScopeId(forkOf(ledger, id)),
  );
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
      unreceived: unreceivedPaths,
    },
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
/**
 * Close one child that will not return.
 *
 * `scope_abandon({ target })` names one exact path under this scope. The
 * bracket closes as failed (a running child becomes ready-with-failure, so a
 * parked join takes it), its descendants close with it, its agent stops, its
 * queued requests reject, and the registry wakes every waiter. The record is
 * kept: the join still reports what happened.
 */
export function handleAbandonCall(station, call) {
  const ledger = ledgerOf(station);
  if (!ledger) return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  const args = parseArgs(call);
  const raw = typeof args?.target === "string" ? args.target.trim() : "";
  const callerPath =
    typeof station.selfScopePath === "function" ? station.selfScopePath() : "/";
  const normalized = normalizeScopePath(callerPath, raw);
  if (raw === "" || !normalized.ok) {
    return errorResult(
      "ABANDON_UNKNOWN_TARGET",
      render(E["abandon-unknown-target"], { target: raw }),
    );
  }
  const record = findScopeByPath(ledger, normalized.path);
  if (!record) {
    return errorResult(
      "ABANDON_UNKNOWN_TARGET",
      render(E["abandon-unknown-target"], { target: normalized.path }),
    );
  }
  if (record.ownerId !== ownerIdOf(station)) {
    return errorResult(
      "ABANDON_NOT_OWNED",
      render(E["abandon-not-owned"], { target: normalized.path }),
    );
  }
  const reason = `abandoned by ${callerPath}`;
  const subtree = abandonDescendants(ledger, record.forkId, reason);
  if (record.status === "running") {
    // A parked join takes only a ready record, so a running child closes as
    // ready-with-failure; the outcome says it was abandoned.
    markReady(ledger, record.forkId, { ok: false, reason, record: "" });
  } else {
    abandon(ledger, record.forkId, reason);
  }
  const wait = station.forkWaitPort?.() ?? null;
  const registry = wait?.registry ?? station.registry ?? null;
  if (registry && typeof registry === "object") {
    setOutcome(registry, record.forkId, { failed: true, reason, record: "" });
    rejectPendingRequests(registry, normalized.path, reason);
    pulse(registry, ledger, record.forkId, { failed: true, reason, record: "" });
    notifyWaiters(registry);
  }
  // The target stops too: its own agent may be the one that never returns.
  const liveIds = [
    record.forkId,
    ...(subtree.runningIds ?? []),
    ...(subtree.liveIds ?? []),
  ];
  station.abortChildrenPort?.(liveIds, subtree.abandonedIds ?? [], liveIds);
  const closed = Array.isArray(subtree.abandonedIds) ? subtree.abandonedIds : [];
  return textResult(render(F["abandon.tool"], { path: normalized.path }), {
    result: {
      ok: true,
      abandoned: [
        normalized.path,
        ...closed.map((forkId) => {
          const child = forkOf(ledger, forkId);
          return child?.path ?? forkId;
        }),
      ],
    },
  });
}

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
        : "No ready scope fits the model window.";
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
    closeToolCallId: frameOf(call),
    persisted,
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
  // The body has now been read for the last time. Render it above, then hand
  // it back: a delivered record has no reader after this receipt, and keeping
  // it makes every later ledger baseline re-serialize the whole transcript.
  // `renderJoinResult` runs before the station persists the join, so the write
  // that follows already carries the smaller record.
  //
  // The release is conditional on the outcome table still holding the text, so
  // a second render of the same join reproduces the identical receipt instead
  // of an empty one. When the table has no copy there is nothing to fall back
  // on, and the body stays: a correct receipt outranks a smaller write.
  if (
    typeof record.record === "string" &&
    typeof outcome?.record === "string"
  ) {
    releaseRecordText(ledger, record.forkId);
  }
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
    result: {
      ok: !childFailed,
      scope: publicScopeId(record),
      failed: childFailed,
      reason: childReason,
      record: rendered,
      note: "History only; do not re-execute it.",
      unreceived: remaining.map((entry) => entry.scopeId),
      persisted: persisted !== false,
    },
  });
}

/**
 * Close or rewind the current scope through `scope_return`.
 *
 * Unified across Root (depth 0) and Child (depth >= 1):
 * - Omitted oath -> small handoff rewind (`stopLoop: true`) back to birth.
 * - Exact oath -> Child seals and delivers to parent (`stopLoop: true`);
 *   Root #1 rewinds for independent review (`stopLoop: true`);
 *   Root #2 consecutive promotes without rewind (`stopLoop: false`).
 * - Woken child -> `dafny` forwards to `..`; the parent receives it as a new
 *   `scope_request` and no second return is invented.
 */
export function handleReturnCall(station, call, options = {}) {
  const args = parseArgs(call);
  const identity = identityOf(station);
  const selfForkId =
    identity && typeof identity.forkId === "string" ? identity.forkId : "";
  const isRoot = selfForkId === "";
  const ledger = ledgerOf(station);
  if (!isRoot && !ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  const record = !isRoot && ledger ? forkOf(ledger, selfForkId) : null;
  const orphans = !isRoot && record
    ? [...openChildren(ledger, selfForkId), ...readyChildren(ledger, selfForkId)]
    : [];
  const receiverId = !isRoot && record ? liveReceiverOf(ledger, record.ownerId ?? "") : "";
  const unreceived = isRoot && ledger ? unreceivedChildren(ledger, "root").length : 0;

  // Reject any mixed batch that pairs `scope_return` with other tool calls in
  // the same assistant message, so sibling tools cannot race loop termination
  // or a rewind boundary.
  const carrying = options.currentMessage ?? null;
  const callsInBeat = carrying ? toolCalls(carrying) : [];
  const mixedToolCalls =
    callsInBeat.length > 1 &&
    callsInBeat.some((entry) => entry.id !== frameOf(call));

  // Root rewinds require a real host session/manager capable of persisting the
  // compaction boundary. If the host explicitly reports `canRewindRoot(ctx) === false`,
  // refuse before mutating state so Root never lands in a stranded pendingRewind.
  const canRewindFn = station.host?.session?.canRewindRoot;
  const canRewindRoot =
    typeof canRewindFn === "function"
      ? canRewindFn(options.ctx) === true
      : Boolean(station.manager && typeof station.manager.appendCompaction === "function");

  const decision = decideScopeReturn({
    isRoot,
    identityForkId: selfForkId,
    record,
    receiverId,
    orphans,
    unreceived,
    relay: station.state?.relay ?? null,
    canRewindRoot,
    mixedToolCalls,
    args,
    callId: typeof call?.id === "string" ? call.id : "",
  });

  if (!decision.ok) {
    if (decision.code === "INVALID_RETURN_OATH") {
      return errorResult("INVALID_RETURN_OATH", E["invalid-return-oath"]);
    }
    if (decision.code === "MISSING_DAFNY") {
      return errorResult("MISSING_DAFNY", E["missing-dafny"]);
    }
    if (decision.code === "MIXED_RETURN_TOOL_CALLS") {
      return errorResult("MIXED_RETURN_TOOL_CALLS", E["mixed-return"]);
    }
    if (decision.code === "UNRECEIVED_CHILDREN") {
      return errorResult(
        "UNRECEIVED_CHILDREN",
        render(E["return-unreceived"], { count: decision.unreceived }),
        { unreceived: decision.unreceived },
      );
    }
    if (decision.code === "ROOT_REWIND_UNAVAILABLE") {
      return errorResult("ROOT_REWIND_UNAVAILABLE", E["return-rewind-unavailable"]);
    }
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

  // Child small handoff: keep bracket RUNNING, capture formatted generation
  // report, and let the spawn ticket rewind back to `originEntryId` after the
  // agent loop stops cleanly via `stopLoop: true`.
  if (decision.kind === "rewind" && decision.scope === "child") {
    const canRewindChild =
      station.childRewindAvailable !== false &&
      typeof station.manager?.branch === "function" &&
      typeof station.manager?.resetLeaf === "function";
    if (!canRewindChild) {
      return errorResult("ROOT_REWIND_UNAVAILABLE", E["return-rewind-unavailable"]);
    }
    const messages =
      typeof station.contextMessages === "function" ? station.contextMessages() : [];
    const report = formatGenerationReport(
      messages,
      childRecordStart(messages, record),
      decision.dafny,
    );
    const generation =
      (Number.isInteger(record.handoffCount) && record.handoffCount >= 0 ? record.handoffCount : 0) + 1;
    setRecordFields(record, { handoffCount: generation });
    station.pendingChildRewind = {
      report,
      big: false,
      generation,
      id: typeof call?.id === "string" ? call.id : "",
    };
    return textResult(
      render(F["return.rewind"], { generation }),
      {
        forkId: selfForkId,
        scopeId: publicScopeId(record),
        accepted: true,
        rewind: true,
        generation,
        stopLoop: true,
      },
    );
  }

  // Root promotion (2nd consecutive big handoff): allow final answer in place.
  if (decision.kind === "promote") {
    station.state.relay = decision.relay;
    return textResult(F["return.finish"], {
      scope: "root",
      accepted: true,
      promoted: true,
      bigStreak: decision.relay.bigStreak,
      canStop: true,
      stopLoop: false,
    });
  }

  // Root rewind (small handoff or 1st big handoff): format this generation's
  // record + dafny, persist `pendingRewind` on `state.relay`, and stop the
  // loop cleanly so `onAgentEnd` dispatches the host rewind ticket.
  if (decision.kind === "rewind" && decision.scope === "root") {
    const messages =
      typeof station.contextMessages === "function" ? station.contextMessages() : [];
    const report = formatGenerationReport(
      messages,
      0,
      decision.dafny,
    );
    const pendingRewind = {
      ...decision.pendingRewind,
      report,
    };
    station.state.relay = {
      ...decision.relay,
      pendingRewind,
    };
    const template = decision.big ? F["return.review"] : F["return.rewind"];
    return textResult(
      render(template, { generation: pendingRewind.generation }),
      {
        scope: "root",
        accepted: true,
        rewind: true,
        big: decision.big,
        generation: pendingRewind.generation,
        stopLoop: true,
        result: {
          ok: true,
          scope: "root",
          rewind: true,
          sealed: false,
          big: decision.big,
          generation: pendingRewind.generation,
        },
      },
    );
  }

  // Child big handoff (oath present): seal the bracket and deliver to receiver.
  // Keep `decideReturn` assertion for the pure fork-join gate contract.
  const gate = decideReturn({
    identityForkId: selfForkId,
    record,
    receiverId: decision.receiverId,
    orphans: decision.orphans,
  });
  if (!gate.ok) {
    return errorResult(gate.code, E["orphans-without-receiver"]);
  }
  const adopted = adoptFork(ledger, selfForkId, decision.receiverId);
  if (!adopted.ok) return errorResult(adopted.code, adopted.reason);

  let renderedRecord = null;
  if (typeof station.setChildOutcome === "function") {
    const messages =
      typeof station.contextMessages === "function" ? station.contextMessages() : [];
    renderedRecord = formatGenerationReport(
      messages,
      childRecordStart(messages, record),
      decision.dafny,
    );
    station.setChildOutcome(selfForkId, {
      record: renderedRecord,
      failed: false,
      reason: null,
    });
  }

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
  if (decision.orphans.length > 0) reparentOrphans(ledger, selfForkId, decision.receiverId);

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
  const receiverText =
    decision.receiverId === "root"
      ? "Root"
      : publicScopeId(forkOf(ledger, decision.receiverId));
  const lines = [`Sealed ${publicScopeId(record)}; delivered to ${receiverText}.`];
  if (decision.orphans.length > 0) {
    lines.push(
      `Reparented to ${receiverText}: ${decision.orphans.map((id) => publicScopeId(forkOf(ledger, id))).join(", ")}.`,
    );
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
    reparented: decision.orphans,
    receiver: decision.receiverId,
    receiverText,
    accepted: true,
    stopLoop: true,
    result: {
      ok: true,
      scope: publicScopeId(record),
      sealed: true,
      receiver: receiverText,
      reparented: decision.orphans.map((id) => publicScopeId(forkOf(ledger, id))),
      persisted,
    },
  });
}

export { levelKeyOf, ownerIdOf, depthOf };
