// The bridge has one synchronous aggregate root and four pure helpers. The
// station must commit its own state before any ticket runs, or a ticket's
// synchronous prefix observes a half-updated snapshot. The ledger must settle
// exactly once, so a late answer from the other surface is refused.

import { afterEach, expect, test } from "bun:test";

const browserGlobals = ["WebSocket", "window", "location", "history", "sessionStorage"];
let savedGlobals;
let activeClient;
let activeSocket;

afterEach(() => {
	// BridgeClient exposes no production close(). A 1008 close releases pending
	// submissions/commands without scheduling a reconnect, so no timer survives
	// into the next test file in the shared Bun process.
	try {
		activeSocket?.onclose?.({ code: 1008 });
	} catch {
		// The test already closed it.
	}
	activeSocket = undefined;
	activeClient = undefined;
	if (!savedGlobals) return;
	for (const [name, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else delete globalThis[name];
	}
	savedGlobals = undefined;
});

const RACE = "../../host-omp-ui/src/station/domain/interaction-race.mjs";
const SURFACE = "../../host-omp-ui/src/station/domain/surface-fence.mjs";
const CODEC = "../../host-omp-ui/src/station/domain/protocol-codec.mjs";
const STATION = "../../host-omp-ui/src/station/ui-bridge-station.mjs";

class FakeSocket {
	static OPEN = 1;
	static last;
	constructor() { this.readyState = 1; this.sent = []; FakeSocket.last = this; }
	send(data) { this.sent.push(JSON.parse(data)); }
	close() { this.readyState = 3; }
}
async function connectClient() {
	savedGlobals = browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
	FakeSocket.last = undefined;
	globalThis.WebSocket = FakeSocket;
	globalThis.window = globalThis;
	globalThis.location = { search: "?token=t", href: "http://x/?token=t", origin: "http://x", protocol: "http:" };
	globalThis.history = { replaceState() {} };
	globalThis.sessionStorage = { getItem: () => null, setItem() {} };
	const { createBridgeClient } = await import("../../host-omp-ui/web/src/protocol/client.ts");
	const client = createBridgeClient();
	const socket = FakeSocket.last;
	socket.onopen();
	activeClient = client;
	activeSocket = socket;
	return { client, socket };
}

test("browser submit clears only after its matching receipt", async () => {
	const { client, socket } = await connectClient();
	const first = client.submitCommand({ text: "one" });
	const second = client.submitCommand({ text: "two" });
	const [a, b] = socket.sent.map((frame) => frame.payload.requestId);
	socket.onmessage({ data: JSON.stringify({ type: "command.result", requestId: b, ok: true }) });
	await second;
	socket.onmessage({ data: JSON.stringify({ type: "command.result", requestId: a, ok: true }) });
	await first;
});

test("browser submit rejects only the failed receipt", async () => {
	const { client, socket } = await connectClient();
	const failed = client.submitCommand({ text: "bad" });
	const good = client.submitCommand({ text: "ok" });
	const [badId, goodId] = socket.sent.map((frame) => frame.payload.requestId);
	socket.onmessage({ data: JSON.stringify({ type: "command.result", requestId: badId, ok: false, code: "rejected" }) });
	await expect(failed).rejects.toThrow("rejected");
	socket.onmessage({ data: JSON.stringify({ type: "command.result", requestId: goodId, ok: true }) });
	await good;
});

test("browser disconnect rejects pending submits and does not retry them", async () => {
	const { client, socket } = await connectClient();
	const pending = client.submitCommand({ text: "uncertain" });
	socket.onclose({ code: 4401 });
	await expect(pending).rejects.toThrow("连接断开");
	expect(socket.sent).toHaveLength(1);
});

test("offline submit rejects without queueing the prompt", async () => {
	const { client, socket } = await connectClient();
	socket.readyState = 3;
	await expect(client.submitCommand({ text: "offline" })).rejects.toThrow("未连接");
	expect(socket.sent).toHaveLength(0);
});

test("currentModel normalizes every host model shape to provider/id", async () => {
	const { createSessionAdapter } = await import("../../host-omp-ui/src/host/session-adapter.mjs");
	const cases = [
		["provider/model", { provider: "provider", id: "model" }],
		[{ provider: "p", modelId: "m" }, { provider: "p", id: "m" }],
		[{ model: "p/m" }, { provider: "p", id: "m" }],
		[{ id: "p/m" }, { provider: "p", id: "m" }],
		[{ id: "m" }, { provider: "", id: "m" }],
		[null, null],
	];
	for (const [raw, expected] of cases) {
		const adapter = createSessionAdapter({ ctx: { models: { current: () => raw } } });
		expect(adapter.currentModel()).toEqual(expected);
	}
});

test("model meta keeps provider/id through station snapshot", async () => {
	const { createUiBridgeStation } = await import("../../host-omp-ui/src/station/ui-bridge-station.mjs");
	const station = createUiBridgeStation({ capabilities: {} });
	const model = { provider: "provider", id: "model" };
	station.onMetaUpdate({ model });
	expect(station.snapshot().meta.model).toEqual(model);
});

test("model selection resolves the host model before passing it to omp", async () => {
	const { createSessionAdapter } = await import("../../host-omp-ui/src/host/session-adapter.mjs");
	const model = { provider: "provider", id: "model" };
	let selected;
	const adapter = createSessionAdapter({
		ctx: { models: { resolve: (spec) => spec === "provider/model" ? model : undefined } },
		pi: { setModel: (value) => { selected = value; return true; } },
	});
	expect(await adapter.setModel("provider", "model")).toBe(true);
	expect(selected).toBe(model);
	await expect(adapter.setModel("provider", "missing")).rejects.toThrow("Model not found");
});

async function load(path) {
	return import(path);
}

function findNode(node, id) {
	if (!node) return undefined;
	if (node.id === id) return node;
	for (const child of node.children ?? []) {
		const found = findNode(child, id);
		if (found) return found;
	}
	return undefined;
}

test("web draft updates are broadcast as well as applied to the editor", async () => {
	const { buildBridgeCapabilities } = await import("../../host-omp-ui/src/activation/tickets.mjs");
	const frames = [];
	const drafts = [];
	const { dispatch } = buildBridgeCapabilities({ tickets: {
		broadcastFrameTicket: (frame) => frames.push(frame),
		syncEditorDraftTicket: (draft) => drafts.push(draft),
	} });
	dispatch({ type: "syncEditorDraft", payload: { text: "x", origin: "web", rev: 1 } });
	expect(frames).toEqual([{ type: "draft.sync", text: "x", origin: "web", rev: 1 }]);
	expect(drafts[0].text).toBe("x");
});

test("submit receipts go only to the requesting client and report ticket failure", async () => {
	const { createUiBridgeStation } = await load(STATION);
	const { buildBridgeCapabilities } = await import("../../host-omp-ui/src/activation/tickets.mjs");
	const receipts = [];
	const capabilities = buildBridgeCapabilities({ tickets: {
		submitComposerTicket: async ({ text }) => text === "bad" ? { ok: false, code: "rejected" } : { ok: true },
		sendClientFrameTicket: async (receipt) => receipts.push(receipt),
	} });
	const station = createUiBridgeStation({ capabilities });
	station.onClientCommand("client-a", { type: "composer.submit", requestId: "one", text: "ok" });
	station.onClientCommand("client-b", { type: "composer.submit", requestId: "two", text: "bad" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(receipts).toContainEqual({ clientId: "client-a", frame: { type: "command.result", requestId: "one", ok: true, code: undefined } });
	expect(receipts).toContainEqual({ clientId: "client-b", frame: { type: "command.result", requestId: "two", ok: false, code: "rejected" } });
});

test("switching sessions replaces the live transcript and queue", async () => {
	const { createUiBridgeStation } = await load(STATION);
	const station = createUiBridgeStation({ capabilities: {} });
	station.onSessionHydrate({ id: "old" }, [{ type: "message", id: "old-message", message: { role: "user", content: "old" } }]);
	station.onQueueUpdate({ steering: ["old queued"] });
	station.onSessionSwitch({ cwd: "/work", sessionManager: {
		getSessionId: () => "new",
		getBranch: () => [{ type: "message", id: "new-message", message: { role: "user", content: "new" } }],
	} });
	expect(station.snapshot().session.id).toBe("new");
	expect(station.snapshot().messages.map((message) => message.id)).toEqual(["new-message"]);
	expect(station.snapshot().queue.steering).toEqual([]);
});

test("the interaction ledger settles once, first writer wins", async () => {
	const { createInteractionLedger, openInteraction, resolveInteraction, closeInteraction, listOpenInteractions } =
		await load(RACE);
	const ledger = createInteractionLedger();
	expect(openInteraction(ledger, { id: "r1", kind: "form", payload: { html: "<form></form>" } }).ok).toBe(true);
	expect(listOpenInteractions(ledger).map((item) => item.id)).toContain("r1");

	const web = resolveInteraction(ledger, "r1", "web", { data: { a: "1" } });
	expect(web).toEqual({ accepted: true, winner: "web" });
	expect(listOpenInteractions(ledger)).toEqual([]);
	const lateTui = resolveInteraction(ledger, "r1", "tui", {});
	expect(lateTui).toMatchObject({ ok: false, code: "already_settled" });

	expect(openInteraction(ledger, { id: "r2", kind: "approve", payload: {} }).ok).toBe(true);
	expect(resolveInteraction(ledger, "r2", "tui", "once")).toEqual({ accepted: true, winner: "tui" });
	expect(resolveInteraction(ledger, "r2", "web", "deny")).toMatchObject({ ok: false, code: "already_settled" });

	expect(resolveInteraction(ledger, "missing", "web", {})).toMatchObject({ ok: false, code: "not_found" });
	closeInteraction(ledger, "r1");
	expect(listOpenInteractions(ledger).map((item) => item.id)).not.toContain("r1");
	expect(resolveInteraction(ledger, "r1", "web", {})).toMatchObject({ ok: false, code: "not_found" });
});

test("surface ops maintain a small document and summarize frames", async () => {
	const { createEmptyDocument, applyTspOpsToDocument, summarizeSurfaceFrame } = await load(SURFACE);
	let doc = createEmptyDocument();
	doc = applyTspOpsToDocument(doc, [
		{ op: "add", parent: "root", node: { id: "a", kind: "text", text: "hello" } },
		{ op: "add", parent: "root", node: { id: "b", kind: "card", children: [] } },
		{ op: "add", parent: "b", node: { id: "c", kind: "text", text: "child" } },
		{ op: "set", id: "a", props: { tone: "muted" } },
		{ op: "text", id: "a", text: "hi" },
		{ op: "focus", id: "a" },
		{ op: "settle", id: "c" },
		{ op: "move", id: "c", parent: "root", index: 0 },
	]);
	const a = findNode(doc.root, "a");
	expect(a.text).toBe("hi");
	expect(a.props.tone).toBe("muted");
	expect(doc.focus).toBe("a");
	expect(doc.settled).toContain("c");
	expect(doc.root.children[0].id).toBe("c");

	doc = applyTspOpsToDocument(doc, [
		{ op: "add", parent: "a", node: { id: "d", kind: "text", text: "d" } },
		{ op: "add", parent: "a", node: { id: "e", kind: "text", text: "e" } },
		{ op: "splice", id: "a", index: 1, remove: 1, items: [{ id: "f", kind: "text", text: "f" }] },
	]);
	expect(findNode(doc.root, "a").children.map((child) => child.id)).toEqual(["d", "f"]);

	doc = applyTspOpsToDocument(doc, [{ op: "del", id: "b" }]);
	expect(findNode(doc.root, "b")).toBeUndefined();

	const summary = summarizeSurfaceFrame({ sf: "s:1", s: 3, ops: [{ op: "add" }, { op: "set" }] });
	expect(summary).toMatchObject({ surfaceId: "s:1", seq: 3, opCount: 2 });
	expect(summary.kinds).toEqual(["add", "set"]);
});

test("positional TspOp tuples from the real Reconciler reduce as documents", async () => {
	const { createEmptyDocument, applyTspOpsToDocument, summarizeSurfaceFrame } = await load(SURFACE);
	const doc = applyTspOpsToDocument(createEmptyDocument(), [
		["add", "main", "s:web", null, { id: "main", k: "col" }],
		["add", "dock", "s:web", null, { id: "dock", k: "col" }],
		["add", "a", "main", null, { id: "a", k: "text", p: { text: "hello" } }],
		["text", "a", "append", " world"],
		["splice", "a", 0, 5, "Hi"],
		["set", "a", { tone: "muted" }],
		["add", "b", "dock", "a", { id: "b", k: "text", p: { text: "b" } }],
		["move", "a", "dock", null],
		["focus", "a"],
		["settle", "a"],
		["reveal", "a", "nearest"],
		["scroll", "a", "line-down"],
	]);

	const a = findNode(doc.root, "a");
	const b = findNode(doc.root, "b");
	const main = findNode(doc.root, "main");
	const dock = findNode(doc.root, "dock");
	expect(a.text).toBe("Hi world");
	expect(a.props).toMatchObject({ text: "Hi world", tone: "muted" });
	expect(doc.focus).toBe("a");
	expect(doc.settled).toContain("a");
	expect(main.children.map((child) => child.id)).toEqual([]);
	expect(dock.children.map((child) => child.id)).toEqual(["b", "a"]);
	expect(b.text).toBe("b");

	// `detachLive` re-adds regions; a re-add must replace, not duplicate.
	const next = applyTspOpsToDocument(doc, [["add", "main", "s:web", null, { id: "main", k: "col" }]]);
	const mains = next.root.children.filter((child) => child.id === "main");
	expect(mains).toHaveLength(1);
	expect(findNode(next.root, "dock").children.map((child) => child.id)).toEqual(["b", "a"]);

	const flat = applyTspOpsToDocument(createEmptyDocument(), [
		{ op: "add", id: "flat", parent: "root", kind: "text", props: { text: "flat" } },
	]);
	expect(findNode(flat.root, "flat")).toMatchObject({ kind: "text", text: "flat" });

	const summary = summarizeSurfaceFrame({
		sf: "s:web",
		s: 2,
		ops: [["add", "x", "main", null, { id: "x", k: "text" }], ["del", "x"]],
	});
	expect(summary.kinds).toEqual(["add", "del"]);
});

test("client commands fail closed and server frames carry a sequence", async () => {
	const { parseClientCommand, encodeServerFrame } = await load(CODEC);
	expect(parseClientCommand('{"type":"composer.submit","text":"hi"}')).toMatchObject({
		ok: true,
		type: "composer.submit",
		payload: { text: "hi" },
	});
	expect(parseClientCommand('{"type":"composer.draft","text":""}')).toMatchObject({ ok: true, payload: { text: "" } });
	expect(parseClientCommand('{"type":"composer.submit","text":""}')).toMatchObject({ ok: false, code: "invalid_payload" });
	expect(parseClientCommand("{")).toMatchObject({ ok: false, code: "invalid_json" });
	expect(parseClientCommand('{"type":"nope"}')).toMatchObject({ ok: false, code: "unknown_type" });
	expect(parseClientCommand('{"type":"composer.submit"}')).toMatchObject({
		ok: false,
		code: "invalid_payload",
	});

	const frame = encodeServerFrame("state.patch", { model: "x" }, 7);
	expect(frame).toMatchObject({ type: "state.patch", payload: { model: "x" }, seq: 7 });
});

test("the station commits before dispatch and stays synchronous", async () => {
	const { createUiBridgeStation } = await load(STATION);
	const events = [];
	const observed = [];
	const station = createUiBridgeStation({
		cwd: "/tmp/project",
		capabilities: {
			dispatch: (event) => {
				events.push(event);
				observed.push(station.snapshot());
			},
		},
	});

	const snapshot = station.snapshot();
	expect(snapshot).not.toBeInstanceOf(Promise);
	expect(snapshot).toHaveProperty("pendingInteractions");

	const opened = station.openInteraction({ id: "r1", kind: "form", payload: { html: "<form></form>" } });
	expect(opened).not.toBeInstanceOf(Promise);
	expect(station.snapshot().pendingInteractions.map((item) => item.id)).toContain("r1");
	// The tail dispatch sees the committed state, never the pre-commit one.
	expect(observed.at(-1).pendingInteractions.map((item) => item.id)).toContain("r1");

	expect(station.resolveInteraction("r1", "web", { data: {} })).toEqual({ accepted: true, winner: "web" });
	expect(station.resolveInteraction("r1", "tui", {})).toMatchObject({ ok: false, code: "already_settled" });
});

test("draft sync drops an A->B->A echo across origins", async () => {
	const { createUiBridgeStation } = await load(STATION);
	const events = [];
	const station = createUiBridgeStation({
		cwd: "/tmp/project",
		capabilities: { dispatch: (event) => events.push(event) },
	});

	station.applyDraft({ source: "tui", text: "/" });
	const synced = station.applyDraft({ source: "web", text: "/x" });
	expect(synced.rev).toBe(2);
	// The host rewrites the draft while reacting to `/`; the editor then echoes
	// the previous value back. That echo must not open a new revision.
	const echo = station.applyDraft({ source: "tui", text: "/" });
	expect(echo.rev).toBe(2);
	expect(events.filter((event) => event.type === "draft.sync")).toHaveLength(1);
});

test("draft sync still accepts a real edit after the same cross-origin pair", async () => {
	const { createUiBridgeStation } = await load(STATION);
	const events = [];
	const station = createUiBridgeStation({
		cwd: "/tmp/project",
		capabilities: { dispatch: (event) => events.push(event) },
	});

	station.applyDraft({ source: "tui", text: "/" });
	station.applyDraft({ source: "web", text: "/x" });
	station.applyDraft({ source: "tui", text: "/" });
	station.applyDraft({ source: "tui", text: "/h" });
	expect(station.applyDraft({ source: "web", text: "/he" }).rev).toBe(4);
	expect(events.some((event) => event.type === "syncEditorDraft" && event.payload.text === "/he")).toBe(true);
});

test("draft sync is revisioned, anti-echo, and submits through the composer path", async () => {
	const { createUiBridgeStation } = await load(STATION);
	const events = [];
	const station = createUiBridgeStation({
		cwd: "/tmp/project",
		capabilities: { dispatch: (event) => events.push(event) },
	});

	const first = station.applyDraft({ source: "tui", text: "hello" });
	expect(first.rev).toBe(1);
	expect(events.filter((event) => event.type === "draft.sync")).toHaveLength(1);

	const beforeEcho = events.length;
	station.applyDraft({ source: "web", text: "hello" });
	expect(events.length).toBe(beforeEcho);

	const second = station.applyDraft({ source: "web", text: "hello!" });
	expect(second.rev).toBe(2);
	expect(
		events.some((event) => event.type === "syncEditorDraft" && event.payload.text === "hello!"),
	).toBe(true);

	expect(station.submitComposer({ text: "hi", mode: "steer" })).not.toBeInstanceOf(Promise);
	expect(events.some((event) => event.type === "submitComposer" && event.payload.mode === "steer")).toBe(true);

	station.abort();
	expect(events.some((event) => event.type === "abort")).toBe(true);
	station.setModel({ provider: "p", modelId: "m" });
	expect(events.some((event) => event.type === "setModel")).toBe(true);
	station.setThinking({ level: "high" });
	expect(events.some((event) => event.type === "setThinking" && event.payload.level === "high")).toBe(true);
	station.setMode({ mode: "plan", action: "enter" });
	expect(events.some((event) => event.type === "setMode" && event.payload.mode === "plan")).toBe(true);
	station.applySurfaceEvent({ ev: "send", sf: "s:1", id: "x", text: "hi" });
	expect(events.some((event) => event.type === "surfaceEvent" && event.payload.ev === "send")).toBe(true);
	station.applySurfaceKeys({ data: "\x1b[A" });
	expect(events.some((event) => event.type === "surfaceKeys")).toBe(true);
});
