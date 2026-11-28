// Official goal bridge: the pure decisions for omp's built-in goal mode.
//
// Herd runs first. Its nudge-and-rewind workflow owns the root until the seal,
// and only then does the official goal continue on its own. These functions are
// the whole decision surface: they parse the two slash commands, decide when the
// official report re-arms or ends the herd session, and decide whether the
// wrapped `api.goal` may complete. Pure only: no I/O, no Station import, no
// host import, no `this`, no `async`.

/**
 * Parse `/herd-goal` and `/goal` as one grammar.
 *
 * Returns `null` for anything that is not exactly one of those commands: a
 * prefix of another word (`/goals`, `/goalie`) is not a command. Subcommand
 * names are case-insensitive; the instruction text keeps its original casing.
 */
export function parseOfficialGoalInput(text) {
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	const match = /^\/(herd-goal|goal)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return null;
	const command = match[1].toLowerCase();
	const rest = (match[2] ?? "").trim();
	if (command === "herd-goal") {
		return rest === ""
			? { command, action: "off", text: "" }
			: { command, action: "set", text: rest };
	}
	if (rest === "") return { command, action: "menu", text: "" };
	const split = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(rest);
	const word = split ? split[1].toLowerCase() : "";
	const tail = split ? (split[2] ?? "").trim() : "";
	switch (word) {
		case "set":
			return tail === ""
				? { command, action: "menu", text: "" }
				: { command, action: "set", text: tail };
		case "drop":
			return { command, action: "drop", text: "" };
		case "pause":
			return { command, action: "pause", text: "" };
		case "resume":
			return { command, action: "resume", text: "" };
		case "show":
			return { command, action: "show", text: "" };
		case "budget":
			return { command, action: "budget", text: tail };
		default:
			// An unrecognised first word is the objective itself, as the
			// official command treats it.
			return { command, action: "set", text: rest };
	}
}

/** True when any message in the list is omp's hidden goal-continuation turn. */
export function isOfficialGoalContinuationTurn(messages) {
	return (
		Array.isArray(messages) &&
		messages.some(
			(message) =>
				message?.role === "custom" && message?.customType === "goal-continuation",
		)
	);
}

/**
 * Canonical JSON for one digest entry.
 *
 * The digest must not change because two objects were built with the same keys
 * in a different order, and it must not throw on a circular value, a function,
 * or `undefined`. Those are the only reasons this exists instead of
 * `JSON.stringify`.
 */
function canonical(value, seen) {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "bigint") return JSON.stringify(String(value));
	if (typeof value !== "object") return "null";
	if (seen.has(value)) return JSON.stringify("[Circular]");
	seen.add(value);
	let text;
	if (Array.isArray(value)) {
		text = `[${value.map((entry) => canonical(entry, seen)).join(",")}]`;
	} else {
		const keys = Object.keys(value).sort();
		text = `{${keys
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`)
			.join(",")}}`;
	}
	seen.delete(value);
	return text;
}

/**
 * Deterministic digest of the tool activity a goal turn performed.
 *
 * The shape matches omp's own `goalContinuationActivity`: one entry per
 * assistant tool call and one per tool result, in transcript order. An empty
 * string means the turn did no tool work at all.
 */
export function officialGoalActivityDigest(messages) {
	if (!Array.isArray(messages)) return "";
	const entries = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type !== "toolCall") continue;
				entries.push(canonical(["call", block.name, block.arguments], new Set()));
			}
			continue;
		}
		if (message.role === "toolResult") {
			entries.push(
				canonical(
					["result", message.toolName, message.content, message.isError === true],
					new Set(),
				),
			);
		}
	}
	return entries.join(":");
}

/** Official goal mode is active when it reports `active` and is not disabled. */
export function isOfficialGoalStatusActive(status, enabled) {
	return status === "active" && enabled !== false;
}

/**
 * Decide what one official-goal report means for the herd session.
 *
 * An active official goal arms the herd workflow (or re-arms it when the host
 * reports a different goal id). A terminal status ends it even in Phase 1; a
 * merely inactive or paused goal ends it only once Phase 2 has begun, because
 * Phase 1 still owns the work and a paused goal must not evict the herd seal.
 */
export function decideOfficialGoalChange({
	herdEnabled = true,
	relayGoal = false,
	goalFallback = false,
	officialGoalActive = false,
	lastOfficialGoalId = null,
	goalId = null,
	status = null,
	enabled = undefined,
} = {}) {
	const officialActive = isOfficialGoalStatusActive(status, enabled);
	if (officialActive === true) {
		const replaced =
			goalId !== null && lastOfficialGoalId !== null && goalId !== lastOfficialGoalId;
		const enterHerdGoal = herdEnabled === true && (relayGoal !== true || replaced);
		return {
			officialActive: true,
			enterHerdGoal,
			exitHerdGoal: false,
			nextGoalId: goalId ?? lastOfficialGoalId ?? null,
		};
	}
	const terminal = status === "dropped" || status === "complete";
	const exitHerdGoal = relayGoal === true && (terminal || goalFallback === true);
	const clearId = terminal || status === "inactive" || status === null;
	return {
		officialActive: false,
		enterHerdGoal: false,
		exitHerdGoal,
		nextGoalId: clearId ? null : (goalId ?? lastOfficialGoalId ?? null),
	};
}

/**
 * Decide what one `agent_end` means for the official goal fallback.
 *
 * Only a goal-continuation turn is judged: it ends the herd session when it did
 * no tool work or repeated the previous continuation turn's work exactly.
 * `nextActivity` carries the digest forward; `null` clears it after an exit.
 */
export function decideFallbackAgentEnd({
	relayGoal = false,
	goalFallback = false,
	messages = null,
	previousActivity = null,
} = {}) {
	if (relayGoal !== true || goalFallback !== true || !isOfficialGoalContinuationTurn(messages)) {
		return {
			isContinuation: false,
			activity: null,
			exitHerdGoal: false,
			nextActivity: previousActivity ?? null,
		};
	}
	const activity = officialGoalActivityDigest(messages);
	const repeated =
		previousActivity !== null &&
		previousActivity !== undefined &&
		activity === previousActivity;
	if (activity.length === 0 || repeated) {
		return { isContinuation: true, activity, exitHerdGoal: true, nextActivity: null };
	}
	return { isContinuation: true, activity, exitHerdGoal: false, nextActivity: activity };
}

/**
 * Decide whether Phase 2 should drive its own next turn or stop.
 *
 * omp's continuation is available only on an interactive TUI. Everywhere else
 * this returns the prompt to repeat so the host can start the next turn itself;
 * an empty prompt, or no active official goal, ends the herd session instead.
 */
export function decideSelfDrivenFallbackStop({
	relayGoal = false,
	goalFallback = false,
	officialGoalActive = false,
	continuationPrompt = null,
	messages = null,
	messageCursor = null,
	previousActivity = null,
} = {}) {
	if (relayGoal !== true || goalFallback !== true) {
		return { action: "none", activity: null, nextCursor: messageCursor ?? null };
	}
	const prompt = typeof continuationPrompt === "string" ? continuationPrompt.trim() : "";
	if (officialGoalActive !== true || prompt === "") {
		return { action: "exit", activity: null, nextCursor: null };
	}
	const list = Array.isArray(messages) ? messages : [];
	const slice =
		typeof messageCursor === "number" && messageCursor >= 0 && messageCursor <= list.length
			? list.slice(messageCursor)
			: list;
	const activity = officialGoalActivityDigest(slice);
	const repeated =
		previousActivity !== null &&
		previousActivity !== undefined &&
		activity === previousActivity;
	if (activity.length === 0 || repeated) {
		return { action: "exit", activity, nextCursor: list.length };
	}
	return { action: "continue", prompt, activity, nextCursor: list.length };
}

/**
 * Decide whether the wrapped `api.goal` may run one op.
 *
 * Phase 1 owns the work, so `complete` is refused until the seal; unreceived
 * subscopes block every completion in every phase. Every other op is allowed and
 * the host's own goal mode decides whether it is meaningful.
 */
export function decideGoalToolCall({
	op = null,
	unreceived = 0,
	relayGoal = false,
	goalFallback = false,
} = {}) {
	const phase = relayGoal !== true ? "manual" : goalFallback === true ? "official_fallback" : "herd_priority";
	if (op === "complete") {
		if (unreceived > 0) {
			return {
				allowed: false,
				phase,
				reason: `Cannot complete goal while ${unreceived} forked subscope(s) remain unreceived. Join all subscopes first.`,
			};
		}
		if (relayGoal === true && goalFallback !== true) {
			return {
				allowed: false,
				phase,
				reason: 'Herd workflow runs first. Call scope_return with the seal oath and deliver FINAL_ANSWER first; then call api.goal({ op: "complete" }) during the official /goal fallback turn.',
			};
		}
	}
	return { allowed: true, phase, reason: null };
}
