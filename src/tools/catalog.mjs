// The tool catalog: the one tool this extension registers, fully bound.
//
// The model sees exactly one tool: `js`. Everything else — host tools, MCP
// tools, the scope control plane — is an async method on the `api` object the
// js ticket builds from the station's capability projection. The control plane
// lives here as a plain function table; it is never registered with the host,
// so no native tool name can leak back into the model's tool list.

import { jsParameters } from "./js-protocol.mjs";
import { jsTicket } from "./js-ticket.mjs";
import {
	abandonTicket,
	forkTicket,
	joinTicket,
	replyTicket,
	requestTicket,
	returnTicket,
} from "./tickets.mjs";
import { errorResult } from "./results.mjs";

const ESSENTIAL = "essential";

/** The one registered tool's name. */
export const JS_TOOL_NAME = "js";

const JS_DESCRIPTION =
	"Run one async JavaScript program against the live `api` object (`api`, `state`, `inputs` in scope; bare expression returns implicitly, statement body needs `return`; always `await` api calls).\n" +
	"\n" +
	"HARD RULE — TWO FIELDS, TWO JOBS: `inputs` is the payload bay; `code` is SHORT glue ONLY. Write `inputs` FIRST, then reference `inputs.<key>` in `code`:\n" +
	"  BAD:  { code: \"await api.write({ path: 'a.txt', content: 'line1\\\\nline2...' })\" }\n" +
	"  GOOD: { inputs: { body: \"line1\\nline2...\" }, code: \"await api.write({ path: 'a.txt', content: inputs.body })\" }\n" +
	"\n" +
	"WHY MODELS STILL BLOW THIS UP: Every model tells itself \"I will escape this one carefully — it's faster than adding `inputs`.\" Then it fails. Text inlined into `code` must survive TWO escape layers (your JS string literal, then the JSON `code` string) and JS parsing. One unescaped backtick, `${`, quote, newline, or lone backslash detonates a `SyntaxError` before a single api call executes. Nothing runs, the wasted turn stays on the ledger forever, and you pay a second turn to re-emit the whole payload anyway. I used to inline patches and reports into `code` and paid that exact tax repeatedly. Doing it after reading this is not bad luck — it is classic amateur self-sabotage.\n" +
	"\n" +
	"STOP-TRIGGER (CHECK BEFORE SENDING): The instant you type a multiline string, `\\n`, a backtick, `${`, an escaped quote, or any payload for `write` (`content`), `edit` (`old_string`/`new_string`), `scope_return` (`dafny`), `scope_fork` (`fsm`), `ask` (`html`), patch, or heredoc inside `code` — STOP. Move it to `inputs.<key>`. `inputs` crosses one JSON layer only: never JS-parsed, never double-escaped, arrives verbatim as a runtime object.\n" +
	"\n" +
	"The set of methods actually bound this turn is printed in the trailing REPL probe; a method absent there does not exist at runtime.";

/**
 * The scope control plane as plain async functions.
 *
 * Signature: `(station, toolCallId, args, ctx, signal, frameId) ->
 * Promise<ToolResult>`. These are internal handlers, not host-registered
 * tools: the js runtime calls them through `host.dispatchInnerTool` and they
 * answer with the same result shape every tool returns.
 */
export function createCoreTools({ tickets = {} } = {}) {
	return Object.freeze({
		scope_fork: (station, toolCallId, args, ctx, _signal, frameId) =>
			forkTicket(station, toolCallId, args, ctx, tickets, frameId),
		scope_join: (station, toolCallId, args, ctx, signal, frameId) =>
			joinTicket(station, toolCallId, args, ctx, signal, tickets, frameId),
		scope_return: (station, toolCallId, args, ctx, signal, frameId) =>
			returnTicket(station, toolCallId, args, ctx, signal, tickets, frameId),
		scope_request: (station, toolCallId, args, ctx, signal) =>
			requestTicket(station, toolCallId, args, ctx, signal, tickets),
		scope_reply: (station, toolCallId, args, ctx, signal) =>
			replyTicket(station, toolCallId, args, ctx, signal, tickets),
		scope_abandon: (station, toolCallId, args, ctx) =>
			abandonTicket(station, toolCallId, args, ctx, tickets),
	});
}

/**
 * Build the one registered tool.
 *
 * Its `execute` builds the host funnel the ticket expects: control-plane names
 * go to the core table, every other name to the host's confiscated-tool
 * snapshot (`host.tools.execute`), with the live `ctx` passed through
 * untouched so the host's approval and dialog fences keep working.
 */
export function createTools({ stationFor, tickets }) {
	const core = createCoreTools({ tickets });
	const jsTool = {
		name: JS_TOOL_NAME,
		label: "JS",
		description: JS_DESCRIPTION,
		parameters: jsParameters,
		loadMode: ESSENTIAL,
		// `scope_join` and `scope_request` park; a queued user message must be
		// able to take the turn back exactly as the native join allowed.
		interruptible: true,
		handlesToolInterrupt: true,
		execute: (toolCallId, params, signal, _onUpdate, ctx) => {
			const station = stationFor(ctx);
			const host = {
				dispatchInnerTool: (name, innerId, args, innerCtx, innerSignal, frameId) => {
					const handle = core[name];
					if (typeof handle === "function") {
						return handle(
							station,
							innerId,
							args,
							innerCtx ?? ctx,
							innerSignal ?? signal ?? null,
							frameId ?? toolCallId,
						);
					}
					const execute = station?.host?.tools?.execute;
					if (typeof execute === "function") {
						// The host's extension wrapper resolves the approval mode from
						// `context.settings`. An extension context carries none, so a
						// context passed as-is resolves to always-ask: the root would
						// prompt, and a child — which has no interactive UI — would
						// throw instead of running the tool. Attach the session's own
						// settings so `tools.approvalMode` decides, exactly as it does
						// for the host's native tool loop.
						const baseCtx = innerCtx ?? ctx;
						const settings =
							typeof station?.host?.session?.settingsOf === "function"
								? station.host.session.settingsOf(baseCtx)
								: null;
						const callCtx =
							settings && baseCtx
								? Object.assign(Object.create(baseCtx), { settings })
								: baseCtx;
						return execute(
							name,
							innerId,
							args,
							innerSignal ?? signal ?? null,
							undefined,
							callCtx,
						);
					}
					return Promise.resolve(
						errorResult(
							"TOOL_UNAVAILABLE",
							`No tool named "${name}" is bound this turn.`,
						),
					);
				},
				report: station?.host?.report,
			};
			return jsTicket(station, toolCallId, params, ctx, signal, host);
		},
	};
	return Object.freeze([jsTool]);
}

/**
 * Bind a catalog to a host's `registerTool`. The composition root calls this
 * once; a test that owns a fake registry can call it too.
 */
export function wireTools(pi, target, tickets = {}) {
	const stationFor =
		typeof target === "function" ? target : (ctx) => target.stationFor(ctx);
	for (const tool of createTools({ stationFor, tickets })) pi.registerTool(tool);
}
