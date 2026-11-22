export function modelKey(model) {
	const id = model?.id ?? model?.model;
	return typeof id === "string" && id
		? model?.provider ? `${model.provider}/${id}` : id
		: null;
}

export function actualModel(ctx, host = null) {
	return host?.model?.of?.(ctx) ?? null;
}

function liveSelector(ctx, key, host = null) {
	const level = host?.model?.thinkingOf?.(ctx);
	return level ? `${key}:${level}` : key;
}

function modelChoice(station, ctx, spec, key) {
	const parsed = typeof spec === "string"
		? station.host?.model?.parseSpec?.(station.pricingCatalog, ctx, spec) ?? null
		: null;
	// The ledger is absent only on a station double that never measured usage.
	const live = actualModel(ctx, station.host) ?? station.usage?.lastCtxModel;
	// Only an exact resolution may name the model a later check expects. A
	// fuzzy match only estimates size and price. The host resolves roles and
	// aliases that the extension never sees.
	const resolvedKey =
		key ?? (parsed?.recognized && parsed?.exact ? parsed.canonicalKey : null);
	return {
		spec: spec ?? null,
		key: resolvedKey,
		pricing: parsed?.pricing,
		thinkingLevel: parsed?.thinkingLevel,
		window: parsed?.contextWindow ?? (resolvedKey && resolvedKey === modelKey(live) ? live?.contextWindow : null),
	};
}

function setChoice(state, scope, spec, key) {
	if (scope) {
		scope.modelSpec = spec;
		scope.modelKey = key;
	} else {
		state.baseModelSpec = spec;
		state.baseModelKey = key;
	}
}

export function observeActualModel(station, ctx) {
	const host = station.host;
	if (!station.hostCapabilities) {
		const caps = host?.model?.capabilities?.(ctx);
		if (caps) {
			station.hostCapabilities = caps;
			host.report?.record?.("host", "capabilities", caps);
		}
	}
	const live = actualModel(ctx, host);
	const key = modelKey(live);
	if (!key) return;
	station.usage.lastCtxModel = live;
	const { state } = station;
	if (state.modelRecovery || station.modelSwitchInFlight || station.pendingModelSwitch) return;
	const spec = liveSelector(ctx, key, host);
	if (state.baseModelKey === key && (spec === key || state.baseModelSpec === spec)) return;
	setChoice(state, null, spec, key);
	station.persist();
}

export function queueModelSwitch(station, target, fallback, scopeId, recovery = false) {
	if (station.portTable.modelSwitch === "off") return;
	if (!target.spec || target.spec === fallback.spec) return;
	station.pendingModelSwitch = {
		command: `/switch ${target.spec}`,
		targetSpec: target.spec,
		expectedKey: target.key,
		expectedThinking: target.thinkingLevel,
		fallbackSpec: fallback.spec,
		fallbackKey: fallback.key,
		scopeId,
		epoch: station.state.epoch,
		recovery,
	};
}

export function takePendingModelSwitch(station, ctx) {
	if (station.portTable.modelSwitch === "off") return null;
	if (station.modelSwitchInFlight) return null;
	const recovery = station.state.modelRecovery;
	if (!station.pendingModelSwitch && recovery) {
		const key = modelKey(actualModel(ctx, station.host));
		if (key) {
			const spec = liveSelector(ctx, key, station.host);
			if (key === recovery.expectedKey && (recovery.targetSpec === key || recovery.targetSpec === spec)) {
				station.state.modelRecovery = null;
				station.persist();
			} else {
				queueModelSwitch(station,
					{ spec: recovery.targetSpec, key: recovery.expectedKey }, { spec, key },
					null, true);
			}
		}
	}
	const req = station.pendingModelSwitch;
	station.pendingModelSwitch = null;
	station.modelSwitchInFlight = req;
	return req;
}

export function reconcileActualModel(station, ctx, req, outcome) {
	const live = outcome?.actualModel ?? outcome?.model ?? actualModel(ctx, station.host);
	const key = modelKey(live) ?? req.fallbackKey;
	if (station.modelSwitchInFlight === req) station.modelSwitchInFlight = null;
	if (station.state.epoch !== req.epoch) return key;
	if (live) station.usage.lastCtxModel = live;
	const observedSpec = key ? liveSelector(ctx, key, station.host) : null;
	const spec = observedSpec && observedSpec !== key ? observedSpec :
		outcome?.ok ? req.targetSpec : key === req.fallbackKey ? req.fallbackSpec : key;
	if (key) setChoice(station.state, null, spec ?? key, key);
	station.state.modelRecovery = null;
	station.persist();
	return key ?? "unknown";
}
