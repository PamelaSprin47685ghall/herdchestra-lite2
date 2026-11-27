// The js beat: what one \`js\` tool call does when the host interrupts it.
//
// The contract is driven by what is actually in flight, not by the tool name:
//   park = scope_join / wait / ask: a pure wait, safe to cancel.
//   work = everything else: a real side effect, including bash and read.
//
// soft (a queued user message) steers when any work is in flight: parks are
// cancelled, work keeps running, and the script finishes naturally. Soft with
// only parks (or nothing) interrupts. Explicit interrupts everything, even two
// bash calls.
//
// These tests drive the public jsTicket entry with a fake station and a fake
// host. They import only the entry and the stable reason symbol, so a
// missing beat module fails an assertion instead of the whole file.

import { describe, expect, test } from "bun:test";

import { jsTicket } from "../src/tools/js-ticket.mjs";
import { TOOL_INTERRUPT_ABORT_REASON } from "../src/tools/tickets.mjs";
import { opClassOf } from "../src/tools/beat.mjs";

const TOOLS = ["bash", "scope_join", "wait", "read"];

function station(tools = TOOLS) {
	const settled = [];
	return {
		settled,
		beginJsCall: () => ({
			mode: "SUBSCOPE",
			tools,
			state: {
				mode: "SUBSCOPE",
				scope: "/api",
				remaining: {},
				unreceived: 0,
			},
			signature: "SUBSCOPE::" + tools.join(",") + "|stop=false",
		}),
		finishJsCall: (toolCallId, calls) => {
			settled.push({ toolCallId, calls });
		},
	};
}

function text(value, details) {
	return {
		content: [{ type: "text", text: value }],
		...(details === undefined ? {} : { details }),
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeHost(handlers = {}) {
	const seen = [];
	return {
		seen,
		dispatchInnerTool(name, id, args, ctx, signal, frameId) {
			const entry = { name, id, args, ctx, signal, frameId };
			seen.push(entry);
			const handler = handlers[name];
			if (typeof handler === "function") return handler(entry);
			return Promise.resolve(text("ok:" + name));
		},
	};
}

/** A park that rejects when its op signal aborts, like joinTicket does. */
function parkUntilAbort(signal, label) {
	const answer = deferred();
	const stop = () => {
		const error = new Error(label + " interrupted");
		error.code = label === "scope_join" ? "JOIN_INTERRUPTED" : "WAIT_INTERRUPTED";
		answer.reject(error);
	};
	if (signal?.aborted) stop();
	else signal?.addEventListener("abort", stop, { once: true });
	return answer.promise;
}

async function start(code, handlers = {}) {
	const fakeStation = station();
	const host = makeHost(handlers);
	const controller = new AbortController();
	const ticket = jsTicket(
		fakeStation,
		"call-1",
		{ code },
		{},
		controller.signal,
		host,
	);
	return { ticket, fakeStation, host, controller };
}

function body(result) {
	const text = result.content[0].text;
	return text.slice(text.indexOf("\n") + 1);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("soft interrupt steers while work is in flight", () => {
	test("bash + bash: neither bash signal is aborted and the script finishes", async () => {
		const bash = [];
		const { ticket, fakeStation, host, controller } = await start(
			"const a = api.bash({ command: 'a' });\n" +
				"const b = api.bash({ command: 'b' });\n" +
				"return Promise.all([a, b]);",
			{
				bash: ({ signal }) => {
					const answer = deferred();
					bash.push({ signal, answer });
					return answer.promise;
				},
			},
		);
		expect(host.seen.map((call) => call.name)).toEqual(["bash", "bash"]);

		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		await flush();

		expect(bash[0].signal.aborted).toBe(false);
		expect(bash[1].signal.aborted).toBe(false);

		bash[0].answer.resolve(text("one"));
		bash[1].answer.resolve(text("two"));
		const result = await ticket;

		expect(result.isError).toBeUndefined();
		expect(body(result)).toContain("one");
		expect(body(result)).toContain("two");
		expect(result.details.beat).toMatchObject({
			decision: "steer",
			reason: "soft",
			lateCalls: 0,
		});
		expect(fakeStation.settled).toHaveLength(1);
	});

	test("bash + join: only the join is cancelled, the bash still completes", async () => {
		const bash = [];
		const joins = [];
		const { ticket, controller, fakeStation } = await start(
			"const b = api.bash({ command: 'b' });\n" +
				"const j = api.scope_join({});\n" +
				"const [rb, rj] = await Promise.allSettled([b, j]);\n" +
				"return [rb.status, rj.status];",
			{
				bash: ({ signal }) => {
					const answer = deferred();
					bash.push({ signal, answer });
					return answer.promise;
				},
				scope_join: ({ signal }) => {
					joins.push(signal);
					return parkUntilAbort(signal, "scope_join");
				},
			},
		);

		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		await flush();

		expect(bash[0].signal.aborted).toBe(false);
		expect(joins[0].aborted).toBe(true);

		bash[0].answer.resolve(text("done"));
		const result = await ticket;

		expect(result.isError).toBeUndefined();
		expect(body(result)).toContain("fulfilled");
		expect(body(result)).toContain("rejected");
		expect(result.details.beat).toMatchObject({ decision: "steer", reason: "soft" });
		expect(fakeStation.settled).toHaveLength(1);
	});

	test("a park started after the steer is refused without dispatch", async () => {
		const bash = [];
		const { ticket, host, controller } = await start(
			"const b = api.bash({ command: 'b' });\n" +
				"await b;\n" +
				"try { await api.scope_join({}); } catch (error) { return error.code ?? error.message; }",
			{
				bash: ({ signal }) => {
					const answer = deferred();
					bash.push({ signal, answer });
					return answer.promise;
				},
			},
		);

		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		await flush();
		bash[0].answer.resolve(text("done"));
		const result = await ticket;

		expect(host.seen.map((call) => call.name)).toEqual(["bash"]);
		expect(body(result)).toContain("BEAT_NO_MORE_WAITS");
		expect(result.details.beat).toMatchObject({ decision: "steer", reason: "soft" });
	});

	test("a script killed by its cancelled park reports JS_STEERED after surviving work settles", async () => {
		const bash = [];
		const { ticket, controller } = await start(
			"api.bash({ command: 'b' });\n" +
				"const joined = await api.scope_join({});\n" +
				"return joined;",
			{
				bash: ({ signal }) => {
					const answer = deferred();
					bash.push({ signal, answer });
					return answer.promise;
				},
				scope_join: ({ signal }) => parkUntilAbort(signal, "scope_join"),
			},
		);

		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		await flush();
		expect(bash[0].signal.aborted).toBe(false);
		bash[0].answer.resolve(text("done"));

		const result = await ticket;
		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_STEERED");
		expect(result.details.beat).toMatchObject({
			decision: "steer",
			reason: "soft",
			orphanWork: 0,
		});
	});
});

describe("soft interrupt with only parks interrupts", () => {
	test("one join: the tool returns without waiting for the join", async () => {
		const joins = [];
		const { ticket, fakeStation, controller } = await start(
			"return await api.scope_join({});",
			{
				scope_join: ({ signal }) => {
					joins.push(signal);
					return parkUntilAbort(signal, "scope_join");
				},
			},
		);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await ticket;

		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_INTERRUPTED");
		expect(result.details.beat).toMatchObject({
			decision: "interrupt",
			reason: "soft",
		});
		expect(joins[0].aborted).toBe(true);
		expect(fakeStation.settled).toHaveLength(1);
	});

	test("join + join: both are cancelled and the tool returns at once", async () => {
		const joins = [];
		const { ticket, controller } = await start(
			"return Promise.all([api.scope_join({}), api.scope_join({})]);",
			{
				scope_join: ({ signal }) => {
					joins.push(signal);
					return parkUntilAbort(signal, "scope_join");
				},
			},
		);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await ticket;

		expect(result.details.code).toBe("JS_INTERRUPTED");
		expect(result.details.beat).toMatchObject({ decision: "interrupt" });
		expect(joins.map((signal) => signal.aborted)).toEqual([true, true]);
	});

	test("an api call after the interrupt is refused locally, not dispatched", async () => {
		const { ticket, host, controller } = await start(
			"try { await api.scope_join({}); } catch {}\n" +
				"try { await api.bash({ command: 'late' }); } catch (error) { return error.code ?? error.message; }",
			{
				scope_join: ({ signal }) => parkUntilAbort(signal, "scope_join"),
			},
		);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await ticket;
		await flush();

		expect(host.seen.map((call) => call.name)).toEqual(["scope_join"]);
		expect(result.details.beat.lateCalls).toBeGreaterThanOrEqual(1);
	});
});

describe("explicit interrupt forces through work", () => {
	test("bash + bash: both bash signals abort and the tool does not wait", async () => {
		const bash = [];
		const { ticket, controller } = await start(
			"const a = api.bash({ command: 'a' });\n" +
				"const b = api.bash({ command: 'b' });\n" +
				"return Promise.all([a, b]);",
			{
				bash: ({ signal }) => {
					const answer = deferred();
					bash.push({ signal, answer });
					return answer.promise;
				},
			},
		);
		controller.abort(new Error("explicit user abort"));
		const result = await ticket;

		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_INTERRUPTED");
		expect(result.details.beat).toMatchObject({
			decision: "interrupt",
			reason: "explicit",
		});
		expect(bash.map((entry) => entry.signal.aborted)).toEqual([true, true]);
	});

	test("a bare Promise that never settles is rescued by the closing race", async () => {
		const { ticket, controller } = await start(
			"await new Promise(() => {});\nreturn 'never';",
		);
		controller.abort(new Error("explicit user abort"));
		const result = await ticket;

		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_INTERRUPTED");
		expect(result.details.beat).toMatchObject({ decision: "interrupt" });
	});
});

describe("the normal path is unchanged", () => {
	test("no abort: the script value is used, the beat is quiet, reconcile runs once", async () => {
		const reads = [];
		const { ticket, fakeStation, host, controller } = await start(
			"const value = await api.read({ path: 'a' });\nreturn value;",
			{
				read: ({ signal }) => {
					reads.push(signal);
					return Promise.resolve(text("hello"));
				},
			},
		);
		const result = await ticket;

		expect(controller.signal.aborted).toBe(false);
		expect(result.isError).toBeUndefined();
		expect(body(result)).toBe("hello");
		expect(result.details.beat).toMatchObject({
			decision: null,
			reason: null,
			lateCalls: 0,
		});
		expect(reads[0].aborted).toBe(false);
		expect(host.seen.map((call) => call.name)).toEqual(["read"]);
		expect(fakeStation.settled).toHaveLength(1);
	});
});

describe("park tool classification", () => {
	test("classifies scope_join, wait, and ask as park and work tools as work", () => {
		expect(opClassOf("scope_join")).toBe("park");
		expect(opClassOf("wait")).toBe("park");
		expect(opClassOf("ask")).toBe("park");
		expect(opClassOf("bash")).toBe("work");
		expect(opClassOf("read")).toBe("work");
	});
});

describe("a steer releases a script parked on a bare Promise", () => {
	test("work settles, the script does not: JS_STEERED instead of a hang", async () => {
		const bash = [];
		const { ticket, controller, fakeStation } = await start(
			"const b = api.bash({ command: 'b' });\nawait new Promise(() => {});\nreturn b;",
			{
				bash: ({ signal }) => {
					const answer = deferred();
					bash.push({ signal, answer });
					return answer.promise;
				},
			},
		);

		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		await flush();
		expect(bash[0].signal.aborted).toBe(false);

		bash[0].answer.resolve(text("done"));
		const result = await ticket;

		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_STEERED");
		expect(result.details.beat).toMatchObject({
			decision: "steer",
			reason: "soft",
			orphanWork: 0,
		});
		expect(fakeStation.settled).toHaveLength(1);
	});

	test("a new work call after the steer throws BEAT_STEERED and dispatches nothing", async () => {
		const bash = [];
		const { ticket, host, controller } = await start(
			"const first = api.bash({ command: 'first' });\n" +
				"await first;\n" +
				"try { await api.bash({ command: 'late' }); } catch (error) { return error.code ?? error.message; }",
			{
				bash: ({ signal }) => {
					const answer = deferred();
					bash.push({ signal, answer });
					return answer.promise;
				},
			},
		);

		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		await flush();
		bash[0].answer.resolve(text("done"));
		const result = await ticket;

		expect(host.seen.map((call) => call.name)).toEqual(["bash"]);
		expect(body(result)).toContain("BEAT_STEERED");
		expect(result.details.beat).toMatchObject({ decision: "steer", reason: "soft" });
	});
});
