import { describe, expect, test } from "bun:test";

import { installFissionUI } from "../src/host/fission-ui.mjs";

// A session stands in for the host agent stream: subscribe registers, emit
// pushes the same event object to every current subscriber.
function createSession() {
	const listeners = new Set();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
		get listenerCount() {
			return listeners.size;
		},
	};
}

const turn = () => ({ type: "turn_start" });
const start = (text) => ({ type: "message_start", message: { role: "assistant", text } });
const update = (text) => ({
	type: "message_update",
	message: { role: "assistant", text },
	assistantMessageEvent: { type: "text_delta", delta: text },
});
const end = (text, extra = {}) => ({ type: "message_end", message: { role: "assistant", text, ...extra } });

describe("installFissionUI", () => {
	test("rejects a session that cannot subscribe", () => {
		expect(() => installFissionUI(null)).toThrow(TypeError);
		expect(() => installFissionUI({})).toThrow(/subscribe/);
		expect(() => installFissionUI({ subscribe: "not a function" })).toThrow(TypeError);
	});

	test("installs one bridge per session", () => {
		const session = createSession();
		const bridge = installFissionUI(session);
		expect(installFissionUI(session)).toBe(bridge);
		// One host subscription feeds the mux, no matter how many UI listeners exist.
		expect(session.listenerCount).toBe(1);
	});

	test("delivers each host event once to every listener", () => {
		const session = createSession();
		const bridge = installFissionUI(session);
		const first = [];
		const second = [];
		session.subscribe((event) => first.push(event));
		session.subscribe((event) => second.push(event));

		const event = turn();
		session.emit(event);

		expect(first).toEqual([event]);
		expect(second).toEqual([event]);
		expect(bridge.listenerCount).toBe(2);
	});

	test("an unsubscribe removes only its own listener", () => {
		const session = createSession();
		installFissionUI(session);
		const first = [];
		const second = [];
		const unsubscribeFirst = session.subscribe((event) => first.push(event));
		session.subscribe((event) => second.push(event));

		unsubscribeFirst();
		unsubscribeFirst();
		session.emit(turn());

		expect(first).toEqual([]);
		expect(second).toHaveLength(1);
	});

	test("leaves subscribers installed before the bridge on the raw stream", () => {
		const session = createSession();
		const before = [];
		session.subscribe((event) => before.push(event));
		installFissionUI(session);
		const after = [];
		session.subscribe((event) => after.push(event));

		const event = turn();
		session.emit(event);

		expect(before).toEqual([event]);
		expect(after).toEqual([event]);
	});

	test("dispose restores the session and keeps subscribed listeners alive", () => {
		const session = createSession();
		const originalSubscribe = session.subscribe;
		const bridge = installFissionUI(session);
		const seen = [];
		const unsubscribe = session.subscribe((event) => seen.push(event));
		expect(session.subscribe).not.toBe(originalSubscribe);

		bridge.dispose();
		bridge.dispose();
		expect(session.subscribe).toBe(originalSubscribe);
		expect(bridge.listenerCount).toBe(0);
		expect(() => bridge.accept("flow", turn())).toThrow(/disposed/);
		expect(() => bridge.cancel("flow", end("cancelled"))).toThrow(/disposed/);
		expect(() => bridge.attach("flow", createSession())).toThrow(/disposed/);

		const event = turn();
		session.emit(event);
		expect(seen).toEqual([event]);

		unsubscribe();
		session.emit(turn());
		expect(seen).toHaveLength(1);
	});

	test("a disposed bridge can be followed by a fresh install", () => {
		const session = createSession();
		const first = installFissionUI(session);
		first.dispose();
		const second = installFissionUI(session);
		expect(second).not.toBe(first);

		const seen = [];
		session.subscribe((event) => seen.push(event));
		const event = turn();
		session.emit(event);
		expect(seen).toEqual([event]);
		expect(session.listenerCount).toBe(2);
	});

	test("serializes competing flows into one legal single-stream sequence", () => {
		const session = createSession();
		const bridge = installFissionUI(session);
		const seen = [];
		session.subscribe((event) => seen.push(event));
		const flowA = createSession();
		const flowB = createSession();
		const detachA = bridge.attach("a", flowA);
		bridge.attach("b", flowB);

		const ownerStart = start("owner");
		const ownerEnd = end("owner");
		session.emit(ownerStart);

		const aStart = start("a");
		const aUpdate = update("aa");
		const aEnd = end("aaa");
		flowA.emit(aStart);
		flowA.emit(aUpdate);
		flowA.emit(aEnd);
		const bStart = start("b");
		flowB.emit(bStart);
		expect(seen).toEqual([ownerStart]);

		session.emit(ownerEnd);
		expect(seen).toEqual([ownerStart, ownerEnd, aStart, aUpdate, aEnd, bStart]);

		const bEnd = end("bbbb");
		flowB.emit(bEnd);
		expect(seen).toEqual([ownerStart, ownerEnd, aStart, aUpdate, aEnd, bStart, bEnd]);

		detachA();
		flowA.emit(start("late"));
		expect(seen).toHaveLength(7);
	});

	test("shows a broadcast once across flows", () => {
		const session = createSession();
		const bridge = installFissionUI(session);
		const seen = [];
		session.subscribe((event) => seen.push(event));
		const flowA = createSession();
		const flowB = createSession();
		bridge.attach("a", flowA);
		bridge.attach("b", flowB);

		const details = { fissionBroadcast: { broadcastId: "broadcast-1" } };
		const firstStart = { type: "message_start", message: { role: "assistant", details } };
		const firstEnd = { type: "message_end", message: { role: "assistant", details } };
		flowA.emit(firstStart);
		flowA.emit(firstEnd);

		const secondStart = { type: "message_start", message: { role: "assistant", details } };
		const secondEnd = { type: "message_end", message: { role: "assistant", details } };
		flowB.emit(secondStart);
		flowB.emit(secondEnd);

		expect(seen).toEqual([firstStart, firstEnd]);
	});

	test("refuses a second attach and a source without subscribe", () => {
		const bridge = installFissionUI(createSession());
		bridge.attach("a", createSession());
		expect(() => bridge.attach("a", createSession())).toThrow(/already attached/);
		expect(() => bridge.attach("b", {})).toThrow(TypeError);
		expect(() => bridge.attach("b", null)).toThrow(TypeError);
	});

	test("cancels an open flow message with the supplied terminal event", () => {
		const session = createSession();
		const bridge = installFissionUI(session);
		const seen = [];
		session.subscribe((event) => seen.push(event));

		const open = start("a");
		bridge.accept("a", open);
		const aborted = end("partial", { stopReason: "aborted" });
		bridge.cancel("a", aborted);
		expect(seen).toEqual([open, aborted]);

		// Cancelling a flow without an open message is a quiet no-op.
		bridge.cancel("a", aborted);
		expect(seen).toEqual([open, aborted]);

		const bStart = start("b");
		bridge.accept("b", bStart);
		expect(() => bridge.cancel("b", turn())).toThrow(/message_end/);
		const bEnd = end("b");
		bridge.cancel("b", bEnd);
		expect(seen).toEqual([open, aborted, bStart, bEnd]);
	});

	test("a throwing host unsubscribe cannot poison the session", () => {
		const listeners = new Set();
		const session = {
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					throw new Error("host unsubscribe failed");
				};
			},
			emit(event) {
				for (const listener of [...listeners]) listener(event);
			},
			get listenerCount() {
				return listeners.size;
			},
		};
		const originalSubscribe = session.subscribe;
		const bridge = installFissionUI(session);
		const seen = [];
		session.subscribe((event) => seen.push(event));
		bridge.attach("a", {
			subscribe() {
				return () => {
					throw new Error("flow detach failed");
				};
			},
		});

		expect(() => bridge.dispose()).not.toThrow();
		expect(session.subscribe).toBe(originalSubscribe);
		expect(bridge.listenerCount).toBe(0);
		expect(() => bridge.accept("a", turn())).toThrow(/disposed/);

		// The dead bridge is not cached: the session can be bridged again.
		const second = installFissionUI(session);
		expect(second).not.toBe(bridge);
		const after = [];
		session.subscribe((event) => after.push(event));
		const event = turn();
		session.emit(event);
		expect(after).toEqual([event]);
		// A listener subscribed through the dead bridge keeps the raw stream.
		expect(seen).toEqual([event]);
	});

	test("installing over an accessor leaves its setter untouched", () => {
		const listeners = new Set();
		const original = (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		};
		const session = {
			emit(event) {
				for (const listener of [...listeners]) listener(event);
			},
		};
		let setterCalls = 0;
		Object.defineProperty(session, "subscribe", {
			configurable: true,
			enumerable: false,
			get: () => original,
			set: () => {
				setterCalls += 1;
			},
		});

		const bridge = installFissionUI(session);
		expect(setterCalls).toBe(0);
		const seen = [];
		session.subscribe((event) => seen.push(event));
		session.emit(turn());
		expect(seen).toHaveLength(1);

		bridge.dispose();
		expect(setterCalls).toBe(0);
		expect(session.subscribe).toBe(original);
		expect(Object.getOwnPropertyDescriptor(session, "subscribe")?.get).toBeInstanceOf(Function);
	});

	test("a refused patch leaves no owner subscription behind", () => {
		const listeners = new Set();
		const original = (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		};
		const session = { emit() {} };
		Object.defineProperty(session, "subscribe", {
			value: original,
			configurable: false,
			enumerable: false,
			writable: false,
		});

		expect(() => installFissionUI(session)).toThrow(TypeError);
		expect(session.subscribe).toBe(original);
		expect(listeners.size).toBe(0);
	});
});
