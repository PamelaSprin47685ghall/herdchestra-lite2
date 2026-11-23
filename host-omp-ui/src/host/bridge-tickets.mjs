// Thin asynchronous tickets. These own every crossing of an await boundary:
// editor submission, model/mode switches, plan review, surface routing and
// server I/O. They never hold domain state; the station does.
import { routeSurfaceEvent } from "./tui-fence.mjs";
import {
	buildDefaultFormData,
	parseAskHtmlForm,
	validateFormSubmission,
} from "../station/domain/html-form-parser.mjs";

const THINKING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PLAN_REVIEW_CHOICES = new Set(["execute", "compact", "keep", "refine", "save"]);
const MAX_SURFACE_KEYS = 512;

function recordOf(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function textOf(value) {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return String(value);
}

// The TUI dialogs take positional arguments, the web card takes a typed
// payload. Keep the mapping here so `request()` never ships `args[0]` alone.
function dialogPayload(kind, args) {
	const first = args?.[0];
	const second = args?.[1];
	const third = args?.[2];
	if (kind === "askDialog") {
		return { title: "需要你的回答", questions: askQuestions(first) };
	}
	if (kind === "approve") return approvalPayload(first);
	if (kind === "select") {
		return { title: textOf(first), options: selectOptions(second), ...dialogFlags(third) };
	}
	if (kind === "confirm") return { title: textOf(first), message: textOf(second) };
	if (kind === "input") {
		return { title: textOf(first), placeholder: textOf(second), ...dialogFlags(third) };
	}
	if (kind === "editor") {
		return { title: textOf(first), prefill: textOf(second), ...dialogFlags(third) };
	}
	return recordOf(first) ?? { value: first };
}

function selectOptions(raw) {
	const options = [];
	for (const item of Array.isArray(raw) ? raw : []) {
		if (typeof item === "string") {
			if (item) options.push({ label: item, value: item });
			continue;
		}
		const entry = recordOf(item);
		const label = textOf(entry?.label);
		if (!entry || !label) continue;
		options.push({
			label,
			value: label,
			...(typeof entry.description === "string" && entry.description ? { description: entry.description } : {}),
		});
	}
	return options;
}

function dialogFlags(raw) {
	const options = recordOf(raw) ?? {};
	const flags = {};
	if (Number.isInteger(options.initialIndex)) flags.initialIndex = options.initialIndex;
	if (options.selectionMarker === "radio" || options.selectionMarker === "checkbox") {
		flags.selectionMarker = options.selectionMarker;
	}
	if (Array.isArray(options.checkedIndices)) {
		flags.checkedIndices = options.checkedIndices.filter((value) => Number.isInteger(value));
	}
	if (Number.isInteger(options.markableCount)) flags.markableCount = options.markableCount;
	if (typeof options.helpText === "string" && options.helpText) flags.helpText = options.helpText;
	if (options.secret === true) flags.secret = true;
	return flags;
}

function askQuestions(raw) {
	const questions = [];
	for (const item of Array.isArray(raw) ? raw : []) {
		const entry = recordOf(item);
		const id = textOf(entry?.id);
		if (!entry || !id) continue;
		const options = [];
		for (const option of Array.isArray(entry.options) ? entry.options : []) {
			const value = recordOf(option);
			const label = textOf(value?.label);
			if (!value || !label) continue;
			options.push({
				label,
				...(typeof value.description === "string" && value.description ? { description: value.description } : {}),
				...(typeof value.preview === "string" && value.preview ? { preview: value.preview } : {}),
			});
		}
		questions.push({
			id,
			question: textOf(entry.question),
			...(typeof entry.header === "string" && entry.header ? { header: entry.header } : {}),
			options,
			multi: entry.multi === true,
			...(Number.isInteger(entry.recommended) ? { recommended: entry.recommended } : {}),
		});
	}
	return questions;
}

function approvalPayload(raw) {
	const prompt = recordOf(raw) ?? {};
	const full = textOf(prompt.full);
	const compact = textOf(prompt.compact);
	const choices = [{ label: "允许本次", value: "once" }];
	if (typeof prompt.session === "string" && prompt.session) {
		choices.push({ label: prompt.session, value: "session" });
	}
	for (const grant of Array.isArray(prompt.grants) ? prompt.grants : []) {
		const entry = recordOf(grant);
		if (!entry || (entry.scope !== "folder" && entry.scope !== "target")) continue;
		if (textOf(entry.label)) choices.push({ label: textOf(entry.label), value: `grant:${entry.scope}:session` });
		if (textOf(entry.alwaysLabel)) {
			choices.push({ label: textOf(entry.alwaysLabel), value: `grant:${entry.scope}:always` });
		}
	}
	choices.push({ label: "拒绝", value: "deny" });
	return {
		title: "工具审批",
		question: full || compact,
		message: full || compact,
		compact,
		full,
		...(typeof prompt.session === "string" ? { session: prompt.session } : {}),
		...(Array.isArray(prompt.grants) ? { grants: prompt.grants } : {}),
		choices,
	};
}

function approvalAnswer(prompt, raw) {
	if (raw === "once" || raw === "approve" || raw === true) return "once";
	if (raw === "session") return typeof prompt?.session === "string" && prompt.session ? "session" : "deny";
	if (raw === "deny" || raw === undefined || raw === null || raw === false) return "deny";
	const grants = Array.isArray(prompt?.grants) ? prompt.grants : [];
	const grantFor = (scope) => grants.find((grant) => recordOf(grant)?.scope === scope);
	if (typeof raw === "string" && raw.startsWith("grant:")) {
		const [, scope, always] = raw.split(":");
		if ((scope === "folder" || scope === "target") && grantFor(scope)) {
			return { grant: scope, always: always === "always" };
		}
	}
	const entry = recordOf(raw);
	if (entry && (entry.grant === "folder" || entry.grant === "target") && grantFor(entry.grant)) {
		return { grant: entry.grant, always: entry.always === true };
	}
	return "deny";
}

function askDialogAnswer(entry, input) {
	if (input.kind === "chat") return { kind: "chat" };
	const answers = new Map();
	for (const answer of Array.isArray(input.answers) ? input.answers : []) {
		const item = recordOf(answer);
		if (item) answers.set(textOf(item.id), item);
	}
	const results = entry.questions.map((question) => {
		const answer = answers.get(question.id) ?? {};
		const allowed = new Set(question.options.map((option) => option.label));
		const selected = (Array.isArray(answer.selectedOptions) ? answer.selectedOptions : [])
			.map((value) => textOf(value))
			.filter((value) => allowed.has(value));
		const customInput = textOf(answer.customInput).trim();
		return {
			id: question.id,
			question: question.question,
			options: question.options.map((option) => option.label),
			multi: question.multi,
			selectedOptions: Array.from(new Set(selected)),
			...(customInput ? { customInput } : {}),
		};
	});
	return { kind: "submit", results };
}

function selectAnswer(entry, input) {
	const labels = entry.options.map((option) => option.label);
	const raw = input.value ?? input.text ?? input.choice;
	if (Number.isInteger(raw) && labels[raw] !== undefined) return labels[raw];
	return typeof raw === "string" && labels.includes(raw) ? raw : undefined;
}

function confirmAnswer(input) {
	if (input.value === true || input.confirmed === true) return true;
	const raw = textOf(input.value ?? input.choice).trim().toLowerCase();
	return raw === "ok" || raw === "yes" || raw === "true" || raw === "confirm" || raw === "approve" || raw === "once";
}

function editorAnswer(input) {
	const data = recordOf(input.data) ?? {};
	const raw = input.value ?? input.text ?? data.value ?? data.text;
	return typeof raw === "string" ? raw : undefined;
}

function formAnswer(entry, input) {
	if (entry.formError) return { ok: false, code: "invalid_form", errors: { form: "unavailable" } };
	const data = recordOf(input.data) ?? {};
	let check;
	try {
		check = validateFormSubmission(entry.form, data);
	} catch {
		return { ok: false, code: "invalid_form", errors: { form: "unavailable" } };
	}
	if (!check.ok) return { ok: false, code: "invalid_form", errors: check.errors };
	const value = { data: check.normalized };
	if (Array.isArray(input.notes) && input.notes.length) value.notes = input.notes;
	if (input.timedOut === true) value.timedOut = true;
	return { ok: true, value };
}

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

export function createUiBridge({ station, getServer } = {}) {
	const pending = new Map();
	let sequence = 0;
	return {
		hasClient() {
			return (getServer()?.clientCount ?? 0) > 0;
		},
		request(kind, args, { signal } = {}) {
			const requestId = `i${++sequence}`;
			let form = null;
			let formError = null;
			let payload;
			if (kind === "formDialog") {
				try {
					form = parseAskHtmlForm(String(args?.[0] ?? ""));
					payload = {
						title: "表单",
						form: {
							contexts: form.contexts,
							fields: form.fields,
							defaults: buildDefaultFormData(form),
						},
					};
				} catch (error) {
					form = null;
					formError = error;
					payload = { title: "表单", form: { contexts: [], fields: [], defaults: {} } };
				}
			} else {
				payload = dialogPayload(kind, args);
			}
			return new Promise((resolve, reject) => {
				const entry = {
					resolve,
					reject,
					kind,
					form,
					formError,
					questions: payload?.questions ?? [],
					options: payload?.options ?? [],
					prompt: kind === "approve" ? recordOf(args?.[0]) ?? {} : null,
					detachAbort: null,
				};
				pending.set(requestId, entry);
				let opened;
				try {
					opened = station?.openInteraction?.({ id: requestId, kind, payload }) ?? { ok: true };
				} catch {
					opened = { ok: true };
				}
				if (opened?.ok === false) {
					pending.delete(requestId);
					reject(new Error(`interaction not opened: ${opened.code ?? "unknown"}`));
					return;
				}
				if (signal?.aborted) {
					pending.delete(requestId);
					try {
						station?.closeInteraction?.(requestId);
					} catch {
						// Closing is best-effort.
					}
					reject(new Error("interaction aborted"));
					return;
				}
				if (signal?.addEventListener) {
					const onAbort = () => {
						const current = pending.get(requestId);
						if (!current) return;
						pending.delete(requestId);
						try {
							station?.closeInteraction?.(requestId);
						} catch {
							// Closing is best-effort.
						}
						current.reject(new Error("interaction aborted"));
					};
					signal.addEventListener("abort", onAbort, { once: true });
					entry.detachAbort = () => signal.removeEventListener?.("abort", onAbort);
				}
			});
		},
		kindOf(requestId) {
			return pending.get(requestId)?.kind;
		},
		resolve(requestId, payload) {
			const entry = pending.get(requestId);
			if (!entry) return { ok: false, code: "not_found" };
			const input = recordOf(payload) ?? {};
			const settle = (value) => {
				pending.delete(requestId);
				try {
					entry.detachAbort?.();
				} catch {
					// Detaching a finished abort listener is best-effort.
				}
				entry.resolve(value);
				return { ok: true, kind: entry.kind, value };
			};
			if (input.cancelled === true) {
				const value = entry.kind === "approve" ? "deny" : entry.kind === "confirm" ? false : undefined;
				return settle(value);
			}
			if (entry.kind === "formDialog") {
				const result = formAnswer(entry, input);
				return result.ok ? settle(result.value) : result;
			}
			if (entry.kind === "askDialog") return settle(askDialogAnswer(entry, input));
			if (entry.kind === "approve") return settle(approvalAnswer(entry.prompt, input.value ?? input.choice));
			if (entry.kind === "confirm") return settle(confirmAnswer(input));
			if (entry.kind === "select") return settle(selectAnswer(entry, input));
			if (entry.kind === "input" || entry.kind === "editor") return settle(editorAnswer(input));
			if (entry.kind === "plan_review") {
				return settle({ choice: input.choice, input: input.input });
			}
			return settle(input.value);
		},
		draft(input) {
			try {
				station?.onTuiDraftChanged?.(input);
			} catch {
				// Draft mirroring is best-effort.
			}
		},
		completion(input) {
			try {
				station?.onTuiCompletionChanged?.(input);
			} catch {
				// Completion mirroring is best-effort.
			}
		},
		mirror(name, args) {
			try {
				if (name === "notify") station?.onNotify?.(args?.[0], args?.[1]);
				else if (name === "setStatus") {
					// omp: setStatus(key, text). The web footer shows the text, not the key.
					const key = textOf(args?.[0]);
					const value = typeof args?.[1] === "string" ? args[1] : null;
					station?.onMetaUpdate?.({ setStatus: value, ...(key ? { statusKey: key } : {}) });
				} else if (name === "setWorkingMessage") {
					station?.onMetaUpdate?.({ setWorkingMessage: args?.[0] ?? null });
				} else if (name === "setWidget") {
					const content = args?.[1];
					if (content == null) station?.onWidgetUpdate?.(args?.[0], null);
					else if (Array.isArray(content) && content.every((line) => typeof line === "string")) {
						station?.onWidgetUpdate?.(args?.[0], content);
					}
					// Component-factory widgets are not serializable; they stay in the
					// TUI and surface overlay instead of being stringified.
				} else if (name === "setTitle") station?.onMetaUpdate?.({ title: args?.[0] ?? null });
			} catch {
				// Mirroring is best-effort.
			}
		},
		reject(requestId, error) {
			const entry = pending.get(requestId);
			if (!entry) return false;
			pending.delete(requestId);
			try {
				entry.detachAbort?.();
			} catch {
				// Detaching a finished abort listener is best-effort.
			}
			entry.reject(error ?? new Error("interaction cancelled"));
			return true;
		},
		cancel(requestId) {
			const targets = requestId ? [[requestId, pending.get(requestId)]] : [...pending];
			for (const [id, entry] of targets) {
				if (!entry) continue;
				pending.delete(id);
				try {
					entry.detachAbort?.();
					station?.closeInteraction?.(id);
				} catch {
					// Closing is best-effort.
				}
				entry.reject(new Error("interaction cancelled by the terminal"));
			}
		},
	};
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
