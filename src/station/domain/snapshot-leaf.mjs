// Pure helpers for locating and validating closed snapshot leaves in a branch.

function hasToolCalls(message) {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
		return false;
	}
	return message.content.some((block) => block?.type === "toolCall");
}

function isSkillReceiptEntry(entry) {
	return entry?.type === "message" && entry?.message?.herdSkill === true;
}

/**
 * Return the last entry id in `branch` that represents a closed turn
 * (skipping trailing `herdSkill` probe entries and any trailing assistant
 * message whose `toolCall`s have no subsequent `toolResult`).
 */
export function closedLeafId(branch) {
	if (!Array.isArray(branch) || branch.length === 0) return null;
	let index = branch.length - 1;
	while (index >= 0 && isSkillReceiptEntry(branch[index])) {
		index -= 1;
	}
	if (index < 0) return null;
	const tail = branch[index];
	if (tail?.type === "message" && hasToolCalls(tail.message)) {
		index -= 1;
		while (index >= 0 && isSkillReceiptEntry(branch[index])) {
			index -= 1;
		}
		if (index < 0) return null;
		return typeof branch[index]?.id === "string" ? branch[index].id : null;
	}
	return typeof tail?.id === "string" ? tail.id : null;
}

/**
 * True when `branch` (ending at a proposed snapshot leaf) has no dangling
 * `toolCall` without a corresponding `toolResult`.
 */
export function isClosedSnapshotBranch(branch) {
	if (!Array.isArray(branch) || branch.length === 0) return true;
	let index = branch.length - 1;
	while (index >= 0 && isSkillReceiptEntry(branch[index])) {
		index -= 1;
	}
	if (index < 0) return true;
	const tail = branch[index];
	if (tail?.type === "message" && hasToolCalls(tail.message)) {
		return false;
	}
	return true;
}
