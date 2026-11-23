// Boundary ratchet for the second, independent omp plugin.
//
// `host-omp` owns scope semantics; `host-omp-ui` owns the web bridge. Neither
// may import the other: installing one must keep working without the other,
// and a shared import would make that promise decorative. The same scan also
// keeps the bridge's pure domain layer free of host and server dependencies,
// and keeps the Station synchronous (Ticket Station Method).

import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CORE = join(ROOT, "src");
const HOST = join(ROOT, "host-omp");
const UI = join(ROOT, "host-omp-ui");

/** Source with comments and string literals removed: only code remains. */
function codeOnly(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "")
		.replace(/\?\./g, ".");
}

function sourceFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.name.endsWith(".mjs")) out.push(path);
	}
	return out;
}

function importSpecifiers(source) {
	const specs = [];
	for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specs.push(match[1]);
	for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(match[1]);
	return specs;
}

function resolvesIntoCore(file, specifier) {
	if (!specifier.startsWith(".")) return false;
	const target = resolve(dirname(file), specifier);
	return target === CORE || target.startsWith(`${CORE}/`);
}

test("host-omp-ui is an independent omp extension package", () => {
	const pkgPath = join(UI, "package.json");
	expect(existsSync(pkgPath)).toBe(true);

	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	expect(pkg.name).toBe("herdchestra-host-omp-ui");
	expect(pkg.type).toBe("module");
	expect(pkg.omp?.extensions).toEqual(["./src/main.mjs"]);
	expect(pkg.pi?.extensions).toEqual(["./src/main.mjs"]);
	expect(existsSync(join(UI, pkg.omp.extensions[0]))).toBe(true);
});

test("host-omp does not import host-omp-ui", () => {
	const offenders = [];
	for (const file of sourceFiles(join(HOST, "src"))) {
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			if (specifier.includes("host-omp-ui") || specifier.includes("herdchestra-host-omp-ui")) {
				offenders.push(`${file} -> ${specifier}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test("host-omp-ui does not import host-omp or reach back into the core", () => {
	const offenders = [];
	for (const file of sourceFiles(join(UI, "src"))) {
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			const namesHostOmp =
				specifier === "herdchestra-host-omp" ||
				specifier.startsWith("herdchestra-host-omp/") ||
				/(^|\/)host-omp(\/|$)/.test(specifier);
			if (namesHostOmp || resolvesIntoCore(file, specifier)) {
				offenders.push(`${file} -> ${specifier}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test("the core does not import either plugin", () => {
	const offenders = [];
	for (const file of sourceFiles(CORE)) {
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			if (specifier.includes("host-omp-ui") || specifier.includes("herdchestra-host-omp-ui")) {
				offenders.push(`${file} -> ${specifier}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test("the Station is synchronous: no async and no await", () => {
	const stationPath = join(UI, "src", "station", "ui-bridge-station.mjs");
	expect(existsSync(stationPath)).toBe(true);

	const code = codeOnly(readFileSync(stationPath, "utf8"));
	expect(code).not.toMatch(/\basync\b/);
	expect(code).not.toMatch(/\bawait\b/);
});

test("the domain layer is pure: no host imports and no server", () => {
	const domainDir = join(UI, "src", "station", "domain");
	expect(existsSync(domainDir)).toBe(true);

	const offenders = [];
	for (const file of sourceFiles(domainDir)) {
		const source = readFileSync(file, "utf8");
		for (const specifier of importSpecifiers(source)) {
			if (specifier.startsWith("@oh-my-pi/") || specifier === "node:http") {
				offenders.push(`${file} -> ${specifier}`);
			}
		}
		if (/\bBun\.serve\b/.test(codeOnly(source))) offenders.push(`${file} -> Bun.serve`);
	}
	expect(offenders).toEqual([]);
});

test("activation tickets expose a catch-all detach that swallows rejection", async () => {
	const ticketsPath = join(UI, "src", "activation", "tickets.mjs");
	expect(existsSync(ticketsPath)).toBe(true);

	const mod = await import(ticketsPath);
	expect(typeof mod.detach).toBe("function");

	// A fire-and-forget ticket must never surface as an unhandled rejection.
	await mod.detach(Promise.reject(new Error("detach must swallow this")));
});
