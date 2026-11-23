import { expect, test } from "bun:test";
import { bindStationDispatch, shutdownRuntime } from "../../host-omp-ui/src/activation/index.mjs";

function makeRuntime(bootPromise) {
	const calls = [];
	const current = {
		disposed: false,
		bootPromise,
		station: { flushDeltas: () => calls.push("flush") },
		unsubscribeCapture: () => calls.push("unsubscribe"),
		bridge: { cancel: () => calls.push("bridge-cancel") },
		watcher: { dispose: () => calls.push("watcher-dispose") },
		uiDecoration: { dispose: () => calls.push("ui-decoration-dispose") },
		server: { close: async () => calls.push("server-close") },
	};
	return { current, calls };
}

test("shutdown marks disposed first and waits for the in-flight boot before flushing", async () => {
	let release;
	const bootPromise = new Promise((resolve) => {
		release = resolve;
	});
	const { current, calls } = makeRuntime(bootPromise);
	const bootSettled = bootPromise.then(() => calls.push("boot-settled"));
	current.station.flushDeltas = () => calls.push(`flush:disposed=${current.disposed}`);

	const done = shutdownRuntime(current);
	await Promise.resolve();
	expect(current.disposed).toBe(true);
	expect(calls).toEqual([]);

	release();
	await bootSettled;
	await done;
	expect(calls.indexOf("boot-settled")).toBeLessThan(calls.indexOf("flush:disposed=true"));
	expect(calls).toContain("server-close");
	expect(calls).toContain("unsubscribe");
});

test("a station dispatches to the runtime it was born with, not the newest one", () => {
	const receivedBy = { a: [], b: [] };
	const refA = { capabilitiesDispatch: (event) => receivedBy.a.push(event) };
	const refB = { capabilitiesDispatch: (event) => receivedBy.b.push(event) };
	const dispatchA = bindStationDispatch(refA);

	// A new session replaces the module-level current runtime; A's station
	// must still deliver its own frames to A's channel.
	refB.capabilitiesDispatch = (event) => receivedBy.b.push(event);
	dispatchA({ type: "transcript.delta", payload: { kind: "text_delta", messageId: "m", blockIndex: 0, delta: "x" } });

	expect(receivedBy.a).toHaveLength(1);
	expect(receivedBy.b).toHaveLength(0);
});

test("a runtime ref without a dispatch capability is inert", () => {
	const dispatch = bindStationDispatch({});
	expect(() => dispatch({ type: "snapshot" })).not.toThrow();
});


test("a rejected boot does not reject shutdown", async () => {
	const { current, calls } = makeRuntime(Promise.reject(new Error("boot failed")));
	await shutdownRuntime(current);
	expect(calls).toContain("flush");
	expect(calls).toContain("server-close");
});

test("a boot that never settles is bounded by the deadline", async () => {
	const { current, calls } = makeRuntime(new Promise(() => {}));
	await shutdownRuntime(current, { deadlineMs: 5 });
	expect(calls).toContain("flush");
	expect(calls).toContain("server-close");
});

test("shutdown without a runtime or boot is a no-op", async () => {
	await shutdownRuntime(null);
	const { current, calls } = makeRuntime(undefined);
	await shutdownRuntime(current);
	expect(calls).toEqual(["flush", "unsubscribe", "bridge-cancel", "watcher-dispose", "ui-decoration-dispose", "server-close"]);
});
