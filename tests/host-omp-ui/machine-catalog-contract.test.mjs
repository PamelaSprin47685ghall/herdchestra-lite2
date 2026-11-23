import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Red contract for host-omp-ui/src/manager/machine-catalog.mjs.
// Do not run Red. The module is expected to be implemented by the Green slice.
//
// Contract:
//   scanMachineSessions({ roots, extraDirs }) -> Promise<{ sessions, diagnostics }>
//   - roots: session roots, each containing *.jsonl directly and/or one bucket directory deep.
//   - extraDirs: additional session dirs with the same shape (custom --session-dir).
//   - Never mutates files, never claims a session lock, never imports @oh-my-pi.
//   - session: { id, path, cwd, title, modified, origin, continuationOf, previousPaths }
//       path is the canonical (newest continuation-tail) absolute path.
//       cwd is null when the header has no cwd; it is never guessed from the bucket name.
//       modified is Math.round(fs.stat().mtimeMs).
//   - diagnostics: [{ path, code: "missing_root" | "invalid_header" | "unreadable", message }]
//     A bad file or root never rejects the whole scan.
const MODULE = "../../host-omp-ui/src/manager/machine-catalog.mjs";

async function load() {
	try {
		return await import(MODULE);
	} catch (error) {
		throw new Error(`Red contract: ${MODULE} is not implemented yet (${error.message})`);
	}
}

const created = [];

afterEach(async () => {
	await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot() {
	const dir = await mkdtemp(join(tmpdir(), "omp-machine-catalog-"));
	created.push(dir);
	return dir;
}

function sessionHeader(overrides = {}) {
	return {
		type: "session",
		version: 1,
		id: "11111111-1111-4111-8111-111111111111",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/home/u/project-a",
		...overrides,
	};
}

async function writeSession(path, header, prefix = []) {
	await mkdir(dirname(path), { recursive: true });
	const lines = [...prefix, header, { type: "message", role: "user", content: "hello" }];
	await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	await utimes(path, new Date("2026-01-01T00:00:00.000Z"), new Date(header.timestamp));
	return path;
}

function byId(sessions, id) {
	return sessions.find((session) => session.id === id);
}

describe("machine session catalog", () => {
	test("reads a standalone title entry when the session header has none", async () => {
		const root = await tempRoot();
		const path = join(root, "-home-u-project-c", "c.jsonl");
		await mkdir(dirname(path), { recursive: true });
		const lines = [
			{ type: "title", v: 1, title: "Titled Session", source: "auto" },
			sessionHeader({ id: "33333333-3333-4333-8333-333333333333", cwd: "/home/u/project-c" }),
			{ type: "message", role: "user", content: "hello" },
		];
		await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

		const { scanMachineSessions } = await load();
		const { sessions } = await scanMachineSessions({ roots: [root] });
		expect(byId(sessions, "33333333-3333-4333-8333-333333333333")).toMatchObject({ title: "Titled Session" });
	});

	test("falls back to the first real user message, never an agent-injected one", async () => {
		const root = await tempRoot();
		const path = join(root, "-home-u-project-d", "d.jsonl");
		await mkdir(dirname(path), { recursive: true });
		const lines = [
			sessionHeader({ id: "44444444-4444-4444-8444-444444444444", cwd: "/home/u/project-d" }),
			{ type: "message", message: { role: "user", attribution: "agent", content: "You are the child of fork x" } },
			{
				type: "message",
				message: { role: "user", attribution: "user", content: [{ type: "text", text: "  Fix the   sidebar  " }] },
			},
		];
		await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

		const { scanMachineSessions } = await load();
		const { sessions } = await scanMachineSessions({ roots: [root] });
		expect(byId(sessions, "44444444-4444-4444-8444-444444444444")).toMatchObject({ title: "Fix the sidebar" });
	});

	test("finds session headers across roots and bucket directories", async () => {
		const root = await tempRoot();
		const otherRoot = await tempRoot();
		const a = await writeSession(join(root, "-home-u-project-a", "a.jsonl"), sessionHeader());
		const b = await writeSession(
			join(otherRoot, "-home-u-project-b", "b.jsonl"),
			sessionHeader({ id: "22222222-2222-4222-8222-222222222222", cwd: "/home/u/project-b", title: "B" }),
		);

		const { scanMachineSessions } = await load();
		const { sessions, diagnostics } = await scanMachineSessions({ roots: [root, otherRoot] });

		expect(diagnostics).toEqual([]);
		expect(sessions).toHaveLength(2);
		expect(byId(sessions, "11111111-1111-4111-8111-111111111111")).toMatchObject({ path: resolve(a), cwd: "/home/u/project-a" });
		expect(byId(sessions, "22222222-2222-4222-8222-222222222222")).toMatchObject({ path: resolve(b), cwd: "/home/u/project-b", title: "B" });
	});

	test("finds the session header even when a title record comes first", async () => {
		const root = await tempRoot();
		const file = join(root, "-home-u-project-a", "a.jsonl");
		await writeSession(file, sessionHeader(), [
			{ type: "title", v: 1, title: "Generated later", updatedAt: "2026-01-01T00:00:00.000Z" },
		]);

		const { scanMachineSessions } = await load();
		const { sessions } = await scanMachineSessions({ roots: [root] });

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", path: resolve(file) });
	});

	test("uses the newest continuation file for one session id", async () => {
		const root = await tempRoot();
		const bucket = join(root, "-home-u-project-a");
		const original = await writeSession(join(bucket, "2026-01-01_1111.jsonl"), sessionHeader());
		const continuation = join(bucket, "2026-01-02_1111.jsonl");
		await writeSession(
			continuation,
			sessionHeader({ continuationOf: "2026-01-01_1111.jsonl", timestamp: "2026-01-02T00:00:00.000Z" }),
		);
		await utimes(continuation, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));

		const { scanMachineSessions } = await load();
		const { sessions } = await scanMachineSessions({ roots: [root] });

		expect(sessions).toHaveLength(1);
		expect(sessions[0].path).toBe(resolve(continuation));
		expect(sessions[0].continuationOf).toBe("2026-01-01_1111.jsonl");
		expect(sessions[0].previousPaths).toContain(resolve(original));
	});

	test("exposes a missing cwd as null instead of guessing it from the bucket name", async () => {
		const root = await tempRoot();
		const file = join(root, "-home-u-project-a", "a.jsonl");
		await writeSession(file, { type: "session", id: "33333333-3333-4333-8333-333333333333", timestamp: "2026-01-01T00:00:00.000Z" });

		const { scanMachineSessions } = await load();
		const { sessions } = await scanMachineSessions({ roots: [root] });

		expect(sessions[0].cwd).toBeNull();
	});

	test("skips corrupt files with diagnostics instead of failing the scan", async () => {
		const root = await tempRoot();
		const good = await writeSession(join(root, "bucket", "good.jsonl"), sessionHeader());
		const corrupt = join(root, "bucket", "corrupt.jsonl");
		await writeFile(corrupt, "{not json}\n{\"type\":\"message\"}\n", "utf8");

		const { scanMachineSessions } = await load();
		const { sessions, diagnostics } = await scanMachineSessions({ roots: [root] });

		expect(sessions.map((session) => session.path)).toEqual([resolve(good)]);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({ path: resolve(corrupt), code: "invalid_header" }),
		);
	});

	test("reports a missing root without throwing", async () => {
		const root = await tempRoot();
		const missing = join(root, "no-such-root");

		const { scanMachineSessions } = await load();
		const { sessions, diagnostics } = await scanMachineSessions({ roots: [missing] });

		expect(sessions).toEqual([]);
		expect(diagnostics).toContainEqual(expect.objectContaining({ path: resolve(missing), code: "missing_root" }));
	});

	test("reports an unreadable entry as a diagnostic", async () => {
		const root = await tempRoot();
		const broken = join(root, "bucket", "broken.jsonl");
		await mkdir(broken, { recursive: true });

		const { scanMachineSessions } = await load();
		const { diagnostics } = await scanMachineSessions({ roots: [root] });

		expect(diagnostics).toContainEqual(expect.objectContaining({ path: resolve(broken), code: "unreadable" }));
	});

	test("scans extra non-default session directories and deduplicates overlap", async () => {
		const root = await tempRoot();
		const extra = await tempRoot();
		const extraFile = await writeSession(
			join(extra, "flat.jsonl"),
			sessionHeader({ id: "44444444-4444-4444-8444-444444444444", cwd: "/tmp/custom" }),
		);

		const { scanMachineSessions } = await load();
		const once = await scanMachineSessions({ roots: [root], extraDirs: [extra] });
		expect(once.sessions).toHaveLength(1);
		expect(once.sessions[0]).toMatchObject({ path: resolve(extraFile), cwd: "/tmp/custom" });

		const overlap = await scanMachineSessions({ roots: [extra], extraDirs: [extra] });
		expect(overlap.sessions).toHaveLength(1);
	});

	test("does not modify session files or create siblings", async () => {
		const root = await tempRoot();
		const file = await writeSession(join(root, "bucket", "a.jsonl"), sessionHeader());
		const before = {
			content: await readFile(file, "utf8"),
			mtime: (await stat(file)).mtimeMs,
			entries: (await readdir(dirname(file))).sort(),
		};

		const { scanMachineSessions } = await load();
		await scanMachineSessions({ roots: [root] });

		expect(await readFile(file, "utf8")).toBe(before.content);
		expect((await stat(file)).mtimeMs).toBe(before.mtime);
		expect((await readdir(dirname(file))).sort()).toEqual(before.entries);
		expect(existsSync(`${file}.lock`)).toBe(false);
	});
});
