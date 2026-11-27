// The one host shape a station reads, and the one merge rule for the two
// producers of it (the composition root's bag and the constructor argument).
//
// The interface is grouped by role: `session`, `model`, `tools`, `accounting`,
// `fork`, `report`. Every group is always present and every declared key is
// always a property, so a reader calls `host.session.branch?.(ctx)` without a
// shape probe of its own. A missing capability is `undefined`, never a second
// spelling of the same name.
//
// This module is pure: it reads the object it is given and copies no state.

export function mergeHost(fromRegistry, fromConstructor) {
	if (!fromRegistry) return fromConstructor ?? null;
	if (!fromConstructor) return fromRegistry;
	return { ...fromConstructor, ...fromRegistry };
}

export function shapeHost(host) {
	const source = host && typeof host === "object" ? host : {};
	const session = source.session ?? {};
	const model = source.model ?? {};
	const tools = source.tools ?? {};
	const accounting = source.accounting ?? {};
	const fork = source.fork ?? {};
	const report = source.report ?? {};
	const pricing = accounting.pricing;
	return {
		session: {
			managerOf: session.managerOf,
			conversationKey: session.conversationKey,
			branch: session.branch,
			agent: session.agent,
			header: session.header,
			setMessages: session.setMessages,
			appendHistory: session.appendHistory,
			settingsOf: session.settingsOf,
			abort: session.abort,
			canRewindRoot: session.canRewindRoot,
		},
		model: {
			of: model.of,
			thinkingOf: model.thinkingOf,
			parseSpec: model.parseSpec,
			capabilities: model.capabilities,
			query: model.query,
		},
		// The confiscated tools. A host that predates this seam leaves both
		// undefined, and the js runtime then binds only the control plane.
		tools: {
			listSpecs: tools.listSpecs,
			execute: tools.execute,
		},
		accounting: {
			usage: accounting.usage,
			pricing: pricing && {
				...pricing,
				emptyCatalog: pricing.emptyCatalog,
			},
		},
		fork: {
			wiring: fork.wiring,
			attachBaseForkPorts: fork.attachBaseForkPorts,
			identityForAgent: fork.identityForAgent,
			agentIdOf: fork.agentIdOf,
			sameManager: fork.sameManager,
			ledgerFor: fork.ledgerFor,
			adoptLedger: fork.adoptLedger,
		},
		report: { record: report.record },
	};
}
