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
];
