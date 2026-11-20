// Activation fission: bind a host session to the one fission scheduler.
//
// The station layer never builds a scheduler. It asks the registry for a port
// and refuses a fission begin when that port is absent. This module is the only
// place that turns a host session into that port, and it installs nothing it
// cannot prove. A missing session, manager, or bound agent leaves the registry
// without a port, so the tool's refusal stays visible as FISSION_UNAVAILABLE
// instead of a half-started batch.
//
// One scheduler belongs to one shared SessionManager. Flow sessions load this
// extension again and share that manager, so the lookup is keyed by the manager
// and stored on globalThis: a flow must find the owner's port, not build a
// second one. The scheduler itself refuses a different manager.

import { hostView } from "../host/adapter.mjs";
import { record } from "../host/diagnostics.mjs";
import { createFissionScheduler } from "../host/fission-scheduler.mjs";
import { installFissionUI } from "../host/fission-ui.mjs";
import { loadDoc } from "../prompts/index.mjs";

const STATE_KEY = Symbol.for("herdchestra-lite2.fission-activation.v1");

/** Facts shared by every extension instance in this process. */
function activationState() {
	let state = globalThis[STATE_KEY];
	if (!state) {
		state = {
			byManager: new WeakMap(),
			entries: new Set(),
			status: null,
		};
		Object.defineProperty(globalThis, STATE_KEY, {
			value: state,
			enumerable: false,
			configurable: true,
		});
	}
	return state;
}

/** Accept an identity object or its id string; never compare objects. */
function identityId(value) {
	if (typeof value === "string" && value !== "") return value;
	if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
	if (typeof value.id === "string" && value.id !== "") return value.id;
	if (typeof value.agentId === "string" && value.agentId !== "") return value.agentId;
	return null;
}

function refuse(state, code, detail, { quiet = false } = {}) {
	state.status = Object.freeze({ ok: false, state: "refused", code, detail });
	// A session that has not been captured yet, or a host without the seam at
	// all, is the ordinary state before the first model call. It must not fill
	// the failure history; the tool's own FISSION_UNAVAILABLE is the answer.
	if (!quiet) {
		const error = new Error(`fission scheduler refused: ${detail}`);
		error.code = code;
		record("fission", error, { code });
	}
	return state.status;
}

function ready(state, detail) {
	state.status = Object.freeze({ ok: true, state: "ready", code: null, detail });
	return state.status;
}

/**
 * Observe whether the host's vibe runtime took over this session.
 *
 * The scheduler must refuse a handoff while the vibe runtime owns the atomic
 * journal batch. omp exposes no public flag for that mode, so the probe uses
 * two observable facts: a declared session flag when one exists, and a
 * successful `activateVibeTools()` call on this session. The probe reports
 * what it saw; it never claims the mode is inactive beyond that evidence.
 */
function vibeProbe(session) {
	const probe = { activated: false };
	const declared = () => {
		const flags = [
			session?.vibeActive,
			session?.isVibeActive,
			session?.vibeRuntime?.active,
			session?.vibeRuntime?.isActive,
			session?.vibe?.active,
		];
		for (const flag of flags) {
			if (flag === true) return true;
			if (typeof flag !== "function") continue;
			try {
				if (flag.call(session) === true) return true;
			} catch {
				// An unreadable flag is not evidence of activity.
			}
		}
		return false;
	};
	const original = session?.activateVibeTools;
	if (typeof original === "function") {
		try {
			session.activateVibeTools = function activateVibeTools(...args) {
				probe.activated = true;
				return Reflect.apply(original, this, args);
			};
		} catch (error) {
			record("fission", error, { seam: "activateVibeTools", optional: true });
		}
	}
	return () => probe.activated || declared();
}

/** Use the session's own model resolver; absence makes the batch say so. */
function modelResolver(session) {
	for (const holder of [session, session?.modelRegistry]) {
		const resolve = holder?.resolveModel;
		if (typeof resolve !== "function") continue;
		return (spec) => {
			try {
				return resolve.call(holder, spec) ?? null;
			} catch {
				return null;
			}
		};
	}
	return null;
}

function liveBatchElsewhere(state, manager) {
	for (const entry of state.entries) {
		if (entry.manager === manager) continue;
		if (entry.scheduler.hasLiveBatches?.() === true) return entry;
	}
	return null;
}

// -- Owner input and abort bridge -----------------------------------------
//
// A batch retires the owner. The owner Agent then runs no turn, so its
// AgentSession.prompt() and AgentSession.steer() have no live agent to drive.
// User input must reach every active leaf instead, and Esc must stop the whole
// batch, not an idle owner.
//
// The host exposes three public entries for this: AgentSession.prompt,
// AgentSession.steer, and AgentSession.abort. This bridge patches them on the
// owner session object only. It never patches the prototype and never patches a
// flow session, because every flow owns its own AgentSession: a nudge sent
// through a flow's own extension instance cannot cross this bridge.
//
// The scheduler's retirement path is not intercepted. retireOwner() aborts the
// owner Agent directly with `agent.abort()`, which never passes through
// AgentSession.abort. When that path falls back to `ctx.abort()`, no flow has
// spawned yet, so `activeLeaves()` is empty and the abort wrapper delegates
// untouched. An abort after the last flow closed is host cleanup for the same
// reason.
//
// Restoration is lazy and exact. Each wrapper re-reads scheduler liveness
// before it acts. When no batch is live, it restores the host's own method and
// delegates, so an idle session carries no patched method. Disposal also
// uninstalls the bridge before the host's own dispose runs.

const INPUT_METHODS = Object.freeze(["prompt", "steer", "abort"]);

function inputBridges() {
	const state = activationState();
	state.inputs ??= new WeakMap();
	return state.inputs;
}

function schedulerIsDisposed(scheduler) {
	if (typeof scheduler?.status !== "function") return false;
	try {
		return scheduler.status()?.disposed === true;
	} catch {
		return true;
	}
}

/** A live batch is the only state in which owner input belongs to the flows. */
function batchIsLive(scheduler) {
	if (typeof scheduler?.hasLiveBatches !== "function") return false;
	if (schedulerIsDisposed(scheduler)) return false;
	try {
		return scheduler.hasLiveBatches() === true;
	} catch {
		return false;
	}
}

function runningLeaves(scheduler) {
	if (typeof scheduler?.activeLeaves !== "function") return [];
	try {
		const leaves = scheduler.activeLeaves();
		return Array.isArray(leaves) ? leaves : [];
	} catch {
		return [];
	}
}

/** Slash commands are host operations; they are not turns for the flows. */
function isFlowInput(value) {
	return typeof value === "string" && value.trim() !== "" && !value.startsWith("/");
}

function broadcastText(scheduler, text) {
	let outcome;
	try {
		outcome = scheduler.broadcast(text);
	} catch (error) {
		throw new Error(`fission input was not delivered: ${error?.message ?? error}`);
	}
	if (outcome?.ok === true) return outcome;
	const detail = outcome?.detail ?? outcome?.code ?? "the scheduler refused the broadcast";
	throw new Error(`fission input was not delivered: ${detail}`);
}

function noRecipient(verb) {
	return new Error(
		`fission: no active flow can receive this ${verb}; the batch is still starting or has already closed`,
	);
}

/**
 * Bind one owner AgentSession to one fission scheduler.
 *
 * While a batch is live, `prompt()` and `steer()` broadcast their text to every
 * active leaf, and `abort()` fans out through `cancelAll()` before the owner's
 * own cleanup runs. Outside that window every method delegates untouched.
 *
 * Returns the installed bridge, or null when the host exposes none of the three
 * methods or when no method can be redefined. A refusal leaves the session as
 * the host built it.
 */
export function installFissionInput(session, scheduler) {
	if (!session || (typeof session !== "object" && typeof session !== "function")) return null;
	if (typeof scheduler?.broadcast !== "function" || typeof scheduler?.cancelAll !== "function") {
		return null;
	}
	const inputs = inputBridges();
	const existing = inputs.get(session);
	if (existing) return existing;

	const patched = new Map();
	const wrappers = new Map();
	let active = true;
	// A bridge is installed when the session starts, long before any batch
	// exists. Ordinary prompts in that window must delegate without removing
	// the bridge, or the batch this session later opens would run unbridged.
	let sawLiveBatch = false;

	function callOriginal(name, receiver, args) {
		const saved = patched.get(name);
		if (!saved) return undefined;
		return Reflect.apply(saved.original, receiver ?? session, args);
	}

	function restore() {
		if (!active) return false;
		active = false;
		if (inputs.get(session) === bridge) inputs.delete(session);
		for (const [name, saved] of patched) {
			if (session[name] !== wrappers.get(name)) continue;
			try {
				if (saved.own) Object.defineProperty(session, name, saved.own);
				else delete session[name];
			} catch (error) {
				record("fission", error, { seam: `input.${name}`, restore: true, optional: true });
			}
		}
		return true;
	}

	const bridge = {
		session,
		scheduler,
		get installed() {
			return active;
		},
		uninstall: restore,
	};

	/**
	 * Whether this call belongs to the flows. The first call that observes a
	 * live batch arms restoration; a call after that batch closed restores the
	 * host methods and delegates. A session that never opened a batch keeps the
	 * bridge installed for the batch it may open later.
	 */
	function inBatchWindow() {
		if (batchIsLive(scheduler)) {
			sawLiveBatch = true;
			return true;
		}
		if (sawLiveBatch) restore();
		return false;
	}

	function makePrompt() {
		return async function prompt(...args) {
			const [text] = args;
			if (!active || !inBatchWindow()) {
				const result = await callOriginal("prompt", this, args);
				// A batch may have opened during this turn. Keep the host from
				// selecting the retired owner's abort as its final answer before
				// the flows finish and the heir is adopted.
				if (active && batchIsLive(scheduler)) {
					await createDisposeBarrier({ scheduler }).wait();
				}
				return result;
			}
			if (!isFlowInput(text)) return callOriginal("prompt", this, args);
			if (runningLeaves(scheduler).length === 0) throw noRecipient("input");
			broadcastText(scheduler, text);
			// The owner produced no turn. The broadcast itself is displayed once
			// by the multiplexer under its broadcastId.
			return false;
		};
	}

	function makeSteer() {
		return async function steer(...args) {
			const [text] = args;
			if (!active || !inBatchWindow()) return callOriginal("steer", this, args);
			if (!isFlowInput(text)) return callOriginal("steer", this, args);
			if (runningLeaves(scheduler).length === 0) throw noRecipient("input");
			broadcastText(scheduler, text);
			return undefined;
		};
	}

	function makeAbort() {
		return async function abort(...args) {
			if (!active || !inBatchWindow()) return callOriginal("abort", this, args);
			// No flow is running: this is the scheduler's owner retirement or
			// post-batch cleanup, not a user interrupt. Delegate untouched.
			if (runningLeaves(scheduler).length === 0) return callOriginal("abort", this, args);
			const [options] = args;
			const reason =
				typeof options?.reason === "string" && options.reason !== ""
					? options.reason
					: "user-interrupt";
			try {
				scheduler.cancelAll(reason);
			} catch (error) {
				// The fan-out failure must not prevent the owner's own abort.
				record("fission", error, { seam: "input.abort", cancelled: false });
			}
			return callOriginal("abort", this, args);
		};
	}

	const factories = { prompt: makePrompt, steer: makeSteer, abort: makeAbort };
	for (const name of INPUT_METHODS) {
		if (typeof session[name] !== "function") continue;
		const original = session[name];
		const own = Object.getOwnPropertyDescriptor(session, name) ?? null;
		const wrapper = factories[name]();
		try {
			Object.defineProperty(session, name, {
				value: wrapper,
				configurable: true,
				writable: true,
			});
		} catch (error) {
			record("fission", error, { seam: `input.${name}`, optional: true });
			continue;
		}
		patched.set(name, { original, own });
		wrappers.set(name, wrapper);
	}
	if (patched.size === 0) return null;
	inputs.set(session, bridge);
	return bridge;
}

/** Remove one input bridge; the host's own methods return in place. */
export function uninstallFissionInput(session) {
	const bridge = inputBridges().get(session);
	return bridge ? bridge.uninstall() : false;
}

// -- Dispose barrier ------------------------------------------------------
//
// `omp -p` runs one turn, then awaits `session.dispose()` and exits. A fission
// begin retires the owner inside that turn, so the prompt returns while the
// flows are still spawning. Disposal seals the shared SessionManager: `seal()`
// turns every later append into a dropped-entry warning. A batch that is still
// running must therefore finish before teardown starts.
//
// The host exposes no extension hook on this path. Every disposal path -- print
// mode, the postmortem signal handler, and the quiet fallback in main.ts --
// awaits the captured AgentSession's own `dispose()`. That method is the one
// seam: this barrier wraps it, waits while the scheduler still reports a live
// batch, and then delegates with the original receiver and arguments.
//
// What the wrapper deliberately does not do:
//   * It does not call `beginDispose()` before waiting. That guard sets
//     `#isDisposed` and tears down the owner's run; the flows are still writing
//     through the shared journal, and the heir's adoption needs the owner agent
//     alive. The host's own dispose runs unchanged after the wait.
//   * It does not reorder print mode's answer selection. That has already
//     happened before disposal; the barrier preserves the journal and the
//     flows, not the text print mode has already chosen.
//
// Bounds. A dispose carrying a postmortem reason (`SIGINT`, `SIGTERM`, `EXIT`,
// `MANUAL`, ...) means the process is being torn down: live flows are cancelled
// first, and the wait is bounded by HERDCHESTRA_FISSION_CANCEL_GRACE_MS so a
// stuck spawn cannot hold Ctrl-C forever.
//
// The host memoizes `dispose()`, so a signal that arrives during an ordinary
// wait calls this wrapper again with a reason. That call must not be dropped:
// it upgrades the wait in place -- cancel now, arm the same grace bound -- and
// still shares the one dispose call.
//
// An ordinary dispose carries no postmortem reason, and it has no default
// ceiling: a legitimate long flow must be allowed to finish, and sealing the
// shared journal under live flows would drop their entries. The wait therefore
// runs until the scheduler reports no live batch, the caller releases it, or
// the host begins a teardown (which arrives here as a postmortem reason).
// HERDCHESTRA_FISSION_DISPOSE_CEILING_MS, or the `ceilingMs` option, can impose
// an explicit bound; when it expires the barrier records a diagnostic before
// delegating, so a live batch is never sealed silently. The default is 0: no
// bound.

const BARRIER_CANCEL_GRACE_MS = 5_000;
const BARRIER_POLL_MS = 25;
const BARRIER_CANCEL_SWEEP_MS = 250;
const TERMINAL_BATCH_STATUSES = new Set([
	"closed",
	"cancelled",
	"crashed",
	"failed",
	"cost-capped",
]);

function envMilliseconds(name, fallback) {
	let raw;
	try {
		raw = process.env?.[name];
	} catch {
		return fallback;
	}
	if (raw === undefined || raw === null || raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function defaultSleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Yield to the macrotask queue.
 *
 * The wait loop uses this whenever a batch promise settles before the poll
 * interval, so a scheduler whose promises are already settled can never starve
 * timers -- the host's teardown, a signal, or a test runner's timeout -- in a
 * microtask-only spin.
 */
function defaultTurn(callback) {
	if (typeof setImmediate === "function") setImmediate(callback);
	else setTimeout(callback, 0);
}

/** A postmortem reason names a process teardown; an ordinary dispose has none. */
function disposalReason(options) {
	const reason = options && typeof options === "object" ? options.reason : undefined;
	return typeof reason === "string" && reason !== "" ? reason : null;
}

/**
 * Read the scheduler's liveness without trusting a method it may not have.
 *
 * `null` means "cannot be observed": the scheduler exposes no liveness probe,
 * so no barrier can be honest about when the journal is safe to seal.
 */
function schedulerLiveness(scheduler) {
	if (typeof scheduler?.hasLiveBatches !== "function") return null;
	let live;
	try {
		live = scheduler.hasLiveBatches() === true;
	} catch {
		return null;
	}
	if (!live) return { live: false, ids: [] };
	const ids = [];
	let disposed = false;
	try {
		const listed = scheduler.status?.();
		// A disposed scheduler no longer witnesses batch completion, so its
		// remaining records cannot hold the journal open.
		disposed = listed?.disposed === true;
		const batches = listed?.batches;
		if (Array.isArray(batches)) {
			for (const batch of batches) {
				if (TERMINAL_BATCH_STATUSES.has(batch?.status)) continue;
				if (typeof batch?.batchId === "string" && batch.batchId !== "") {
					ids.push(batch.batchId);
				}
			}
		}
	} catch {
		// The boolean above is still the answer; ids only shorten the wait.
	}
	return disposed ? { live: false, ids: [] } : { live: true, ids };
}

/** One promise per known batch, each already settled to undefined on failure. */
function pendingBatches(scheduler, ids) {
	const pending = [];
	for (const id of ids) {
		try {
			const promise = scheduler.waitForBatch(id);
			if (promise && typeof promise.then === "function") {
				pending.push(promise.then(
					() => undefined,
					() => undefined,
				));
			}
		} catch {
			// A batch the scheduler can no longer name has no promise to await.
		}
	}
	return pending;
}

/**
 * Build one end barrier over a fission scheduler.
 *
 * `wait(options)` resolves with the outcome that released it: `quiescent` (no
 * live batch), `released` (explicit control), `unobservable` (no liveness
 * probe), `cancel-deadline` (a teardown reason outlived its grace), or
 * `ceiling` (an explicitly configured bound expired). Only `quiescent` means
 * no batch is live; every other outcome is reported or recorded, so teardown
 * past a live batch is never silent.
 */
export function createDisposeBarrier({
	scheduler = null,
	cancelGraceMs,
	ceilingMs,
	pollMs,
	now = Date.now,
	sleep = defaultSleep,
	turn = defaultTurn,
} = {}) {
	const grace = cancelGraceMs
		?? envMilliseconds("HERDCHESTRA_FISSION_CANCEL_GRACE_MS", BARRIER_CANCEL_GRACE_MS);
	const ceiling = ceilingMs
		?? envMilliseconds("HERDCHESTRA_FISSION_DISPOSE_CEILING_MS", 0);
	const interval = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : BARRIER_POLL_MS;
	let released = null;
	// A release must reach a waiter sleeping inside nextTick(); these resolvers
	// are the waiters that can be woken without waiting for the poll interval.
	const waiters = new Set();
	// A teardown reason can arrive after an ordinary wait has begun, because the
	// host memoizes `dispose()`. The upgrade lives outside `wait` so it can
	// reach the in-flight loop; repeated reasons keep the first deadline.
	let escalated = null;

	function release(reason = "released") {
		if (released !== null) return false;
		released = String(reason ?? "released");
		wake();
		return true;
	}

	function wake() {
		for (const resolve of [...waiters]) resolve();
		waiters.clear();
	}

	function sweep(reason) {
		if (typeof scheduler?.cancelAll !== "function") return;
		try {
			scheduler.cancelAll(reason);
		} catch (error) {
			record("fission", error, { barrier: "cancel", optional: true });
		}
	}

	/**
	 * Upgrade the wait with a teardown reason that arrived after it began.
	 *
	 * Cancelling immediately is what makes Ctrl-C effective while an ordinary
	 * dispose is waiting; the grace deadline is armed once and never extended
	 * by repeated signals. Accepts the dispose options object or a raw reason.
	 */
	function escalate(input) {
		const next = typeof input === "string"
			? (input !== "" ? input : null)
			: disposalReason(input);
		if (next === null) return false;
		sweep(next);
		const at = now();
		if (escalated === null) {
			escalated = { reason: next, deadline: at + grace, sweptAt: at };
		} else {
			escalated.reason = next;
			escalated.sweptAt = at;
		}
		wake();
		return true;
	}

	/**
	 * One bounded tick of the wait.
	 *
	 * `ids` are the batches the scheduler can name; their promises settle the
	 * tick early. The poll interval is the fallback, and release() wakes the
	 * waiter immediately. A live batch therefore never holds dispose past one
	 * interval without the loop re-reading liveness and its deadline.
	 */
	function nextTick(ids) {
		const pending = pendingBatches(scheduler, ids);
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				waiters.delete(finish);
				resolve();
			};
			waiters.add(finish);
			// A batch promise settling early ends the tick, but never continues
			// the loop in the same microtask turn: the next iteration starts on
			// a macrotask, so timers and signals keep running while the journal
			// stays live. Without this an already-settled promise would spin
			// forever without the event loop ever advancing.
			if (pending.length > 0) {
				Promise.all(pending).then(
					() => {
						if (!settled) turn(finish);
					},
					() => {
						if (!settled) turn(finish);
					},
				);
			}
			sleep(interval).then(finish, finish);
		});
	}

	async function wait(options = {}) {
		let reason = disposalReason(options);
		if (reason !== null) sweep(reason);
		const startedAt = now();
		let deadline = reason !== null
			? startedAt + grace
			: ceiling > 0
				? startedAt + ceiling
				: null;
		let sweptAt = reason !== null ? startedAt : 0;
		for (;;) {
			if (released !== null) return "released";
			// Adopt a reason that arrived while this wait was already running.
			// The earlier bound (ceiling or a first reason) is never extended.
			if (escalated !== null && reason === null) {
				reason = escalated.reason;
				deadline = deadline === null
					? escalated.deadline
					: Math.min(deadline, escalated.deadline);
				sweptAt = escalated.sweptAt;
			}
			const liveness = schedulerLiveness(scheduler);
			if (liveness === null) {
				// The barrier cannot prove the journal is safe to seal. Say so
				// rather than sealing a live batch in silence.
				record(
					"fission",
					new Error("the scheduler exposes no usable liveness probe"),
					{ barrier: "unobservable" },
				);
				return "unobservable";
			}
			if (!liveness.live) return "quiescent";
			if (deadline !== null && now() >= deadline) {
				if (reason === null) {
					// An explicit ceiling is the only bound an ordinary dispose
					// can hit. Never seal silently: leave the evidence first.
					record(
						"fission",
						new Error("the dispose ceiling expired with live fission batches"),
						{ barrier: "ceiling", batches: liveness.ids },
					);
					return "ceiling";
				}
				// The grace ran out; abort once more so teardown can finish.
				sweep(`${reason}: dispose barrier`);
				return "cancel-deadline";
			}
			// A flow that finishes spawning inside the grace window is a new
			// target: the first cancelAll only saw the flows that existed then.
			if (reason !== null && now() - sweptAt >= BARRIER_CANCEL_SWEEP_MS) {
				sweptAt = now();
				sweep(reason);
			}
			await nextTick(liveness.ids);
		}
	}

	return {
		wait,
		release,
		escalate,
		state() {
			return {
				released,
				live: schedulerLiveness(scheduler),
				graceMs: grace,
				ceilingMs: ceiling,
				teardown: escalated ? { ...escalated } : null,
			};
		},
	};
}

/**
 * Wrap one AgentSession's `dispose()` with the barrier. Idempotent per session:
 * a repeated attach returns the barrier already installed.
 *
 * Returns null when the host offers no disposal method or the scheduler cannot
 * report liveness. Both cases leave the session untouched, so the normal host
 * teardown proceeds instead of a half-installed barrier.
 */
export function installDisposeBarrier(session, scheduler, options = {}) {
	if (!session || (typeof session !== "object" && typeof session !== "function")) return null;
	const state = activationState();
	state.barriers ??= new WeakMap();
	const existing = state.barriers.get(session);
	if (existing) return existing;
	const original = session.dispose;
	if (typeof original !== "function") return null;
	if (typeof scheduler?.hasLiveBatches !== "function") return null;

	const barrier = createDisposeBarrier({ ...options, scheduler });
	let disposeCall = null;
	const installed = {
		barrier,
		original,
		release: (reason) => barrier.release(reason),
		/**
		 * Restore the host's own dispose. The scheduler's forced disposal
		 * leaves no live batch to wait for, and a detached barrier must not
		 * outlive the session it was installed on.
		 */
		uninstall() {
			if (state.barriers.get(session) !== installed) return false;
			state.barriers.delete(session);
			if (session.dispose !== disposeWithBarrier) return false;
			try {
				Object.defineProperty(session, "dispose", {
					value: original,
					configurable: true,
					writable: true,
				});
			} catch (error) {
				record("fission", error, { seam: "dispose", restore: true, optional: true });
				return false;
			}
			return true;
		},
	};
	function disposeWithBarrier(...args) {
		if (!disposeCall) {
			// The host calls `session.dispose()`, but a detached call has no
			// receiver. Falling back to the session keeps the original method's
			// `this` intact instead of handing it `undefined`.
			const receiver = this ?? session;
			disposeCall = (async () => {
				try {
					// The barrier never replaces the host's dispose. If it cannot
					// decide, the caller still receives the teardown it asked for.
					await barrier.wait(args[0]);
				} catch (error) {
					record("fission", error, { barrier: "dispose", optional: true });
				}
				try {
					inputBridges().get(session)?.uninstall?.();
				} catch (error) {
					record("fission", error, { seam: "input.dispose", optional: true });
				}
				return Reflect.apply(original, receiver, args);
			})();
		} else {
			// The host memoizes its dispose call, so a postmortem signal during
			// an ordinary wait arrives here, not inside `wait`. Cancel the flows
			// now and bound the shared wait by the grace window.
			barrier.escalate(args[0]);
		}
		return disposeCall;
	}
	try {
		Object.defineProperty(session, "dispose", {
			value: disposeWithBarrier,
			configurable: true,
			writable: true,
		});
	} catch (error) {
		record("fission", error, { seam: "dispose", optional: true });
		return null;
	}
	state.barriers.set(session, installed);
	return installed;
}

function installPort(registry, scheduler) {
	if (typeof registry?.setFissionScheduler !== "function") {
		throw new TypeError("the station registry exposes no setFissionScheduler()");
	}
	registry.setFissionScheduler(scheduler);
}

/** Build the scheduler for this manager, or refuse with the exact gap. */
function attach(state, registry, ctx) {
	const view = hostView(ctx);
	const manager = view.manager;
	if (!manager || (typeof manager !== "object" && typeof manager !== "function")) {
		return refuse(
			state,
			"FISSION_UNSUPPORTED",
			"ctx.sessionManager is absent; the shared journal cannot be bound",
		);
	}

	const existing = state.byManager.get(manager);
	if (existing) {
		try {
			installPort(registry, existing.scheduler);
		} catch (error) {
			return refuse(state, "FISSION_UNSUPPORTED", String(error?.message ?? error), {
				quiet: true,
			});
		}
		// A flow session shares the manager, but only the owner's own input
		// belongs to the batch. A flow's session keeps its own prompt path.
		if (existing.ownerSession && view.session === existing.ownerSession) {
			try {
				installFissionInput(existing.ownerSession, existing.scheduler);
			} catch (error) {
				record("fission", error, { seam: "input", optional: true });
			}
		}
		installDisposeBarrier(view.session, existing.scheduler);
		return ready(state, "the scheduler is bound to this shared journal");
	}

	const other = liveBatchElsewhere(state, manager);
	if (other) {
		return refuse(
			state,
			"FISSION_SCHEDULER_BUSY",
			`a fission batch opened by ${other.ownerLabel} is still live; one process holds one scheduler`,
			{ quiet: true },
		);
	}

	if (typeof registry?.bindFlow !== "function") {
		return refuse(state, "FISSION_UNSUPPORTED", "the station registry exposes no bindFlow()", {
			quiet: true,
		});
	}

	const session = view.session;
	if (!session || (typeof session !== "object" && typeof session !== "function")) {
		return refuse(
			state,
			"FISSION_UNSUPPORTED",
			"no live AgentSession is captured; flows cannot be spawned without the owner session",
			{ quiet: true },
		);
	}

	const expected = identityId(ctx?.agent);
	let actual = null;
	try {
		actual = typeof session.getAgentId === "function" ? session.getAgentId() : null;
	} catch {
		actual = null;
	}
	if (expected && typeof actual === "string" && actual !== "" && actual !== expected) {
		return refuse(
			state,
			"FISSION_UNSUPPORTED",
			`the captured session reports agent ${actual}, not ctx.agent ${expected}; binding would attach the wrong owner`,
			{ quiet: true },
		);
	}
	if (!session.agent || typeof session.agent !== "object") {
		return refuse(
			state,
			"FISSION_UNSUPPORTED",
			"the session exposes no agent; adoption and flow event routing need it",
			{ quiet: true },
		);
	}

	let bridge = null;
	try {
		bridge = installFissionUI(session);
	} catch (error) {
		// Without the multiplexer flow events do not reach the screen. The
		// scheduler still runs, and owns installFissionEvents as its bridge.
		record("fission", error, { seam: "installFissionUI", optional: true });
	}

	const resolveModel = modelResolver(session);
	let scheduler;
	try {
		scheduler = createFissionScheduler({
			manager,
			session,
			agent: session.agent,
			bindFlow: (flowId, station, permission, meta) =>
				registry.bindFlow(flowId, station, permission, meta),
			unbindFlow: (flowId) => registry.unbindFlow(flowId),
			levelTemplate: loadDoc("receipts/scope")["inside-text"],
			vibeActive: vibeProbe(session),
			...(resolveModel ? { resolveModel } : {}),
			onPromote: (_target, _heir, batch) => {
				try {
					batch?.station?.persist?.();
				} catch (error) {
					record("fission", error, { persist: true });
				}
			},
			...(bridge ? { bridge } : {}),
		});
	} catch (error) {
		try {
			bridge?.dispose?.();
		} catch {
			// Restore is best effort; the refusal itself is the answer.
		}
		return refuse(
			state,
			error?.code ?? "FISSION_UNSUPPORTED",
			String(error?.message ?? error),
		);
	}

	try {
		installPort(registry, scheduler);
	} catch (error) {
		try {
			scheduler.dispose({ force: true });
		} catch {
			// The port was never installed.
		}
		try {
			bridge?.dispose?.();
		} catch {
			// Restore is best effort.
		}
		return refuse(state, "FISSION_UNSUPPORTED", String(error?.message ?? error), {
			quiet: true,
		});
	}

	let input = null;
	try {
		input = installFissionInput(session, scheduler);
	} catch (error) {
		record("fission", error, { seam: "input", optional: true });
	}

	const entry = {
		manager,
		scheduler,
		bridge,
		input,
		ownerSession: session,
		ownerLabel: identityId(ctx?.agent) ?? "unknown",
	};
	state.byManager.set(manager, entry);
	state.entries.add(entry);
	installDisposeBarrier(session, scheduler);
	return ready(state, "the scheduler is bound to this session");
}

/**
 * Attach the scheduler on the first session event that carries a session.
 *
 * `session_start` is the earliest point with a manager. `before_agent_start`
 * repeats the attempt in case a host emits no start event or a session switch
 * changed the manager. Repeating is safe: the manager lookup returns the
 * existing port, and a refusal is recorded once by the diagnostics ring.
 */
export function wireFission(pi, registry) {
	const state = activationState();
	const ensure = (ctx) => attach(state, registry, ctx);
	for (const event of ["session_start", "before_agent_start"]) {
		try {
			pi.on(event, (_event, ctx) => {
				ensure(ctx);
			});
		} catch (error) {
			record("fission", error, { missing: [event], optional: true });
		}
	}
	return {
		ensure,
		status: () => state.status,
	};
}

/** The last attach verdict: ready, or the exact host gap that refused it. */
export function fissionActivationStatus() {
	return activationState().status;
}
