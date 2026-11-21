// scope/batch: the same port, with many containers at once.
//
// The port still owns the stack and the budget arithmetic; what it does not own
// is the batch registry. That arrives as `registerBatch`, a function handed in
// by the composition root, so this file never imports the station and never
// reaches across ports. The same shape as folding's retired() lookup.
//
// Without that function the implementation refuses: a batch scope that cannot
// register a batch is not a batch scope, and pretending otherwise would report
// success for a container nobody can name.

const SCOPE_UNAVAILABLE = "SCOPE_UNAVAILABLE";

function refusal(code, detail) {
	return { ok: false, code, port: "scope", detail };
}

function copyCounts(source) {
	const out = {};
	for (const key of Object.keys(source ?? {})) out[key] = source[key];
	return out;
}

export function createBatchScope({ registerBatch } = {}) {
	const stack = [];
	const batches = new Map();
	let sequence = 0;

	function top() {
		return stack.length > 0 ? stack[stack.length - 1] : null;
	}

	return {
		name: "batch",

		begin(spec = {}) {
			const intent = typeof spec.intent === "string" ? spec.intent.trim() : "";
			if (intent === "") return refusal("INVALID_INTENT", "begin requires an intent");
			if (typeof registerBatch !== "function") {
				return refusal(
					"SCOPE_BATCH_UNAVAILABLE",
					"this scope has no batch registry, so no batch can open",
				);
			}
			const budget = copyCounts(spec.budget);
			for (const key of Object.keys(budget)) {
				if (!Number.isFinite(budget[key]) || budget[key] < 0) {
					return refusal("INVALID_BUDGET", `budget for ${key} must be a non-negative number`);
				}
			}
			const flows = Array.isArray(spec.fission) ? spec.fission : [];
			if (flows.length === 0) {
				return refusal("INVALID_FISSION", "a batch needs at least one flow");
			}
			let registered;
			try {
				registered = registerBatch({ intent, budget: copyCounts(budget), flows });
			} catch (error) {
				return refusal("BATCH_REFUSED", String(error?.message ?? error));
			}
			if (registered?.ok === false) {
				return registered;
			}
			sequence += 1;
			const scope = {
				id: typeof registered?.batchId === "string" ? registered.batchId : `batch-${sequence}`,
				intent,
				budget,
				remaining: copyCounts(budget),
				spent: Object.fromEntries(Object.keys(budget).map((key) => [key, 0])),
				parent: top()?.id ?? null,
				flows: flows.length,
			};
			stack.push(scope);
			batches.set(scope.id, scope);
			return { ok: true, scope };
		},

		end() {
			if (stack.length === 0) return refusal("NOT_IN_SCOPE", "no scope is open");
			const scope = stack.pop();
			return { ok: true, scope };
		},

		charge(amounts = {}) {
			const scope = top();
			if (scope === null) {
				return refusal("NOT_IN_SCOPE", "nothing can be charged without a scope");
			}
			for (const [tool, wanted] of Object.entries(amounts)) {
				const available = scope.remaining[tool] ?? 0;
				if (!Number.isFinite(wanted) || wanted < 0) {
					return refusal("INVALID_CHARGE", `charge for ${tool} must be a non-negative number`);
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
					flows: scope.flows,
					budget: copyCounts(scope.budget),
					remaining: copyCounts(scope.remaining),
					spent: copyCounts(scope.spent),
				},
			};
		},
	};
}
