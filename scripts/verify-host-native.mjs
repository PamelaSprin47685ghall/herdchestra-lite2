#!/usr/bin/env bun
// Select and verify the native addon for the pinned host checkout.
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.OMP_HOST) throw new Error("OMP_HOST must name the host checkout");
const host = resolve(process.env.OMP_HOST);
const detection = await import(pathToFileURL(join(host, "scripts/host-detect.ts")).href);
const addon = detection.resolveLocalHostAddon({
	platform: process.platform,
	arch: process.arch,
	avx2: detection.detectHostAvx2Support(),
});

if (process.argv.includes("--target")) {
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, "filename=" + addon.filename + "\n");
	}
	console.log(addon.filename);
} else {
	const manifest = JSON.parse(readFileSync(join(host, "packages/natives/package.json"), "utf8"));
	const { verifyHostAddonLoads } = await import(pathToFileURL(join(host, "scripts/bazel-natives.ts")).href);
	await verifyHostAddonLoads(
		join(host, "packages/natives/native", addon.filename),
		undefined,
		manifest.version,
	);
	console.log("PASS: " + addon.filename + " loads and reports native version " + manifest.version);
}
