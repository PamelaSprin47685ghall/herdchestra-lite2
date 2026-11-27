// `scope_request` / `scope_reply`: a question with an answer, not a mailbox.
//
// A scope is named by where it sits in the tree. The caller queues one request
// and parks on the Promise that `enqueueRequest` minted; the target reads the
// request at its next request, where the capability projection collapses to
// AWAITING_REPLY and `scope_reply` is the only callable method. The reply
// resolves the caller's Promise, and its script continues on the next line.
//
// This module is the station-side translation layer only: it resolves the
// address, validates the arguments, queues, decides how to deliver, and wraps
// the Promise into a tool result. The queue, the wait graph, the cycle guard
// and the FIFO all live in scope/request-queue.mjs.
//
// Plain synchronous functions. The only Promise here is the one the queue
// already minted: nothing in this file awaits, and every state change lands
// before the delivery hook runs.

import { forkOf } from "../scope/forkjoin.mjs";
import {
  findScopeByPath,
  looksLikePattern,
  normalizeScopePath,
  scopePathOf,
} from "../scope/path.mjs";
import {
  cancelRequest,
  enqueueRequest,
  resolveRequest,
  runtimeOf,
  withdrawRequest,
} from "../scope/request-queue.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { parseArgs } from "./messages.mjs";
import { forkRegistryOf } from "./ports-contract.mjs";

const E = loadDoc("errors");

function ledgerOf(station) {
  const ledger = station.forkLedgerPort?.() ?? null;
  if (ledger && typeof ledger === "object") return ledger;
  return station.brackets ?? null;
}

function identityOf(station) {
  const identity = station.forkIdentityPort?.() ?? null;
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
  if (record) {
    const path = scopePathOf(record);
    if (path !== null && path !== "") return path;
  }
  if (typeof identity.path === "string" && identity.path !== "") {
    return identity.path;
  }
  if (typeof identity.ownScopeId === "string" && identity.ownScopeId !== "") {
    return `/${identity.ownScopeId}`;
  }
  return "/";
}

function callHook(station, runtime, hook, details) {
  if (typeof runtime?.[hook] !== "function") return false;
  try {
    runtime[hook]();
    return true;
  } catch (error) {
    station.noteError?.("fork", error, details);
    return false;
  }
}

/**
 * Deliver a queued request to its target, cheapest correct path first.
 *
 * A running scope needs nothing for a soft request: its next request builds the
 * probe and sees the queue head. Everything else needs a nudge — an idle scope
 * must be woken or it will never make another request, a scope parked in a join
 * would sleep through the request, and an interrupt request must break the beat
 * that is currently running. Every branch is best-effort: if a hook is missing
 * the request still sits in the queue and a later request picks it up.
 */
function deliverRequest(station, registry, target, entry) {
  const runtime = runtimeOf(registry, target);
  if (!runtime || runtime.state !== "running") {
    // A stopped scope answers through a wake: the live idle handle or a
    // one-shot resume. No hook means nothing will ever read the queue.
    return callHook(station, runtime, "wake", { target, phase: "request-wake" })
      ? "wake"
      : "none";
  }
  const parked = runtime.parked;
  const parkedNow =
    parked === "join" || (parked instanceof Set && parked.size > 0);
  if (parkedNow) {
    // Every current join must yield, not only the last one registered: a
    // beat parked on two joins cannot be freed by cancelling one.
    const hooks =
      runtime.yieldJoins instanceof Map
        ? [...runtime.yieldJoins.values()]
        : typeof runtime.yieldJoin === "function"
          ? [runtime.yieldJoin]
          : [];
    let yielded = false;
    for (const hook of hooks) {
      if (typeof hook !== "function") continue;
      try {
        hook();
        yielded = true;
      } catch (error) {
        station.noteError?.("fork", error, { target, phase: "request-yield" });
      }
    }
    return yielded ? "yield" : "none";
  }
  if (entry.interrupt === true) {
    callHook(station, runtime, "interrupt", { target, phase: "request-interrupt" });
  }
  return "running";
}

function requestArgs(call) {
  const args = parseArgs(call);
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  return null;
}

/**
 * One `scope_request({ target, message, interrupt? })`.
 *
 * Returns the standard tool-result shape once the answer arrives. The info-rich
 * object travels in `details.result` so a script receives `{ ok, from, reply }`
 * as data rather than prose.
 */
export function handleRequestToolCall(station, call, _ctx = null, signal = null) {
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", "No fork ledger is bound to this scope.");
  }
  const registry = forkRegistryOf(station);
  if (!registry) {
    return errorResult("FORK_REGISTRY_UNAVAILABLE", "No fork registry is bound to this scope.");
  }
  const args = requestArgs(call);
  if (!args) {
    return errorResult(
      "INVALID_REQUEST_ARGS",
      "scope_request takes one object: { target, message, interrupt? }.",
    );
  }
  const rawTarget = typeof args.target === "string" ? args.target.trim() : "";
  if (rawTarget === "") {
    return errorResult("INVALID_SCOPE_TARGET", "scope_request needs a target path.");
  }
  if (looksLikePattern(rawTarget)) {
    return errorResult(
      "INVALID_SCOPE_TARGET",
      "scope_request takes one exact path, never a wildcard. Request several scopes with Promise.all over state.scopes.",
    );
  }
  const message = typeof args.message === "string" ? args.message : "";
  if (message.trim() === "") {
    return errorResult("INVALID_MESSAGE", "scope_request needs a non-empty message.");
  }
  const sender = senderPathOf(station, ledger);
  const normalized = normalizeScopePath(sender, rawTarget);
  if (!normalized.ok) {
    return errorResult(normalized.code, `Cannot resolve "${rawTarget}" from ${sender}.`);
  }
  const target = normalized.path;
  if (target === sender) {
    return errorResult("REQUEST_DEADLOCK_CYCLE", "A scope cannot request itself.");
  }
  // A finished scope is still addressable: it is woken for one reply turn. The
  // root has no record and is addressed as `/`.
  const targetRecord = target === "/" ? null : findScopeByPath(ledger, target);
  if (target !== "/" && !targetRecord) {
    return errorResult("UNKNOWN_SCOPE_TARGET", `No scope is registered at ${target}.`, {
      target,
      sender,
    });
  }
  // A record that never started, or that already failed, has no session to
  // wake and nothing to resume: refuse before the request exists. Every other
  // stopped scope is offered to the wake path below, which settles the caller
  // instead of parking when no handle can be built.
  if (targetRecord && (targetRecord.status === "failed" || targetRecord.outcome === "failed")) {
    return errorResult(
      "REQUEST_UNREACHABLE",
      render(E["request-unreachable"], { target }),
      { target, sender },
    );
  }
  const queued = enqueueRequest(registry, {
    from: sender,
    target,
    message,
    interrupt: args.interrupt === true,
  });
  if (!queued.ok) {
    return errorResult(queued.code, queued.reason, { target, sender });
  }
  // Tail position: the queue and the wait edge are written before any delivery
  // hook runs, so a woken target never observes a half-registered request.
  const delivery = deliverRequest(station, registry, target, queued.entry);
  // A running scope needs no hook: it reads the queue at its own next request.
  // Only a stopped target that nothing can wake leaves the request unread.
  if (delivery === "none" && targetRecord?.status !== "running") {
    // No live idle handle and no branch to resume: nothing will ever read this
    // queue. Settle the request so the caller does not park, and answer with
    // the same refusal a dead record gets.
    cancelRequest(registry, target, queued.id);
    queued.entry.promise?.catch?.(() => {});
    return errorResult(
      "REQUEST_UNREACHABLE",
      render(E["request-unreachable"], { target }),
      { target, sender },
    );
  }
  if (!signal || typeof signal.addEventListener !== "function") {
    return queued.entry.promise.then(
      (reply) => textResult(reply, { result: { ok: true, from: target, reply } }),
      (error) =>
        errorResult("REQUEST_FAILED", String(error?.message ?? error), { target, sender }),
    );
  }
  // The caller can be interrupted while it parks. Withdraw an undelivered
  // request; keep a delivered one in the FIFO (its reply would otherwise be
  // orphaned) but drop this caller's wait edge. Either way the caller gets a
  // settled tool result instead of a Promise nobody owns.
  let interrupted = false;
  let resolveInterruption = null;
  const interruption = new Promise((resolve) => {
    resolveInterruption = resolve;
  });
  const onAbort = () => {
    if (interrupted) return;
    interrupted = true;
    if (queued.entry.delivered !== true) {
      cancelRequest(registry, target, queued.id);
    } else {
      // The target already printed the request. Keeping it at the FIFO head
      // would starve every later request behind a reply nobody is waiting
      // for; withdraw it so the next request becomes the head.
      withdrawRequest(
        registry,
        target,
        queued.id,
        "The requesting scope interrupted before the answer arrived.",
      );
    }
    resolveInterruption(
      errorResult(
        "REQUEST_INTERRUPTED",
        "The request was interrupted before the answer arrived.",
        { target, sender },
      ),
    );
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const answer = queued.entry.promise.then(
    (reply) => textResult(reply, { result: { ok: true, from: target, reply } }),
    (error) =>
      interrupted
        ? new Promise(() => {})
        : errorResult("REQUEST_FAILED", String(error?.message ?? error), { target, sender }),
  );
  return Promise.race([answer, interruption]).finally(() => {
    signal.removeEventListener?.("abort", onAbort);
  });
}

/**
 * One `scope_reply(reply)`. Only reachable while the projection is
 * AWAITING_REPLY, and only the delivered queue head may be answered.
 */
export function handleReplyToolCall(station, call, _ctx = null) {
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", "No fork ledger is bound to this scope.");
  }
  const registry = forkRegistryOf(station);
  if (!registry) {
    return errorResult("FORK_REGISTRY_UNAVAILABLE", "No fork registry is bound to this scope.");
  }
  // A bare string is the documented form: `api.scope_reply("…")`. `parseArgs`
  // normalizes object arguments only — it answers `{}` for a string — so read
  // the raw value first. A string argument is the reply text, not a JSON blob
  // to parse, and the mode the model is in says exactly that.
  const raw = call?.arguments;
  const args = typeof raw === "string" ? raw : parseArgs(call);
  const text =
    typeof args === "string"
      ? args
      : typeof args?.reply === "string"
        ? args.reply
        : typeof args?.text === "string"
          ? args.text
          : typeof args?.message === "string"
            ? args.message
            : null;
  if (text === null) {
    return errorResult("INVALID_REPLY", "scope_reply takes the reply text, as a string or { reply }.");
  }
  const self = senderPathOf(station, ledger);
  const resolved = resolveRequest(registry, self, text);
  if (!resolved.ok) {
    return errorResult(resolved.code, resolved.reason, { scope: self });
  }
  return textResult(String(text), { result: { ok: true } });
}
