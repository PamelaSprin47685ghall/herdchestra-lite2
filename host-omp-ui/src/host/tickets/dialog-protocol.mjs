// Pure dialog protocol mapping: TUI positional arguments to typed web payloads,
// and typed web answers back to native TUI results. No I/O, no host state.
import { validateFormSubmission } from "../../station/domain/html-form-parser.mjs";

export function recordOf(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function textOf(value) {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return String(value);
}

// The TUI dialogs take positional arguments, the web card takes a typed
// payload. Keep the mapping here so `request()` never ships `args[0]` alone.
export function dialogPayload(kind, args) {
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

export function approvalAnswer(prompt, raw) {
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

export function askDialogAnswer(entry, input) {
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

export function selectAnswer(entry, input) {
	const labels = entry.options.map((option) => option.label);
	const raw = input.value ?? input.text ?? input.choice;
	if (Number.isInteger(raw) && labels[raw] !== undefined) return labels[raw];
	return typeof raw === "string" && labels.includes(raw) ? raw : undefined;
}

export function confirmAnswer(input) {
	if (input.value === true || input.confirmed === true) return true;
	const raw = textOf(input.value ?? input.choice).trim().toLowerCase();
	return raw === "ok" || raw === "yes" || raw === "true" || raw === "confirm" || raw === "approve" || raw === "once";
}

export function editorAnswer(input) {
	const data = recordOf(input.data) ?? {};
	const raw = input.value ?? input.text ?? data.value ?? data.text;
	return typeof raw === "string" ? raw : undefined;
}

export function formAnswer(entry, input) {
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
