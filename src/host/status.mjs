/**
 * Host status widget, ported from ../HerdchestraLite/src/herd/main.cljs.
 *
 * The native working line is never touched. Usage, the session prefix, and the
 * host label share one widget line above the editor:
 *   <usage> · <session prefix> · <user@short-host>
 *
 * Every write is driven by a real host event. There is no polling timer and no
 * deferred merge: an identical line is simply not written twice.
 */

import os from "node:os";
import {
	accumulateUsage,
	entryUsage,
	hostLabel,
	sessionPrefix,
	usageLine,
	usageSnapshot,
	zeroUsage,
} from "./usage.mjs";
import { record } from "./diagnostics.mjs";
import { findFissionManager, isFissionManager } from "./fission-manager.mjs";

function freshSession() {
	return {
		totals: zeroUsage(),
		last: zeroUsage(),
		usageText: "",
		prefix: "",
		host: "",
		widgetLine: null,
	};
}

/**
 * The fission proxy a context writes through, or null.
 *
 * A flow owns a per-flow proxy over the batch's one shared manager, and the
 * host may expose either the proxy it was handed or only the raw manager.
 * Both forms are resolved here by the flow identity the scheduler assigns.
 */
function fissionProxyFor(ctx) {
	const declared = ctx?.sessionManager ?? null;
	if (!declared) return null;
	if (isFissionManager(declared)) return declared;
	const agent = ctx?.agent;
	const identities = [
		agent?.id,
		agent?.agentId,
		ctx?.agentId,
		ctx?.flowId,
		agent?.label,
		agent?.displayName,
		ctx?.label,
	];
	for (const identity of identities) {
		const proxy = findFissionManager(declared, identity);
		if (proxy) return proxy;
	}
	return null;
}

function isSubagent(ctx) {
	const agent = ctx?.agent;
	if (!agent) return false;
	// A fission flow is a parallel worker of this session, not a sub agent.
	// The host marks it from `parentAgentId`, which is exactly the mark that
	// would silence the status line; the proxy is what says otherwise.
	if (fissionProxyFor(ctx)) return false;
	if (agent.kind === "sub" || agent.kind === "subagent") return true;
	return typeof agent.depth === "number" && agent.depth > 0;
}

function anyPositive(snapshot) {
	return (
		snapshot.input > 0 ||
		snapshot.cacheRead > 0 ||
		snapshot.cacheWrite > 0 ||
		snapshot.output > 0 ||
		snapshot.cost > 0
	);
}

function hostLabelFromProcess() {
	try {
		return hostLabel(os.userInfo().username, os.hostname());
	} catch {
		return null;
	}
}

/** Build one isolated status runtime. Production installs one per extension. */
export function createStatusRuntime(options = {}) {
	const diagnostics = options.diagnostics ?? null;
	const sessions = new WeakMap();
	const totals = new Map();
	const orphanKey = {};
	let activeUsageKey = null;
	let displayHost = null;

	// Flows run with `hasUI: false`, so their own context cannot host the
	// widget even though they drive the one session record. Remember the last
	// context that could and write the line there.
	function rememberDisplayHost(ctx) {
		if (canUseWidget(ctx)) displayHost = ctx;
	}

	function keyFor(ctx) {
		// One record per session, not per flow. Every fission flow writes
		// through its own proxy, but all of them share one manager and one
		// journal; keying on the proxy would split the accumulated totals N
		// ways and give every flow a private `last`.
		const proxy = fissionProxyFor(ctx);
		const key = proxy?.shared ?? ctx?.sessionManager ?? ctx;
		return key && (typeof key === "object" || typeof key === "function") ? key : orphanKey;
	}

	function readBranchUsage(manager, session) {
		try {
			const branch = manager?.getBranchView?.() ?? manager?.getBranch?.() ?? [];
			for (const entry of Array.isArray(branch) ? branch : []) {
				const usage = entryUsage(entry);
				if (usage) accumulateUsage(session.totals, usageSnapshot(usage));
			}
		} catch (error) {
			// A branch that cannot be read starts from zero usage. Record it:
			// every later number on this line is then measured from zero, and
			// nothing on screen would say why.
			record("status", error, { stage: "branch-usage" });
		}
	}

	function initSessionUsage(ctx) {
		const key = keyFor(ctx);
		const session = freshSession();
		sessions.set(key, session);
		totals.set(key, session.totals);
		readBranchUsage(key, session);
		return session;
	}

	function ensureInitialized(ctx) {
		rememberDisplayHost(ctx);
		const key = keyFor(ctx);
		const existing = sessions.get(key);
		if (existing) return { key, session: existing, created: false };
		return { key, session: initSessionUsage(ctx), created: true };
	}

	function canUseWidget(ctx) {
		return Boolean(
			ctx?.ui &&
				typeof ctx.ui.setWidget === "function" &&
				ctx.hasUI !== false,
		);
	}

	function writeWidget(ctx, line) {
		if (!canUseWidget(ctx)) return false;
		try {
			ctx.ui.setWidget("herd", [line], { placement: "aboveEditor" });
			return true;
		} catch {
			return false;
		}
	}

	function totalOfAllSessions() {
		const total = zeroUsage();
		for (const snapshot of totals.values()) accumulateUsage(total, snapshot);
		return total;
	}

	function usageCurrentText(session) {
		const active = activeUsageKey ? sessions.get(activeUsageKey)?.last : null;
		const current = active && anyPositive(active) ? active : session.last;
		return usageLine(current, totalOfAllSessions());
	}

	function stylePart(ctx, role, text) {
		const theme = ctx?.ui?.theme;
		if (!theme || typeof theme.fg !== "function") return text;
		return theme.fg(role, text);
	}

	function styleUsage(ctx, text) {
		return text
			.split(/(\[¥[^\]\s;]*\])/g)
			.filter((part) => part.length > 0)
			.map((part) => stylePart(ctx, part.startsWith("[¥") ? "accent" : "dim", part))
			.join("");
	}

	function flushWidget(ctx, session) {
		const host = canUseWidget(ctx) ? ctx : displayHost;
		if (!host) return;
		const parts = [];
		if (session.host) parts.push(stylePart(host, "accent", session.host));
		if (session.usageText) parts.push(styleUsage(host, session.usageText));
		if (session.prefix) parts.push(stylePart(host, "dim", session.prefix));
		const issues = diagnostics ? diagnostics.total() : 0;
		if (issues > 0) parts.push(stylePart(host, "dim", `⚠ ${issues}`));
		if (parts.length === 0) return;
		const line = parts.join(stylePart(host, "dim", "  ---  "));
		if (line === session.widgetLine) return;
		if (writeWidget(host, line)) session.widgetLine = line;
	}

	function flushUsage(ctx, session) {
		session.usageText = usageCurrentText(session);
		flushWidget(ctx, session);
	}

	function showUsage(ctx) {
		if (isSubagent(ctx)) return;
		const { session } = ensureInitialized(ctx);
		flushUsage(ctx, session);
	}

	function showSessionPrefix(ctx) {
		if (isSubagent(ctx)) return;
		const { session } = ensureInitialized(ctx);
		let name;
		try {
			name = ctx?.sessionManager?.getSessionName?.();
		} catch {
			name = undefined;
		}
		const prefix = sessionPrefix(name);
		if (prefix === null) return;
		session.prefix = prefix;
		flushWidget(ctx, session);
	}

	function showHost(ctx) {
		if (isSubagent(ctx)) return;
		const { session } = ensureInitialized(ctx);
		const label = hostLabelFromProcess();
		if (!label) return;
		session.host = label;
		flushWidget(ctx, session);
	}

	function bootstrap(ctx) {
		return ensureInitialized(ctx).session;
	}

	function messageEnd(message, ctx) {
		const session = bootstrap(ctx);
		if (message?.role === "assistant") {
			const usage = message.usage;
			if (usage) {
				const snapshot = usageSnapshot(usage);
				accumulateUsage(session.totals, snapshot);
				session.last = snapshot;
				// Single-value fields show the most recent writer, whichever
				// flow or side request it was. Recording the writer only for
				// sub agents froze the line on the last sub agent's numbers.
				activeUsageKey = keyFor(ctx);
			}
		}
		showSessionPrefix(ctx);
		showHost(ctx);
		showUsage(ctx);
	}

	function safe(handler) {
		return (...args) => {
			try {
				return handler(...args);
			} catch (error) {
				// A throwing handler must not take the other displays down, but
				// swallowing it outright hides every rendering bug.
				record("status", error);
				return undefined;
			}
		};
	}

	function install(pi) {
		const on = (event, handler) => {
			try {
				pi?.on?.(event, handler);
			} catch {
				// Hosts without that hook keep the remaining displays.
			}
		};

		on(
			"session_start",
			safe((_event, ctx) => {
				// A second start on the same manager must not erase the
				// accumulated totals: the session, not the flow, owns them.
				const { key, session, created } = ensureInitialized(ctx);
				// A genuinely new session starts a new ledger: the old
				// manager's totals and its last writer must not leak into
				// this line.
				if (created) {
					totals.clear();
					totals.set(key, session.totals);
					activeUsageKey = null;
				}
				showSessionPrefix(ctx);
				showHost(ctx);
				showUsage(ctx);
			}),
		);
		on(
			"message_end",
			safe((event, ctx) => messageEnd(event?.message, ctx)),
		);
		on(
			"message_update",
			safe((_event, ctx) => showUsage(ctx)),
		);
		on(
			"message_start",
			safe((_event, ctx) => showUsage(ctx)),
		);
		on(
			"before_agent_start",
			safe((_event, ctx) => showUsage(ctx)),
		);
		on(
			"tool_execution_start",
			safe((_event, ctx) => {
				showUsage(ctx);
				queueMicrotask(() => showUsage(ctx));
			}),
		);
		on(
			"tool_execution_update",
			safe((_event, ctx) => showUsage(ctx)),
		);
		on(
			"tool_execution_end",
			safe((_event, ctx) => showUsage(ctx)),
		);
	}

	return {
		install,
		initSessionUsage,
		messageEnd,
		showUsage,
		showSessionPrefix,
		showHost,
		stateFor: (ctx) => ensureInitialized(ctx).session,
	};
}

/** Register the one-line status widget on a host. */
export function installStatus(pi, options) {
	return createStatusRuntime(options).install(pi);
}
