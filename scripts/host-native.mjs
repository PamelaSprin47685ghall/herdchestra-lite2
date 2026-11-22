// Native addon selection for a host checkout.
//
// A checkout whose `packages/natives/native` addon predates its source can
// still import: the older binary may lack only a symbol that session
// construction later calls. Comparing the stamped build version catches that
// state before the host import. When `~/.omp/natives/<version>` already holds
// the matching prebuilt addon, the smoke scripts borrow it and re-run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function manifestVersion(host) {
	const manifest = join(host, "packages/natives/package.json");
	if (!existsSync(manifest)) return null;
	try {
		const version = JSON.parse(readFileSync(manifest, "utf8")).version;
		return typeof version === "string" && version !== "" ? version : null;
	} catch {
		return null;
	}
}

function localAddon(host) {
	const dir = join(host, "packages/natives/native");
	const tag = `${process.platform}-${process.arch}`;
	const names =
		process.arch === "x64"
			? [
					`pi_natives.${tag}-modern.node`,
					`pi_natives.${tag}-baseline.node`,
					`pi_natives.${tag}.node`,
				]
			: [`pi_natives.${tag}.node`];
	for (const name of names) {
		const path = join(dir, name);
		if (existsSync(path)) return path;
	}
	return null;
}

function addonBuildVersion(addonPath) {
	const probe =
		`const m = { exports: {} }; try { process.dlopen(m, ${JSON.stringify(addonPath)}); } ` +
		"catch { process.exit(2); } " +
		"const f = m.exports.__piNativesBuildVersion; " +
		'process.stdout.write(typeof f === "function" ? String(f()) : "");';
	const proc = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
	return proc.status === 0 && proc.stdout.trim() !== "" ? proc.stdout.trim() : null;
}

/** An installed prebuilt addon matching the checkout's declared version. */
export function findInstalledAddon(host) {
	const version = manifestVersion(host);
	if (version === null) return null;
	const tag = `${process.platform}-${process.arch}`;
	const filenames =
		process.arch === "x64"
			? [
					`pi_natives.${tag}-modern.node`,
					`pi_natives.${tag}-baseline.node`,
					`pi_natives.${tag}.node`,
				]
			: [`pi_natives.${tag}.node`];
	const bases = [];
	if (process.env.PI_NATIVES_DIR) bases.push(process.env.PI_NATIVES_DIR);
	if (process.env.XDG_DATA_HOME) {
		bases.push(join(process.env.XDG_DATA_HOME, "omp", "natives"));
	}
	bases.push(join(homedir(), ".omp", "natives"));
	for (const base of bases) {
		const dir = join(base, version);
		for (const filename of filenames) {
			if (existsSync(join(dir, filename))) return { version, dir, base };
		}
	}
	return null;
}

/** Re-run the current script with the installed addon, or return false. */
export function borrowInstalledAddon(host, script) {
	const addon = findInstalledAddon(host);
	if (!addon) return false;
	console.log(`borrowing @oh-my-pi/pi-natives@${addon.version} from ${addon.dir}`);
	const child = spawnSync(process.execPath, [script], {
		stdio: "inherit",
		env: {
			...process.env,
			PI_COMPILED: "1",
			PI_NATIVES_DIR: addon.base,
			OMP_SMOKE_BORROWED: addon.dir,
		},
	});
	process.exit(child.status ?? 1);
}

/**
 * Borrow when the local addon's stamped version differs from the checkout's
 * package version. An import that succeeds is not proof of a matching addon.
 */
export function borrowStaleAddon(host, script) {
	if (process.env.OMP_SMOKE_BORROW === "0" || process.env.OMP_SMOKE_BORROWED) {
		return false;
	}
	const expected = manifestVersion(host);
	const local = localAddon(host);
	const built = local ? addonBuildVersion(local) : null;
	if (!expected || !built || built === expected) return false;
	if (!findInstalledAddon(host)) return false;
	console.log(
		`local addon reports ${built}, host expects ${expected}; borrowing the installed version`,
	);
	return borrowInstalledAddon(host, script);
}
