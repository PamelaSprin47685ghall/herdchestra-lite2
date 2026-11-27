import { describe, test, expect } from "bun:test";

const TICKETS = "../../host-omp-ui/src/host/tickets/host-tickets.mjs";
const BRIDGE = "../../host-omp-ui/src/host/tickets/interaction-bridge.mjs";

async function load() {
	try {
		const [tickets, bridge] = await Promise.all([import(TICKETS), import(BRIDGE)]);
		return { createHostTickets: tickets.createHostTickets, createUiBridge: bridge.createUiBridge };
	} catch (error) {
		throw new Error(`Red contract: ${TICKETS} is not implemented yet (${error.message})`);
	}
}

function makeStation() {
	const opens = [];
	const closes = [];
	const meta = [];
	const widgets = [];
	return {
		opens,
		closes,
		meta,
		widgets,
		openInteraction(request) {
			opens.push(request);
			return { ok: true };
		},
		closeInteraction(id) {
			closes.push(id);
		},
		onNotify() {},
		onMetaUpdate(patch) {
			meta.push(patch);
		},
		onWidgetUpdate(key, lines) {
			widgets.push([key, lines]);
		},
		onTuiDraftChanged() {},
	};
}

function makeBridge(station) {
	return { station, getServer: () => ({ clientCount: 1 }) };
}

test("a disabled native editor refuses submission without changing its draft or attachments", async () => {
	const { createHostTickets } = await load();
	const editor = {
		disableSubmit: true, text: "existing", pendingImages: [], pendingImageLinks: [], pendingTexts: [],
		getText() { return this.text; }, setText(text) { this.text = text; },
		insertText() { throw new Error("must not insert"); }, insertTextAttachment() { throw new Error("must not insert"); },
		submitRemote() { throw new Error("must not submit"); },
	};
	const tickets = createHostTickets({ getEditor: () => editor });
	for (const attachments of [[], [{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" }]]) {
		expect(await tickets.submitComposerTicket({ text: "new", attachments })).toMatchObject({ ok: false, code: "editor_not_ready" });
		expect(editor.text).toBe("existing");
		expect(editor.pendingImages).toEqual([]);
	}
});

test("submission applies image and text attachments to the native editor", async () => {
	const { createHostTickets } = await load();
	const editor = {
		pendingImages: [], pendingImageLinks: [], text: "",
		setText(text) { this.text = text; },
		getText() { return this.text; },
		insertText(text) { this.text += text; },
		insertTextAttachment(text, name) { this.attachment = { text, name }; this.text += "[text attachment]"; },
		submitRemote(text) { this.submitted = text; },
	};
	const tickets = createHostTickets({ getEditor: () => editor });
	const result = await tickets.submitComposerTicket({ text: "describe", attachments: [
		{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" },
		{ name: "a.txt", mimeType: "text/plain", data: "aGVsbG8=" },
	] });
	// Native submit returns void; it cannot confirm async acceptance.
	expect(result).toMatchObject({ ok: false, code: "submission_unconfirmed" });
	expect(editor.pendingImages).toEqual([{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
	expect(editor.attachment.text).toBe("hello");
	expect(editor.submitted).toBe("describe[Image #1][text attachment]");
	expect(editor.pendingImageLinks).toEqual([undefined]);
});

test("UTF-8 JSON documents are accepted, but binary PDFs are rejected", async () => {
	const { createHostTickets } = await load();
	const calls = [];
	const tickets = createHostTickets({ pi: { sendUserMessage: async (...args) => calls.push(args) } });
	expect((await tickets.submitComposerTicket({ mode: "followUp", attachments: [{ name: "a.json", mimeType: "application/json", data: "eyJvayI6dHJ1ZX0=" }] })).ok).toBe(true);
	expect(calls[0][0][0].text).toContain('{"ok":true}');
	expect(await tickets.submitComposerTicket({ mode: "followUp", attachments: [{ name: "a.pdf", mimeType: "application/pdf", data: "JVBERi0=" }] })).toMatchObject({ ok: false, code: "unsupported_attachment" });
});

test("a failed attachment insertion restores the existing draft and image lists", async () => {
	const { createHostTickets } = await load();
	const editor = {
		text: "original", pendingImages: [], pendingImageLinks: [], pendingTexts: [],
		setText(text) { this.text = text; }, getText() { return this.text; },
		insertText() { throw new Error("insert failed"); }, insertTextAttachment() {}, submit() {},
	};
	const tickets = createHostTickets({ getEditor: () => editor });
	const result = await tickets.submitComposerTicket({ text: "original", attachments: [
		{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" },
	] });
	expect(result.ok).toBe(false);
	expect(editor.text).toBe("original");
	expect(editor.pendingImages).toEqual([]);
	expect(editor.pendingImageLinks).toEqual([]);
});

test("attachment failure restores a draft whose cursor was at the start", async () => {
	const { createHostTickets } = await load();
	const editor = {
		text: "draft", cursor: "start", pendingImages: [], pendingImageLinks: [], pendingTexts: [],
		getText() { return this.text; }, getCursor() { return { line: 0, col: 0 }; },
		setText(text, options) { this.text = text; this.cursor = options?.cursor ?? "end"; },
		clearDraft() { this.text = ""; },
		insertTextAttachment() { throw new Error("failed"); }, submit() {},
	};
	const result = await createHostTickets({ getEditor: () => editor }).submitComposerTicket({ text: "draft", attachments: [{ name: "a.txt", mimeType: "text/plain", data: "aGVsbG8=" }] });
	expect(result.ok).toBe(false);
	expect(editor.text).toBe("draft");
	expect(editor.cursor).toBe("start");
});

test("failed text attachment insertion clears native atom state before restoring draft", async () => {
	const { createHostTickets } = await load();
	const editor = {
		text: "draft", pendingImages: [], pendingImageLinks: [], pendingTexts: [], atoms: [],
		getText() { return this.text; }, setText(text) { this.text = text; },
		clearDraft() { this.text = ""; this.pendingTexts = []; this.atoms = []; },
		insertTextAttachment(text) { this.pendingTexts.push(text); this.atoms.push(text); throw new Error("failed"); },
		submit() {},
	};
	const result = await createHostTickets({ getEditor: () => editor }).submitComposerTicket({ text: "draft", attachments: [{ name: "a.txt", mimeType: "text/plain", data: "aGVsbG8=" }] });
	expect(result.ok).toBe(false);
	expect(editor.text).toBe("draft");
	expect(editor.pendingTexts).toEqual([]);
	expect(editor.atoms).toEqual([]);
});

test("attachments cannot overwrite a different existing TUI draft", async () => {
	const { createHostTickets } = await load();
	const editor = { text: "existing", pendingImages: [], pendingImageLinks: [], pendingTexts: [], getText() { return this.text; }, setText(text) { this.text = text; }, insertText() {}, insertTextAttachment() {}, submit() {} };
	const tickets = createHostTickets({ getEditor: () => editor });
	const result = await tickets.submitComposerTicket({ text: "other", attachments: [{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" }] });
	expect(result).toMatchObject({ ok: false, code: "draft_conflict" });
	expect(editor.text).toBe("existing");
});

test("queued messages carry image and text attachments without mutating the editor", async () => {
	const { createHostTickets } = await load();
	const calls = [];
	const tickets = createHostTickets({ pi: { sendUserMessage: async (...args) => calls.push(args) }, getEditor: () => { throw new Error("editor must stay untouched"); } });
	for (const mode of ["steer", "followUp"]) {
		const result = await tickets.submitComposerTicket({ text: "look", mode, attachments: [
			{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" },
			{ name: "a.txt", mimeType: "text/plain", data: "aGVsbG8=" },
		] });
		expect(result.ok).toBe(true);
		expect(calls.at(-1)).toEqual([[{ type: "text", text: "look\n\nhello" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }], { deliverAs: mode }]);
	}
});

test("shutting down a bridge rejects pending interactions without answering them", async () => {
	const { createUiBridge } = await load();
	const station = makeStation();
	const bridge = createUiBridge(makeBridge(station));
	const pending = bridge.request("confirm", ["Confirm", "Continue?"]);
	const outcome = pending.then(() => null, (error) => error);
	bridge.cancel();
	const error = await outcome;
	expect(error).toBeInstanceOf(Error);
	expect(error.message).toContain("interaction cancelled");
	expect(station.closes).toEqual([station.opens[0].id]);
});

test("failed command tickets notify clients instead of disappearing", async () => {
	const { buildBridgeCapabilities } = await import("../../host-omp-ui/src/activation/tickets.mjs");
	const frames = [];
	const { dispatch } = buildBridgeCapabilities({ tickets: {
		setModelTicket: async () => ({ ok: false, code: "unknown_model" }),
		broadcastFrameTicket: (frame) => frames.push(frame),
	} });
	dispatch({ type: "setModel", payload: { provider: "p", modelId: "missing" } });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(frames).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
});

test("wiring hands the raw ticket result to the reconciler", async () => {
	const { buildBridgeCapabilities } = await import("../../host-omp-ui/src/activation/tickets.mjs");
	const seen = [];
	const frames = [];
	const result = { ok: false, code: "unknown_model", reported: { model: null } };
	const { dispatch } = buildBridgeCapabilities({
		tickets: {
			setModelTicket: async () => result,
			broadcastFrameTicket: (frame) => frames.push(frame),
		},
		onResult: (event, received) => {
			seen.push([event.type, received]);
			return { outcomes: [{ kind: "toast", level: "error", message: "reconciled" }] };
		},
	});
	dispatch({ type: "setModel", payload: { provider: "p", modelId: "missing" } });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(seen).toEqual([["setModel", result]]);
	expect(frames).toEqual([{ type: "toast", level: "error", message: "reconciled" }]);
});

describe("createUiBridge request payloads", () => {
	test("select keeps title, options, and selection flags", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));
		const pending = bridge.request("select", [
			"Pick one",
			["one", { label: "two", description: "second" }],
			{ initialIndex: 1, selectionMarker: "checkbox", checkedIndices: [1], markableCount: 2 },
		]);
		const opened = station.opens.at(-1);
		expect(opened.kind).toBe("select");
		expect(opened.payload).toMatchObject({
			title: "Pick one",
			initialIndex: 1,
			selectionMarker: "checkbox",
			checkedIndices: [1],
			markableCount: 2,
		});
		expect(opened.payload.options).toEqual([
			{ label: "one", value: "one" },
			{ label: "two", value: "two", description: "second" },
		]);
		expect(bridge.resolve(opened.id, { value: "two" }).value).toBe("two");
		await expect(pending).resolves.toBe("two");
	});

	test("checkbox select returns one toggle and accepts refreshed checked state", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));
		const options = ["one", "two", "Done"];
		const first = bridge.request("select", ["Pick", options, { selectionMarker: "checkbox", checkedIndices: [0], markableCount: 2 }]);
		bridge.resolve(station.opens.at(-1).id, { value: "two" });
		await expect(first).resolves.toBe("two");
		const second = bridge.request("select", ["Pick", options, { selectionMarker: "checkbox", checkedIndices: [0, 1], markableCount: 2 }]);
		expect(station.opens.at(-1).payload.checkedIndices).toEqual([0, 1]);
		bridge.resolve(station.opens.at(-1).id, { value: "Done" });
		await expect(second).resolves.toBe("Done");
	});

	test("an unlisted select answer resolves as a cancellation", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));
		const pending = bridge.request("select", ["Pick", ["one"]]);
		bridge.resolve(station.opens.at(-1).id, { value: "invented" });
		await expect(pending).resolves.toBeUndefined();
	});

	test("confirm keeps its message and maps ok/cancel to booleans", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));
		const okPending = bridge.request("confirm", ["Deploy", "Deploy to prod?"]);
		expect(station.opens.at(-1).payload).toMatchObject({ title: "Deploy", message: "Deploy to prod?" });
		bridge.resolve(station.opens.at(-1).id, { value: "ok" });
		await expect(okPending).resolves.toBe(true);

		const cancelPending = bridge.request("confirm", ["Deploy", "No?"]);
		bridge.resolve(station.opens.at(-1).id, { cancelled: true });
		await expect(cancelPending).resolves.toBe(false);
	});

	test("input and editor keep placeholder/prefill and accept form values", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));

		const inputPending = bridge.request("input", ["Name", "Ada?", { secret: true }]);
		expect(station.opens.at(-1).payload).toMatchObject({ title: "Name", placeholder: "Ada?", secret: true });
		bridge.resolve(station.opens.at(-1).id, { value: "Ada" });
		await expect(inputPending).resolves.toBe("Ada");

		const editorPending = bridge.request("editor", ["Body", "draft text"]);
		expect(station.opens.at(-1).payload).toMatchObject({ title: "Body", prefill: "draft text" });
		bridge.resolve(station.opens.at(-1).id, { data: { value: "final text" } });
		await expect(editorPending).resolves.toBe("final text");
	});

	test("askDialog ships questions and resolves to the native submit result", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));
		const questions = [
			{
				id: "q1",
				question: "Which?",
				header: "Choice",
				options: [{ label: "A" }, { label: "B", description: "bee" }],
				multi: true,
				recommended: 1,
			},
		];
		const pending = bridge.request("askDialog", [questions, {}]);
		const opened = station.opens.at(-1);
		expect(opened.payload.questions).toEqual([
			{
				id: "q1",
				question: "Which?",
				header: "Choice",
				options: [{ label: "A" }, { label: "B", description: "bee" }],
				multi: true,
				recommended: 1,
			},
		]);

		const result = bridge.resolve(opened.id, {
			answers: [{ id: "q1", selectedOptions: ["B", "not-an-option"], customInput: " extra " }],
		});
		expect(result.value).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Which?",
					options: ["A", "B"],
					multi: true,
					selectedOptions: ["B"],
					customInput: "extra",
				},
			],
		});
		await expect(pending).resolves.toEqual(result.value);
	});

	test("formDialog validates before settling and cancellation resolves undefined", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));
		const html = '<form><p>Intro</p><label>Name <input name="name" required></label></form>';

		const pending = bridge.request("formDialog", [html, {}]);
		const opened = station.opens.at(-1);
		const fields = opened.payload.form.fields;
		expect(fields.map((field) => field.name)).toEqual(["name"]);

		let settled = false;
		pending.then(() => {
			settled = true;
		});
		const invalid = bridge.resolve(opened.id, { data: {} });
		expect(invalid).toMatchObject({ ok: false, code: "invalid_form" });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(bridge.kindOf(opened.id)).toBe("formDialog");

		const valid = bridge.resolve(opened.id, { data: { name: "Ada" } });
		expect(valid.ok).toBe(true);
		await expect(pending).resolves.toMatchObject({ data: { name: "Ada" } });

		const cancelled = bridge.request("formDialog", [html, {}]);
		bridge.resolve(station.opens.at(-1).id, { cancelled: true });
		await expect(cancelled).resolves.toBeUndefined();
	});

	test("approve offers session/grant choices and fails closed", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));
		const prompt = {
			full: "run rm -rf build",
			compact: "rm -rf build",
			session: "Allow for session",
			grants: [{ scope: "folder", label: "Allow folder", alwaysLabel: "Always allow folder" }],
		};
		const pending = bridge.request("approve", [prompt, {}]);
		const opened = station.opens.at(-1);
		const values = opened.payload.choices.map((choice) => choice.value);
		expect(values).toContain("once");
		expect(values).toContain("session");
		expect(values).toContain("grant:folder:session");
		expect(values).toContain("grant:folder:always");
		expect(values).toContain("deny");

		expect(bridge.resolve(opened.id, { value: "grant:folder:always" }).value).toEqual({
			grant: "folder",
			always: true,
		});
		await pending;

		const unknown = bridge.request("approve", [prompt, {}]);
		expect(bridge.resolve(station.opens.at(-1).id, { value: "invented" }).value).toBe("deny");
		await expect(unknown).resolves.toBe("deny");

		const session = bridge.request("approve", [prompt, {}]);
		expect(bridge.resolve(station.opens.at(-1).id, { value: "session" }).value).toBe("session");
		await session;
	});

	test("mirror keeps status text and skips non-serializable widget factories", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));

		bridge.mirror("setStatus", ["context", "Running tests"]);
		expect(station.meta.at(-1)).toMatchObject({ setStatus: "Running tests", statusKey: "context" });
		bridge.mirror("setStatus", ["context", undefined]);
		expect(station.meta.at(-1)).toMatchObject({ setStatus: null });
		bridge.mirror("setWorkingMessage", ["Thinking"]);
		expect(station.meta.at(-1)).toMatchObject({ setWorkingMessage: "Thinking" });

		bridge.mirror("setWidget", ["todo", ["one", "two"]]);
		bridge.mirror("setWidget", ["component", () => null]);
		bridge.mirror("setWidget", ["todo", null]);
		expect(station.widgets).toEqual([
			["todo", ["one", "two"]],
			["todo", null],
		]);
	});

	test("an already-aborted signal rejects and closes the interaction", async () => {
		const { createUiBridge } = await load();
		const station = makeStation();
		const bridge = createUiBridge(makeBridge(station));
		const controller = new AbortController();
		controller.abort();
		const pending = bridge.request("input", ["Name"], { signal: controller.signal });
		await expect(pending).rejects.toThrow("aborted");
		expect(station.closes).toContain(station.opens.at(-1).id);
	});
});

describe("createHostTickets", () => {
	test("setModel resolves a Model object before calling pi.setModel", async () => {
		const { createHostTickets } = await load();
		const model = { id: "m1", provider: "p1", name: "Model One" };
		const calls = [];
		const ctx = {
			models: {
				list: () => [model],
				resolve: (spec) => (spec === "p1/m1" ? model : undefined),
			},
			abort() {},
		};
		const pi = {
			async setModel(value) {
				calls.push(value);
				return true;
			},
		};
		const tickets = createHostTickets({ ctx, pi, diagnostics: { record() {} } });
		const result = await tickets.setModelTicket({ provider: "p1", modelId: "m1" });
		expect(result.ok).toBe(true);
		expect(calls).toEqual([model]);

		const unknown = await tickets.setModelTicket({ provider: "p1", modelId: "missing" });
		expect(unknown).toMatchObject({ ok: false, code: "unknown_model" });
		expect(calls).toHaveLength(1);
	});

	test("setThinking rejects an unknown level without touching the host", async () => {
		const { createHostTickets } = await load();
		const levels = [];
		const tickets = createHostTickets({
			pi: { setThinkingLevel: (level) => levels.push(level) },
			ctx: {},
			diagnostics: { record() {} },
		});
		expect(await tickets.setThinkingTicket({ level: "turbo" })).toMatchObject({ ok: false, code: "invalid_level" });
		expect(await tickets.setThinkingTicket({ level: "high" })).toEqual({ ok: true });
		expect(levels).toEqual(["high"]);
	});

	test("resolvePlanReview translates the review's label to its stable choice id", async () => {
		const { createHostTickets } = await load();
		const calls = [];
		const ctx = {
			getPendingPlanReview: () => ({
				reviewId: "r1",
				options: [
					{ id: "execute", label: "Execute", disabled: false },
					{ id: "keep", label: "Keep (12k tokens)", disabled: false },
				],
			}),
			resolvePlanReview: (reviewId, choice, input) => {
				calls.push([reviewId, choice, input]);
				return true;
			},
		};
		const tickets = createHostTickets({ ctx, pi: {}, diagnostics: { record() {} } });
		expect(await tickets.resolvePlanReviewTicket({ reviewId: "r1", choice: "Keep (12k tokens)" })).toEqual({
			ok: true,
			value: true,
		});
		expect(calls.at(-1)).toEqual(["r1", "keep", undefined]);
		expect(await tickets.resolvePlanReviewTicket({ reviewId: "r1", choice: "execute" })).toEqual({
			ok: true,
			value: true,
		});
		expect(calls.at(-1)).toEqual(["r1", "execute", undefined]);
		expect(await tickets.resolvePlanReviewTicket({ reviewId: "r1", choice: "nonsense" })).toMatchObject({
			ok: false,
			code: "invalid_choice",
		});
	});

	test("submitComposer refuses to send a slash command as plain chat", async () => {
		const { createHostTickets } = await load();
		const sent = [];
		const tickets = createHostTickets({
			pi: { sendUserMessage: async (text) => sent.push(text) },
			getEditor: () => null,
			ctx: {},
			diagnostics: { record() {} },
		});
		expect(await tickets.submitComposerTicket({ text: "/compact" })).toMatchObject({
			ok: false,
			code: "editor_unavailable",
		});
		expect(sent).toHaveLength(0);
		expect(await tickets.submitComposerTicket({ text: "hello" })).toEqual({ ok: true });
		expect(sent).toEqual(["hello"]);

		const edits = [];
		const editor = {
			getText: () => "",
			setText: (text) => edits.push(text),
			submit: () => edits.push("submit"),
		};
		const withEditor = createHostTickets({
			pi: { sendUserMessage: async (text) => sent.push(text) },
			getEditor: () => editor,
			ctx: {},
			diagnostics: { record() {} },
		});
		expect(await withEditor.submitComposerTicket({ text: "/compact" })).toEqual({ ok: true });
		expect(edits).toEqual(["/compact", "submit"]);
		expect(sent).toEqual(["hello"]);
	});
});
