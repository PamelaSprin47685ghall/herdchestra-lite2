// A tmux command sequence can fail after new-session has already succeeded.
// Keep its launch context when the child may still be consuming it.
export async function executeTmuxLaunch({ spec, contextPath, run, hasSession, removeContext, record }) {
	let outcome;
	let message;
	try {
		outcome = await run(spec.command, spec.args);
		if (outcome.code === 0) return { ok: true, tmuxSession: spec.tmuxSession, keepaliveFailed: false, diagnostics: [] };
		message = String(outcome.stderr || outcome.stdout || `tmux exited with status ${outcome.code}`).trim();
	} catch (error) {
		message = String(error?.message ?? error);
	}
	let exists = false;
	try { exists = await hasSession(spec.tmuxSession); } catch { /* report original failure */ }
	if (exists) {
		const diagnostic = { code: "keepalive_failed", message };
		try { record?.("tmux-keepalive", diagnostic); } catch { /* diagnostics must not abort launch */ }
		return { ok: true, tmuxSession: spec.tmuxSession, keepaliveFailed: true, diagnostics: [diagnostic] };
	}
	try { await removeContext(contextPath); } catch (error) { try { record?.("launch-context-cleanup", error); } catch {} }
	return { ok: false, code: "launch_failed", message, tmuxSession: spec.tmuxSession, keepaliveFailed: false, diagnostics: [] };
}
