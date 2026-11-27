// Delta coalescing for the web bridge, kept out of the Station.
//
// The Station is a synchronous aggregate root: it commits state and hands a
// frame to the injected dispatcher. Waiting — even a 16ms timer — belongs to a
// ticket, so the schedule that turns many text deltas into one frame is here and
// the Station only receives the resulting capability.
//
// This module lives in the domain layer because it imports nothing: the
// Station's own directory may not reach into `../host/`.

export function createDeltaMerger(dispatch, schedule = (run) => setTimeout(run, 16)) {
	let pending = null;
	let timer = null;
	let scheduled = false;
	const cancel = () => {
		if (timer != null && typeof clearTimeout === "function") clearTimeout(timer);
		timer = null;
		scheduled = false;
	};
	const flush = () => {
		cancel();
		if (!pending) return;
		const frame = pending;
		pending = null;
		dispatch(frame);
	};
	const push = (frame) => {
		const payload = frame?.payload;
		const mergeable =
			frame?.type === "transcript.delta" &&
			(payload?.kind === "text_delta" || payload?.kind === "thinking_delta");
		if (!mergeable) {
			flush();
			dispatch(frame);
			return;
		}
		if (
			pending &&
			pending.payload.kind === payload.kind &&
			pending.payload.messageId === payload.messageId &&
			pending.payload.blockIndex === payload.blockIndex
		) {
			pending.payload.delta += payload.delta ?? "";
			if (typeof frame.seq === "number") pending.seq = Math.max(pending.seq ?? 0, frame.seq);
		} else {
			flush();
			pending = { type: "transcript.delta", seq: frame.seq, payload: { ...payload } };
		}
		if (!scheduled) {
			scheduled = true;
			timer = schedule(flush);
		}
	};
	return { push, flush };
}
