import { agentIdOf, conversationKeyOf } from "./identity-adapters.mjs";
// Host-side binding for the composition root.
//
// The activation layer used to decide owner UI, child identity, display, and
// child-session assembly inline. Those are host facts, not wiring: this module
// resolves them into a plain binding, so activation only calls
// bindHostForkPorts with the result.

import { createBranchSession, registerOwnerUI } from "./branch-session.mjs";
import { prepareChildContext, stopAfterScopeReturn } from "./branch-context.mjs";
import { childDisplayFor } from "./child-display.mjs";
import { rememberSession, sessionFor } from "./capture.mjs";
import { planStationBinding } from "./domain/binding.mjs";

function agentIdOfSession(session) {
	const id =
		(typeof session?.getAgentId === "function" ? session.getAgentId() : null) ??
		session?.agent?.id;
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
	stopAfterScopeReturn(owner?.agent, owner);
	const baseIdentity =
		typeof station?.forkIdentityPort === "function" ? station.forkIdentityPort() : null;
	const childIdentity =
		baseIdentity ?? forkWiring.identityForAgent(agentIdOf(ctx));
	// The root interface is the only user-facing surface. Register it on the
	// owner session so a fork's approval appears there, with the child's label,
	// instead of a headless prompt nobody sees. A headless root keeps the honest
	// OWNER_UI_ABSENT limitation.
	const plan = planStationBinding({
		owner,
		childIdentity,
		hasUI: ctx?.hasUI,
		ui: ctx?.ui,
	});
	if (plan.registerOwnerUI) registerOwnerUI(owner, ctx.ui);
	// Descendants use the same root display sink, regardless of adoption.
	const display =
		plan.displayKind === "holder"
			? childIdentity.displayHolder
			: plan.displayKind === "child"
				? childIdentity.display
				: plan.displayKind === "owner"
					? childDisplayFor(owner, ctx?.ui)
					: ctx?.ui
						? childDisplayFor(owner ?? ctx?.session ?? ctx, ctx.ui)
						: null;
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
						sessionManager: spec.sessionManager ?? spec.manager ?? station.manager ?? null,
						flowId: spec.agentId,
						sourceToolCallId: spec.sourceToolCallId,
						upscopeSnapshotLeafId: spec.upscopeSnapshotLeafId,
						agentDisplayName: spec.path ?? spec.scopeId,
						ui: childIdentity ? null : (ctx?.ui ?? null),
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
		abortChild: options.abortChild ?? null,
		interruptChild: options.interruptChild ?? null,
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
	if (forkWiring.identityForAgent(agentIdOf(ctx))) return;
	if (ctx?.hasUI === false || !ctx?.ui) return;
	// A context can carry the live session before the host reports it through
	// the manager. Remember it so a later manager-only context still resolves
	// the same owner.
	if (ctx?.session === owner) rememberSession(owner);
	registerOwnerUI(owner, ctx.ui);
	station.setDisplayPort(childDisplayFor(owner, ctx.ui));
}
