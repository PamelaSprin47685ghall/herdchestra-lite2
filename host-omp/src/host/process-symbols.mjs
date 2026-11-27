/**
 * Process-wide symbol registry: the only owner of every `Symbol.for` key that
 * host-omp exchanges with another copy of itself or with a sibling extension.
 *
 * Each key crosses a process boundary. Native Esc aborts through
 * `AgentSession.prototype.abort`; the sibling Web UI extension writes the user
 * abort hook; a forked child session is a second extension instance that must
 * find the parent's fork wiring, transcript listeners and status ledger. A
 * string is the only shared identity two copies of this module can agree on,
 * so every key string here is a published contract: change one and an older
 * copy stops matching silently.
 *
 * Only `Symbol.for("pi-agent-core.terminal-tool-result")` belongs to upstream
 * pi; the rest are ours. Values are frozen by `Symbol.for` itself, so this
 * module exports constants rather than a mutable table.
 */

/** One fork wiring per process: a child engine reuses the parent's registry,
 * ledger and waiters. First writer wins. */
export const FORK_WIRING_KEY = Symbol.for("herdchestra-lite2.fork-wiring.v1");

/** The process-wide user abort hook the host calls with an opaque ctx. */
export const USER_ABORT_KEY = Symbol.for("herdchestra-lite2.user-abort.v1");

/** The live engine set the abort hook routes into. */
export const USER_ABORT_ENGINES_KEY = Symbol.for("herdchestra-lite2.user-abort-engines.v1");

/** Abort reason that ends a child because its parent is gone. */
export const CASCADE_ABORT_REASON = Symbol.for("herdchestra-lite2.scope-cascade-abort.v1");

/** Session hook that reports a native user interrupt (Esc, Web UI abort). */
export const USER_ABORT_CAPTURE = Symbol.for("herdchestra-lite2.user-abort-capture.v1");

/** Upstream pi: the tool result that ends a scope-return turn. */
export const TERMINAL_RESULT = Symbol.for("pi-agent-core.terminal-tool-result");

/** The installed after-tool-call hook that stops a returning scope. */
export const RETURN_STOP = Symbol.for("herdchestra-lite2.scope-return-stop.v1");

/** Marker every branch manager proxy carries. */
export const BRANCH_MANAGER = Symbol.for("herdchestra-lite2.branch-manager.v1");

/** Captured host internals: session, manager, agent seam. */
export const SESSION_CAPTURE_STATE = Symbol.for("herdchestra-lite2.session-capture.v2");

/** Marker proving the vibe tools were installed once. */
export const VIBE_PATCH = Symbol.for("herdchestra-lite2.vibe-tools.v2");

/** Marker proving the extension runner getter was patched once. */
export const RUNNER_GETTER_PATCH = Symbol.for("herdchestra-lite2.runner-getter.v2");

/** Marker proving the session abort was patched once. */
export const ABORT_PATCH = Symbol.for("herdchestra-lite2.session-abort.v1");

/** One transcript subscription per session, shared by every display. */
export const TRANSCRIPT_SUBSCRIBE = Symbol.for("herdchestra-lite2.transcript-subscribe.v1");

/** The listener table keyed by session. */
export const TRANSCRIPT_LISTENERS = Symbol.for("herdchestra-lite2.transcript-listeners.v1");

/** Marker proving a session's request preparation was installed once. */
export const PREPARATION = Symbol.for("herdchestra-lite2.context-preparation.v1");

/** The status ledger shared by every activation in the process. */
export const STATUS_STATE = Symbol.for("herdchestra-lite2.status-state.v1");
