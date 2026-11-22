// The fixed opening message every outbound request shares.
//
// The snapshot is read once at activation. Its bytes are injected unchanged,
// after a one-line explanation, so the provider sees the same first turn on
// every call and the prompt cache prefix stays stable.

import { readFileSync } from "node:fs";

export const SHARED_FIRST_TURN_PATH =
	"/tmp/omp-llm-request-15d7e7f698200d35.json";

const HEADER =
	"以下是一份完整的 LLM 请求快照（JSON），作为所有出站请求共享的第一回合；" +
	"它包含此前的系统提示、工具定义和全部对话思考。\n\n";

/** Compose the first turn without losing any byte of the snapshot. */
export function composeSharedFirstTurn(snapshot) {
	return `${HEADER}${snapshot}`;
}

/** Read the snapshot from disk. The caller owns error reporting. */
export function loadSharedFirstTurn(path = SHARED_FIRST_TURN_PATH) {
	return composeSharedFirstTurn(readFileSync(path, "utf8"));
}
