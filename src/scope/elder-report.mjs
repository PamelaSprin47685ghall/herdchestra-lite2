// Elder report contract: one bound for the tool schema and the runtime.
//
// The stored report is the trimmed text, so the bound applies to the trimmed
// length. JSON Schema cannot trim, but a pattern can express the same set on
// the raw string: optional leading and trailing white space around a span of
// MIN..MAX characters that starts and ends with a non-space character. The
// schema and elderReportProblem therefore accept exactly the same values.

export const MIN_ELDER_REPORT_CHARS = 24;
export const MAX_ELDER_REPORT_CHARS = 4000;

// String.prototype.trim removes \s plus the BOM, which \s alone does not match.
const TRIM = "[\\s\\uFEFF]";

/** Raw string whose trimmed length is MIN..MAX and whose content is not blank. */
export const ELDER_REPORT_PATTERN =
	`^${TRIM}*\\S[\\s\\S]{${MIN_ELDER_REPORT_CHARS - 2},${MAX_ELDER_REPORT_CHARS - 2}}\\S${TRIM}*$`;

/** True when the value cannot be used as a report even before any gate. */
export function elderReportProblem(value) {
	if (typeof value !== "string") {
		return { code: "INVALID_ARGUMENT", message: "elder_report must be a string or null." };
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return { code: "INVALID_ARGUMENT", message: "elder_report must be a non-empty string or null." };
	}
	if (trimmed.length < MIN_ELDER_REPORT_CHARS) {
		return {
			code: "INVALID_ELDER_REPORT",
			message: `elder_report needs at least ${MIN_ELDER_REPORT_CHARS} characters. Say what the successor still needs from that record; the content decides its format.`,
			details: { minimum: MIN_ELDER_REPORT_CHARS },
		};
	}
	if (trimmed.length > MAX_ELDER_REPORT_CHARS) {
		return {
			code: "INVALID_ELDER_REPORT",
			message: `elder_report exceeds ${MAX_ELDER_REPORT_CHARS} characters. Shorten it to what a successor cannot recover elsewhere.`,
			details: { maximum: MAX_ELDER_REPORT_CHARS },
		};
	}
	return null;
}
