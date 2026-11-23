// Host tickets: each method crosses at most one await boundary and reports a
// discriminated result. Failures are diagnosed and never thrown to the host.
import { routeSurfaceEvent } from "../tui-fence.mjs";
import { textOf } from "./dialog-protocol.mjs";

const THINKING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PLAN_REVIEW_CHOICES = new Set(["execute", "compact", "keep", "refine", "save"]);
const MAX_SURFACE_KEYS = 512;

// The web renders the plan review's own labels; `ctx.resolvePlanReview` only
// accepts the stable ids. Re-measure the open review to translate.
function resolvePlanChoice(ctx, requested) {
	if (typeof requested !== "string") return undefined;
	const raw = requested.trim();
	if (PLAN_REVIEW_CHOICES.has(raw)) return raw;
	const lower = raw.toLowerCase();
	if (PLAN_REVIEW_CHOICES.has(lower)) return lower;
	let pending;
	try {
		pending = ctx?.getPendingPlanReview?.();
	} catch {
		pending = undefined;
	}
	for (const option of Array.isArray(pending?.options) ? pending.options : []) {
		if (option?.label === requested || option?.id === requested) return option.id;
	}
	return undefined;
}

function resolveModel(ctx, provider, modelId) {
	const id = textOf(modelId);
	if (!id) return null;
	let models = [];
	try {
		models = ctx?.models?.list?.() ?? [];
	} catch {
		models = [];
	}
	const list = Array.isArray(models) ? models : [];
	const same = list.find(
		(model) => model && model.id === id && (!provider || model.provider === provider),
	);
	if (same) return same;
	for (const spec of provider ? [`${provider}/${id}`, id] : [id]) {
		try {
			const resolved = ctx?.models?.resolve?.(spec);
			if (resolved && (!provider || resolved.provider === provider)) return resolved;
		} catch {
			// Fall through to the next spelling.
		}
	}
	return null;
}

export function createHostTickets({
	adapter,
	pi,
	ctx,
	diagnostics,
	getServer,
	getEditor,
	getTui,
	getReconciler,
} = {}) {
	const fail = (domain, error) => {
		diagnostics?.record?.(domain, error);
		return { ok: false };
	};

	return {
		async startServerTicket(start) {
			try {
				return { ok: true, value: await start?.() };
			} catch (error) {
				return fail("start-server", error);
			}
		},
		async stopServerTicket() {
			try {
				await getServer()?.close?.();
				return { ok: true };
			} catch (error) {
				return fail("stop-server", error);
			}
		},
		async broadcastFrameTicket(frame) {
			try {
				getServer()?.broadcast?.(frame);
				return { ok: true };
			} catch (error) {
				return fail("broadcast", error);
			}
		},
		async sendClientFrameTicket({ clientId, frame } = {}) {
			try {
				getServer()?.sendToClient?.(clientId, frame);
				return { ok: true };
			} catch (error) {
				return fail("send-client", error);
			}
		},
		async submitComposerTicket({ text, mode, attachments = [] } = {}) {
			try {
				let content = typeof text === "string" ? text : String(text ?? "");
				if (!Array.isArray(attachments) || attachments.length > 10) return { ok: false, code: "invalid_attachments" };
				let total = 0;
				const decoded = [];
				for (let item of attachments) {
					if (!item || typeof item.name !== "string" || typeof item.mimeType !== "string" || typeof item.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) return { ok: false, code: "invalid_attachment" };
					const bytes = Buffer.from(item.data, "base64");
					total += bytes.length;
					if (bytes.length > 5 * 1024 * 1024 || total > 10 * 1024 * 1024) return { ok: false, code: "attachment_too_large" };
					if (["application/json", "application/ld+json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript"].includes(item.mimeType)) item = { ...item, mimeType: "text/plain" };
					if (!/^image\/(?:png|jpeg|gif|webp)$/.test(item.mimeType) && !item.mimeType.startsWith("text/")) return { ok: false, code: "unsupported_attachment" };
					if (item.mimeType.startsWith("image/")) {
						const matches = item.mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : item.mimeType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : item.mimeType === "image/gif" ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii")) : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
						if (!matches) return { ok: false, code: "invalid_attachment_type" };
					} else {
						new TextDecoder("utf-8", { fatal: true }).decode(bytes);
					}
					decoded.push({ ...item, bytes });
				}
				if (mode === "steer" || mode === "followUp") {
					if (typeof pi?.sendUserMessage !== "function") return { ok: false, code: "unsupported" };
					if (decoded.length) {
						const textParts = [content, ...decoded.filter((item) => item.mimeType.startsWith("text/")).map((item) => new TextDecoder("utf-8", { fatal: true }).decode(item.bytes))].filter(Boolean);
						const blocks = [...(textParts.length ? [{ type: "text", text: textParts.join("\n\n") }] : []), ...decoded.filter((item) => item.mimeType.startsWith("image/")).map((item) => ({ type: "image", mimeType: item.mimeType, data: item.data }))];
						await pi.sendUserMessage(blocks, { deliverAs: mode });
					} else await pi.sendUserMessage(content, { deliverAs: mode });
					return { ok: true };
				}
				const defaultEditor = getEditor();
				if (defaultEditor?.disableSubmit) return { ok: false, code: "editor_not_ready" };
				if (decoded.length) {
					const editor = defaultEditor;
					if (!editor || typeof editor.setText !== "function" || typeof editor.getText !== "function" || typeof editor.insertTextAttachment !== "function" || !Array.isArray(editor.pendingImages) || (decoded.some((item) => item.mimeType.startsWith("image/")) && (typeof editor.insertText !== "function" || !Array.isArray(editor.pendingImageLinks))) || (typeof editor.submitRemote !== "function" && typeof editor.submit !== "function")) return { ok: false, code: "editor_unavailable" };
					const previousText = editor.getText();
					const previousCursor = editor.getCursor?.();
					if ((previousText && previousText !== content) || editor.pendingImages.length || editor.pendingTexts?.length) return { ok: false, code: "draft_conflict" };
					try {
					editor.setText(content);
					for (const item of decoded) {
						if (item.mimeType.startsWith("image/")) {
							if (typeof editor.insertText !== "function" || !Array.isArray(editor.pendingImageLinks)) return { ok: false, code: "editor_unavailable" };
							editor.pendingImages.push({ type: "image", mimeType: item.mimeType, data: item.data });
							editor.pendingImageLinks.push(undefined);
							editor.insertText(`[Image #${editor.pendingImages.length}]`);
						} else editor.insertTextAttachment(new TextDecoder("utf-8", { fatal: true }).decode(item.bytes));
					}
					if (typeof editor.getText === "function") content = editor.getText();
					if (typeof editor.submitRemote === "function") editor.submitRemote(content);
					else editor.submit();
					// Editor.submit is synchronous and returns no admission receipt.
					// Keep the browser's attachment copy: the host may still reject it.
					return { ok: false, code: "submission_unconfirmed" };
					} catch (error) {
						try {
							if (typeof editor.clearDraft === "function") editor.clearDraft();
							else {
								editor.pendingImages.length = 0;
								if (Array.isArray(editor.pendingImageLinks)) editor.pendingImageLinks.length = 0;
								if (Array.isArray(editor.pendingTexts)) editor.pendingTexts.length = 0;
							}
							editor.setText(previousText, { cursor: previousCursor?.line === 0 && previousCursor?.col === 0 ? "start" : "end" });
						} catch { /* Preserve the original failure. */ }
						throw error;
					}
				}
				const editor = getEditor();
				if (typeof editor?.submitRemote === "function") {
					editor.submitRemote(content);
					return { ok: true };
				}
				// A captured host editor without `submitRemote` still supports the
				// exact TUI path (slash commands, `!`/`$`, queueing) via set + submit.
				if (typeof editor?.setText === "function" && typeof editor?.submit === "function") {
					if (typeof editor.getText !== "function" || editor.getText() !== content) editor.setText(content);
					editor.submit();
					return { ok: true };
				}
				// Slash commands and shell escapes only work through the real
				// composer; silently sending them as chat text would be wrong.
				if (/^[/!$]/.test(content.trimStart())) return { ok: false, code: "editor_unavailable" };
				if (typeof pi?.sendUserMessage !== "function") return { ok: false, code: "unsupported" };
				await pi.sendUserMessage(content);
				return { ok: true };
			} catch (error) {
				return fail("submit-composer", error);
			}
		},
		async syncEditorDraftTicket({ text } = {}) {
			try {
				const expected = typeof text === "string" ? text : "";
				const editor = getEditor();
				if (typeof editor?.applyRemoteDraft === "function") {
					const written = editor.applyRemoteDraft({ text: expected });
					if (written === false) return { ok: false, code: "unverified" };
					if (typeof editor.getText === "function" && editor.getText() !== expected) {
						return { ok: false, code: "unverified" };
					}
					return { ok: true };
				}
				if (typeof editor?.setText === "function") {
					editor.setText(expected);
					if (typeof editor.getText === "function" && editor.getText() !== expected) {
						return { ok: false, code: "unverified" };
					}
					return { ok: true };
				}
				return { ok: false, code: "no-editor" };
			} catch (error) {
				return fail("sync-draft", error);
			}
		},
		async abortSessionTicket() {
			try {
				if (typeof ctx?.abort !== "function") return { ok: false, code: "unsupported" };
				ctx.abort();
				return { ok: true };
			} catch (error) {
				return fail("abort", error);
			}
		},
		async setModelTicket({ provider, modelId } = {}) {
			try {
				if (typeof pi?.setModel !== "function") return { ok: false, code: "unsupported" };
				// pi.setModel takes a resolved Model, not a provider/id pair.
				const model = resolveModel(ctx, provider, modelId);
				if (!model) return { ok: false, code: "unknown_model" };
				const switched = await pi.setModel(model);
				if (switched === false) return { ok: false, code: "model_rejected" };
				// ctx.model is a live getter in the extension context; the model query
				// fallback supports hosts exposing current() instead.
				const current = ctx?.model ?? ctx?.models?.current?.();
				let levels;
				try {
					const value = ctx?.session?.getAvailableEffortSelectors?.();
					if (Array.isArray(value)) levels = value.filter((item) => typeof item === "string");
				} catch {
					levels = undefined;
				}
				const reported = {
					...(current ? { model: current } : {}),
					...(levels !== undefined ? { thinkingLevels: levels } : {}),
				};
				return {
					ok: true,
					value: model,
					...(Object.keys(reported).length ? { reported } : {}),
					...(levels !== undefined ? { thinkingLevels: levels } : {}),
				};
			} catch (error) {
				return fail("set-model", error);
			}
		},
		async setThinkingTicket({ level } = {}) {
			try {
				if (typeof pi?.setThinkingLevel !== "function") return { ok: false, code: "unsupported" };
				if (!THINKING_LEVELS.has(level)) return { ok: false, code: "invalid_level" };
				pi.setThinkingLevel(level);
				const current = pi?.getThinkingLevel?.();
				const levels = (() => {
					try {
						const value = ctx?.session?.getAvailableEffortSelectors?.();
						return Array.isArray(value) ? value.filter((item) => typeof item === "string") : undefined;
					} catch {
						return undefined;
					}
				})();
				const reported = {
					...(current !== undefined ? { thinkingLevel: current } : {}),
					...(levels !== undefined ? { thinkingLevels: levels } : {}),
				};
				return {
					ok: true,
					...(Object.keys(reported).length ? { reported } : {}),
					...(levels !== undefined ? { thinkingLevels: levels } : {}),
				};
			} catch (error) {
				return fail("set-thinking", error);
			}
		},
		async setModeTicket(payload) {
			try {
				if (typeof ctx?.sessionModes?.set !== "function") return { ok: false, code: "unsupported" };
				const { clientId: _clientId, requestId: _requestId, ...request } = payload ?? {};
				const result = await ctx.sessionModes.set(request);
				if (result?.ok === false) return { ok: false, code: result.code ?? "mode_rejected", value: result };
				if (result?.ok !== true) return { ok: false, code: "mode_unconfirmed" };
				return { ok: true, value: result, ...(result.state ? { reported: { modes: result.state } } : {}) };
			} catch (error) {
				return fail("set-mode", error);
			}
		},
		async resolvePlanReviewTicket({ reviewId, choice, input } = {}) {
			try {
				if (typeof ctx?.resolvePlanReview !== "function") return { ok: false, code: "unsupported" };
				const choiceId = resolvePlanChoice(ctx, choice);
				if (!choiceId) return { ok: false, code: "invalid_choice" };
				const resolved = ctx.resolvePlanReview(reviewId, choiceId, input);
				return resolved === false ? { ok: false, code: "not_resolved" } : { ok: true, value: resolved };
			} catch (error) {
				return fail("plan-review", error);
			}
		},
		async routeSurfaceEventTicket(event) {
			try {
				return routeSurfaceEvent({ reconciler: getReconciler(), tui: getTui(), event });
			} catch (error) {
				return fail("surface-event", error);
			}
		},
		async injectSurfaceKeysTicket({ data } = {}) {
			try {
				if (typeof data !== "string" || !data || data.length > MAX_SURFACE_KEYS) {
					return { ok: false, code: "invalid_keys" };
				}
				if (typeof getTui()?.injectDebugInput !== "function") return { ok: false, code: "unsupported" };
				// Reuse the routed path so the completion mirror is refreshed
				// after arrow keys move the TUI autocomplete selection.
				return routeSurfaceEvent({
					reconciler: getReconciler(),
					tui: getTui(),
					event: { ev: "keys", data },
				});
			} catch (error) {
				return fail("surface-keys", error);
			}
		},
		async refreshSessionsTicket({ cwd } = {}) {
			try {
				return { ok: true, value: await adapter?.listProjectSessions?.(cwd) };
			} catch (error) {
				return fail("refresh-sessions", error);
			}
		},
	};
}
