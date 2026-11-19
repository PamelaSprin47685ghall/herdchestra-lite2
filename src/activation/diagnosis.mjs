// Activation diagnosis: make a missing host seam loud.
//
// host/capture.mjs patches two AgentSession members and writes one message
// array. When the host renames any of them, the extension still loads and the
// `scope` tool still appears, but folding and the relay degrade in silence.
// This module turns that silence into one visible error per session.

/**
 * The seam names a broken host surface, or a single `error` when no name is
 * available. An `ok` diagnosis contributes nothing.
 *
 * @param {{ok: boolean, missing?: string[], error?: string|null}|null} diagnosis
 * @returns {string[]}
 */
function missingOf(diagnosis) {
	if (!diagnosis || diagnosis.ok) return [];
	const missing = Array.isArray(diagnosis.missing)
		? diagnosis.missing.filter(Boolean)
		: [];
	if (missing.length > 0) return missing;
	return [diagnosis.error ?? "unknown seam"];
}

/**
 * Announce a broken seam or a dead event binding on the first session that
 * runs.
 *
 * @param {object} pi Host extension API.
 * @param {{ok: boolean, missing: string[], error: string|null}|null} diagnosis
 * @param {{ok: boolean, missing: string[], error: string|null}|null} hookDiagnosis
 */
export function wireHostDiagnosis(pi, diagnosis, hookDiagnosis = null) {
	const seams = missingOf(diagnosis);
	const events = missingOf(hookDiagnosis);
	if (seams.length === 0 && events.length === 0) return;
	const parts = [];
	if (seams.length > 0) {
		parts.push(
			`seam missing — ${seams.join(", ")}; folding and relay are disabled`,
		);
	}
	if (events.length > 0) {
		parts.push(
			`event missing — ${events.join(", ")}; scope transitions and the relay are disabled`,
		);
	}
	const text = `Herdchestra: host ${parts.join("; host ")}`;
	const announced = new WeakSet();
	try {
		pi?.on?.("session_start", (_event, ctx) => {
			const key = ctx?.sessionManager ?? ctx;
			if (key && announced.has(key)) return;
			if (key) announced.add(key);
			try {
				ctx?.ui?.notify?.(text, "error");
			} catch {
				// A headless context has no notice surface. The status line
				// still carries the diagnostic count.
			}
		});
	} catch {
		// A host without session_start keeps the remaining surfaces.
	}
}
