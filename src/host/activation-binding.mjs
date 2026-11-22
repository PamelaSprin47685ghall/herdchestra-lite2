// Host-side binding for the composition root.
//
// The activation layer used to decide owner UI, child identity, display, and
// child-session assembly inline. Those are host facts, not wiring: this module
// resolves them into a plain binding, so activation only calls
// bindHostForkPorts with the result.

import { createBranchSession, registerOwnerUI } from "./branch-session.mjs";
import { prepareChildContext } from "./branch-context.mjs";
import { childDisplayFor } from "./child-display.mjs";
import { rememberSession, sessionFor } from "./capture.mjs";
import {
	agentIdOf,
	conversationKeyOf,
	identityForAgent,
} from "./fork-registry.mjs";
import { scopeTitle } from "../scope/scope-id.mjs";

function agentIdOfSession(session) {
	const id = session?.agent?.id;
	return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Resolve the host-owned half of a station binding.
 *
 * The registry has already attached the base ports (ledger, identity, wait).
 * This function only names the owner session, the display port, and the
 * child-session factories; it does not choose a ledger and never writes the
 * station's domain state.
 */
export function resolveStationBinding(station, ctx, forkWiring, options = {}) {
	const stationFor = options.stationFor;
	const refresh = options.refresh;
	const owner = sessionFor(ctx);
	const baseIdentity =
		typeof station?.forkIdentityPort === "function" ? station.forkIdentityPort() : null;
	const childIdentity =
		baseIdentity ?? identityForAgent(forkWiring.registry, agentIdOf(ctx));
	// The root interface is the only user-facing surface. Register it on the
	// owner session so a fork's approval appears there, with the child's label,
	// instead of a headless prompt nobody sees. A headless root keeps the honest
	// OWNER_UI_ABSENT limitation.
	if (owner && !childIdentity && ctx?.hasUI !== false && ctx?.ui) {
		registerOwnerUI(owner, ctx.ui);
	}
	// Descendants use the same root display sink, regardless of adoption.
	const display =
		childIdentity?.displayHolder ??
		childIdentity?.display ??
		(!childIdentity && ctx?.hasUI !== false ? childDisplayFor(owner, ctx?.ui) : null);
	// The session id is the conversation key, not the manager object: a fork
	// branch holds a per-branch manager proxy, and an object key would give
	// parent and child two different ledgers.
	const conversationKey = conversationKeyOf(ctx?.sessionManager ?? ctx);
	const prepareChild = (session) =>
		prepareChildContext(session, stationFor, {
			agentId: agentIdOfSession(session),
			refresh,
		});
	const createSession =
		owner && typeof createBranchSession === "function"
			? (spec) =>
					createBranchSession({
						session: spec.ownerSession ?? owner,
						sessionManager: spec.sessionManager ?? station.manager ?? null,
						flowId: spec.agentId,
						sourceToolCallId: spec.sourceToolCallId,
						agentDisplayName: scopeTitle(spec.scopeId),
						ui: childIdentity ? null : (ctx?.ui ?? null),
						// The selector was resolved by the station with the host's
						// own model facade before any bracket was registered. Pass
						// the host Model object; an absent override keeps the
						// owner's model and level.
						model: spec.modelOverride,
						thinkingLevel: spec.thinkingLevel,
					})
			: undefined;
	return {
		identity: childIdentity,
		display,
		conversationKey,
		ownerSession: owner,
		prepareChild,
		createSession,
	};
}

/**
 * Fill a display that arrived after the station was cached. The owner-UI
 * registration and the headless guard belong to this host service, not to
 * activation.
 */
export function refreshStationDisplay(station, ctx, forkWiring) {
	if (!station || typeof station.setDisplayPort !== "function") return;
	const owner = sessionFor(ctx);
	if (!owner) return;
	if (identityForAgent(forkWiring.registry, agentIdOf(ctx))) return;
	if (ctx?.hasUI === false || !ctx?.ui) return;
	// A context can carry the live session before the host reports it through
	// the manager. Remember it so a later manager-only context still resolves
	// the same owner.
	if (ctx?.session === owner) rememberSession(owner);
	registerOwnerUI(owner, ctx.ui);
	station.setDisplayPort(childDisplayFor(owner, ctx.ui));
}
