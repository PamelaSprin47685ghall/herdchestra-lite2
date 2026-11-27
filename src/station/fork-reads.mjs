// Read-only readers over a station: ledger, identity, depth, model window,
// measured context, receipt pricing, and the child receipt text itself.
//
// Plain synchronous functions. They read ports and state and never write: the
// control handlers own every mutation. Keeping them apart bounds the control
// surface and lets the fork, join, return, and abandon handlers share one
// definition of "which ledger", "which depth", and "which window".

import { forkOf } from "../scope/ledger-charge.mjs";
import { unreceivedChildren } from "../scope/ledger-brackets.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { roleOfPath } from "../scope/roles.mjs";
import { targetsText } from "../scope/targets.mjs";
import { joinReceipt } from "../transcript/replay.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { decideJoinAdmission } from "./domain/fork-join.mjs";
import { resolveContextWindow } from "./domain/context.mjs";

const S = loadDoc("receipts/scope");

function ledgerOf(station) {
  if (typeof station.forkLedgerPort === "function") {
    const ledger = station.forkLedgerPort();
    if (ledger && typeof ledger === "object") return ledger;
  }
  return station.brackets ?? null;
}

function identityOf(station) {
  const identity = station.forkIdentityPort?.() ?? null;
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
  const depth = station.forkDepthPort?.();
  if (Number.isInteger(depth) && depth >= 0) return depth;
  return typeof station.ownerId === "string" && station.ownerId !== "" ? 1 : 0;
}

/** The level key that groups sibling brackets. */
export function levelKeyOf(station) {
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
  const outcome = station.childOutcomePort?.(record.forkId) ?? null;
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
  // A station double may predate the method; the domain owns the resolution
  // order, so the double resolves the window exactly as the station does.
  const window =
    typeof station.contextWindowTokens === "function"
      ? station.contextWindowTokens()
      : resolveContextWindow(station);
  return Number.isFinite(window) && window > 0 ? window : null;
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
 * One reading of a returning scope: its record text, its failure and abandon
 * facts, and the scopes still unreceived.
 *
 * Admission prices a receipt from this reading and delivery renders it from the
 * same reading. Two readings of one record could disagree, and a price that does
 * not match the text sent is a defect, not an approximation.
 *
 * `excludeSelf` drops the candidate itself, which admission needs: at price
 * time the candidate is still inside the unreceived set.
 */
function joinEnvelope(station, record, options = {}) {
  const ledger = options.ledger ?? ledgerOf(station);
  const ownerId = options.ownerId ?? ownerIdOf(station);
  const remaining =
    ledger === null
      ? []
      : unreceivedChildren(ledger, ownerId)
          .filter((id) => (options.excludeSelf === true ? id !== record.forkId : true))
          .map((id) => ({ forkId: id, scopeId: publicScopeId(forkOf(ledger, id)) }));
  const outcome = station.childOutcomePort?.(record.forkId) ?? null;
  return {
    ledger,
    ownerId,
    remaining,
    record: recordTextOf(station, record),
    failed: record.outcome === "failed" || outcome?.failed === true,
    abandoned: record.abandonRequested === true || outcome?.abandoned === true,
    abandonedBy: record.abandonedBy ?? outcome?.abandonedBy ?? null,
    abandonReason: record.abandonReason ?? outcome?.abandonReason ?? null,
    reason: record.reason ?? outcome?.reason ?? null,
    // Both texts exist, so delivery can release one of them after rendering.
    releasesRecord:
      typeof record.record === "string" && typeof outcome?.record === "string",
  };
}

function joinReceiptChars(station, record) {
  const envelope = joinEnvelope(station, record, { excludeSelf: true });
  return joinReceipt({
    forkId: publicScopeId(record),
    record: envelope.record,
    failed: envelope.failed,
    abandoned: envelope.abandoned,
    abandonedBy: envelope.abandonedBy,
    abandonReason: envelope.abandonReason,
    reason: envelope.reason,
    remaining: envelope.remaining.map((entry) => entry.scopeId),
  }).length;
}

/**
 * Admission for one candidate join. A refusal keeps the record ready; the
 * caller names the refusal and lets the model choose a larger window or a
 * smaller result.
 */
function admitJoin(station, record, options = {}) {
  const recordChars = joinReceiptChars(station, record);
  const window = options.window !== undefined ? options.window : windowOf(station);
  const reserve =
    options.reserve !== undefined ? options.reserve : station.forkReservePort?.();
  const margin =
    options.margin !== undefined ? options.margin : station.forkMarginPort?.();
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
function childRecordStart(messages, fork) {
  const source = Array.isArray(messages) ? messages : [];
  const forkId = fork && typeof fork.forkId === "string" ? fork.forkId : "";
  if (forkId !== "") {
    const names = [fork.path, fork.scopeId, forkId].filter(
      (name) => typeof name === "string" && name !== "",
    );
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const text = textOfUser(source[index]).trimStart();
      for (const name of names) {
        if (text.startsWith(scopeReceiptMarker(name))) {
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

/** The receipt the subscope reads at its own start. */
function childReceiptText(spec) {
  const path = spec.path ?? spec.scopeId ?? spec.forkId;
  const upscopePath = spec.upscopePath ?? "/";
  const callerPath = spec.callerPath ?? "/";
  const profession = typeof spec.profession === "string" ? spec.profession.trim() : "";
  const lines = [
    render(S["fork.subscope-status"], {
      marker: scopeReceiptMarker(path),
      role: spec.role ?? roleOfPath(path) ?? "unknown",
      depth: spec.childDepth,
      upscopePath,
      callerPath,
      fsm: spec.fsm,
      remaining: budgetText(spec.budget),
      targets: targetsText(spec.targets),
    }),
  ];
  if (callerPath.toLowerCase() !== upscopePath.toLowerCase()) {
    lines.push(
      render(S["fork.subscope-cross-caller"], {
        upscopePath,
        callerPath,
      }),
    );
  }
  lines.push(
    render(S["fork.subscope-return"], { callerPath }),
    S["fork.subscope-routing"],
  );
  // The identity line sits directly under the receipt's first physical line,
  // which is the marker sentence: the status block renders three lines, so the
  // insertion happens inside that block rather than between blocks. It is
  // rendered here rather than spliced in by the caller, so the string that is
  // priced and the string that is sent are the same string.
  if (profession !== "") {
    const [marker, ...status] = lines[0].split("\n");
    lines.splice(0, 1, [marker, profession, ...status].join("\n"));
  }
  return lines.join("\n");
}


export {
  admitJoin,
  ledgerOf,
  identityOf,
  ownerIdOf,
  depthOf,
  frameOf,
  windowOf,
  measuredBase,
  densityOf,
  childRecordStart,
  childReceiptText,
  joinEnvelope,
};
