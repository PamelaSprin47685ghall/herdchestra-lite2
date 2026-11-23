import { describe, test, expect } from "bun:test";

import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";
import { buildBridgeCapabilities } from "../../host-omp-ui/src/activation/tickets.mjs";
import { parseClientCommand } from "../../host-omp-ui/src/station/domain/protocol-codec.mjs";
import { createManagerClient } from "../../host-omp-ui/src/host/manager-client.mjs";

// Red contract for the draft path and terminal sync.
//
// The browser tracks every `composer.draft` it sends with a 30s timer and
// expects exactly one `command.result` carrying the same requestId. The
// station dropped { clientId, requestId } when it translated the command into
// `syncEditorDraft`, so the debounce answered nothing and the UI reported
// "操作超时，结果未知". The same silence hid the terminal result: a synced
// draft and a host with no captured editor were indistinguishable.
//
// A command that changes no state must still answer. Silence is the bug, not
// the absence of an editor.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeHarness({ syncEditorDraftTicket } = {}) {
	const sent = [];
	const broadcast = [];
	const applied = [];
	const dispatched = [];
	const tickets = {
		sendClientFrameTicket: async ({ clientId, frame }) => {
			sent.push({ clientId, frame });
			return { ok: true };
		},
		broadcastFrameTicket: async (frame) => {
			broadcast.push(frame);
			return { ok: true };
		},
		submitComposerTicket: async () => ({ ok: true }),
		abortSessionTicket: async () => ({ ok: true }),
		syncEditorDraftTicket:
			syncEditorDraftTicket ??
			(async ({ text }) => {
				applied.push(text);
				return { ok: true };
			}),
	};
	const capabilities = buildBridgeCapabilities({
		tickets,
		diagnostics: { record() {} },
	});
	const station = createUiBridgeStation({
		capabilities: {
			dispatch: (event) => {
				dispatched.push(event);
				capabilities.dispatch(event);
			},
		},
	});
	return { station, sent, broadcast, applied, dispatched };
}

const results = (sent) =>
	sent.filter(({ frame }) => frame?.type === "command.result");

describe("client command envelope", () => {
	test("the codec keeps clientId and requestId for draft and submit", () => {
		const draft = parseClientCommand({
			type: "composer.draft",
			text: "你好",
			clientId: "c1",
			requestId: "r1",
		});
		expect(draft.ok).toBe(true);
		expect(draft.payload).toMatchObject({
			text: "你好",
			clientId: "c1",
			requestId: "r1",
		});
		const submit = parseClientCommand({
			type: "composer.submit",
			text: "你好",
			clientId: "c1",
			requestId: "r2",
		});
		expect(submit.ok).toBe(true);
		expect(submit.payload).toMatchObject({
			text: "你好",
			clientId: "c1",
			requestId: "r2",
		});
	});
});

describe("draft sync carries its envelope end to end", () => {
	test("a web draft updates the station and hands its envelope to the ticket", () => {
		const { station, dispatched } = makeHarness();
		station.onClientCommand("c1", {
			type: "composer.draft",
			text: "你好",
			clientId: "c1",
			requestId: "r1",
		});
		expect(station.snapshot().draft).toMatchObject({
			text: "你好",
			origin: "web",
		});
		const sync = dispatched.find((event) => event.type === "syncEditorDraft");
		expect(sync?.payload).toMatchObject({
			text: "你好",
			origin: "web",
			clientId: "c1",
			requestId: "r1",
		});
	});

	test("a synced draft answers the origin once and applies to the editor", async () => {
		const { station, sent, applied } = makeHarness();
		station.onClientCommand("c1", {
			type: "composer.draft",
			text: "你好",
			clientId: "c1",
			requestId: "r1",
		});
		await flush();
		const answered = results(sent);
		expect(answered).toHaveLength(1);
		expect(answered[0].clientId).toBe("c1");
		expect(answered[0].frame).toMatchObject({
			type: "command.result",
			requestId: "r1",
			ok: true,
		});
		expect(applied).toEqual(["你好"]);
	});

	test("an unchanged draft still answers, without rewriting the editor", async () => {
		const { station, sent, applied } = makeHarness();
		const command = (requestId) => ({
			type: "composer.draft",
			text: "你好",
			clientId: "c1",
			requestId,
		});
		station.onClientCommand("c1", command("r1"));
		await flush();
		station.onClientCommand("c1", command("r2"));
		await flush();
		const answered = results(sent);
		expect(answered.map(({ frame }) => frame.requestId)).toEqual(["r1", "r2"]);
		expect(answered.every(({ frame }) => frame.ok === true)).toBe(true);
		expect(applied).toEqual(["你好"]);
	});

	test("a host without an editor answers no-editor instead of staying silent", async () => {
		const { station, sent } = makeHarness({
			syncEditorDraftTicket: async () => ({ ok: false, code: "no-editor" }),
		});
		station.onClientCommand("c1", {
			type: "composer.draft",
			text: "你好",
			clientId: "c1",
			requestId: "r1",
		});
		await flush();
		const answered = results(sent);
		expect(answered).toHaveLength(1);
		expect(answered[0].frame).toMatchObject({
			type: "command.result",
			requestId: "r1",
			ok: false,
			code: "no-editor",
		});
	});

	test("a TUI-origin draft stays uncorrelated and answers nothing", async () => {
		const { station, sent } = makeHarness();
		station.onTuiDraftChanged({ text: "from tui" });
		await flush();
		expect(results(sent)).toHaveLength(0);
	});
});

describe("submit receipts stay correlated", () => {
	test("a web submit answers exactly once with its requestId", async () => {
		const { station, sent } = makeHarness();
		station.onClientCommand("c1", {
			type: "composer.submit",
			text: "跑测试",
			requestId: "r9",
		});
		await flush();
		const answered = results(sent);
		expect(answered).toHaveLength(1);
		expect(answered[0]).toMatchObject({
			clientId: "c1",
			frame: { type: "command.result", requestId: "r9", ok: true },
		});
	});
});

describe("manager client failure receipts", () => {
	test("a rejected handler answers its origin with a failed result", async () => {
		const realFetch = globalThis.fetch;
		const realWebSocket = globalThis.WebSocket;
		class FakeSocket {
			static OPEN = 1;
			static last;
			constructor() {
				this.readyState = 1;
				this.sent = [];
				FakeSocket.last = this;
				queueMicrotask(() => this.onopen?.());
			}
			send(data) { this.sent.push(JSON.parse(String(data))); }
			close() { this.readyState = 3; }
		}
		try {
			globalThis.WebSocket = FakeSocket;
			globalThis.fetch = async () => ({ ok: true, json: async () => ({ name: "herd-omp-ui-manager" }) });
			const client = await createManagerClient({
				preferredPort: 39999,
				token: "t",
				onBootstrap: async () => ({ session: { id: "s" } }),
				onClientCommand: async () => { throw new Error("boom"); },
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			FakeSocket.last.onmessage({ data: JSON.stringify({ type: "manager.command", clientId: "c1", command: { type: "composer.submit", requestId: "r1", payload: { text: "x" } } }) });
			let receipt;
			for (let attempt = 0; attempt < 50 && !receipt; attempt += 1) {
				await flush();
				receipt = FakeSocket.last.sent.find((frame) => frame.type === "agent.client_frame" && frame.frame?.type === "command.result");
			}
			expect(receipt).toMatchObject({ clientId: "c1", frame: { requestId: "r1", ok: false, code: "failed" } });
			await client.close();
		} finally {
			globalThis.fetch = realFetch;
			globalThis.WebSocket = realWebSocket;
		}
	});
});

describe("browser-shaped draft frames and real terminal writes", () => {
	test("a manager-normalized browser frame answers command.result", async () => {
		const { station, sent } = makeHarness();
		const frame = {
			type: "composer.draft",
			ts: 1,
			payload: { text: "你好", requestId: "r-frame" },
		};
		// manager/server.mjs normalizes an inbound browser frame exactly this way
		// before forwarding manager.command to the agent.
		const command = frame.payload ? { ...frame.payload, ...frame, payload: frame.payload } : frame;
		station.onClientCommand("c-browser", command);
		await flush();
		const answered = results(sent);
		expect(answered).toHaveLength(1);
		expect(answered[0]).toMatchObject({
			clientId: "c-browser",
			frame: { type: "command.result", requestId: "r-frame", ok: true },
		});
	});

	test("a captured editor that only exposes setDraft is written and verified", async () => {
		const { createBridgeEditorClass } = await import("../../host-omp-ui/src/host/tui-fence.mjs");
		class DraftOnly {
			constructor() {
				this.text = "";
			}
			setDraft(text) {
				this.text = text;
			}
			getText() {
				return this.text;
			}
		}
		const BridgeEditor = createBridgeEditorClass(DraftOnly);
		const editor = new BridgeEditor({ draft() {} });
		expect(editor.applyRemoteDraft({ text: "终端同步" })).toBe(true);
		expect(editor.getText()).toBe("终端同步");

		class Inert {
			getText() {
				return "";
			}
		}
		const InertEditor = new (createBridgeEditorClass(Inert))({ draft() {} });
		expect(InertEditor.applyRemoteDraft({ text: "终端同步" })).toBe(false);
	});
});
