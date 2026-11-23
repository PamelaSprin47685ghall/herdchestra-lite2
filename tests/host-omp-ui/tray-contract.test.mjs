// Red contract for src/host/manager-tray.mjs (not yet implemented).
//
// Production API:
//   createManagerTray({ url, token, adapter, openUrl, diagnostics })
//     -> { start(), stop(), click(), get visible() }
//
// `adapter` is the injectable desktop capability:
//   { create({ tooltip, onClick }) -> handle, destroy(handle) }
// `openUrl` defaults to the platform browser opener; tests inject a spy.
// The tray belongs to the manager leader only: followers never start one.
import { describe, expect, test } from "bun:test";
import { createManagerTray } from "../../host-omp-ui/src/host/manager-tray.mjs";

function makeAdapter({ failCreate = false, failDestroy = false } = {}) {
	const live = new Set();
	const clicks = [];
	const adapter = {
		live,
		clicks,
		create({ tooltip, onClick }) {
			if (failCreate) throw new Error("no desktop tray");
			const handle = { tooltip, onClick };
			live.add(handle);
			return handle;
		},
		destroy(handle) {
			live.delete(handle);
			if (failDestroy) throw new Error("destroy failed");
		},
	};
	return adapter;
}

function makeDiagnostics() {
	const entries = [];
	return { entries, record: (label, error) => entries.push({ label, error }) };
}

const base = "http://127.0.0.1:37421";
const token = "a+b/c=d";

describe("manager tray lifecycle", () => {
	test("start creates exactly one tray; start is idempotent", async () => {
		const adapter = makeAdapter();
		const tray = createManagerTray({ url: base, token, adapter, openUrl: () => {} });
		await tray.start();
		await tray.start();
		expect(adapter.live.size).toBe(1);
		expect(tray.visible).toBe(true);
	});

	test("click opens the fixed Web address with the shared token", async () => {
		const adapter = makeAdapter();
		const opened = [];
		const tray = createManagerTray({ url: base, token, adapter, openUrl: (url) => opened.push(url) });
		await tray.start();
		const [handle] = [...adapter.live];
		handle.onClick();
		expect(opened).toEqual([`${base}/?token=${encodeURIComponent(token)}`]);
	});

	test("stop destroys the icon and leaves no live handle", async () => {
		const adapter = makeAdapter();
		const tray = createManagerTray({ url: base, token, adapter, openUrl: () => {} });
		await tray.start();
		await tray.stop();
		expect(tray.visible).toBe(false);
		expect(adapter.live.size).toBe(0);
	});

	test("a later leader can show again without stacking icons", async () => {
		const adapter = makeAdapter();
		const first = createManagerTray({ url: base, token, adapter, openUrl: () => {} });
		const second = createManagerTray({ url: base, token, adapter, openUrl: () => {} });
		await first.start();
		await first.stop();
		await second.start();
		expect(adapter.live.size).toBe(1);
	});

	test("desktop tray unavailable is diagnosed and does not throw", async () => {
		const adapter = makeAdapter({ failCreate: true });
		const diagnostics = makeDiagnostics();
		const tray = createManagerTray({ url: base, token, adapter, openUrl: () => {}, diagnostics });
		await tray.start();
		expect(tray.visible).toBe(false);
		expect(diagnostics.entries).toHaveLength(1);
		expect(diagnostics.entries[0].label).toBe("tray-start");
	});

	test("a broken destroy is diagnosed; stop still reports hidden", async () => {
		const adapter = makeAdapter({ failDestroy: true });
		const diagnostics = makeDiagnostics();
		const tray = createManagerTray({ url: base, token, adapter, openUrl: () => {}, diagnostics });
		await tray.start();
		await tray.stop();
		expect(tray.visible).toBe(false);
		expect(diagnostics.entries.some((entry) => entry.label === "tray-stop")).toBe(true);
	});

	test("token never appears in diagnostics", async () => {
		const adapter = makeAdapter({ failCreate: true });
		const diagnostics = makeDiagnostics();
		const tray = createManagerTray({ url: base, token, adapter, openUrl: () => {}, diagnostics });
		await tray.start();
		const text = diagnostics.entries.map((entry) => String(entry.error?.message ?? entry.error)).join("\n");
		expect(text).not.toContain(token);
	});
});

describe("async desktop adapter", () => {
	test("awaits async create and destroy without leaving a live icon", async () => {
		const live = new Set();
		const events = [];
		const adapter = {
			live,
			async create() {
				await Promise.resolve();
				const handle = { onClick: () => {} };
				live.add(handle);
				events.push("create");
				return handle;
			},
			async destroy(handle) {
				await Promise.resolve();
				live.delete(handle);
				events.push("destroy");
			},
		};
		const tray = createManagerTray({ url: base, token, adapter, openUrl: () => {} });
		await tray.start();
		expect(tray.visible).toBe(true);
		await tray.stop();
		expect(tray.visible).toBe(false);
		expect(adapter.live.size).toBe(0);
		expect(events).toEqual(["create", "destroy"]);
	});

	test("stop during a pending create still destroys the late icon", async () => {
		const live = new Set();
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const adapter = {
			live,
			create() {
				return gate.then(() => {
					const handle = { onClick: () => {} };
					live.add(handle);
					return handle;
				});
			},
			destroy(handle) {
				live.delete(handle);
			},
		};
		const tray = createManagerTray({ url: base, token, adapter, openUrl: () => {} });
		const starting = tray.start();
		await tray.stop();
		release();
		await starting;
		expect(tray.visible).toBe(false);
		expect(live.size).toBe(0);
	});

	test("async destroy failure is diagnosed, rejects nothing, and scrubs the token", async () => {
		const diagnostics = makeDiagnostics();
		const adapter = {
			create() {
				return { onClick: () => {} };
			},
			async destroy() {
				throw new Error(`boom ${token}`);
			},
		};
		const tray = createManagerTray({ url: base, token, adapter, openUrl: () => {}, diagnostics });
		await tray.start();
		await tray.stop();
		expect(tray.visible).toBe(false);
		const entry = diagnostics.entries.find((item) => item.label === "tray-stop");
		expect(entry).toBeTruthy();
		expect(String(entry.error.message)).not.toContain(token);
	});
});
