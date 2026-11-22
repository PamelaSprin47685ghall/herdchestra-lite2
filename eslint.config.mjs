// Ticket Station Method enforcement.
//
// AGENTS.md §2.1 states the station rule as a hard, statically checkable
// constraint: a station method is a plain synchronous function. These three
// domains own stations, ticket capabilities, and relay state transitions, so
// an `async` or `await` that appears here is a design error, not a style
// preference. Awarding the rule a permanent home keeps it true after the
// current authors are gone.

const stationRule = {
	selector: "FunctionDeclaration[async=true]",
	message:
		"A station method is a plain synchronous function. Move the wait into a ticket (AGENTS.md §2.1).",
};

const noAsync = {
	selector: "ArrowFunctionExpression[async=true]",
	message:
		"A station method is a plain synchronous function. Move the wait into a ticket (AGENTS.md §2.1).",
};

const noFunctionExpressionAsync = {
	selector: "FunctionExpression[async=true]",
	message:
		"A station method is a plain synchronous function. Move the wait into a ticket (AGENTS.md §2.1).",
};

const noAwait = {
	selector: "AwaitExpression",
	message:
		"Stations never await. Return or hand off the ticket Promise instead (AGENTS.md §2.1).",
};

const noForAwait = {
	selector: "ForOfStatement[await=true]",
	message:
		"Stations never await. Move the loop into a ticket (AGENTS.md §2.1).",
};

export default [
	{
		files: ["src/station/**/*.mjs", "src/scope/**/*.mjs", "src/relay/**/*.mjs"],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: "module",
		},
		rules: {
			"no-dupe-class-members": "error",
			"no-restricted-syntax": [
				"error",
				stationRule,
				noAsync,
				noFunctionExpressionAsync,
				noAwait,
				noForAwait,
			],
		},
	},
	{
		// The Station class and its domain modules receive host capabilities
		// through `registry.host()`. The registry is the composition bridge and
		// the only station file allowed to import the host layer; every other
		// station file is host-free. The ratchet test enforces the same rule.
		files: ["src/station/**/*.mjs"],
		ignores: ["src/station/registry.mjs"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["../host/*", "../../host/*"],
							message:
								"Station code receives host capabilities through the registry's host() bag; a direct host import is a layering error.",
						},
					],
				},
			],
		},
	},
];
