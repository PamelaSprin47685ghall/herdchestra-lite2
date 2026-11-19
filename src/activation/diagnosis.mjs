// Activation diagnosis: make a missing host seam loud.
//
// host/capture.mjs patches two AgentSession members and writes one message
// array. When the host renames any of them, the extension still loads and the
// `scope` tool still appears, but folding and the relay degrade in silence.
// This module turns that silence into one visible error per session.

/**
 * Announce a broken seam on the first session that runs.
 *
 * @param {object} pi Host extension API.
 * @param {{ok: boolean, missing: string[], error: string|null}|null} diagnosis
 */
export function wireHostDiagnosis(pi, diagnosis) {
	if (!diagnosis || diagnosis.ok) return;
	const detail =
		diagnosis.missing.length > 0
			? diagnosis.missing.join(", ")
			: (diagnosis.error ?? "unknown seam");
	const text = `Herdchestra: host seam missing — ${detail}; folding and relay are disabled`;
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
