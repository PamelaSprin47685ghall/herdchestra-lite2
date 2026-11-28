// The engine: the one value this package hands a host.
//
// Assembly is a core concern because it is core policy: which ports exist,
// which tickets back which tool, and which read model a display may see. The
// host supplies facts (`host`) and verbs (`tickets`); it receives one engine
// and never reaches into a module.

import { buildPorts } from "./core/ports/build.mjs";
import { isReadOnlySubagentPolicy } from "./core/policy.mjs";
import { createStationRegistry } from "./station/registry.mjs";
import { createForkWiring } from "./wiring/fork-wiring.mjs";
import { createScopes } from "./scope/scopes.mjs";
import { createTools } from "./tools/catalog.mjs";
import { preloadDocs, render } from "./prompts/index.mjs";
import { preloadSkills } from "./prompts/skills.mjs";

/** A refusal is data with both sides named; a half table wires another system. */
function resolvePortsOrThrow(env, report) {
	const built = buildPorts(env);
	if (built.ok) return built;
	report?.("activation", new Error(built.detail), { port: built.port, feature: built.feature });
	const error = new Error(built.detail);
	error.code = built.code ?? "PORT_UNAVAILABLE";
	error.port = built.port;
	error.feature = built.feature;
	throw error;
}

/**
 * Build the engine for one extension instance.
 *
 * `host` is the grouped fact bag; `tickets` are the host's async verbs. Both
 * are plain objects, so a test can hand this function a double without a host
 * process. Nothing here imports a host module.
 */
export function createEngine({ host = {}, tickets = {}, env = process.env, pricingCatalog = null, spawn = null } = {}) {
	const ports = resolvePortsOrThrow(env, host.report?.record);
	// A fork tree spans agents, and the host builds the extension again for
	// every child session. The wiring therefore belongs to the process, not to
	// one engine: the parent registers a fork, the child's station must find
	// that same registry, ledger, and waiter set. The host owns the slot; the
	// core creates the object once and asks the host to keep it. Engines that
	// share no slot (tests) stay isolated.
	const shared = host.fork?.wiring?.() ?? null;
	const forkWiring = shared ?? createForkWiring(
		{
			conversationKeyOf: host.session?.conversationKey,
			sameManager: host.fork?.sameManager,
		},
		{ report: host.report?.record ?? null, spawn },
	);
	if (!shared) host.fork?.wiring?.(forkWiring);
	const registry = createStationRegistry({
		host,
		tickets,
		pricingCatalog,
		ports: ports.names,
		implementations: ports.implementations,
		features: ports.features,
		forkWiring,
		onStation: host.fork?.attachStation ?? null,
		onStationRefresh: host.fork?.refreshStation ?? null,
	});
	const scopes = createScopes({ forkWiring });
	// One accessor creates, one only looks. A probe must never mint a station for
	// a context nobody owns: the host routes an interrupt by asking who already
	// holds the context, and a lookup that created on a miss would answer itself.
	const stationFor = (ctx) => registry.stationFor(ctx);
	const peekStation = (ctx) =>
		registry.hasStation(ctx) ? registry.stationFor(ctx) : null;
	const userAbort = (ctx, evidence = null) =>
		peekStation(ctx)?.onUserAbort?.(ctx, evidence) ?? null;
	// The classification vocabulary has one home, core/policy.mjs; a host that
	// must exempt a read-only agent asks this instead of comparing the string. The
	// context is passed through untouched: the station reads it.
	const isReadOnlySubagent = (ctx) => {
		const station = peekStation(ctx);
		if (!station || typeof station.policy !== "function") return false;
		return isReadOnlySubagentPolicy(station.policy(ctx));
	};
	return {
		station: stationFor,
		peekStation,
		isReadOnlySubagent,
		hasStation: (ctx) => registry.hasStation(ctx),
		userAbort,
		tools: createTools({ stationFor: (ctx) => registry.stationFor(ctx), tickets }),
		scopes,
		text: Object.freeze({
			preload: () => preloadDocs() + preloadSkills(),
			render: (name, vars) => render(name, vars),
		}),
		ports: ports.names,
		forkWiring: () => forkWiring,
		registry,
	};
}

/**
 * The surface a host may implement, and nothing else.
 *
 * This is a declaration, not a description: a core file that reaches for a key
 * outside these lists fails `tests/architecture/core-host-free.test.mjs`. The
 * gateway between the two shapes below and the host is `shapeHost`, so the
 * declared keys and the keys that shim accepts are also pinned equal — a new
 * key cannot appear on one side only.
 *
 * `attachStation` and `refreshStation` are lifecycle hooks read by the engine
 * itself; a station never sees them, which is why they are declared here but
 * absent from `shapeHost`.
 */
export const HOST_CONTRACT = Object.freeze({
	session: Object.freeze([
		"managerOf",
		"conversationKey",
		"branch",
		"agent",
		"header",
		"setMessages",
		"appendHistory",
		"settingsOf",
		"abort",
		"canRewindRoot",
	]),
	model: Object.freeze(["of", "thinkingOf", "parseSpec", "capabilities", "query"]),
	// The confiscated tool set: `listSpecs` is the `.d.ts` input, `execute` is
	// the funnel the js runtime calls for every non-control method.
	tools: Object.freeze(["listSpecs", "execute"]),
	accounting: Object.freeze(["usage", "pricing"]),
	fork: Object.freeze([
		"wiring",
		"attachBaseForkPorts",
		"identityForAgent",
		"agentIdOf",
		"sameManager",
		"ledgerFor",
		"adoptLedger",
		"attachStation",
		"refreshStation",
	]),
	report: Object.freeze(["record"]),
});

/** Keys the engine reads from `host.fork` before a station exists. */
export const ENGINE_ONLY_HOST_KEYS = Object.freeze({
	fork: Object.freeze(["attachStation", "refreshStation"]),
});

/** The verbs a host may implement: each one is an async host effect. */
export const TICKET_CONTRACT = Object.freeze([
	"steer",
	"prompt",
	"rewindRoot",
	"restoreScopedModel",
	"applyPendingModelSwitch",
	"canSteer",
	"canPrompt",
	// The official goal mirror: one verb owns the host `/goal` enter/drop and
	// commits the herd session only after the host accepted the objective.
	"goalSession",
]);
