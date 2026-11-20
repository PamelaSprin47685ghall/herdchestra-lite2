/**
 * Usage accounting for the native working line.
 *
 * Ported from ../HerdchestraLite/src/herd/main.cljs without host access:
 * every export here is deterministic and does no I/O.
 */

const BOLD_DIGITS = ["𝟬", "𝟭", "𝟮", "𝟯", "𝟰", "𝟱", "𝟲", "𝟳", "𝟴", "𝟵"];

/** Coerce a token or cost value to a finite number; nil and junk are zero. */
export function usageNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value === undefined || value === null) return 0;
	const number = Number(value);
	return Number.isNaN(number) ? 0 : number;
}

/** Return the first present field under any of the accepted aliases. */
export function usageField(usage, names) {
	if (!usage || typeof usage !== "object") return undefined;
	for (const name of names) {
		const value = usage[name];
		if (value !== undefined && value !== null) return value;
	}
	return undefined;
}

// Cost component names in billing order. A provider may report a total,
// component amounts, or both. The component sum is the fallback, so a
// provider that omits `total` still reports its real charge.
const COST_PARTS = [
	["input", "input_cost", "inputCost", "prompt"],
	["output", "output_cost", "outputCost", "completion"],
	["cacheRead", "cache_read", "cacheReadCost", "cache_read_cost"],
	["cacheWrite", "cache_write", "cacheWriteCost", "cache_write_cost"],
];

function costPartSum(cost) {
	let sum = 0;
	for (const names of COST_PARTS) {
		const value = usageField(cost, names);
		if (value !== undefined) sum += usageNumber(value);
	}
	return sum;
}

/** Read one call's charge. Never derive it from tokens and a model rate. */
export function usageCost(usage) {
	const cost = usage?.cost;
	if (typeof cost === "number") return usageNumber(cost);
	if (cost && typeof cost === "object") {
		const total = cost.total ?? usageField(cost, ["total_cost", "cost_total"]);
		if (total !== undefined) return usageNumber(total);
		return costPartSum(cost);
	}
	const totalCost = usageField(usage, ["total_cost", "totalCost", "cost_total"]);
	if (totalCost !== undefined) return usageNumber(totalCost);
	return 0;
}

/** Normalize one provider usage payload into the extension's shape. */
export function usageSnapshot(usage) {
	return {
		input: usageNumber(
			usageField(usage, ["input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]),
		),
		cacheRead: usageNumber(
			usageField(usage, [
				"cacheRead",
				"cache_read",
				"cache_read_input_tokens",
				"cacheReadInputTokens",
			]),
		),
		cacheWrite: usageNumber(
			usageField(usage, [
				"cacheWrite",
				"cache_write",
				"cache_creation_input_tokens",
				"cacheCreationInputTokens",
			]),
		),
		output: usageNumber(
			usageField(usage, [
				"output",
				"output_tokens",
				"outputTokens",
				"completion_tokens",
				"completionTokens",
			]),
		),
		cost: usageCost(usage),
	};
}

export function zeroUsage() {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
}

export function totalInput(snapshot) {
	return snapshot.input + snapshot.cacheRead + snapshot.cacheWrite;
}

/** Cache reads as a percentage of all input tokens. */
export function cacheRate(snapshot) {
	const total = totalInput(snapshot);
	return total > 0 ? 100.0 * (snapshot.cacheRead / total) : 0.0;
}

export function kFormat(tokens) {
	return `${(tokens / 1000).toFixed(1)}k`;
}

export function pctFormat(rate) {
	return `${rate.toFixed(1)}%`;
}

/** Replace ASCII digits with mathematical bold digits. */
export function boldNumber(text) {
	let out = "";
	for (const character of String(text)) {
		const digit = character.charCodeAt(0) - 48;
		out += digit >= 0 && digit <= 9 ? BOLD_DIGITS[digit] : character;
	}
	return out;
}

/** The exact working-line text used by Lite. */
export function usageLine(current, total) {
	return (
		`Δ: ${kFormat(totalInput(current))} × ${pctFormat(cacheRate(current))} ` +
		`→ ${kFormat(current.output)} [¥${boldNumber(current.cost.toFixed(3))}]; ` +
		`Σ: ${kFormat(totalInput(total))} × ${pctFormat(cacheRate(total))} ` +
		`→ ${kFormat(total.output)} [¥${boldNumber(total.cost.toFixed(3))}];`
	);
}

/** Add one snapshot into a mutable total. */
export function accumulateUsage(total, snapshot) {
	total.input += snapshot.input;
	total.cacheRead += snapshot.cacheRead;
	total.cacheWrite += snapshot.cacheWrite;
	total.output += snapshot.output;
	total.cost += snapshot.cost;
	return total;
}

/** Sum a list of mutable totals into a new total. */
export function totalUsage(snapshots) {
	const total = zeroUsage();
	for (const snapshot of snapshots) accumulateUsage(total, snapshot);
	return total;
}

/** Read the usage payload carried by a session branch entry. */
export function entryUsage(entry) {
	if (!entry || typeof entry !== "object") return undefined;
	if (entry.type === "message") {
		const message = entry.message;
		return message?.role === "assistant" ? message.usage : undefined;
	}
	if (entry.type === "model_usage") return entry.usage;
	return undefined;
}

/** Extract the `name NN` prefix from a session name, or return the name. */
export function sessionPrefix(name) {
	if (typeof name !== "string") return null;
	const match = /^(\S+) ([A-Z0-9]{1,6}): .*$/.exec(name);
	return match ? `${match[1]} ${match[2]}` : name;
}

/** Build `user@short-host`, or null when either part is blank. */
export function hostLabel(user, host) {
	if (typeof user !== "string" || typeof host !== "string") return null;
	if (!user.trim() || !host.trim()) return null;
	const shortHost = host.split(".")[0] ?? "";
	if (!shortHost) return null;
	return `${user}@${shortHost}`;
}
