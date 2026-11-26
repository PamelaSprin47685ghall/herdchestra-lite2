/**
 * The js ticket: the one async coroutine behind the single `js` tool.
 *
 * The model sees exactly one tool (`js({ code, inputs? })`). Everything it
 * used to call natively — bash, read, edit, the scope controls — is an async
 * method on a frozen `api` object that this ticket builds once per execution
 * from the station's capability projection. The projection is the single
 * source of truth: the same one drives the per-turn REPL probe and the cache
 * signature, so the keys the model sees in the probe are exactly the keys
 * this object carries. No aliasing, no remapping: `api.read` is the host's
 * `read`, `api.scope_fork` is the core's `scope_fork`, one to one.
 *
 * Execution is sandboxed by hygiene, not by adversarial threat model: each
 * run gets a fresh `vm` context built on a null-prototype object so the host's
 * process-wide `globalThis` slots never leak into user code, and script-local
 * variables never persist across turns — a fork, a rewind, or a session reload
 * rebuilds the identical `api` from durable station state.
 *
 * Injected contracts (implemented outside this module, do not implement here):
 *
 * - `station.beginJsCall(ctx)` — synchronous pre-check. Returns the frozen
 *   capability projection `{ mode, tools: string[], state, signature }` for
 *   this beat. `tools` is the sorted list of method names `api` carries;
 *   `state` is the read-only snapshot handed to the script as `state`.
 * - `station.finishJsCall(toolCallId, calls, ctx)` — synchronous reconcile,
 *   invoked exactly once in `finally` with every inner call this execution
 *   attempted (`{ id, name, args, resultText?, isError? }`). Settles the
 *   beat's accounting (beatShares + chargeBranch + panhandle + persist) in
 *   one atomic beat. Must never throw; guarded here as a courtesy.
 * - `host.dispatchInnerTool(name, callId, args, ctx, signal, frameId)` — the
 *   host-side funnel. `callId` is synthetic (`<frameId>#<index>`) so one script
 *   can call the same control twice; `frameId` is the assistant tool call the
 *   journal knows. Returns a Promise of the standard tool-result shape
 *   `{ content: [{ type: "text", text }], isError?, details? }`. `scope_*`
 *   names route to the core's control implementations, everything else to
 *   the confiscated host tool of the same name. The live `ctx` is passed
 *   through untouched so the host's UI fences (approval dialogs, web/TUI
 *   racing) keep working.
 */

import vm from "node:vm";
import { inspect } from "node:util";
import { errorResult, textResult } from "./results.mjs";

/**
 * The fixed echo line at the top of every js result. The code itself is
 * already in the tool call's arguments; echoing it again would burn the
 * tokens twice, so the echo is a constant — the same bytes every time, which
 * also keeps the prefix-cache picture identical across beats.
 */
export const REPL_ECHO =
	"> await AsyncFunction('api', 'state', 'inputs', code)(api, state, inputs)";

// Inner results recorded into `details.innerCalls` feed the web UI's artifact
// pane. They are journal metadata, not model context, so a generous cap keeps
// the JSONL honest without losing ordinary reads.
const RESULT_TEXT_CAP = 50_000;

/**
 * Compile user code into an async function with `(api, state, inputs)` in
 * scope. Two shapes are accepted so the model never has to think about the
 * distinction:
 *
 * 1. A single expression (`"1 + inputs.one"`, `"await api.read('x')"`): the
 *    expression's value becomes the result without needing `return`.
 * 2. A statement body (`"const x = await api.read('x'); return x;"`): run
 *    as the body of the async function.
 *
 * The expression form is tried first. A bare trailing semicolon is the one
 * ambiguity (`"1 + 1;"` is a valid statement but not a valid expression), so
 * after the plain expression parse fails the compile retries once with a
 * single trailing semicolon stripped before falling back to the statement
 * body. Whatever parses first wins; if nothing parses, the statement-body
 * error is thrown — its line numbers are the closest to what the model wrote.
 *
 * The newline placement keeps user code starting at its own line in every
 * form, so syntax-error line numbers never shift by more than the fixed
 * one-line header.
 */
export function compileAsync(sandbox, code) {
	const source = String(code ?? "");
	const attempts = [
		`(async function(api, state, inputs) { return (\n${source}\n); })`,
		`(async function(api, state, inputs) { return (\n${source.replace(/;\s*$/, "")}\n); })`,
		`(async function(api, state, inputs) {\n${source}\n})`,
	];
	let bodyError = null;
	for (const attempt of attempts) {
		try {
			return vm.runInContext(attempt, sandbox);
		} catch (error) {
			bodyError = error;
		}
	}
	throw bodyError;
}

function capText(text) {
	if (typeof text !== "string") return text;
	if (text.length <= RESULT_TEXT_CAP) return text;
	return `${text.slice(0, RESULT_TEXT_CAP)}\n… [truncated at ${RESULT_TEXT_CAP} chars]`;
}

/**
 * Render one value the way a REPL would print it. Strings pass through raw —
 * a file read or a patch stays readable source instead of an escaped JSON
 * blob — everything else goes through `util.inspect`.
 */
function formatOne(value) {
	if (typeof value === "string") return value;
	return inspect(value, { depth: 4, maxStringLength: 20_000, maxArrayLength: 1_000 });
}

/**
 * The second line of the js result.
 *
 * A script that ends without returning anything (`undefined`) but did call
 * `api.*` almost certainly forgot its `return`: rather than burning the whole
 * turn on `undefined`, hand back the outputs of everything it called, in
 * call order. A script that returned something real — even an empty string —
 * gets exactly that.
 */
export function formatReplValue(value, outputs) {
	if (value === undefined) {
		if (Array.isArray(outputs) && outputs.length > 0) {
			return outputs.map(formatOne).join("\n\n");
		}
		return "undefined";
	}
	return formatOne(value);
}

/**
 * Unwrap one inner tool result into the value the script receives.
 *
 * Control tools (`scope_fork`, `scope_join`, `scope_request`, …) hand their
 * info-rich object back through `details.result`; everything else unwraps to
 * the concatenated text of the result content. An `isError` result throws —
 * inside the script that is a plain exception the model can catch or let
 * surface as the turn's error line.
 */
function unwrapResult(res) {
	const text = (res?.content ?? []).map((part) => part?.text ?? "").join("\n");
	if (res?.isError) {
		const error = new Error(text || "Tool call failed");
		error.code = res?.details?.code;
		throw error;
	}
	if (res?.details && Object.hasOwn(res.details, "result")) return res.details.result;
	return text;
}

/**
 * Execute one `js` tool call.
 *
 * Sandwich shape per the Ticket Station Method: the synchronous pre-check
 * (`station.beginJsCall`) and the synchronous reconcile
 * (`station.finishJsCall` in `finally`) bracket the only async region — the
 * vm execution itself. The station never awaits; this ticket never holds
 * station state of its own.
 *
 * Poka-yoke inventory:
 *
 * - `halted`: once `scope_return` lands a stopLoop result the turn is over.
 *   Every later `api.*` call throws, even inside a `try/catch` the model
 *   wrote around the return — catching the refusal cannot resurrect the turn.
 * - `scope_return` exclusivity: calling it after any non-return api call in
 *   the same execution throws `MIXED_RETURN_TOOL_CALLS`, mirroring the
 *   station's native-batch rule. A failed validation does not poison retries:
 *   only calls other than `scope_return` count.
 * - Errors after a successful halt are expected fallout (the halted guard
 *   throwing inside user code) and do not mark the result as failed.
 */
export async function jsTicket(station, toolCallId, params, ctx, signal = null, host = {}) {
	let projection;
	try {
		projection = station.beginJsCall(ctx);
	} catch (error) {
		host?.report?.record?.("tickets", error, { kind: "js", phase: "begin", toolCallId });
		return errorResult("JS_BEGIN_INTERNAL_ERROR", String(error?.message ?? error));
	}

	const toolNames = Array.isArray(projection?.tools) ? projection.tools : [];
	const state = projection?.state ?? {};
	const dispatch = host?.dispatchInnerTool;

	const calls = [];
	const outputs = [];
	let halted = false;
	let terminalDetails = null;
	let controlDetails = null;

	const api = Object.create(null);
	for (const name of toolNames) {
		if (typeof name !== "string" || name === "") continue;
		const fn = async (args = {}) => {
			if (halted) {
				throw new Error(`Turn already terminated by scope_return: api.${name} is no longer available.`);
			}
			if (name === "scope_return" && calls.some((call) => call.name !== "scope_return")) {
				throw new Error("MIXED_RETURN_TOOL_CALLS: call scope_return alone in its own js execution.");
			}
			if (typeof dispatch !== "function") {
				throw new Error("js runtime is not wired: host.dispatchInnerTool is missing.");
			}
			const innerId = `${toolCallId}#${calls.length}`;
			const entry = { id: innerId, name, args };
			calls.push(entry);
			let raw;
			try {
				raw = await dispatch(name, innerId, args, ctx, signal, toolCallId);
			} catch (error) {
				entry.isError = true;
				entry.resultText = String(error?.message ?? error);
				throw error;
			}
			// Control tools answer with the info-rich object the model reads, and
			// that same object is the machine channel: `scope_return` reports the
			// rewind, the seal, or the promotion there, and the host reads
			// `details.stopLoop` to decide whether the loop ends. Surface those
			// fields on the js result as well, so a caller sees the decision
			// without reopening the inner result.
			if (name.startsWith("scope_") && raw?.details && typeof raw.details === "object") {
				controlDetails = { ...(controlDetails ?? {}), ...raw.details };
			}
			if (raw?.details?.stopLoop === true) {
				halted = true;
				terminalDetails = raw.details;
			}
			let value;
			try {
				value = unwrapResult(raw);
			} catch (error) {
				entry.isError = true;
				entry.resultText = capText(String(error?.message ?? error));
				throw error;
			}
			entry.isError = false;
			entry.resultText = capText(typeof value === "string" ? value : inspect(value, { depth: 4, maxStringLength: RESULT_TEXT_CAP }));
			outputs.push(value);
			return value;
		};
		Object.defineProperty(fn, "name", { value: name });
		api[name] = fn;
	}
	Object.freeze(api);

	const sandbox = vm.createContext(Object.create(null));
	let value;
	let failure = null;
	try {
		const compiled = compileAsync(sandbox, params?.code);
		value = await compiled(api, state, params?.inputs ?? {});
	} catch (error) {
		failure = error;
	} finally {
		// Reconcile exactly once, whatever happened above. The station owns the
		// accounting; an accounting failure is a bug in the station, not in the
		// model's script, so it is reported sideways instead of masking the
		// script's own outcome.
		try {
			station.finishJsCall(toolCallId, calls, ctx);
		} catch (settleError) {
			host?.report?.record?.("tickets", settleError, { kind: "js", phase: "settle", toolCallId });
		}
	}

	const failed = failure !== null && !halted;
	const body = failed
		? `Uncaught ${failure?.name ?? "Error"}: ${failure?.message ?? String(failure)}`
		: formatReplValue(value, outputs);
	const text = `${REPL_ECHO}\n${body}`;
	const details = {
		...(controlDetails ?? {}),
		...(terminalDetails ?? {}),
		innerCalls: calls.map(({ id, name, args, resultText, isError }) => ({
			id,
			name,
			args,
			...(resultText !== undefined ? { resultText } : {}),
			...(isError !== undefined ? { isError } : {}),
		})),
	};
	if (failed) {
		return {
			isError: true,
			content: [{ type: "text", text }],
			details: { code: "JS_UNCAUGHT", ...details },
		};
	}
	return textResult(text, details);
}
