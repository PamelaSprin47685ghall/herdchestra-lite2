// Station registry: one station per session manager, plus the active registry.

import { SessionStation } from "./station.mjs";

const nullTickets = {
	steer: () => {},
	canSteer: false,
	activateTools: (activeTools, prompt, changed) =>
		changed ? { systemPrompt: prompt } : undefined,
};

// Fission facts outlive one extension instance. A flow session loads the
// extension again, so its own registry must still route by flow identity and
// find the one scheduler the owner installed. The identity the host publishes
// on `ctx.agent` is an ExtensionAgentIdentity `{ kind, id, name, depth,
// parentId? }`, not an Agent instance, and every flow deliberately shares one
// SessionManager. So the key is the identity's `id` string; the manager is
// recorded to reject a colliding bind, never used as the discriminator.
const FLOWS_KEY = Symbol.for("herdchestra-lite2.fission-flows.v2");
const SCHEDULER_KEY = Symbol.for("herdchestra-lite2.fission-scheduler.v1");

function globalFlows() {
	let flows = globalThis[FLOWS_KEY];
	if (!flows) {
		flows = new Map();
		Object.defineProperty(globalThis, FLOWS_KEY, {
			value: flows,
			enumerable: false,
			configurable: true,
		});
	}
	return flows;
}

/** Accept an identity object or its id string; never compare objects. */
function identityId(value) {
	if (typeof value === "string" && value !== "") return value;
	if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
	if (typeof value.id === "string" && value.id !== "") return value.id;
	if (typeof value.agentId === "string" && value.agentId !== "") return value.agentId;
	return null;
}

function flowEntry(value) {
	const id = identityId(value);
	return id ? globalFlows().get(id) ?? null : null;
}

export function createStationRegistry(pi, tickets = nullTickets, pricingCatalog) {
	const stations = new WeakMap();
	// Flow ids are strings (`ctx.agent.id`), and a WeakMap refuses a primitive
	// key. The local map only mirrors the global one for this extension
	// instance; unbind walks both.
	const flows = new Map();
	const flowEntries = new Set();
	let orphanStation = null;
	let pendingStation = null;
	let scheduler = null;

	// The pending handoff belongs to one session. A `/new` or a session switch
	// must never route the next stop to the old station.
	function sameManager(station, ctx) {
		const key = ctx?.sessionManager ?? ctx;
		if (!key || !station?.manager) return false;
		if (station.manager === key) return true;
		try {
			const live = key.getSessionId?.();
			const armed = station.manager.getSessionId?.();
			return Boolean(live && armed && live === armed);
		} catch {
			return false;
		}
	}

	const registry = {
		// The host must explicitly bind each agent; a shared manager is not a
		// flow identity. Unbound callers retain the existing session path.
		bindFlow(agent, station, permission, meta = null) {
			const id = identityId(agent) ?? identityId(meta?.identity);
			if (!id) throw new TypeError("Flow agent identity (ctx.agent.id) is required");
			if (!station || (permission !== "ro" && permission !== "rw")) throw new TypeError("Flow station and permission are required");
			const manager = meta?.manager ?? station.manager ?? null;
			const existing = globalFlows().get(id);
			if (existing || station.fissionFlow) throw new Error("Flow is already bound");
			const entry = {
				id,
				identity: meta?.identity ?? null,
				station,
				permission,
				manager,
				batchId: meta?.batchId ?? null,
				index: Number.isInteger(meta?.index) ? meta.index : null,
				label: typeof meta?.label === "string" ? meta.label : "",
			};
			station.fissionFlow = entry;
			flows.set(id, entry);
			globalFlows().set(id, entry);
			flowEntries.add(entry);
			return entry;
		},
		unbindFlow(agent) {
			const id = identityId(agent);
			const entry = id ? flows.get(id) ?? flowEntry(id) : null;
			if (!entry) return;
			if (entry.station?.fissionFlow === entry) delete entry.station.fissionFlow;
			if (id) flows.delete(id);
			globalFlows().delete(entry.id);
			flowEntries.delete(entry);
		},
		flowFor(agent) {
			const id = identityId(agent);
			return id ? flows.get(id) ?? flowEntry(id) : null;
		},
		flows() {
			return [...flowEntries];
		},
		stationForAgent(agent) {
			return flowEntry(agent)?.station ?? null;
		},
		// One scheduler per process: the owner installs it, flow extension
		// instances read the same port back. The port is the only seam between
		// this station layer and the spawning scheduler.
		//
		// Port contract (synchronous; the owner must never await):
		//   registerBatch({ toolCallId, sessionManager, station, ctx, begin,
		//                   flows, totals, stage, elderReport, mainAgent,
		//                   nested })
		//     -> { ok: true, batchId } | { ok: false, code, reason }
		//   cancelBatch(batchId)                     optional; undo registration
		//   retireOwner({ batchId, station, ctx })    called from tool_result
		//     -> { abort: false } keeps the owner alive; default aborts it
		//   onOwnerEnd({ batchId, station, ctx, event }) optional; starts flows.
		//     It must await the owner session's
		//     settleInFlightMessagePersistence() before resolving batch.ackId.
		//   hasRunningFlows(batchId)                 optional; stop guard probe
		//   onOwnerStop({ batchId, station, ctx })   optional; overrides guard
		//
		// The station's pending descriptor is its own stop guard, never the
		// scheduler's batch object; the id is the only value that crosses.
		setFissionScheduler(port) {
			if (port !== null && port !== undefined && typeof port.registerBatch !== "function") {
				throw new TypeError("A fission scheduler must implement registerBatch()");
			}
			scheduler = port ?? null;
			globalThis[SCHEDULER_KEY] = scheduler;
			return scheduler;
		},
		fissionScheduler() {
			return scheduler ?? globalThis[SCHEDULER_KEY] ?? null;
		},
		stationFor(ctx) {
			const entry = flowEntry(ctx?.agent);
			if (entry) return entry.station;
			const key = ctx?.sessionManager ?? ctx;
			if (!key || (typeof key !== "object" && typeof key !== "function")) {
				if (!orphanStation) {
					orphanStation = new SessionStation(null, pi, tickets, registry, pricingCatalog);
				}
				return orphanStation;
			}
			let station = stations.get(key);
			if (!station) {
				station = new SessionStation(ctx?.sessionManager ?? null, pi, tickets, registry, pricingCatalog);
				stations.set(key, station);
			}
			return station;
		},
		stationForStop(ctx) {
			// A flow shares its manager with every sibling, so the pending-stop
			// fallback below must never capture a flow event. The identity decides.
			const entry = flowEntry(ctx?.agent);
			if (entry) return entry.station;
			const station = registry.stationFor(ctx);
			if (station.state.relay?.handoffPending) return station;
			if (!pendingStation) return station;
			if (!sameManager(pendingStation, ctx)) {
				pendingStation = null;
				return station;
			}
			if (pendingStation.state.relay?.handoffPending) return pendingStation;
			return station;
		},
		markPending(station) {
			pendingStation = station;
		},
		clearPending(station) {
			if (!station || pendingStation === station) pendingStation = null;
		},
	};

	return registry;
}

let activeRegistry = null;
let fallbackRegistry = null;

export function setActiveRegistry(registry) {
	activeRegistry = registry;
}

export function stationFor(ctx) {
	if (!activeRegistry) {
		if (!fallbackRegistry) fallbackRegistry = createStationRegistry(null);
		return fallbackRegistry.stationFor(ctx);
	}
	return activeRegistry.stationFor(ctx);
}

/** Alias kept for test compatibility: returns the SessionStation for ctx. */
export function stateFor(ctx) {
	return stationFor(ctx);
}
