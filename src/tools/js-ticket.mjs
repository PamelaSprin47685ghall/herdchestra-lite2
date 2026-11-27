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
 * Interrupts are owned by `beat.mjs`, not by the host signal. Every inner call
 * gets its own AbortController; the host signal only drives the beat's one
 * decision. A soft interrupt steers when work is in flight; an explicit one
 * interrupts. The script races `beat.closing`, so a bare Promise that never
 * settles cannot hold the tool call hostage.
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
import { renderYamlView } from "../format/yaml-view.mjs";
import { errorResult, textResult } from "./results.mjs";
import { JS_INTERRUPTED, JS_STEERED, createBeat } from "./beat.mjs";

/**
 * The fixed echo line at the top of every js result. The code itself is
 * already in the tool call's arguments; echoing it again would burn the
 * tokens twice, so the echo is a constant — the same bytes every time, which
 * also keeps the prefix-cache picture identical across beats.
 */
export const REPL_ECHO =
	"> await AsyncFunction('api', 'state', 'inputs', code)(api, state, inputs)";

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

/**
 * Render one value the way a REPL would print it. Strings pass through raw —
 * a file read or a patch stays readable source instead of an escaped blob —
 * everything else becomes block YAML through `renderYamlView`.
 */
function formatOne(value) {
	if (typeof value === "string") return value;
	return renderYamlView(value, {
		depth: Number.POSITIVE_INFINITY,
		maxStringLength: Number.POSITIVE_INFINITY,
	});
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
 * vm execution and the beat's interrupt race. The station never awaits; this
 * ticket never holds station state of its own.
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
 * - `beat.closed`: after an interrupt, every later `api.*` throws
 *   `BEAT_CLOSED` without dispatch, charge, or an inner-call entry.
 * - `beat.parksAllowed`: after a steer, a new park throws
 *   `BEAT_NO_MORE_WAITS`; the script cannot re-block the turn it just gave up.
 * - Errors after a successful halt are expected fallout (the halted guard
 *   throwing inside user code) and do not mark the result as failed.
 */
export async function jsTicket(
	station,
	toolCallId,
	params,
	ctx,
	signal = null,
	host = {},
) {
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
	const beat = createBeat({ signal });

	const calls = [];
	const outputs = [];
	let halted = false;
	let terminalDetails = null;
	let controlDetails = null;

	const api = Object.create(null);
	for (const name of toolNames) {
		if (typeof name !== "string" || name === "") continue;
		const fn = async (args = {}) => {
			// The beat owns the interrupt verdict, so it answers before halted or
			// mixed-return checks: an aborted turn's stable error is BEAT_CLOSED,
			// and the refusal is counted even if scope_return landed first.
			beat.rejectIfClosed(name);
			if (halted) {
				throw new Error(
					`Turn already terminated by scope_return: api.${name} is no longer available.`,
				);
			}
			if (name === "scope_return" && calls.some((call) => call.name !== "scope_return")) {
				throw new Error(
					"MIXED_RETURN_TOOL_CALLS: call scope_return alone in its own js execution.",
				);
			}
			if (typeof dispatch !== "function") {
				throw new Error("js runtime is not wired: host.dispatchInnerTool is missing.");
			}
			// The beat refuses a late call before it can reach the host or the
			// accounting: no dispatch, no charge, no inner-call row.
			const op = beat.beginOp(name);
			const innerId = `${toolCallId}#${calls.length}`;
			const entry = { id: innerId, name, args };
			calls.push(entry);
			let raw;
			try {
				// Every op carries its own controller. The host's signal stops at
				// the beat: forwarding it here would let one soft steer kill bash.
				const rawPromise = dispatch(
					name,
					innerId,
					args,
					ctx,
					op.controller.signal,
					toolCallId,
				);
				raw = await beat.attach(op, rawPromise, entry);
			} catch (error) {
				entry.isError = true;
				entry.resultText = String(error?.message ?? error);
				beat.endOp(op);
				throw error;
			}
			beat.endOp(op);
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
				entry.resultText = String(error?.message ?? error);
				throw error;
			}
			entry.isError = false;
			entry.resultText =
				typeof value === "string"
					? value
					: renderYamlView(value, {
							depth: Number.POSITIVE_INFINITY,
							maxStringLength: Number.POSITIVE_INFINITY,
						});
			outputs.push(value);
			return value;
		};
		Object.defineProperty(fn, "name", { value: name });
		api[name] = fn;
	}
	Object.freeze(api);

	const sandbox = vm.createContext(Object.create(null));
	const script = (async () => {
		try {
			const compiled = compileAsync(sandbox, params?.code);
			const value = await compiled(api, state, params?.inputs ?? {});
			return { ok: true, value };
		} catch (error) {
			return { ok: false, error };
		}
	})();

	let outcome = null;
	let interrupted = false;
	let steered = false;
	try {
		if (beat.decision === "interrupt") {
			interrupted = true;
		} else {
			const raced = await Promise.race([
				script,
				beat.closing.then(() => ({ interrupted: true })),
				// A steer releases the call only after every surviving work op
				// settled and the script had one macrotask to finish. A script
				// that wins the race keeps its value; one still parked on a bare
				// Promise is released as JS_STEERED instead of hanging.
				beat.steerClosing.then(() => ({ steered: true })),
			]);
			if (raced?.interrupted) interrupted = true;
			else if (raced?.steered) steered = true;
			else outcome = raced;
		}
		// A script that finished in the same microtask as an explicit abort
		// still honors the abort: the host asked for the turn back.
		if (!interrupted && !steered && beat.decision === "interrupt") interrupted = true;
		if (interrupted || steered) {
			beat.sealOps();
		} else if (beat.decision === "steer") {
			// The script finished first; work keeps its own signal and its own
			// life. The tool call waits for it so the result and the accounting
			// describe the work that ran.
			await beat.waitForWork();
		}
	} finally {
		beat.dispose();
		// Reconcile exactly once, whatever happened above. The station owns the
		// accounting; an accounting failure is a bug in the station, not in the
		// model's script, so it is reported sideways instead of masking the
		// script's own outcome.
		try {
			station.finishJsCall(toolCallId, calls, ctx);
		} catch (settleError) {
			host?.report?.record?.("tickets", settleError, {
				kind: "js",
				phase: "settle",
				toolCallId,
			});
		}
	}

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
		beat: beat.details,
	};

	if (interrupted) {
		const reason = beat.details.reason ?? "explicit";
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `${REPL_ECHO}\nbeat interrupted (${reason}) before the script finished.`,
				},
			],
			details: { ...details, code: JS_INTERRUPTED },
		};
	}

	if (steered) {
		const reason = beat.details.reason ?? "soft";
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `${REPL_ECHO}\nbeat steered (${reason}); its work settled, but the script did not finish.`,
				},
			],
			details: { ...details, code: JS_STEERED },
		};
	}

	const failed = outcome?.ok === false && !halted;
	if (failed && beat.decision === "steer") {
		const error = outcome.error;
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `${REPL_ECHO}\nUncaught ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
				},
			],
			details: { ...details, code: JS_STEERED },
		};
	}

	const value = outcome?.ok === true ? outcome.value : undefined;
	const body = failed
		? `Uncaught ${outcome.error?.name ?? "Error"}: ${outcome.error?.message ?? String(outcome.error)}`
		: formatReplValue(value, outputs);
	const text = `${REPL_ECHO}\n${body}`;
	if (failed) {
		return {
			isError: true,
			content: [{ type: "text", text }],
			details: { ...details, code: "JS_UNCAUGHT" },
		};
	}
	return textResult(text, details);
}
