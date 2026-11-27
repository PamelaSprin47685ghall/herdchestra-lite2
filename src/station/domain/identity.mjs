// Pure subscope identity and ledger resolution for fork wiring.

export function buildChildIdentity(spec = {}, deps = {}) {
	const callerId =
		typeof spec.callerId === "string"
			? spec.callerId
			: (typeof spec.parentOwnerId === "string" ? spec.parentOwnerId : null);
	return {
		forkId: typeof spec.forkId === "string" ? spec.forkId : null,
		callerId,
		parentOwnerId: callerId,
		path: typeof spec.path === "string" ? spec.path : null,
		upscopePath: typeof spec.upscopePath === "string" ? spec.upscopePath : null,
		callerPath: typeof spec.callerPath === "string" ? spec.callerPath : null,
		ownScopeId: typeof spec.ownScopeId === "string" ? spec.ownScopeId : null,
		fsm: typeof spec.fsm === "string" ? spec.fsm : null,
		budget:
			spec.budget && typeof spec.budget === "object" ? { ...spec.budget } : null,
		time: Number.isFinite(spec.time) && spec.time > 0 ? spec.time : null,
		targets: spec.targets ?? null,
		childDepth: Number.isInteger(spec.childDepth) ? spec.childDepth : null,
		agentId: typeof deps.agentId === "string" ? deps.agentId : null,
		display: deps.display ?? null,
		displayHolder: deps.displayHolder ?? null,
		ledger:
			deps.ledger && typeof deps.ledger === "object" ? deps.ledger : null,
		persistRoot:
			typeof deps.persistRoot === "function" ? deps.persistRoot : null,
	};
}
