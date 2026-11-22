/**
 * Activation domain index: assemble the extension from stations, hooks, and
 * tools. Mechanical only. No business logic lives here.
 */

import { createStationRegistry } from "../station/index.mjs";
import { bindHostForkPorts } from "../host/fork-wiring.mjs";
import { agentIdOf, conversationKeyOf, identityForAgent } from "../host/fork-registry.mjs";
import { createBranchSession, registerOwnerUI } from "../host/branch-session.mjs";
import { childDisplayFor } from "../host/child-display.mjs";
import { prepareChildContext } from "../host/branch-context.mjs";
import { rememberSession, sessionFor } from "../host/capture.mjs";
import { scopeTitle } from "../scope/scope-id.mjs";
import { buildPorts } from "./ports.mjs";

import { record } from "../host/diagnostics.mjs";
import { wireCommands } from "./commands.mjs";
import { wireHostDiagnosis } from "./diagnosis.mjs";
import { buildTickets } from "./tickets.mjs";
import { installCapture } from "./capture.mjs";
import { wireHooks } from "./hooks.mjs";
import { wireTools } from "./tools.mjs";

export { installCapture };

/** Assemble the extension: registry, hooks, tools, and commands. */
/**
 * Resolve every port once, at startup, and hand the answer to the registry.
 *
 * This is the only place in the extension that reads a switch. A refusal here
 * is a configuration error with both sides named, so it is recorded and thrown
 * rather than quietly falling back: a half-resolved table would wire a
 * different system than the one the user asked for.
 */
export function resolveWiringPorts(env = process.env) {
	const built = buildPorts(env);
	if (built.ok) {
		return { ok: true, ports: built.names, implementations: built.implementations };
	}
	record("activation", new Error(built.detail), { port: built.port });
	return built;
}

export function wireExtension(pi, pricingCatalog, diagnosis = null, env = process.env) {
	const ports = resolveWiringPorts(env);
	const table = ports.ok ? ports.ports : {};
	let registry = null;
	// Refresh only the UI seams of a cached station. The first attach may have
	// missed the interactive context; a later event carries it. This must stay
	// cheap: the registry calls it on every stationFor of the session.
	const refreshStationUI = (station, ctx) => {
		if (!station || typeof station.setDisplayPort !== "function") return;
		const owner = sessionFor(ctx);
		if (!owner) return;
		const forkWiring = registry.forkWiring();
		if (identityForAgent(forkWiring.registry, agentIdOf(ctx))) return;
		if (ctx?.hasUI === false || !ctx?.ui) return;
		// A context can carry the live session before the host reports it
		// through the manager. Remember it so a later manager-only context
		// still resolves the same owner.
		if (ctx?.session === owner) rememberSession(owner);
		registerOwnerUI(owner, ctx.ui);
		station.setDisplayPort(childDisplayFor(owner, ctx.ui));
	};
	const attachStation = (station, ctx) => {
			// The registry already attached the ports with the process-wide
			// wiring. Reuse that exact wiring so this station cannot end up on a
			// second ledger tree; only the host-owned spawner is added here.
			const forkWiring = registry.forkWiring();
			const owner = sessionFor(ctx);
			// A station that belongs to a fork child can name its own bracket.
			// The agent id is the only handle the host publishes on a context;
			// without a match this stays null and scope_return refuses, which
			// is the honest answer for a branch that was not forked.
			const baseIdentity =
				typeof station.forkIdentityPort === "function" ? station.forkIdentityPort() : null;
			const childIdentity = baseIdentity ?? identityForAgent(forkWiring.registry, agentIdOf(ctx));
			// The root interface is the only user-facing surface. Register it
			// on the owner session so a fork's tool approval can be shown there
			// with the child's label instead of falling back to a headless
			// prompt nobody sees. A headless root has no ctx.ui and keeps the
			// honest OWNER_UI_ABSENT limitation.
			// Descendants use the same root display sink, regardless of adoption.
			if (owner && !childIdentity && ctx?.hasUI !== false && ctx?.ui) registerOwnerUI(owner, ctx.ui);
			const display =
				childIdentity?.displayHolder ??
				childIdentity?.display ??
				(!childIdentity && ctx?.hasUI !== false ? childDisplayFor(owner, ctx?.ui) : null);
			bindHostForkPorts(station, forkWiring, {
				identity: childIdentity,
				display,
				// The session id is the conversation key, not the manager object:
				// a fork branch holds a per-branch manager proxy, and an object
				// key would give parent and child two different ledgers.
				conversationKey: conversationKeyOf(ctx?.sessionManager ?? ctx),
				ownerSession: owner,
				prepareChild: (session) =>
					prepareChildContext(
						session,
						(childCtx) => registry.stationFor(childCtx),
						{
							agentId:
								typeof session?.agent?.id === "string" && session.agent.id !== ""
									? session.agent.id
									: null,
							refresh: attachStation,
						},
					),
				createSession:
					owner && typeof createBranchSession === "function"
						? (spec) =>
								createBranchSession({
									session: spec.ownerSession ?? owner,
									sessionManager: spec.sessionManager ?? station.manager ?? null,
									flowId: spec.agentId,
									sourceToolCallId: spec.sourceToolCallId,
									agentDisplayName: scopeTitle(spec.scopeId),
									ui: childIdentity ? null : (ctx?.ui ?? null),
									// The selector was resolved by the station with the
									// host's own model facade before any bracket was
									// registered. Pass the host Model object; an absent
									// override keeps the owner's model and level.
									model: spec.modelOverride,
									thinkingLevel: spec.thinkingLevel,
								})
						: undefined,
			});
	};
	registry = createStationRegistry(pi, buildTickets(pi), pricingCatalog, {
		ports: table,
		implementations: ports.ok ? ports.implementations : {},
		onStation: attachStation,
		onStationRefresh: refreshStationUI,
	});
	const hooks = wireHooks(pi, registry);
	wireTools(pi, registry);
	wireCommands(pi, registry);
	wireHostDiagnosis(pi, diagnosis, hooks);
	// The root needs the resolved table to decide whether the status widget
	// exists at all; the decision stays here, not in the host renderer.
	return { hooks, ports: table, registry };
}
