// Station restore: rebuild state from the newest persisted snapshot.

import { createState, deserializeState } from "../scope/index.mjs";
import { toolCalls } from "../transcript/index.mjs";

const SESSION_STATE_TYPE = "scope.state";

function restoreState(manager) {
	try {
		const branch = manager?.getBranch?.() ?? [];
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry?.type === "custom" && entry.customType === SESSION_STATE_TYPE) {
				const restored = deserializeState(entry.data);
				// A crash can leave an active scope whose begin message never
				// reached the transcript. Drop such scopes instead of charging
				// every later tool call to a scope that can never be closed.
				if (restored.scopes.length > 0 || restored.collapses.length > 0) {
					try {
						const context = manager.buildSessionContext?.();
						const messages = Array.isArray(context?.messages) ? context.messages : [];
						const visible = new Set();
						for (const message of messages) {
							if (message?.role !== "assistant") continue;
							for (const call of toolCalls(message)) visible.add(call.id);
						}
						// A scope whose begin left the branch can never be closed
						// or folded. Drop it instead of charging later calls to it.
						restored.scopes = restored.scopes.filter((scope) =>
							visible.has(scope.beginToolCallId),
						);
						// A pending elder whose begin left the branch can never be
						// archived: seal it so no new scope asks for its report.
						// Other lost records are folded as before.
						for (const record of restored.collapses) {
							if (record?.collapsed === false && !visible.has(record.beginToolCallId)) {
								if (record.report === null && record.sealed !== true) {
									record.sealed = true;
								} else {
									record.collapsed = true;
								}
							}
						}
					} catch {
						// Keep the restored state when the host cannot expose context.
					}
				}
				return restored;
			}
		}
	} catch {
		// Corrupt or absent history: start empty rather than guess.
	}
	return createState();
}

export { SESSION_STATE_TYPE, restoreState };
