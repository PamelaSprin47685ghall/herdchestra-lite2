// Read/write adapter over the official omp session. Every host accessor is
// guarded: the web surface is optional, and a missing capability must degrade
// to null instead of rejecting into the extension host.
function safe(fn, fallback = undefined) {
	try {
		const value = fn();
		return value === undefined ? fallback : value;
	} catch {
		return fallback;
	}
}

export function createSessionAdapter({ ctx, pi } = {}) {
	const sessionManager = ctx?.sessionManager;
	return {
		sessionInfo() {
			return {
				id: safe(() => sessionManager?.getSessionId(), null),
				file: safe(() => sessionManager?.getSessionFile(), null),
				title: safe(() => sessionManager?.getSessionName(), null),
				cwd: safe(() => sessionManager?.getCwd(), ctx?.cwd ?? null),
			};
		},
		branch() {
			return safe(() => sessionManager?.getBranch(), []);
		},
		entries() {
			return safe(() => sessionManager?.getEntries(), []);
		},
		usage() {
			return safe(() => sessionManager?.getUsageStatistics(), {});
		},
		models() {
			return safe(() => ctx?.models?.list?.(), []);
		},
		currentModel() {
			const raw = safe(() => ctx?.models?.current?.(), null);
			if (!raw) return null;
			if (typeof raw === "string") {
				const [provider, ...rest] = raw.split("/");
				return { provider, id: rest.join("/") || provider };
			}
			if (typeof raw !== "object") return null;
			const source = raw.id ?? raw.modelId ?? raw.model ?? raw.name ?? null;
			if (typeof source !== "string" || !source) return null;
			const declared = raw.provider ?? raw.providerId ?? null;
			if (typeof declared === "string" && declared) {
				// A declared provider wins: the id is the catalog id (which may itself
				// contain slashes). Splitting it again would flatten
				// `mistral/deepseek-v4-1-flash-1017` into provider `mistral`, a model
				// the catalog never lists.
				const prefix = `${declared}/`;
				return {
					provider: declared,
					id: source.startsWith(prefix) ? source.slice(prefix.length) : source,
				};
			}
			const [embeddedProvider, ...rest] = source.split("/");
			return {
				provider: rest.length ? embeddedProvider : "",
				id: rest.length ? rest.join("/") : source,
			};
		},
		contextUsage() {
			return safe(() => ctx?.getContextUsage?.(), null);
		},
		modes() {
			return safe(() => ctx?.sessionModes?.getState?.(), null);
		},
		thinkingLevel() {
			return safe(() => pi?.getThinkingLevel?.(), null);
		},
		thinkingLevels() {
			// Authoritative per-model selectable levels: off + auto + supported efforts,
			// already ceiling-filtered by the host. Never synthesize the list here.
			const selectors = safe(
				() =>
					ctx?.session?.getAvailableEffortSelectors?.() ??
					pi?.getAvailableEffortSelectors?.() ??
					ctx?.getAvailableEffortSelectors?.(),
				undefined,
			);
			// An empty selector list means "unknown for this model", not "no levels":
			// fall through so the concrete/declared lists can still supply the slider.
			if (Array.isArray(selectors) && selectors.length > 0) {
				return selectors.filter((level) => typeof level === "string");
			}
			const concrete = safe(
				() =>
					ctx?.session?.getAvailableThinkingLevels?.() ??
					pi?.getAvailableThinkingLevels?.() ??
					ctx?.getAvailableThinkingLevels?.(),
				undefined,
			);
			if (Array.isArray(concrete) && concrete.length > 0) {
				return ["off", ...concrete.filter((level) => typeof level === "string")];
			}
			const model = safe(() => ctx?.models?.current?.(), null);
			if (model && typeof model === "object" && model.reasoning === false) return [];
			// The catalog schema declares `thinking.efforts`; `levels` is the legacy
			// key. Either one can supply the slider when the host selectors are empty.
			const declared =
				model && typeof model === "object"
					? (model.thinking?.efforts ?? model.thinking?.levels)
					: undefined;
			if (Array.isArray(declared)) {
				const filtered = declared.filter((level) => typeof level === "string");
				return filtered.length > 0 ? ["off", ...filtered] : [];
			}
			// Unknown: keep the previous station value rather than clearing it.
			return undefined;
		},
		async listProjectSessions(cwd) {
			try {
				const module = pi?.pi?.SessionManager ? pi.pi : await import("@oh-my-pi/pi-coding-agent");
				const sessions = await module.SessionManager.list(
					cwd ?? this.sessionInfo().cwd,
					safe(() => sessionManager?.getSessionDir?.()) || undefined,
				);
				return sessions.map((session) => ({
					id: session.id,
					title: session.title ?? null,
					path: session.path,
					modified: session.modified instanceof Date ? session.modified.toISOString() : session.modified,
					messageCount: session.messageCount ?? 0,
				}));
			} catch {
				return [];
			}
		},
		async setModel(provider, modelId) {
			const model = ctx?.models?.resolve?.(`${provider}/${modelId}`);
			if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
			return pi.setModel(model);
		},
		async setThinking(level) {
			return safe(() => pi?.setThinkingLevel?.(level));
		},
		async setMode(payload) {
			return safe(() => ctx?.sessionModes?.set?.(payload));
		},
		abort() {
			return safe(() => ctx?.abort?.());
		},
		resolvePlanReview(reviewId, choice, input) {
			return safe(() => ctx?.resolvePlanReview?.(reviewId, choice, input));
		},
	};
}
