// The multiplexed display must survive a cold start: the station is often
// attached before the interactive UI context exists (or before the session is
// remembered). A display snapshot taken at that moment stays null forever, so
// the root must keep a live holder and every later station access refreshes it.

import { describe, expect, test } from "bun:test";

import { activate } from "../host-omp/src/main.mjs";
import { createForkWiring } from "../src/wiring/fork-wiring.mjs";
import { attachForkPorts } from "./helpers/fork-attach.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { registerFork } from "../src/scope/ledger-brackets.mjs";
import { rememberSession } from "../host-omp/src/host/capture.mjs";
import { identityOf } from "../src/scope/fork-registry.mjs";
import { appendRequestMessages, attachRequestPreparation } from "./helpers/request-preparation.mjs";

function managerOf(id = "ui-init") {
	return { getSessionId: () => id, getBranch: () => [], getLeafId: () => null };
}

function hostOf() {
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerTool() {},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		sendUserMessage() {
			return Promise.resolve();
		},
	};
	return { pi, handlers, commands };
}

async function emit(handlers, event, payload, ctx) {
	const results = [];
	for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
	return results.find((result) => result !== undefined);
}

function sessionOf(manager) {
	const messages = [];
	return {
		sessionManager: manager,
		agent: { id: "agent-root", state: { messages, systemPrompt: [], tools: [] } },
		isStreaming: false,
	};
}

function uiOf() {
	const widgets = new Map();
	return {
		setWidget(key, content) {
			widgets.set(key, content);
		},
		setWorkingMessage() {},
		widgets,
	};
}

describe("a station with no display at attach time", () => {
	test("accepts the display later and uses it for the next child", async () => {
		const wiring = createForkWiring();
		const station = Object.create(SessionStation.prototype);
	station.state = { brackets: null };
		const attached = attachForkPorts(station, wiring, {
			conversationKey: "ui-init-child",
			createSession: async () => ({
				ok: true,
				session: { messages: [], prompt: async () => {}, agent: { state: { messages: [] } } },
			}),
		});
		expect(station.displayPort()).toBeNull();

		const attachedChildren = [];
		station.setDisplayPort({
			rootWait() {},
			request() {},
			attach(label, child) {
				attachedChildren.push({ label, child });
				return () => {};
			},
			activeTools: 0,
		});
		expect(station.displayPort()).not.toBeNull();
		expect(typeof station.noteScopeRequest).toBe("function");

		const registered = registerFork(attached.ledger, {
			forkId: "child",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "ui probe",
			depth: 0,
		});
		expect(registered.ok).toBe(true);
		station.childSpawnPort()({
			forkId: "child",
			childDepth: 1,
			fsm: "ui probe",
			receipt: "child receipt",
			parentOwnerId: "root",
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(attachedChildren).toHaveLength(1);
		expect(attachedChildren[0].label).toBe("/child");
		expect(attachedChildren[0].child).toBeTruthy();
	});
});

describe("station reuse after a cold attach", () => {
	test("a later request with a ready UI enables the display", async () => {
		const host = hostOf();
		const manager = managerOf();
		const session = sessionOf(manager);
		const ctx = { sessionManager: manager, hasUI: false };
		attachRequestPreparation(session, ctx);
		const wired = await activate(host.pi, {});
		const user = { role: "user", content: "go", timestamp: Date.now() };
		manager.getBranch = () => [{ type: "message", message: user }];
		appendRequestMessages(ctx, user);

		await emit(host.handlers, "before_agent_start", { systemPrompt: [] }, ctx);
		const station = wired.engine.station(ctx);
		expect(station.displayPort()).toBeNull();

		const ready = { ...ctx, hasUI: true, ui: uiOf() };
		rememberSession(session);
		await emit(host.handlers, "before_agent_start", { systemPrompt: [] }, ready);

		const display = station.displayPort();
		expect(display).not.toBeNull();
		expect(typeof display.attach).toBe("function");
		expect(typeof display.request).toBe("function");
		// The second lookup must return the same station, now with a display.
		expect(wired.engine.station(ready)).toBe(station);
	});
});

function childSessionOf(id) {
	return {
		messages: [],
		agent: { id, state: { messages: [], stopReason: "aborted" } },
		prompt: async () => {},
	};
}

function displayOf() {
	const attached = [];
	const port = {
		rootWait() {},
		request() {},
		attach(label, child) {
			attached.push({ label, child });
			return () => {};
		},
		activeTools: 0,
	};
	return { port, attached };
}

function resolvedDisplayOf(identity) {
	if (!identity) return null;
	const value = identity.displayHolder ?? identity.display;
	if (typeof value === "function") return value();
	if (value && typeof value === "object" && "current" in value) return value.current;
	return value ?? null;
}

async function spawnBeforeDisplay() {
	const wiring = createForkWiring();
	const station = Object.create(SessionStation.prototype);
	station.state = { brackets: null };
	const sessions = [];
	let releaseFirst = null;
	const attached = attachForkPorts(station, wiring, {
		conversationKey: "ui-init-late-child",
		createSession: async (spec) => {
			const session = childSessionOf(`agent-${spec.forkId}`);
			// The first child stays suspended at its prompt, so the display
			// arrives while the session is alive. The stop reason ends the
			// spawner's return-nudge loop after the gate is released.
			if (sessions.length === 0) {
				session.prompt = () => new Promise((resolve) => { releaseFirst = resolve; });
			}
			sessions.push(session);
			return { ok: true, session };
		},
	});
	expect(station.displayPort()).toBeNull();
	const registered = registerFork(attached.ledger, {
		forkId: "child-before-ui",
		ownerId: "root",
		levelKey: "root|0|0",
		fsm: "late display",
		depth: 0,
	});
	expect(registered.ok).toBe(true);
	station.childSpawnPort()({
		forkId: "child-before-ui",
		childDepth: 1,
		fsm: "late display",
		receipt: "child receipt",
		parentOwnerId: "root",
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(sessions).toHaveLength(1);

	const display = displayOf();
	station.setDisplayPort(display.port);
	await new Promise((resolve) => setTimeout(resolve, 10));
	return { wiring, station, sessions, display, releaseFirst: () => releaseFirst?.() };
}

async function coldStation(id) {
	const host = hostOf();
	const manager = managerOf(id);
	const session = sessionOf(manager);
	const cold = { sessionManager: manager, hasUI: false };
	const wired = await activate(host.pi, {});
	const station = wired.engine.station(cold);
	return { host, manager, session, wired, station };
}

describe("a child spawned before the UI appears", () => {
	test("keeps a live display for the existing child and the next spawn", async () => {
		const { wiring, station, sessions, display, releaseFirst } = await spawnBeforeDisplay();
		const childIdentity = identityOf(wiring.registry, "child-before-ui");
		expect(resolvedDisplayOf(childIdentity)).toBe(display.port);

		// The child station receives the identity's display value, which may be
		// a live holder. A holder must resolve to its current port, never leak
		// through as the display object itself.
		const childStation = Object.create(SessionStation.prototype);
		childStation.state = { brackets: null };
		childStation.persist = () => {};
		attachForkPorts(childStation, wiring, {
			identity: childIdentity,
			display: childIdentity?.displayHolder ?? childIdentity?.display ?? null,
			conversationKey: "ui-init-late-child",
		});
		expect(childStation.displayPort()).toBe(display.port);

		const next = registerFork(station.forkLedgerPort(), {
			forkId: "child-after-ui",
			ownerId: "root",
			levelKey: "root|0|1",
			fsm: "late display next",
			depth: 0,
		});
		expect(next.ok).toBe(true);
		station.childSpawnPort()({
			forkId: "child-after-ui",
			childDepth: 1,
			fsm: "late display next",
			receipt: "child receipt",
			parentOwnerId: "root",
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(sessions).toHaveLength(2);
		expect(display.attached.some((entry) => entry.child === sessions[0])).toBe(true);
		expect(display.attached.some((entry) => entry.child === sessions[1])).toBe(true);
		releaseFirst();
	});

	test("a child session created before the UI is attached when the display arrives", async () => {
		const { sessions, display, releaseFirst } = await spawnBeforeDisplay();
		expect(display.attached.some((entry) => entry.child === sessions[0])).toBe(true);
		releaseFirst();
	});
});

describe("a later context after a cold attach", () => {
	test("enables the display from an explicit ctx session without prior capture", async () => {
		const { wired, station, manager, session } = await coldStation("ui-init-explicit-session");
		expect(station.displayPort()).toBeNull();
		const ready = { sessionManager: manager, hasUI: true, ui: uiOf(), session };
		expect(wired.engine.station(ready)).toBe(station);
		expect(station.displayPort()).not.toBeNull();
	});

	test("a headless later ctx does not clear an existing display", async () => {
		const { wired, station, manager, session } = await coldStation("ui-init-headless");
		const ready = { sessionManager: manager, hasUI: true, ui: uiOf(), session };
		wired.engine.station(ready);
		const display = station.displayPort();
		expect(display).not.toBeNull();
		const headless = { ...ready, hasUI: false, ui: undefined };
		expect(wired.engine.station(headless)).toBe(station);
		expect(station.displayPort()).toBe(display);
	});
});

describe("a grandchild spawned before the UI appears", () => {
	test("is attached when the root display arrives", async () => {
		const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
		const wiring = createForkWiring();
		const root = Object.create(SessionStation.prototype);
		root.state = { brackets: null };
		root.persist = () => {};
		const sessions = [];
		const releases = [];
		const createPendingSession = async (spec) => {
			const session = childSessionOf(`agent-${spec.forkId}`);
			// Keep the prompt pending so the spawn ticket stays alive until the
			// display arrives; a resolved prompt detaches the queued display.
			session.prompt = () => new Promise((resolve) => { releases.push(resolve); });
			sessions.push(session);
			return { ok: true, session };
		};
		const attached = attachForkPorts(root, wiring, {
			conversationKey: "ui-init-grandchild",
			createSession: createPendingSession,
		});
		expect(root.displayPort()).toBeNull();

		const childRegistered = registerFork(attached.ledger, {
			forkId: "child-before-ui",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "grandchild display",
			depth: 0,
		});
		expect(childRegistered.ok).toBe(true);
		root.childSpawnPort()({
			forkId: "child-before-ui",
			childDepth: 1,
			fsm: "grandchild display",
			receipt: "child receipt",
			parentOwnerId: "root",
		});
		await settle();
		expect(sessions).toHaveLength(1);

		const childIdentity = identityOf(wiring.registry, "child-before-ui");
		expect(childIdentity).toBeTruthy();
		const childStation = Object.create(SessionStation.prototype);
		childStation.state = { brackets: null };
		childStation.persist = () => {};
		attachForkPorts(childStation, wiring, {
			identity: childIdentity,
			display: childIdentity?.displayHolder ?? childIdentity?.display ?? null,
			conversationKey: "ui-init-grandchild",
			createSession: createPendingSession,
		});
		expect(childStation.displayPort()).toBeNull();

		const grandRegistered = registerFork(childStation.forkLedgerPort(), {
			forkId: "grand-before-ui",
			ownerId: "child-before-ui",
			levelKey: "root|0|0|0",
			fsm: "grandchild display",
			depth: 0,
		});
		expect(grandRegistered.ok).toBe(true);
		childStation.childSpawnPort()({
			forkId: "grand-before-ui",
			childDepth: 2,
			fsm: "grandchild display",
			receipt: "grandchild receipt",
			parentOwnerId: "child-before-ui",
		});
		await settle();
		expect(sessions).toHaveLength(2);

		const display = displayOf();
		root.setDisplayPort(display.port);
		await settle();

		const childSession = sessions.find((session) => session.agent.id === "agent-child-before-ui");
		const grandSession = sessions.find((session) => session.agent.id === "agent-grand-before-ui");
		expect(childSession).toBeTruthy();
		expect(grandSession).toBeTruthy();
		expect(display.attached.some((entry) => entry.child === childSession)).toBe(true);
		expect(display.attached.some((entry) => entry.child === grandSession)).toBe(true);
		expect(childStation.displayPort()).toBe(display.port);
		for (const release of releases) release();
		await settle();
	});
});
