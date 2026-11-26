// The js ticket: the one async coroutine behind the single `js` tool.
//
// What a consumer depends on:
//   - the two-line result shape (`> await AsyncFunction(...)` then the value),
//   - the poka-yoke guards: only projected methods exist, `scope_return` runs
//     alone, and nothing runs after it — not even inside a `try/catch`,
//   - `details.innerCalls` for the artifact pane and `details.stopLoop` as the
//     machine channel the host reads to end the loop,
//   - reconciliation exactly once, whatever the script did.

import { describe, expect, test } from "bun:test";
import vm from "node:vm";

import {
	compileAsync,
	formatReplValue,
	jsTicket,
	REPL_ECHO,
} from "../src/tools/js-ticket.mjs";

const PROJECTION = {
	mode: "CHILD",
	tools: ["read", "bash", "scope_return"],
	state: { mode: "CHILD", scope: "/api", remaining: { read: "2/3" }, unreceived: 0, scopes: ["/", "/api"] },
	signature: "CHILD::bash,read,scope_return|stop=false",
};

/** A station stand-in: the projection in, the settled calls out. */
function station(projection = PROJECTION, overrides = {}) {
	const settled = [];
	return {
		settled,
		beginJsCall: () => projection,
		finishJsCall: (toolCallId, calls) => {
			settled.push({ toolCallId, calls });
		},
		...overrides,
	};
}

/** A host stand-in that answers each inner call from a table. */
function host(answers, seen = []) {
	return {
		seen,
		dispatchInnerTool: (name, id, args) => {
			seen.push({ name, id, args });
			const answer = answers[name];
			if (typeof answer === "function") return Promise.resolve(answer(args));
			if (answer === undefined) {
				return Promise.resolve({
					isError: true,
					content: [{ type: "text", text: `no tool ${name}` }],
				});
			}
			return Promise.resolve(answer);
		},
	};
}

const text = (value, details) => ({
	content: [{ type: "text", text: value }],
	...(details === undefined ? {} : { details }),
});

async function run(code, { answers = {}, inputs, projection, stationOverrides } = {}) {
	const fakeStation = station(projection, stationOverrides);
	const fakeHost = host(answers);
	const result = await jsTicket(fakeStation, "call-1", { code, inputs }, { agent: null }, null, fakeHost);
	return { result, fakeStation, fakeHost };
}

function body(result) {
	const text = result.content[0].text;
	return text.slice(text.indexOf("\n") + 1);
}

describe("the result shape", () => {
	test("is always the echo line plus the value", () => {
		expect(REPL_ECHO).toBe(
			"> await AsyncFunction('api', 'state', 'inputs', code)(api, state, inputs)",
		);
	});

	test("prints a bare expression without needing a return", async () => {
		const { result } = await run("1 + inputs.one", { inputs: { one: 1 } });
		expect(result.content[0].text.startsWith(`${REPL_ECHO}\n`)).toBe(true);
		expect(body(result)).toBe("2");
		expect(result.isError).toBeUndefined();
	});

	test("tolerates one trailing semicolon on an expression", async () => {
		const { result } = await run("1 + 1;");
		expect(body(result)).toBe("2");
	});

	test("runs a statement body with awaits", async () => {
		const { result } = await run("const x = await api.read({ path: 'a' });\nreturn x;", {
			answers: { read: text("hello") },
		});
		expect(body(result)).toBe("hello");
	});

	test("prints a multi-line string raw instead of escaping it", async () => {
		const source = "line one\nline two";
		const { result } = await run("await api.read({ path: 'a' })", {
			answers: { read: text(source) },
		});
		// No `return`, so the script's own call output is handed back verbatim.
		expect(body(result)).toBe(source);
	});

	test("reports an uncaught error with its name", async () => {
		const { result } = await run("throw new TypeError('nope')");
		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_UNCAUGHT");
		expect(body(result)).toBe("Uncaught TypeError: nope");
	});

	test("reports a syntax error instead of crashing the ticket", async () => {
		const { result, fakeStation } = await run("const = 1");
		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_UNCAUGHT");
		// Reconcile still ran, with an empty call list.
		expect(fakeStation.settled).toHaveLength(1);
		expect(fakeStation.settled[0].calls).toEqual([]);
	});
});

describe("the api surface is exactly the projection", () => {
	test("an absent method does not exist at runtime", async () => {
		const { result } = await run("typeof api.todo");
		expect(body(result)).toBe("undefined");
	});

	test("state is the projection's read-only snapshot", async () => {
		const { result } = await run("[state.scope, state.remaining.read, state.mode]");
		expect(body(result)).toBe("- /api\n- 2/3\n- CHILD");
	});

	test("every api key is the real tool name, one to one", async () => {
		const { result } = await run("Object.keys(api).sort().join(',')");
		expect(body(result)).toBe("bash,read,scope_return");
	});
});

describe("scope_return exclusivity", () => {
	test("refuses to run after another call in the same script", async () => {
		const { result, fakeHost } = await run(
			"await api.read({ path: 'a' });\nawait api.scope_return({ dafny: 'x' });",
			{ answers: { read: text("hello"), scope_return: text("sealed", { stopLoop: true }) } },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("MIXED_RETURN_TOOL_CALLS");
		expect(fakeHost.seen.map((call) => call.name)).toEqual(["read"]);
	});

	test("a failed return does not poison a retry", async () => {
		const { result, fakeHost } = await run(
			"try { await api.scope_return({ dafny: '' }); } catch {}\nawait api.scope_return({ dafny: 'x' });",
			{
				answers: {
					scope_return: (args) =>
						args.dafny === ""
							? { isError: true, content: [{ type: "text", text: "missing dafny" }] }
							: text("sealed", { stopLoop: true, result: { ok: true } }),
				},
			},
		);
		// Only scope_return calls count, so the retry is allowed through.
		expect(fakeHost.seen.map((call) => call.name)).toEqual(["scope_return", "scope_return"]);
		expect(result.isError).toBeUndefined();
	});
});

describe("nothing runs after a successful return", () => {
	const ANSWERS = {
		read: text("hello"),
		scope_return: text("sealed", { stopLoop: true, result: { ok: true, kind: "seal" } }),
	};

	test("a later call throws and never reaches the host", async () => {
		const { result, fakeHost } = await run(
			"await api.scope_return({ dafny: 'x' });\nawait api.read({ path: 'a' });",
			{ answers: ANSWERS },
		);
		expect(fakeHost.seen.map((call) => call.name)).toEqual(["scope_return"]);
		// The trailing guard error is expected fallout, not a failed turn.
		expect(result.isError).toBeUndefined();
		expect(result.details.stopLoop).toBe(true);
	});

	test("catching the refusal cannot resurrect the turn", async () => {
		const { result, fakeHost } = await run(
			"await api.scope_return({ dafny: 'x' });\ntry { await api.read({ path: 'a' }); } catch {}\nawait api.read({ path: 'b' });",
			{ answers: ANSWERS },
		);
		expect(fakeHost.seen.map((call) => call.name)).toEqual(["scope_return"]);
		expect(result.isError).toBeUndefined();
	});
});

describe("details carry what the host and the artifact pane need", () => {
	test("innerCalls records every attempted call with its id and args", async () => {
		const { result } = await run(
			"await api.read({ path: 'a' });\nawait api.bash({ command: 'ls' });\nreturn 1;",
			{ answers: { read: text("hello"), bash: text("ok") } },
		);
		expect(result.details.innerCalls).toHaveLength(2);
		expect(result.details.innerCalls[0]).toMatchObject({
			id: "call-1#0",
			name: "read",
			args: { path: "a" },
			resultText: "hello",
			isError: false,
		});
		expect(result.details.innerCalls[1]).toMatchObject({ id: "call-1#1", name: "bash" });
	});

	test("a failing inner call is marked and its error surfaces", async () => {
		const { result } = await run("await api.read({ path: 'a' })", {
			answers: { read: { isError: true, content: [{ type: "text", text: "ENOENT" }] } },
		});
		expect(result.isError).toBe(true);
		expect(body(result)).toContain("ENOENT");
		expect(result.details.innerCalls[0].isError).toBe(true);
	});

	test("a control result is surfaced on the js details as well", async () => {
		const { result } = await run("await api.scope_return({ dafny: 'x' })", {
			answers: {
				scope_return: text("sealed", {
					stopLoop: true,
					promoted: false,
					result: { ok: true, kind: "seal" },
				}),
			},
		});
		expect(result.details.stopLoop).toBe(true);
		expect(result.details.promoted).toBe(false);
		expect(result.details.result).toEqual({ ok: true, kind: "seal" });
	});
});

describe("reconciliation", () => {
	test("finishJsCall runs exactly once with the attempted calls", async () => {
		const { fakeStation } = await run("await api.read({ path: 'a' })", {
			answers: { read: text("hello") },
		});
		expect(fakeStation.settled).toHaveLength(1);
		expect(fakeStation.settled[0].toolCallId).toBe("call-1");
		expect(fakeStation.settled[0].calls.map((call) => call.name)).toEqual(["read"]);
	});

	test("an accounting failure does not replace the script's own outcome", async () => {
		const { result } = await run("1 + 1", {
			stationOverrides: {
				finishJsCall: () => {
					throw new Error("ledger exploded");
				},
			},
		});
		expect(result.isError).toBeUndefined();
		expect(body(result)).toBe("2");
	});

	test("a broken pre-check is reported as a begin failure, not a crash", async () => {
		const fakeStation = station(PROJECTION, {
			beginJsCall: () => {
				throw new Error("no projection");
			},
		});
		const result = await jsTicket(fakeStation, "call-1", { code: "1" }, {}, null, host({}));
		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_BEGIN_INTERNAL_ERROR");
		expect(fakeStation.settled).toEqual([]);
	});

	test("a missing host funnel is an error the model can read", async () => {
		const fakeStation = station();
		const result = await jsTicket(fakeStation, "call-1", { code: "await api.read()" }, {}, null, {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("dispatchInnerTool is missing");
	});
});

describe("helpers", () => {
	test("compileAsync accepts an expression and a statement body", () => {
		const sandbox = vm.createContext(Object.create(null));
		const expression = compileAsync(sandbox, "1 + 2");
		const statement = compileAsync(sandbox, "const x = 4;\nreturn x + 1;");
		expect(expression.constructor.name).toBe("AsyncFunction");
		expect(statement.constructor.name).toBe("AsyncFunction");
	});

	test("formatReplValue hands back the call outputs when nothing was returned", () => {
		expect(formatReplValue(undefined, ["a", "b"])).toBe("a\n\nb");
		expect(formatReplValue(undefined, [])).toBe("undefined");
		// An empty string is a real answer, not a missing one.
		expect(formatReplValue("", ["ignored"])).toBe("");
	});
});
