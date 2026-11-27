// Frame vocabulary ratchet.
//
// The bridge sends frames by name; `ServerFrame` in the web protocol is an open
// index signature, so TypeScript cannot tell a typo from a new frame. The list
// of broadcast names therefore has one declaration (the domain codec) and one
// consumer that matters (the browser's switch). A name sent without a case is a
// frame the UI drops in silence.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_FRAMES } from "../../host-omp-ui/src/station/domain/protocol-codec.mjs";

const WEB_PROTOCOL = join(import.meta.dir, "..", "..", "host-omp-ui", "web", "src", "protocol");

// Frames addressed to one client instead of broadcast, so they are not part of
// SERVER_FRAMES; the browser still has to know them.
const DIRECT_FRAMES = ["command.result", "history.page"];

function handledByBrowser() {
	const names = new Set();
	for (const file of ["store.ts", join("reducers", "frames.ts")]) {
		const source = readFileSync(join(WEB_PROTOCOL, file), "utf8");
		for (const match of source.matchAll(/case\s+"([^"]+)"/g)) names.add(match[1]);
	}
	return names;
}

test("every frame this plugin sends has a browser case", () => {
	const handled = handledByBrowser();
	const unknown = [...SERVER_FRAMES, ...DIRECT_FRAMES].filter((name) => !handled.has(name));
	expect(unknown).toEqual([]);
});

test("the broadcast list holds no duplicate names", () => {
	const names = [...SERVER_FRAMES];
	expect(new Set(names).size).toBe(names.length);
});
