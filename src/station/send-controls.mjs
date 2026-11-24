// `scope_send`: one message, addressed by path.
//
// A scope is named by where it sits in the tree, not by a conversation-global
// label. This handler resolves the address, then delivers: a running scope
// reads the message at its next turn boundary, the root is steered through its
// own station, and a finished scope is woken in place. One delivery shape for
// all three, so a reply is always the same call.
//
// Plain synchronous function. Every state change lands before the wake port is
// called, so a woken scope never observes a half-written inbox.

import { forkOf, touchFork } from "../scope/forkjoin.mjs";
import { normalizeScopePath, resolveScopeTargets } from "../scope/path.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { parseArgs } from "./messages.mjs";

const E = loadDoc("errors");

/** A target that names a set instead of one scope. */
const GLOB = /[*?[]/;

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
 * The path this station speaks from. The root has no identity and sits at `/`;
 * a child reads its own record first, because the path is the address every
 * other scope already knows it by.
 */
export function senderPathOf(station, ledger = ledgerOf(station)) {
  const identity = identityOf(station);
  if (!identity) return "/";
  const record =
    ledger && typeof identity.forkId === "string"
      ? forkOf(ledger, identity.forkId)
      : null;
  if (record && typeof record.path === "string" && record.path !== "") {
    return record.path;
  }
  if (typeof identity.path === "string" && identity.path !== "") {
    return identity.path;
  }
  if (typeof identity.ownScopeId === "string" && identity.ownScopeId !== "") {
    return `/${identity.ownScopeId}`;
  }
  return "/";
}

function readTargets(raw) {
  if (typeof raw === "string") {
    return raw.trim() === "" ? null : [raw];
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const list = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") return null;
    list.push(entry);
  }
  return list;
}

function readBudget(raw) {
  if (raw === undefined || raw === null) return { ok: true, budget: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const budget = {};
  for (const [tool, amount] of Object.entries(raw)) {
    if (!Number.isInteger(amount) || amount < 0) return { ok: false };
    if (amount > 0) budget[tool] = amount;
  }
  return { ok: true, budget };
}

/**
 * Add turns to a target with the same arithmetic a fork uses when it mints a
 * budget: the grant is added to both the ceiling and what is left, so the
 * receipt and the accounting agree.
 */
function grantTurns(record, budget) {
  const tools = Object.keys(budget ?? {});
  if (tools.length === 0) return false;
  if (!record.budget || typeof record.budget !== "object") record.budget = {};
  if (!record.remaining || typeof record.remaining !== "object") record.remaining = {};
  for (const tool of tools) {
    record.budget[tool] = (record.budget[tool] ?? 0) + budget[tool];
    record.remaining[tool] = (record.remaining[tool] ?? 0) + budget[tool];
  }
  return true;
}

/**
 * A woken scope's deadline has already run out, so waking it without restarting
 * the clock would make its first call an overdraw. The restart is the same one
 * a resumed branch uses: the record's own time budget, from now.
 */
function restartClock(station, record) {
  const clock =
    typeof station.clockPort === "function" ? station.clockPort() : null;
  if (!clock || typeof clock.start !== "function") return;
  if (!Number.isFinite(record.timeBudgetMs)) return;
  clock.start(record, record.timeBudgetMs, Date.now());
}

function scopeEnvelope(senderPath, message) {
  return `[Message from ${senderPath}]\n${message}`;
}

function deliveryText(delivered, woken, zero) {
  if (delivered.length === 0) return zero ? "Delivered to 0 active scopes." : "No scope received the message.";
  const wokenText = woken.length === 0 ? "" : ` Woke ${woken.join(", ")}.`;
  return `Sent to ${delivered.join(", ")}.${wokenText}`;
}

/**
 * One send, one delivery path.
 *
 * A message to the root goes to the root inbox and, when the root station is
 * wired, straight to its steer channel. A message to any other scope goes to
 * that scope's inbox; a scope that is not running is marked woken, which is
 * what puts it back in the active list and starts its wake ticket. The wake
 * port is called last, after every field is written.
 */
export function handleSendCall(station, call, _ctx = null) {
  const args = parseArgs(call);
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  const targets = readTargets(args?.target);
  if (targets === null) {
    return errorResult(
      "INVALID_SCOPE_TARGET",
      E["invalid-scope-target"] ?? "A send needs a target path or a list of paths.",
    );
  }
  const message = typeof args?.message === "string" ? args.message.trim() : "";
  if (message === "") {
    return errorResult(
      "INVALID_MESSAGE",
      E["invalid-message"] ?? "A send needs a non-empty message.",
    );
  }
  const read = readBudget(args?.budget);
  if (!read.ok) {
    return errorResult("INVALID_BUDGET", E["invalid-budget"]);
  }
  const budget = read.budget;
  const senderPath = senderPathOf(station, ledger);
  const envelope = scopeEnvelope(senderPath, message);

  // A target the caller could not name is refused before anything is written,
  // so a batch never delivers half of what it promised.
  const resolved = resolveScopeTargets(ledger, senderPath, targets);
  if (!resolved.ok) {
    // A broadcast that reaches nothing is an answer, not a fault: every scope
    // it could reach has finished, and a finished scope is never woken by a
    // set. An exact path is different, and the resolver already named it.
    const exclusiveGlobs = targets.every((target) => {
      const shape = normalizeScopePath(senderPath, target);
      return shape.ok === true && shape.isGlob === true;
    });
    if (resolved.code === "NO_MATCHING_SCOPES" && exclusiveGlobs) {
      return textResult(deliveryText([], [], true), {
        delivered: [],
        woken: [],
        budgetGranted: false,
      });
    }
    const named = resolved.target ?? targets.join(", ");
    return errorResult(
      resolved.code,
      resolved.code === "UNKNOWN_SCOPE_TARGET"
        ? render(E["unknown-scope-target"] ?? "No scope is registered at {{target}}.", {
            target: named,
          })
        : render(E["no-matching-scopes"] ?? "No active scope matches {{target}}.", {
            target: named,
          }),
      { target: named, sender: senderPath },
    );
  }

  const delivered = [];
  const woken = [];
  const wake = [];
  let budgetGranted = false;

  for (const target of resolved.targets) {
    if (target.kind === "root") {
      if (!Array.isArray(ledger.rootInbox)) ledger.rootInbox = [];
      ledger.rootInbox.push({ from: senderPath, message, envelope });
      delivered.push("/");
      const steer =
        typeof station.rootSteerPort === "function"
          ? station.rootSteerPort()
          : null;
      if (typeof steer === "function") steer(envelope);
      continue;
    }
    const record = forkOf(ledger, target.forkId);
    if (!record) continue;
    if (!Array.isArray(record.inbox)) record.inbox = [];
    record.inbox.push({ from: senderPath, message, envelope });
    delivered.push(target.path);
    if (record.status !== "running") {
      record.woken = true;
      restartClock(station, record);
      woken.push(target.path);
      wake.push(record.forkId);
    }
    if (budget !== null && grantTurns(record, budget)) budgetGranted = true;
    // The mailbox, the cursor and the wake flag are not fork annotations, so
    // the record must be marked by hand or a shared snapshot can miss them.
    if (ledger?.order) touchFork(ledger, record.forkId);
  }

  delivered.sort();
  woken.sort();
  // Tail position: every field above is written before the ticket that reads
  // the record starts.
  const wakePort =
    typeof station.childWakePort === "function" ? station.childWakePort() : null;
  if (typeof wakePort === "function") {
    for (const forkId of wake) {
      try {
        wakePort(forkId);
      } catch (error) {
        station.noteError?.("fork", error, { forkId, phase: "wake" });
      }
    }
  }
  return textResult(deliveryText(delivered, woken, false), {
    delivered,
    woken,
    budgetGranted,
    sender: senderPath,
  });
}
