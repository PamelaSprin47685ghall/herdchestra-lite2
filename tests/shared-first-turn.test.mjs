import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	composeSharedFirstTurn,
	loadSharedFirstTurn,
} from "../host-omp/src/host/shared-first-turn.mjs";

describe("shared first turn", () => {
	test("keeps every byte of the snapshot after the fixed header", () => {
		const snapshot = '{"messages":[{"role":"user","content":"你好"}]}';
		const text = composeSharedFirstTurn(snapshot);
		expect(text.endsWith(snapshot)).toBe(true);
		expect(text.indexOf(snapshot)).toBe(text.length - snapshot.length);
	});

	test("reads the snapshot from a path", () => {
		const dir = mkdtempSync(join(tmpdir(), "shared-first-turn-"));
		const path = join(dir, "snapshot.json");
		try {
			writeFileSync(path, '{"ok":true}');
			expect(loadSharedFirstTurn(path)).toBe(
				composeSharedFirstTurn('{"ok":true}'),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
