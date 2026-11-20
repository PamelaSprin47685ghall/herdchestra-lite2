import { describe, expect, test } from "bun:test";

import { isRetiredOwnerArtifact } from "../src/host/fission-ui.mjs";

const REASON = "Fission owner retired";

function assistantAborted(errorMessage) {
	return {
		type: "message_end",
		message: { role: "assistant", content: [], stopReason: "aborted", errorMessage },
	};
}

function toolResult({ isError, text }) {
	return {
		type: "message_end",
		message: { role: "toolResult", isError, content: [{ type: "text", text }] },
	};
}

describe("retired owner artifacts", () => {
	test("hides the aborted banner the retirement itself produced", () => {
		expect(isRetiredOwnerArtifact(assistantAborted(REASON))).toBe(true);
	});

	test("hides the error result of a call the aborted batch never ran", () => {
		expect(
			isRetiredOwnerArtifact(
				toolResult({ isError: true, text: `Tool was not executed because the run was aborted: ${REASON}.` }),
			),
		).toBe(true);
	});

	test("keeps a user interrupt and a provider failure visible", () => {
		expect(isRetiredOwnerArtifact(assistantAborted("user-interrupt"))).toBe(false);
		expect(isRetiredOwnerArtifact(assistantAborted("Request was aborted"))).toBe(false);
		expect(isRetiredOwnerArtifact(toolResult({ isError: true, text: "command failed: exit 1" }))).toBe(false);
	});

	test("keeps an ordinary tool result that merely succeeded", () => {
		expect(isRetiredOwnerArtifact(toolResult({ isError: false, text: REASON }))).toBe(false);
	});

	test("ignores events that carry no message", () => {
		expect(isRetiredOwnerArtifact({ type: "agent_end", messages: [] })).toBe(false);
		expect(isRetiredOwnerArtifact(undefined)).toBe(false);
	});
});
