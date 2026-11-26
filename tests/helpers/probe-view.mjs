/**
 * Parse the YAML body of a REPL probe.
 *
 * The probe prints one command line, a block YAML document, then the closing
 * reminder. Tests read that document instead of matching its bytes.
 */

export const PROBE_COMMAND = "> ({ api: Object.keys(api), ...state })";

export function probeOf(text) {
	const lines = String(text).split("\n");
	const at = lines.indexOf(PROBE_COMMAND);
	if (at < 0) throw new Error("probe command line not found");
	const body = [];
	for (let i = at + 1; i < lines.length; i += 1) {
		if (lines[i].startsWith("> ")) break;
		body.push(lines[i]);
	}
	return Bun.YAML.parse(body.join("\n")) || {};
}
