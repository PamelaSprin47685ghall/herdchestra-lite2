import { preparseModelSpec } from "../host/pricing.mjs";
import { capabilities, modelOf, thinkingOf } from "../host/adapter.mjs";
import { record } from "../host/diagnostics.mjs";
import { currentScope } from "../scope/index.mjs";

export function modelKey(model) {
	const id = model?.id ?? model?.model;
	return typeof id === "string" && id
		? model?.provider ? `${model.provider}/${id}` : id
		: null;
}

export function actualModel(ctx) {
	return modelOf(ctx);
}

function liveSelector(ctx, key) {
	const level = thinkingOf(ctx);
	return level ? `${key}:${level}` : key;
}

export function modelChoice(station, ctx, spec, key) {
	const parsed = typeof spec === "string"
		? preparseModelSpec(station.pricingCatalog, ctx, spec)
		: null;
	// The ledger is absent only on a station double that never measured usage.
	const live = actualModel(ctx) ?? station.usage?.lastCtxModel;
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
	if (!station.hostCapabilities) {
		station.hostCapabilities = capabilities(ctx);
		record("host", "capabilities", station.hostCapabilities);
	}
	const live = actualModel(ctx);
	const key = modelKey(live);
	if (!key) return;
	station.usage.lastCtxModel = live;
	const { state } = station;
	if (state.modelRecovery || station.modelSwitchInFlight || station.pendingModelSwitch) return;
	const scope = currentScope(state);
	const spec = liveSelector(ctx, key);
	const currentKey = scope ? scope.modelKey : state.baseModelKey;
	const currentSpec = scope ? scope.modelSpec : state.baseModelSpec;
	if (currentKey === key && (spec === key || currentSpec === spec)) return;
	if (!state.baseModelKey && scope && !scope.previousModelKey) {
		state.baseModelKey = key;
		state.baseModelSpec = spec;
		for (const active of state.scopes) {
			active.previousModelKey ??= key;
			active.previousModelSpec ??= spec;
		}
	}
	setChoice(state, scope, spec, key);
	station.persist();
}

export function queueModelSwitch(station, target, fallback, scopeId, recovery = false) {
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
	if (station.modelSwitchInFlight) return null;
	const recovery = station.state.modelRecovery;
	if (!station.pendingModelSwitch && recovery) {
		const key = modelKey(actualModel(ctx));
		if (key) {
			const spec = liveSelector(ctx, key);
			if (key === recovery.expectedKey && (recovery.targetSpec === key || recovery.targetSpec === spec)) {
				station.state.modelRecovery = null;
				station.persist();
			} else {
				queueModelSwitch(station,
					{ spec: recovery.targetSpec, key: recovery.expectedKey }, { spec, key },
					currentScope(station.state)?.id ?? null, true);
			}
		}
	}
	const req = station.pendingModelSwitch;
	station.pendingModelSwitch = null;
	station.modelSwitchInFlight = req;
	return req;
}

export function reconcileActualModel(station, ctx, req, outcome) {
	const live = outcome?.actualModel ?? outcome?.model ?? actualModel(ctx);
	const key = modelKey(live) ?? req.fallbackKey;
	if (station.modelSwitchInFlight === req) station.modelSwitchInFlight = null;
	const scope = currentScope(station.state);
	if ((scope?.id ?? null) !== req.scopeId || station.state.epoch !== req.epoch) return key;
	if (live) station.usage.lastCtxModel = live;
	const observedSpec = key ? liveSelector(ctx, key) : null;
	const spec = observedSpec && observedSpec !== key ? observedSpec :
		outcome?.ok ? req.targetSpec : key === req.fallbackKey ? req.fallbackSpec : key;
	if (key) setChoice(station.state, scope, spec ?? key, key);
	station.state.modelRecovery = null;
	station.persist();
	return key ?? "unknown";
}
