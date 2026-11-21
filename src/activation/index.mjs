/**
 * Activation domain index: assemble the extension from stations, hooks, and
 * tools. Mechanical only. No business logic lives here.
 */

import { createStationRegistry, setActiveRegistry } from "../station/index.mjs";
import { attachForkPorts } from "../host/fork-wiring.mjs";
import { conversationKeyOf, identityForAgent } from "../host/fork-registry.mjs";
import { createBranchSession, registerOwnerUI } from "../host/branch-session.mjs";
import { childDisplayFor } from "../host/child-display.mjs";
import { prepareChildContext } from "../host/branch-context.mjs";
import { sessionFor } from "../host/capture.mjs";
import { scopeTitle } from "../scope/scope-id.mjs";
import { resolvePorts } from "../core/ports/resolve.mjs";

/** The host's agent id for a context, or null. */
function agentIdOf(ctx) {
	const direct = ctx?.agent?.id;
	if (typeof direct === "string" && direct !== "") return direct;
	const fallback = ctx?.agentId;
	return typeof fallback === "string" && fallback !== "" ? fallback : null;
}
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
	const resolved = resolvePorts({}, env);
	if (!resolved.ok) {
		const detail = `the port switch is unusable: ${resolved.code} port=${resolved.port} wanted=${resolved.wanted ?? "default"} available=[${resolved.available.join(", ")}]`;
		record("activation", new Error(detail), { port: resolved.port });
		return { ok: false, ...resolved, detail };
	}
	return resolved;
}

export function wireExtension(pi, pricingCatalog, diagnosis = null, env = process.env) {
	const ports = resolveWiringPorts(env);
	const table = ports.ok ? ports.ports : {};
	let registry = null;
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
			const childIdentity = identityForAgent(forkWiring.registry, agentIdOf(ctx));
			// The root interface is the only user-facing surface. Register it
			// on the owner session so a fork's tool approval can be shown there
			// with the child's label instead of falling back to a headless
			// prompt nobody sees. A headless root has no ctx.ui and keeps the
			// honest OWNER_UI_ABSENT limitation.
			// Descendants use the same root display sink, regardless of adoption.
			if (owner && !childIdentity && ctx?.hasUI !== false && ctx?.ui) registerOwnerUI(owner, ctx.ui);
			const display = childIdentity?.display ??
				(!childIdentity && ctx?.hasUI !== false ? childDisplayFor(owner, ctx?.ui) : null);
			attachForkPorts(station, forkWiring, {
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
								})
						: undefined,
			});
	};
	registry = createStationRegistry(pi, buildTickets(pi), pricingCatalog, {
		...table,
		onStation: attachStation,
	});
	if (!ports.ok) {
		record("activation", new Error(ports.detail), { wiring: "ports" });
	}
	setActiveRegistry(registry);
	const hooks = wireHooks(pi, registry);
	wireTools(pi, registry);
	wireCommands(pi, registry);
	wireHostDiagnosis(pi, diagnosis, hooks);
	// The root needs the resolved table to decide whether the status widget
	// exists at all; the decision stays here, not in the host renderer.
	return { hooks, ports: ports.ok ? ports.ports : {} };
}
