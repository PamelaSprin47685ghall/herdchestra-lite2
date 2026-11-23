// Web ↔ TUI dialog bridge: one pending-interaction ledger, abort-safe and
// idempotent. Every station call is best-effort; a missing station must not
// break the dialog path.
import {
	buildDefaultFormData,
	parseAskHtmlForm,
} from "../../station/domain/html-form-parser.mjs";
import {
	approvalAnswer,
	askDialogAnswer,
	confirmAnswer,
	dialogPayload,
	editorAnswer,
	formAnswer,
	recordOf,
	selectAnswer,
	textOf,
} from "./dialog-protocol.mjs";

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
