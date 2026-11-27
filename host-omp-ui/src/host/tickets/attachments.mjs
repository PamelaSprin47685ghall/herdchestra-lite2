// Browser attachment envelope: validate and decode before any host call.
//
// The browser is untrusted input, so every refusal is a typed code and never an
// exception; a decode that throws stays the ticket's business. Kept out of
// host-tickets.mjs so the composer ticket reads as one decision, not a mime
// ladder.

const decodeText = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp)$/;
// Markup and script documents arrive as plain text: the host must never believe
// the browser about a mime type that can execute.
const TEXTUAL_MIME = [
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/javascript",
];

function matchesImageSignature(mimeType, bytes) {
	if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	if (mimeType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
	if (mimeType === "image/gif") return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"));
	return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

/**
 * Validate and decode the browser attachment envelope.
 *
 * @param {unknown} attachments
 * @returns {{ ok: true, decoded: object[] } | { ok: false, code: string }}
 */
export function decodeAttachments(attachments) {
	if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) return { ok: false, code: "invalid_attachments" };
	let total = 0;
	const decoded = [];
	for (let item of attachments) {
		if (!item || typeof item.name !== "string" || typeof item.mimeType !== "string" || typeof item.data !== "string" || !BASE64.test(item.data)) return { ok: false, code: "invalid_attachment" };
		const bytes = Buffer.from(item.data, "base64");
		total += bytes.length;
		if (bytes.length > MAX_ATTACHMENT_BYTES || total > MAX_TOTAL_BYTES) return { ok: false, code: "attachment_too_large" };
		if (TEXTUAL_MIME.includes(item.mimeType)) item = { ...item, mimeType: "text/plain" };
		if (!IMAGE_MIME.test(item.mimeType) && !item.mimeType.startsWith("text/")) return { ok: false, code: "unsupported_attachment" };
		if (item.mimeType.startsWith("image/")) {
			if (!matchesImageSignature(item.mimeType, bytes)) return { ok: false, code: "invalid_attachment_type" };
		} else {
			decodeText(bytes);
		}
		decoded.push({ ...item, bytes });
	}
	return { ok: true, decoded };
}

export { decodeText };
