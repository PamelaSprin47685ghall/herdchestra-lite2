// The package boundary ratchet.
//
// `herdchestra-lite2` is the host-agnostic core; `herdchestra-host-omp` is the
// only package that may speak to a host. These scans keep the boundary true
// after the files have moved: a core file that reaches for a host module, a
// host package name, or an npm dependency of the host would compile and pass a
// casual review, so the rule lives here and in `eslint.config.mjs`.

import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	ENGINE_ONLY_HOST_KEYS,
	HOST_CONTRACT,
	TICKET_CONTRACT,
} from "../../src/engine.mjs";
import { shapeHost } from "../../src/core/host-shape.mjs";

const ROOT = join(import.meta.dir, "..", "..");
const CORE = join(ROOT, "src");
const HOST = join(ROOT, "host-omp");

/** Source with comments and string literals removed: only code remains. */
function codeOnly(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "")
		.replace(/\?\./g, ".");
}

function sourceFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.name.endsWith(".mjs")) out.push(path);
	}
	return out;
}

function importSpecifiers(source) {
	return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
}

test("no core file imports a host module or the host package", () => {
	const offenders = [];
	for (const file of sourceFiles(CORE)) {
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			const hostImport =
				specifier.startsWith("@oh-my-pi/") ||
				specifier.startsWith("herdchestra-host-omp") ||
				specifier.includes("host-omp/") ||
				/(^|\/)host\//.test(specifier) ||
				/(^|\/)activation\//.test(specifier);
			if (hostImport) offenders.push(`${file} -> ${specifier}`);
		}
	}
	expect(offenders).toEqual([]);
});

test("core never dereferences a host session handle", () => {
	const offenders = [];
	for (const file of sourceFiles(CORE)) {
		const source = readFileSync(file, "utf8");
		// A comment may name the shape; a member expression may not.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		if (code.includes("sessionManager")) offenders.push(file);
	}
	expect(offenders).toEqual([]);
});

test("the root package names both extension entries", () => {
	// A one-command install fetches the root package, so the root is where the
	// two extension entries must be declared; the host package keeps its own
	// entry so a standalone `omp plugin link ./host-omp` still works. The core
	// stays a library: no `pi` field, and every `src/` file is still scanned
	// above for host imports.
	const core = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const host = JSON.parse(readFileSync(join(HOST, "package.json"), "utf8"));
	expect(core.pi).toBeUndefined();
	expect(core.omp.extensions).toEqual([
		"./host-omp/src/main.mjs",
		"./host-omp-ui/src/main.mjs",
	]);
	for (const entry of core.omp.extensions) {
		expect({ entry, exists: existsSync(join(ROOT, entry)) }).toEqual({ entry, exists: true });
	}
	expect(host.omp.extensions).toEqual(["./src/main.mjs"]);
	expect(host.pi.extensions).toEqual(["./src/main.mjs"]);
	expect(existsSync(join(HOST, host.omp.extensions[0]))).toBe(true);
	expect(host.dependencies["herdchestra-lite2"]).toBeDefined();
	// `file:` materializes a copy of the repository and the host package would
	// silently compile against a stale core. `link:` is a declaration, so it
	// holds even where `node_modules` is absent (a fresh checkout, CI before the
	// install step).
	expect(host.dependencies["herdchestra-lite2"]).toBe("link:..");
});

test("the host package depends on the core by package name, not by path", () => {
	const specs = new Set();
	for (const file of sourceFiles(join(HOST, "src"))) {
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			if (specifier.startsWith(".")) continue;
			specs.add(specifier);
		}
	}
	// The core package name must be used; a relative escape back into `src/`
	// would make the dependency decorative.
	expect([...specs].filter((spec) => spec === "herdchestra-lite2").length).toBeGreaterThan(0);
	for (const spec of specs) {
		const allowed = spec === "herdchestra-lite2" || spec.startsWith("node:");
		expect(allowed).toBe(true);
	}
});

test("the local dependency resolves to the live source, not a copy", () => {
	// `bun install` may materialize a `file:` dependency as a full copy of the
	// repository. A copy ages: editing the core would leave the host package
	// testing yesterday's code, and every check would stay green. A `link:`
	// dependency stays a symlink to the repository root. `node_modules` is not
	// tracked, so a fresh checkout without an install proves nothing either way.
	const DEPENDENCY = join(HOST, "node_modules", "herdchestra-lite2");
	if (!existsSync(DEPENDENCY)) return;
	expect(lstatSync(DEPENDENCY).isSymbolicLink()).toBe(true);
});

test("a symlinked dependency resolves to the repository root itself", () => {
	const DEPENDENCY = join(HOST, "node_modules", "herdchestra-lite2");
	if (!existsSync(DEPENDENCY)) return;
	expect(realpathSync(DEPENDENCY)).toBe(realpathSync(ROOT));
});

test("every published files entry exists in the package", () => {
	// A `files` entry that names nothing is not harmless: it ships an empty
	// promise, and `npm pack` silently omits whatever the entry was meant to
	// carry. The skills moved into the core's `resources/`, so the host package
	// must not keep naming a `skills/` directory it no longer carries.
	const offenders = [];
	for (const pkgPath of [join(ROOT, "package.json"), join(HOST, "package.json")]) {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		for (const entry of pkg.files ?? []) {
			const path = join(dirname(pkgPath), entry.replace(/\/+$/, ""));
			if (!existsSync(path)) offenders.push(`${pkgPath} -> ${entry}`);
		}
	}
	expect(offenders).toEqual([]);
});

test("the core exports exactly one value: the engine factory", () => {
	const source = readFileSync(join(CORE, "index.mjs"), "utf8");
	const statements = [...source.matchAll(/^\s*export\b.*$/gm)].map((match) => match[0].trim());
	expect(statements).toEqual(['export { createEngine } from "./engine.mjs";']);
});

test("the host package takes exactly one symbol from the core", () => {
	const names = [];
	for (const file of sourceFiles(join(HOST, "src"))) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"herdchestra-lite2"/g)) {
			names.push(
				...match[1]
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean),
			);
		}
	}
	expect(names).toEqual(["createEngine"]);
});

test("core never touches a session handle", () => {
	// `ctx` may travel through the core as an opaque token. The first member
	// access on it would name a host field, and every later rename in the host
	// would become a silent break.
	const offenders = [];
	for (const file of sourceFiles(CORE)) {
		for (const match of codeOnly(readFileSync(file, "utf8")).matchAll(/\bctx\s*[!.?]*\s*\.\s*[a-zA-Z_]/g)) {
			offenders.push(`${file}: ${match[0].trim()}`);
		}
	}
	expect(offenders).toEqual([]);
});

test("the host contract is closed: no core file reaches for an undeclared key", () => {
	// The contract is the only thing that may grow. Without this scan the bag
	// widens one convenient key at a time, and the "interface" becomes whatever
	// the last patch needed.
	const offenders = [];
	for (const file of sourceFiles(CORE)) {
		const code = codeOnly(readFileSync(file, "utf8"));
		for (const match of code.matchAll(/\bhost\.([a-zA-Z_]+)\.([a-zA-Z_]+)/g)) {
			const [, group, key] = match;
			if (!HOST_CONTRACT[group]?.includes(key)) offenders.push(`${file}: host.${group}.${key}`);
		}
		for (const match of code.matchAll(/\btickets\.([a-zA-Z_]+)/g)) {
			const [, key] = match;
			if (!TICKET_CONTRACT.includes(key)) offenders.push(`${file}: tickets.${key}`);
		}
	}
	expect(offenders).toEqual([]);
});

test("no contract entry is dead weight", () => {
	// A key declared but never read is a promise to no one. Each group and each
	// verb must be reached by at least one core file.
	const code = sourceFiles(CORE)
		.map((file) => codeOnly(readFileSync(file, "utf8")))
		.join("\n");
	for (const group of Object.keys(HOST_CONTRACT)) {
		expect({ group, used: new RegExp(`\\bhost\\.${group}\\b`).test(code) }).toEqual({
			group,
			used: true,
		});
	}
	for (const verb of TICKET_CONTRACT) {
		expect({ verb, used: new RegExp(`\\btickets\\.${verb}\\b`).test(code) }).toEqual({
			verb,
			used: true,
		});
	}
});

test("the declared contract and the shape a station accepts are the same shape", () => {
	// `shapeHost` is the gateway: it widens the old flat bag and returns the
	// canonical grouped object. If a key exists on one side only, either a host
	// supplies something no station reads, or a station reads something no host
	// will supply.
	const shaped = shapeHost({});
	for (const group of Object.keys(HOST_CONTRACT)) {
		const engineOnly = ENGINE_ONLY_HOST_KEYS[group] ?? [];
		const declared = HOST_CONTRACT[group].filter((key) => !engineOnly.includes(key));
		expect({ group, keys: Object.keys(shaped[group]).sort() }).toEqual({
			group,
			keys: [...declared].sort(),
		});
	}
});
