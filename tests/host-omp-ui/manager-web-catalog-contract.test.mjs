import { describe, test, expect } from "bun:test";

/**
 * Red contract for the machine-wide session catalog in the Web client.
 *
 * Do not run Red. The manager is the user's entry point, so the catalog must
 * be machine-wide: every project, every registered `--session-dir`, not just
 * the cwd of whichever instance currently owns the live session.
 *
 * Minimal API required from `host-omp-ui/web/src/protocol/store.ts`:
 *
 *   Frame { type: "manager.sessions", sessions: SessionSummary[] }
 *     - Replaces `WebState.sessions` with the manager's authoritative
 *       machine-wide catalog. Missing/invalid `sessions` is a no-op.
 *
 *   Snapshot `sessions` (the instance's project-only list)
 *     - MERGES by session id into `WebState.sessions`; it never removes a
 *       catalog entry. The catalog is owned by the manager frame, not by
 *       whichever instance snapshot arrived last.
 *     - A duplicate id keeps the entry with the newest `modified`.
 *
 *   `session.select` / `session.switched` / `meta.update`
 *     - Preserve `WebState.sessions`. Switching the active instance must not
 *       reset the user's catalog to that instance's cwd.
 *
 * Delivery note for the Green slice: AppShell must load the manager catalog
 * on first open (and on the refresh button) by sending the catalog frame;
 * `fetchBootstrap()` alone is not the catalog. The reducer contract below
 * keeps that transport choice free.
 */

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";

async function loadStore() {
	try {
		return await import(STORE);
	} catch (error) {
		throw new Error(`Red contract: cannot load ${STORE}: ${error.message}`);
	}
}

function session(id, cwd, extra = {}) {
	return {
		id,
		title: `Session ${id}`,
		cwd,
		path: `/sessions/${cwd.replaceAll("/", "-")}/${id}.jsonl`,
		modified: "2026-11-20T00:00:00.000Z",
		...extra,
	};
}

function catalog(sessions) {
	return { type: "manager.sessions", sessions };
}

function snapshot({ id = "live", sessions = [], ...rest } = {}) {
	return {
		type: "snapshot",
		sessionId: id,
		session: { id, title: `Session ${id}` },
		messages: [],
		streaming: false,
		models: [],
		meta: {},
		todos: [],
		queue: { steering: [], followUp: [] },
		draft: { rev: 0, text: "", origin: "tui" },
		pendingInteractions: [],
		surface: { sf: "s:web", s: 1, ops: [] },
		notifications: [],
		sessions,
		artifacts: [],
		...rest,
	};
}

const A = session("a", "/home/u/project-a");
const B = session("b", "/home/u/project-b");
const C = session("c", "/tmp/other-profile");

describe("machine-wide session catalog", () => {
	test("manager.sessions hydrates sessions from every project", async () => {
		const { createInitialWebState, reduceWebState } = await loadStore();
		const state = reduceWebState(createInitialWebState(), catalog([A, B, C]));
		expect(state.sessions.map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
		expect(state.sessions.find((item) => item.id === "b").cwd).toBe("/home/u/project-b");
	});

	test("an instance snapshot with a project-only list cannot shrink the catalog", async () => {
		const { createInitialWebState, reduceWebState } = await loadStore();
		let state = reduceWebState(createInitialWebState(), catalog([A, B, C]));
		state = reduceWebState(state, snapshot({ sessions: [A] }));
		expect(state.sessions.map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
	});

	test("a first snapshot still contributes its project sessions before the catalog loads", async () => {
		const { createInitialWebState, reduceWebState } = await loadStore();
		const state = reduceWebState(createInitialWebState(), snapshot({ sessions: [A] }));
		expect(state.sessions.map((item) => item.id)).toEqual(["a"]);
	});

	test("switching the active instance preserves the catalog", async () => {
		const { createInitialWebState, reduceWebState } = await loadStore();
		let state = reduceWebState(createInitialWebState(), catalog([A, B, C]));
		state = reduceWebState(state, {
			type: "session.select",
			sessionId: "b",
			instanceId: "instance-b",
		});
		state = reduceWebState(state, snapshot({ id: "b", sessions: [B] }));
		expect(state.sessions.map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
		expect(state.liveSession.session?.id).toBe("b");
	});

	test("a late meta.update cannot replace the catalog with an instance list", async () => {
		const { createInitialWebState, reduceWebState } = await loadStore();
		let state = reduceWebState(createInitialWebState(), catalog([A, B, C]));
		state = reduceWebState(state, {
			type: "meta.update",
			sessionId: "a",
			sessions: [A],
		});
		expect(state.sessions.map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
	});

	test("refreshing the catalog replaces stale entries but keeps the active view", async () => {
		const { createInitialWebState, reduceWebState } = await loadStore();
		let state = reduceWebState(createInitialWebState(), catalog([A, B]));
		state = reduceWebState(state, { type: "session.select", sessionId: "a" });
		state = reduceWebState(state, catalog([session("a", "/home/u/project-a", { title: "Renamed A" }), C]));
		expect(state.sessions.map((item) => item.id).sort()).toEqual(["a", "c"]);
		expect(state.sessions.find((item) => item.id === "a").title).toBe("Renamed A");
		expect(state.liveSession.session?.id).toBe("a");
	});

	test("duplicate ids from two instances keep the newest record", async () => {
		const { createInitialWebState, reduceWebState } = await loadStore();
		let state = reduceWebState(createInitialWebState(), catalog([A]));
		state = reduceWebState(
			state,
			snapshot({
				sessions: [
					session("a", "/home/u/project-a", {
						title: "Newer A",
						modified: "2026-11-22T00:00:00.000Z",
					}),
				],
			}),
		);
		expect(state.sessions.find((item) => item.id === "a").title).toBe("Newer A");
	});

	test("a malformed catalog frame never erases the catalog", async () => {
		const { createInitialWebState, reduceWebState } = await loadStore();
		let state = reduceWebState(createInitialWebState(), catalog([A, B]));
		state = reduceWebState(state, { type: "manager.sessions" });
		state = reduceWebState(state, { type: "manager.sessions", sessions: null });
		expect(state.sessions.map((item) => item.id).sort()).toEqual(["a", "b"]);
	});
});
