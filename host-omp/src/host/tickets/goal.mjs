// Official goal session: `/herd-goal` is an alias for the host's `/goal`, and
// `api.goal` is the same tool the model would call outside a herd turn.
//
// Herd runs first: its nudge and rewind keep the root working until the sealed
// final answer. The official goal is armed at the same time and becomes the
// fallback continuation after that release. Nothing here deep-imports the core
// package: `host-omp` may take only `createEngine` from it, so the tiny slash
// grammar and every receipt live in this file.

import { sessionFor } from "../capture.mjs";
import { record } from "../diagnostics.mjs";

const GOAL_OPS = new Set(["get", "create", "complete", "pause", "resume", "drop"]);

/** A mode snapshot may spell the goal as a status string or a record. */
function goalStatusOf(goal) {
	if (typeof goal === "string") return goal;
	if (goal && typeof goal === "object" && typeof goal.status === "string") {
		return goal.status;
	}
	return null;
}

function canControlModes(ctx) {
	return typeof ctx?.sessionModes?.set === "function";
}

/**
 * Parse `/goal ...` and `/herd-goal ...` without importing the core parser.
 *
 * Returns `{ command, action, text }` where action is one of `set`, `off`,
 * `drop`, `pause`, `resume`, `show`, `budget`, or `menu`. A bare `/goal` is a
 * menu and must reach the built-in command untouched, so it answers `menu`.
 */
export function parseGoalSlash(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed.startsWith("/")) return null;
	const match = /^\/(goal|herd-goal)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return null;
	const command = match[1];
	const rest = (match[2] ?? "").trim();
	if (rest === "") {
		return command === "goal"
			? { command, action: "menu", text: "" }
			: { command, action: "off", text: "" };
	}
	const [head, ...tail] = rest.split(/\s+/);
	const word = head.toLowerCase();
	const body = tail.join(" ").trim();
	if (command === "herd-goal") {
		if (word === "off" || word === "drop") return { command, action: "off", text: "" };
		if (word === "pause" || word === "resume" || word === "show") {
			return { command, action: word, text: body };
		}
		if (word === "budget") return { command, action: "budget", text: body };
		if (word === "set") return { command, action: "set", text: body };
		return { command, action: "set", text: rest };
	}
	if (word === "set") return { command, action: "set", text: body };
	if (word === "off" || word === "drop") return { command, action: "drop", text: "" };
	if (word === "pause" || word === "resume" || word === "show") {
		return { command, action: word, text: body };
	}
	if (word === "budget") return { command, action: "budget", text: body };
	if (word === "menu") return { command, action: "menu", text: "" };
	// Any other text after `/goal` is an objective, the same as `/goal set`.
	return { command, action: "set", text: rest };
}

/** The live session and its official goal runtime, when the host exposes one. */
export function sessionRuntimeOf(ctx) {
	const direct = ctx?.session;
	const session = (() => {
		if (direct) return direct;
		try {
			return sessionFor(ctx);
		} catch {
			return null;
		}
	})();
	return { session, runtime: session?.goalRuntime ?? null };
}

function continuationModes(session) {
	try {
		const value = session?.settings?.get?.("goal.continuationModes");
		if (Array.isArray(value)) return value;
	} catch {
		// A settings shape this host does not expose falls back to the default.
	}
	return ["interactive"];
}

/** True when this session drives goal continuation on its own. */
export function hasInteractiveContinuationDriver(ctx, session) {
	return canControlModes(ctx) && continuationModes(session).includes("interactive");
}

function officialStateOf(ctx, runtime, session) {
	try {
		const mode = ctx?.sessionModes?.getState?.()?.goal;
		if (mode) return { goal: mode, source: "modes" };
	} catch {
		// Fall through to the runtime snapshot.
	}
	const state = runtime?.getState?.() ?? session?.getGoalModeState?.() ?? null;
	return { goal: state?.goal ?? null, state, source: "runtime" };
}

function messageOf(result) {
	return typeof result?.message === "string" && result.message ? result.message : null;
}

async function dropModes(ctx) {
	try {
		const dropped = await ctx.sessionModes.set({ mode: "goal", action: "drop" });
		return dropped?.ok !== false;
	} catch (error) {
		record("tickets", error, { kind: "goal-drop" });
		return false;
	}
}

async function dropRuntime(ctx) {
	const { session, runtime } = sessionRuntimeOf(ctx);
	if (!runtime) return false;
	try {
		await runtime.dropGoal();
		session?.setGoalModeState?.(undefined);
		return true;
	} catch (error) {
		record("tickets", error, { kind: "goal-drop-runtime" });
		return false;
	}
}

/** Send the first turn. A runtime session uses `session.prompt` so print mode
 * drives the run instead of leaving a fire-and-forget host message behind. */
async function deliverFirstTurn(pi, ctx, text, station) {
	const { session } = sessionRuntimeOf(ctx);
	try {
		if (session && typeof session.prompt === "function") {
			await session.prompt(text, {
				attribution: "user",
				expandPromptTemplates: false,
				runCommands: false,
				...(session.isStreaming ? { streamingBehavior: "steer" } : {}),
			});
			return { ok: true };
		}
		if (typeof pi?.sendUserMessage === "function") {
			await pi.sendUserMessage(text, { attribution: "user" });
			return { ok: true };
		}
		station?.endGoalSession?.();
		return { ok: false, code: "GOAL_DELIVERY_FAILED", message: "the host cannot send a user message" };
	} catch (error) {
		record("tickets", error, { kind: "goal-prompt", chars: text.length });
		station?.endGoalSession?.();
		return { ok: false, code: "GOAL_DELIVERY_FAILED", message: String(error?.message ?? error) };
	}
}

/**
 * Run one `/herd-goal` command against the official goal.
 *
 * `spec` is the station's parsed intent: `{ kind: "off" }` or
 * `{ kind: "goal", text, epoch, skipPrompt? }`. The station commits its relay
 * only through `commitGoalSession`, after the official goal accepted the
 * objective, so the two states cannot disagree.
 */
export async function goalSessionTicket(pi, ctx, spec, station = null) {
	try {
		const kind = spec?.kind === "goal" ? "goal" : "off";
		if (kind === "off") {
			if (canControlModes(ctx)) {
				const status = goalStatusOf(ctx?.sessionModes?.getState?.()?.goal);
				if (status === "active" || status === "paused") await dropModes(ctx);
			} else {
				const { runtime } = sessionRuntimeOf(ctx);
				if (runtime) await dropRuntime(ctx);
			}
			return { ok: true, kind: "off", changed: true, goal: false, message: "goal mode off" };
		}

		const text = typeof spec?.text === "string" ? spec.text.trim() : "";
		if (text === "") {
			return { ok: false, code: "GOAL_TEXT_REQUIRED", message: "goal mode needs an instruction" };
		}
		const epoch = spec?.epoch;
		const skipPrompt = spec?.skipPrompt === true;

		if (canControlModes(ctx)) {
			const current = ctx?.sessionModes?.getState?.()?.goal ?? null;
			const status = goalStatusOf(current);
			const sameObjective =
				status === "active" &&
				typeof current?.objective === "string" &&
				current.objective.trim() === text &&
				!current?.tokenBudget;
			if (!sameObjective && (status === "active" || status === "paused")) {
				const dropped = await dropModes(ctx);
				if (!dropped) {
					return {
						ok: false,
						code: "GOAL_DROP_FAILED",
						message: "failed to drop the running official /goal",
					};
				}
			}
			let entered;
			try {
				// Enter is always attempted, even when the objective already
				// matches: the host answers `changed: false` for an idempotent
				// call, and a refusal proves the goal is not actually armed.
				entered = await ctx.sessionModes.set({ mode: "goal", action: "enter", objective: text });
			} catch (error) {
				record("tickets", error, { kind: "goal-enter" });
				return { ok: false, code: "GOAL_ENTER_FAILED", message: String(error?.message ?? error) };
			}
			if (entered?.ok !== true) {
				return {
					ok: false,
					code: typeof entered?.code === "string" && entered.code ? entered.code : "GOAL_ENTER_FAILED",
					message: messageOf(entered) ?? "failed to set the official /goal",
				};
			}
			const committed = station?.commitGoalSession?.({ epoch, officialActive: true }) ?? { committed: true };
			if (!committed?.committed) {
				await dropModes(ctx);
				return { ok: false, code: "GOAL_STALE", message: "goal command superseded" };
			}
			if (!skipPrompt) {
				const delivered = await deliverFirstTurn(pi, ctx, text, station);
				if (!delivered.ok) {
					await dropModes(ctx);
					return delivered;
				}
			}
			return {
				ok: true,
				kind: "goal",
				text,
				goal: true,
				officialGoal: true,
				message: "goal started (official /goal set; herd runs first, the official goal backs up after the final answer)",
			};
		}

		const { session, runtime } = sessionRuntimeOf(ctx);
		if (runtime) {
			const current = runtime.getState?.() ?? session?.getGoalModeState?.() ?? null;
			const status = goalStatusOf(current?.goal);
			if (status === "active") {
				const same =
					typeof current?.goal?.objective === "string" &&
					current.goal.objective.trim() === text &&
					!current?.goal?.tokenBudget;
				if (!same) {
					try {
						await runtime.replaceGoal({ objective: text });
					} catch (error) {
						record("tickets", error, { kind: "goal-replace" });
						return { ok: false, code: "GOAL_ENTER_FAILED", message: String(error?.message ?? error) };
					}
				}
			} else if (status === "paused") {
				try {
					await runtime.dropGoal();
					await runtime.createGoal({ objective: text });
				} catch (error) {
					record("tickets", error, { kind: "goal-create" });
					return { ok: false, code: "GOAL_ENTER_FAILED", message: String(error?.message ?? error) };
				}
			} else {
				try {
					await runtime.createGoal({ objective: text });
				} catch (error) {
					record("tickets", error, { kind: "goal-create" });
					return { ok: false, code: "GOAL_ENTER_FAILED", message: String(error?.message ?? error) };
				}
			}
			const nextState = runtime.getState?.() ?? null;
			session?.setGoalModeState?.(nextState);
			const goalId = nextState?.goal?.id ?? null;
			const committed = station?.commitGoalSession?.({ epoch, officialActive: true, goalId }) ?? { committed: true };
			if (!committed?.committed) {
				try {
					await runtime.dropGoal();
					session?.setGoalModeState?.(undefined);
				} catch (error) {
					record("tickets", error, { kind: "goal-rollback" });
				}
				return { ok: false, code: "GOAL_STALE", message: "goal command superseded" };
			}
			if (!skipPrompt) {
				const delivered = await deliverFirstTurn(pi, ctx, text, station);
				if (!delivered.ok) {
					await dropRuntime(ctx);
					return delivered;
				}
			}
			return {
				ok: true,
				kind: "goal",
				text,
				goal: true,
				officialGoal: true,
				message: "goal started (official /goal set via GoalRuntime; herd runs first, the official goal backs up after the final answer)",
			};
		}

		const committed = station?.commitGoalSession?.({ epoch, officialActive: false }) ?? { committed: true };
		if (!committed?.committed) {
			return { ok: false, code: "GOAL_STALE", message: "goal command superseded" };
		}
		if (!skipPrompt) {
			const delivered = await deliverFirstTurn(pi, ctx, text, station);
			if (!delivered.ok) return delivered;
		}
		return {
			ok: true,
			kind: "goal",
			text,
			goal: true,
			officialGoal: false,
			message: "goal started (official goal unavailable in this session; herd-only)",
		};
	} catch (error) {
		record("tickets", error, { kind: "goal" });
		return { ok: false, code: "GOAL_TICKET_FAILED", message: String(error?.message ?? error) };
	}
}

function formatGoalReceipt(state, herdPhase, report = null) {
	const goal = state?.goal ?? null;
	const lines = [];
	if (!goal) {
		lines.push("No active goal.");
	} else {
		lines.push(`Goal: ${typeof goal.objective === "string" ? goal.objective : "(unnamed)"}`);
		lines.push(`Status: ${goal.status ?? "unknown"}`);
		const budget =
			typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget)
				? ` / ${goal.tokenBudget}`
				: "";
			lines.push(`Tokens: ${goal.tokensUsed ?? goal.tokenUsage?.total ?? 0}${budget}`);
	}
	if (report) lines.push(`Completion: ${report}`);
	if (typeof herdPhase === "string" && herdPhase !== "") {
		lines.push(`Herd phase: ${herdPhase}`);
	}
	return lines.join("\n");
}

function goalStateAfter(runtime, session, fallback) {
	return runtime?.getState?.() ?? session?.getGoalModeState?.() ?? fallback;
}

/**
 * The wrapped `api.goal` implementation.
 *
 * It never uses `sessionModes`, because a mode transition refuses `busy` while
 * a turn streams; the runtime is the in-turn surface for the same goal.
 */
export async function executeWrappedGoalTool(args, ctx, station = null, nativeTool = null, call = {}) {
	try {
		const op = typeof args?.op === "string" ? args.op.trim() : "";
		if (typeof station?.checkGoalToolCall === "function") {
			const gate = station.checkGoalToolCall(op);
			if (gate?.allowed === false) {
				return {
					content: [{ type: "text", text: gate.reason ?? "This goal operation is not allowed now." }],
					details: { op, blocked: true, herdPhase: gate.phase ?? null },
				};
			}
		}
		const { session, runtime } = sessionRuntimeOf(ctx);
		if (!runtime) {
			if (nativeTool && typeof nativeTool.execute === "function") {
				const result = await nativeTool.execute(call.callId, args, call.signal, call.onUpdate, ctx);
				// The host tool owns the goal, so the station mirrors the effect
				// it just produced instead of trusting a state this scope cannot
				// read back.
				if (op === "complete" || op === "drop") {
					station?.onOfficialGoalUpdated?.(
						{ status: op === "complete" ? "complete" : "dropped" },
						{ enabled: false, goal: { status: op === "complete" ? "complete" : "dropped" } },
					);
				} else if (op === "create" || op === "pause" || op === "resume") {
					const status = op === "create" ? "active" : op === "pause" ? "paused" : "active";
					station?.onOfficialGoalUpdated?.(
						{ status },
						{ enabled: status === "active", goal: { status } },
					);
				}
				return result;
			}
			return {
				content: [{ type: "text", text: "Official goal runtime is not available in this session." }],
				isError: true,
			};
		}
		if (!GOAL_OPS.has(op)) {
			return {
				content: [
					{
						type: "text",
						text: 'Invalid goal op. Use "create", "get", "complete", "pause", "resume", or "drop".',
					},
				],
				isError: true,
			};
		}

		if (op === "get") {
			const state = goalStateAfter(runtime, session, null);
			return { content: [{ type: "text", text: formatGoalReceipt(state, station?.goalPhase?.() ?? null) }] };
		}

		if (op === "create") {
			const objective = typeof args?.objective === "string" ? args.objective.trim() : "";
			const rawBudget = args?.token_budget ?? args?.tokenBudget;
			const tokenBudget =
				Number.isInteger(rawBudget) && rawBudget > 0 ? rawBudget : undefined;
			if (objective === "") {
				return { content: [{ type: "text", text: "Goal creation needs a non-empty objective." }], isError: true };
			}
			if (rawBudget !== undefined && tokenBudget === undefined) {
				return { content: [{ type: "text", text: "token_budget must be a positive integer." }], isError: true };
			}
			await runtime.createGoal({ objective, ...(tokenBudget ? { tokenBudget } : {}) });
			const state = goalStateAfter(runtime, session, null);
			session?.setGoalModeState?.(state);
			station?.onOfficialGoalUpdated?.(state?.goal ?? null, state);
			return { content: [{ type: "text", text: formatGoalReceipt(state, station?.goalPhase?.() ?? null) }] };
		}

		if (op === "complete") {
			const result = await runtime.completeGoalFromTool();
			const state = goalStateAfter(runtime, session, {
				enabled: false,
				mode: "exiting",
				goal: { ...(result?.goal ?? {}), status: "complete" },
			});
			session?.setGoalModeState?.(state);
			station?.onOfficialGoalUpdated?.(state?.goal ?? { status: "complete" }, state);
			return {
				content: [
					{
						type: "text",
						text: formatGoalReceipt(
							state,
							station?.goalPhase?.() ?? null,
							typeof result?.completionBudgetReport === "string"
								? result.completionBudgetReport
								: null,
						),
					},
				],
			};
		}

		if (op === "pause") {
			await runtime.pauseGoal();
			const state = goalStateAfter(runtime, session, null);
			session?.setGoalModeState?.(state);
			station?.onOfficialGoalUpdated?.(state?.goal ?? { status: "paused" }, state);
			return { content: [{ type: "text", text: formatGoalReceipt(state, station?.goalPhase?.() ?? null) }] };
		}

		if (op === "resume") {
			await runtime.resumeGoal();
			const state = goalStateAfter(runtime, session, null);
			session?.setGoalModeState?.(state);
			station?.onOfficialGoalUpdated?.(state?.goal ?? { status: "active" }, state);
			return { content: [{ type: "text", text: formatGoalReceipt(state, station?.goalPhase?.() ?? null) }] };
		}

		await runtime.dropGoal();
		session?.setGoalModeState?.(undefined);
		station?.onOfficialGoalUpdated?.({ status: "dropped" }, { enabled: false, goal: { status: "dropped" } });
		return {
			content: [{ type: "text", text: formatGoalReceipt({ goal: null }, station?.goalPhase?.() ?? null) }],
		};
	} catch (error) {
		record("tickets", error, { kind: "goal-tool" });
		return {
			content: [{ type: "text", text: `Goal operation failed: ${String(error?.message ?? error)}` }],
			isError: true,
		};
	}
}

function notifyResult(ctx, result) {
	if (typeof ctx?.ui?.notify !== "function") return;
	if (typeof result?.message !== "string" || result.message === "") return;
	ctx.ui.notify(result.message, result.ok === false ? "error" : "info");
}

/**
 * `pi.on("input")`: the alias and the non-TUI control surface.
 *
 * In an interactive TUI `/goal` executes natively and `/herd-goal set` is
 * rewritten to `/goal set ...`, so the official command owns the objective and
 * `goal_updated` arms or drops the herd session. Outside a TUI there is no
 * official command, so the runtime is driven directly.
 */
export async function handleGoalInput(event, ctx, station, pi) {
	try {
		if (!station || station.portTable?.herd !== "on") return undefined;
		if (typeof event?.text !== "string") return undefined;
		const parsed = parseGoalSlash(event.text);
		if (!parsed) return undefined;

		if (canControlModes(ctx)) {
			if (parsed.command === "goal") return undefined;
			if (parsed.action === "set") {
				const status = goalStatusOf(ctx?.sessionModes?.getState?.()?.goal);
				if (status === "paused") {
					const dropped = await dropModes(ctx);
					if (!dropped) {
						ctx?.ui?.notify?.("failed to drop the paused official /goal", "error");
						return { handled: true };
					}
				}
				return { text: `/goal set ${parsed.text}` };
			}
			if (parsed.action === "off" || parsed.action === "drop") {
				const result = await station.onGoalCommand("", ctx);
				notifyResult(ctx, result);
				return { handled: true };
			}
			// pause / resume / show / budget / menu keep the official grammar:
			// rewrite, and let the built-in command own the transition.
			const tail = parsed.text === "" ? "" : ` ${parsed.text}`;
			return { text: `/goal ${parsed.action}${tail}` };
		}

		if (parsed.action === "set") {
			const result = await station.onGoalCommand(parsed.text, ctx);
			notifyResult(ctx, result);
			return { handled: true };
		}
		if (parsed.action === "off" || parsed.action === "drop") {
			const result = await station.onGoalCommand("", ctx);
			notifyResult(ctx, result);
			return { handled: true };
		}
		const { session, runtime } = sessionRuntimeOf(ctx);
		if (!runtime) {
			ctx?.ui?.notify?.("Official goal runtime is not available in this session.", "error");
			return { handled: true };
		}
		if (parsed.action === "pause") await runtime.pauseGoal();
		else if (parsed.action === "resume") await runtime.resumeGoal();
		else if (parsed.action === "budget") {
			const value = parsed.text.trim().toLowerCase();
			const budget = value === "off" || value === "" ? undefined : Number(value);
			if (budget !== undefined && (!Number.isInteger(budget) || budget <= 0)) {
				ctx?.ui?.notify?.("token budget must be a positive integer or off", "error");
				return { handled: true };
			}
			if (typeof runtime.setTokenBudget === "function") await runtime.setTokenBudget(budget);
		}
		const state = runtime.getState?.() ?? session?.getGoalModeState?.() ?? null;
		session?.setGoalModeState?.(state);
		station.onOfficialGoalUpdated?.(state?.goal ?? null, state);
		ctx?.ui?.notify?.(formatGoalReceipt(state, station?.goalPhase?.() ?? null), "info");
		return { handled: true };
	} catch (error) {
		record("tickets", error, { kind: "goal-input" });
		ctx?.ui?.notify?.(`goal input failed: ${String(error?.message ?? error)}`, "error");
		return { handled: true };
	}
}

/**
 * Print mode has no `input` hook. This synchronous check decides whether the
 * first prompt itself carries `/goal set ...`, so the normal path stays
 * synchronous and the preload happens only when it is needed.
 */
export function shouldActivatePrintGoal(event, ctx, station) {
	try {
		if (canControlModes(ctx)) return null;
		if (!station || station.portTable?.herd !== "on") return null;
		const direct = typeof event?.prompt === "string" ? event.prompt : event?.text;
		const text =
			typeof direct === "string" && direct.trim() !== ""
				? direct
				: lastUserMessageText(ctx);
		const parsed = parseGoalSlash(text);
		if (!parsed || parsed.command !== "goal" || parsed.action !== "set" || parsed.text === "") {
			return null;
		}
		const { runtime } = sessionRuntimeOf(ctx);
		if (!runtime) return null;
		const current = runtime.getState?.() ?? null;
		const status = goalStatusOf(current?.goal);
		const same =
			status === "active" &&
			typeof current?.goal?.objective === "string" &&
			current.goal.objective.trim() === parsed.text;
		return same ? null : parsed;
	} catch (error) {
		record("tickets", error, { kind: "goal-print-check" });
		return null;
	}
}

/** Arm the goal for a print-mode prompt that is already starting its turn. */
export async function activatePrintGoalFromPrompt(parsed, ctx, station) {
	try {
		const { session, runtime } = sessionRuntimeOf(ctx);
		if (!runtime) return false;
		const current = runtime.getState?.() ?? null;
		const status = goalStatusOf(current?.goal);
		if (status === "active") await runtime.replaceGoal({ objective: parsed.text });
		else if (status === "paused") {
			await runtime.dropGoal();
			await runtime.createGoal({ objective: parsed.text });
		} else await runtime.createGoal({ objective: parsed.text });
		const state = runtime.getState?.() ?? null;
		session?.setGoalModeState?.(state);
		station?.commitGoalSession?.({
			epoch: station?.nextGoalEpoch?.() ?? null,
			officialActive: true,
			goalId: state?.goal?.id ?? null,
		});
		session?.sendGoalModeContext?.({ deliverAs: "steer" });
		return true;
	} catch (error) {
		record("tickets", error, { kind: "goal-print-activate" });
		return false;
	}
}

/** Observe the official goal for `session_stop`; pure, never mutates. */
export function observeOfficialGoalForStop(ctx) {
	try {
		const { session, runtime } = sessionRuntimeOf(ctx);
		const modeGoal = ctx?.sessionModes?.getState?.()?.goal ?? null;
		const state = runtime?.getState?.() ?? session?.getGoalModeState?.() ?? null;
		const active = goalStatusOf(modeGoal) === "active" || goalStatusOf(state?.goal) === "active";
		const interactive = hasInteractiveContinuationDriver(ctx, session);
		const prompt =
			active && !interactive && typeof runtime?.buildContinuationPrompt === "function"
				? runtime.buildContinuationPrompt()
				: null;
		return { officialGoalActive: active, officialContinuationPrompt: prompt };
	} catch (error) {
		record("tickets", error, { kind: "goal-stop-observe" });
		return { officialGoalActive: false, officialContinuationPrompt: null };
	}
}

/** The text of the last user message a session already holds, if any. */
function lastUserMessageText(ctx) {
	try {
		const { session } = sessionRuntimeOf(ctx);
		const messages = session?.agent?.state?.messages;
		if (!Array.isArray(messages)) return null;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "user") continue;
			const content = message.content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return null;
			const text = content
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("");
			return text.trim() === "" ? null : text;
		}
		return null;
	} catch {
		return null;
	}
}

/** The preload is needed only while `js` exists and `goal` does not. */
export function needsGoalPreload(ctx) {
	try {
		const { session } = sessionRuntimeOf(ctx);
		const enabled = session?.getEnabledToolNames?.();
		return Boolean(
			Array.isArray(enabled) &&
				enabled.includes("js") &&
				!enabled.includes("goal") &&
				typeof session?.setActiveToolsByName === "function",
		);
	} catch {
		return false;
	}
}

/** Add `goal` to the active roster without a provider-request rewrite. */
export async function preloadOfficialGoalTool(ctx) {
	try {
		const { session } = sessionRuntimeOf(ctx);
		const enabled = session?.getEnabledToolNames?.();
		if (!Array.isArray(enabled) || typeof session?.setActiveToolsByName !== "function") return false;
		if (enabled.includes("goal")) return false;
		await session.setActiveToolsByName([...enabled, "goal"]);
		return true;
	} catch (error) {
		record("tickets", error, { kind: "goal-preload" });
		return false;
	}
}
