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
		// `deer-flow` is a git submodule (bytedance/deer-flow) with its own pnpm
		// toolchain and its own eslint config. ESLint 10 looks for a config
		// beside each linted file, so without this global ignore `eslint .`
		// loads `deer-flow/frontend/eslint.config.js` and dies on that
		// submodule's uninstalled dependencies. The root test script draws the
		// same line with `--path-ignore-patterns 'deer-flow/**'`.
		ignores: ["deer-flow/**"],
	},
	{
		// `src/scope/fork-registry.mjs` is the session-wide waiter: its Promises
		// are what a ticket parks on, not a station method. Every other file in
		// these three domains stays synchronous.
		ignores: ["src/scope/fork-registry.mjs"],
		files: [
			"src/station/**/*.mjs",
			"src/scope/**/*.mjs",
			"src/relay/**/*.mjs",
			"src/wiring/**/*.mjs",
		],
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
		// The core package is host-agnostic by construction: it receives host
		// capabilities through an injected bag, and the host package supplies
		// them. A direct host import in core is a layering error, not a style
		// preference. The ratchet test enforces the same rule on the file tree.
		files: ["src/**/*.mjs"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: [
								"../host/*",
								"../../host/*",
								"**/host/*",
								"../activation/*",
								"../../activation/*",
								"@oh-my-pi/*",
								"herdchestra-host-omp",
								"herdchestra-host-omp/*",
							],
							message:
								"Core code receives host capabilities through an injected bag; a direct host import is a layering error.",
						},
					],
				},
			],
		},
	},
	{
		// The domain layer points one way. A station calls into the domain, and a
		// ticket may call both; the domain never reaches back into a station, a
		// tool, or the wiring that assembles them. That single rule is what keeps
		// this directory a domain instead of a second composition root.
		files: ["src/scope/**/*.mjs"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: [
								"../station/*",
								"../../station/*",
								"../tools/*",
								"../../tools/*",
								"../wiring/*",
								"../../wiring/*",
							],
							message:
								"The domain layer never imports a station, a tool, or the wiring; those depend on it, not the reverse.",
						},
						{
							group: [
								"../host/*",
								"../../host/*",
								"**/host/*",
								"../activation/*",
								"../../activation/*",
								"@oh-my-pi/*",
								"herdchestra-host-omp",
								"herdchestra-host-omp/*",
							],
							message:
								"Core code receives host capabilities through an injected bag; a direct host import is a layering error.",
						},
					],
				},
			],
		},
	},
	{
		// The host package may speak to omp, but it reaches the core by package
		// name. A relative escape into `../src/` would make the dependency
		// decorative and let the two packages drift back into one tree.
		files: ["host-omp/src/**/*.mjs"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["../src/*", "../../src/*", "../../../src/*"],
							message:
								"Import the core by package name (`herdchestra-lite2`), never by a relative path.",
						},
					],
				},
			],
		},
	},
	{
		// `host-omp-ui` is a separate plugin: it may bridge omp, but it must not
		// import the other host package, directly or by package name.
		files: ["host-omp-ui/src/**/*.mjs"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: [
								"herdchestra-host-omp",
								"herdchestra-host-omp/*",
								"../host-omp/*",
								"../../host-omp/*",
							],
							message:
								"host-omp-ui is a separate plugin; it must not import host-omp.",
						},
						{
							group: ["../src/*", "../../src/*", "../../../src/*"],
							message:
								"Import the core by package name (`herdchestra-lite2`), never by a relative path.",
						},
					],
				},
			],
		},
	},
	{
		// The UI bridge station is the same aggregate-root rule as the core:
		// every state transition is synchronous, waits belong to tickets.
		files: ["host-omp-ui/src/station/**/*.mjs"],
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
];
