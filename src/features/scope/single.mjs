// scope/single: one container, opened on the current session.
//
// The port owns the stack and the budget. It does not know about batches, and
// it never reads a switch: the wiring decides which implementation to use.
//
// Refusals are data with the shared code, so a caller handles one shape no
// matter which implementation it holds.

const SCOPE_UNAVAILABLE = "SCOPE_UNAVAILABLE";

function refusal(detail) {
	return { ok: false, code: SCOPE_UNAVAILABLE, port: "scope", detail };
}

function copyCounts(source) {
	const out = {};
	for (const key of Object.keys(source ?? {})) out[key] = source[key];
	return out;
}

function chargeKey(scope, tool) {
	return `${scope.id}:${tool}`;
}

export function createSingleScope() {
	const stack = [];
	let sequence = 0;

	function top() {
		return stack.length > 0 ? stack[stack.length - 1] : null;
	}

	return {
		name: "single",

		begin(spec = {}) {
			const intent = typeof spec.intent === "string" ? spec.intent.trim() : "";
			if (intent === "") return refusal("begin requires an intent");
			const budget = copyCounts(spec.budget);
			for (const key of Object.keys(budget)) {
				if (!Number.isFinite(budget[key]) || budget[key] < 0) {
					return refusal(`budget for ${key} must be a non-negative number`);
				}
			}
			sequence += 1;
			const scope = {
				id: `single-${sequence}`,
				intent,
				budget,
				remaining: copyCounts(budget),
				spent: Object.fromEntries(Object.keys(budget).map((key) => [key, 0])),
				parent: top()?.id ?? null,
			};
			stack.push(scope);
			return { ok: true, scope };
		},

		end() {
			if (stack.length === 0) return refusal("no scope is open");
			const scope = stack.pop();
			return { ok: true, scope };
		},

		charge(amounts = {}) {
			const scope = top();
			if (scope === null) return refusal("nothing can be charged without a scope");
			for (const [tool, wanted] of Object.entries(amounts)) {
				const available = scope.remaining[tool] ?? 0;
				if (!Number.isFinite(wanted) || wanted < 0) {
					return refusal(`charge for ${tool} must be a non-negative number`);
				}
				if (wanted > available) {
					return {
						ok: false,
						code: "BUDGET_EXHAUSTED",
						port: "scope",
						detail: `insufficient budget for ${tool}`,
						tool,
						available,
						wanted,
					};
				}
				scope.remaining[tool] = available - wanted;
				scope.spent[tool] = (scope.spent[tool] ?? 0) + wanted;
			}
			return { ok: true, remaining: copyCounts(scope.remaining) };
		},

		snapshot() {
			const scope = top();
			if (scope === null) return { ok: true, depth: 0, scope: null };
			return {
				ok: true,
				depth: stack.length,
				scope: {
					id: scope.id,
					intent: scope.intent,
					parent: scope.parent,
					budget: copyCounts(scope.budget),
					remaining: copyCounts(scope.remaining),
					spent: copyCounts(scope.spent),
				},
			};
		},
	};
}
