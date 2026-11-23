import { expect, test } from "bun:test";
import { createDeltaMerger, createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";

function harness() {
	const frames = [];
	const scheduled = [];
	const merger = createDeltaMerger(
		(frame) => frames.push(frame),
		(run) => { scheduled.push(run); return scheduled.length; },
	);
	return { frames, scheduled, merger };
}

const text = (delta, blockIndex = 0, messageId = "m1") => ({
	type: "transcript.delta",
	payload: { kind: "text_delta", messageId, blockIndex, delta },
});

test("same block consecutive text deltas merge into one abc flush", () => {
	const { frames, scheduled, merger } = harness();
	for (const d of ["a", "b", "c"]) merger.push(text(d));
	expect(scheduled.length).toBe(1);
	expect(frames.length).toBe(0);
	scheduled[0]();
	expect(frames.length).toBe(1);
	expect(frames[0].payload.delta).toBe("abc");
});

test("different blockIndex preserves order", () => {
	const { frames, scheduled, merger } = harness();
	merger.push(text("a", 0));
	merger.push(text("b", 1));
	expect(frames.length).toBe(1);
	expect(frames[0].payload.delta).toBe("a");
	scheduled[scheduled.length - 1]();
	expect(frames.length).toBe(2);
	expect(frames[1].payload.delta).toBe("b");
});

test("message_end flushes pending delta before dispatch", () => {
	const { frames, merger } = harness();
	merger.push(text("a"));
	merger.push({ type: "transcript.delta", payload: { kind: "message_end", messageId: "m1" } });
	expect(frames.map((f) => f.payload.kind)).toEqual(["text_delta", "message_end"]);
});

test("station.flushDeltas dispatches the pending merge without rescheduling", () => {
	const frames = [];
	const scheduled = [];
	const station = createUiBridgeStation({
		capabilities: { dispatch: (frame) => frames.push(frame) },
		schedule: (run) => { scheduled.push(run); return scheduled.length; },
	});
	const message = { id: "a1", role: "assistant", content: [], timestamp: 10 };
	station.onAgentEvent({ type: "message_start", message });
	station.onAgentEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", delta: "a" },
	});
	const deltas = () => frames.filter((frame) => frame.payload?.kind === "text_delta");
	expect(deltas()).toHaveLength(0);
	expect(scheduled).toHaveLength(1);

	station.flushDeltas();
	expect(deltas()).toHaveLength(1);
	expect(deltas()[0].payload.delta).toBe("a");
	expect(scheduled).toHaveLength(1);

	station.flushDeltas();
	expect(deltas()).toHaveLength(1);
});
