/**
 * Block-style YAML view for model-facing text.
 *
 * Bun 1.4.4 ships Bun.YAML.stringify, but it prints one flow line, keeps
 * newlines escaped, turns Map/Date/RegExp into {} and throws on BigInt.
 * Display needs the other shape: block mappings, block sequences, and a
 * literal block for a multi-line string. This module is that single renderer;
 * the REPL probe and the js result both call it.
 *
 * Output is data, never an executable document. A value with no YAML form
 * becomes a stable placeholder, so a render cannot throw.
 */

const INDENT = 2;

export function renderYamlView(value, options) {
	const opts = options || {};
	const frame = {
		depth: opts.depth === undefined ? 4 : opts.depth,
		maxStringLength: opts.maxStringLength === undefined ? 20000 : opts.maxStringLength,
		seen: new Set(),
	};
	const out = emit(value, 0, frame);
	if (out.kind === "inline") return out.text;
	if (out.header) return [out.header].concat(out.lines).join("\n");
	return out.lines.join("\n");
}

function inline(text) {
	return { kind: "inline", text: text };
}

function block(lines) {
	return { kind: "block", header: "", lines: lines };
}

function pad(level) {
	return " ".repeat(level);
}

function emit(value, indent, frame) {
	if (value === null || value === undefined) return inline("null");
	if (typeof value !== "object") return scalar(value, indent, frame);
	if (indent / INDENT > frame.depth) return inline(quote("..."));

	if (Array.isArray(value)) {
		if (frame.seen.has(value)) return inline(quote("<circular>"));
		frame.seen.add(value);
		try {
			return emitArray(value, indent, frame);
		} finally {
			frame.seen.delete(value);
		}
	}
	if (ArrayBuffer.isView(value)) {
		return inline(quote("<" + value.constructor.name + " " + value.byteLength + " bytes>"));
	}
	if (value instanceof Date) return inline(quote(value.toISOString()));
	if (value instanceof RegExp) return inline(quote(String(value)));
	if (value instanceof Error) return inline(quote(value.name + ": " + value.message));
	if (value instanceof Map) return inline(quote("<Map(" + value.size + ")>"));
	if (value instanceof Set) return inline(quote("<Set(" + value.size + ")>"));
	if (frame.seen.has(value)) return inline(quote("<circular>"));

	frame.seen.add(value);
	try {
		return emitObject(value, indent, frame);
	} finally {
		frame.seen.delete(value);
	}
}

function emitObject(value, indent, frame) {
	const lines = [];
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) continue;
		const child = emit(value[key], indent + INDENT, frame);
		const name = keyText(key);
		if (child.kind === "inline") {
			lines.push(pad(indent) + name + ": " + child.text);
		} else if (child.header) {
			lines.push(pad(indent) + name + ": " + child.header);
			for (const line of child.lines) lines.push(line);
		} else {
			lines.push(pad(indent) + name + ":");
			for (const line of child.lines) lines.push(line);
		}
	}
	if (lines.length === 0) return inline("{}");
	return block(lines);
}

function emitArray(value, indent, frame) {
	const lines = [];
	for (const item of value) {
		const child = emit(item, indent + INDENT, frame);
		if (child.kind === "inline") {
			lines.push(pad(indent) + "- " + child.text);
		} else if (child.header) {
			lines.push(pad(indent) + "- " + child.header);
			for (const line of child.lines) lines.push(line);
		} else {
			const first = child.lines[0].slice(indent + INDENT);
			lines.push(pad(indent) + "- " + first);
			for (let i = 1; i < child.lines.length; i += 1) lines.push(child.lines[i]);
		}
	}
	if (lines.length === 0) return inline("[]");
	return block(lines);
}

function scalar(value, indent, frame) {
	switch (typeof value) {
		case "boolean":
			return inline(value ? "true" : "false");
		case "number":
			return inline(numberText(value));
		case "bigint":
			return inline(quote(value.toString() + "n"));
		case "symbol":
			return inline(quote(value.description ? "<symbol " + value.description + ">" : "<symbol>"));
		case "function":
			return inline(quote("<function " + (value.name || "anonymous") + ">"));
		case "string":
			return stringValue(value, indent, frame);
		default:
			return inline(quote(String(value)));
	}
}

function stringValue(value, indent, frame) {
	let text = value;
	if (Number.isFinite(frame.maxStringLength) && text.length > frame.maxStringLength) {
		text = text.slice(0, frame.maxStringLength) + "… [truncated at " + frame.maxStringLength + " chars]";
	}
	if (text === "") return inline(quote(""));
	if (/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return inline(quote(text));
	if (text.indexOf("\n") !== -1) {
		const keepsTrailing = text.endsWith("\n");
		const body = keepsTrailing ? text.slice(0, -1) : text;
		const contentIndent = pad(indent);
		const lines = body.split("\n").map(function (line) {
			return line === "" ? "" : contentIndent + line;
		});
		return { kind: "block", header: keepsTrailing ? "|" : "|-", lines: lines };
	}
	return inline(needsQuote(text) ? quote(text) : text);
}

function needsQuote(text) {
	if (/^\s|\s$/.test(text)) return true;
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return true;
	if (/^[-?:,[\]{}#&*!|>'"%@\x60]/.test(text)) return true;
	if (/: | #/.test(text)) return true;
	if (/^(?:---|\.\.\.)$/.test(text)) return true;
	if (/^(?:true|false|null|~|yes|no|on|off)$/i.test(text)) return true;
	if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return true;
	return false;
}

function keyText(key) {
	if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) && !/^(?:true|false|null|~|yes|no|on|off)$/i.test(key)) {
		return key;
	}
	return quote(key);
}

function numberText(value) {
	if (Number.isNaN(value)) return ".nan";
	if (value === Infinity) return ".inf";
	if (value === -Infinity) return "-.inf";
	return Object.is(value, -0) ? "-0" : String(value);
}

function quote(text) {
	return JSON.stringify(text);
}
