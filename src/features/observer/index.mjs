// Observer port: keep a record of what the provider actually sent, or nothing.
//
// `on` appends a small, opaque fact per request and can report the last one.
// `off` accepts the same calls and forgets them, so a disabled observer costs
// nothing and changes no output.

const EMPTY_REPORT = Object.freeze({ seen: 0, last: null });

export function createObserverOn() {
	const seen = [];
	return {
		name: "on",
		observe(frame) {
			seen.push({ revision: frame?.revision ?? null, count: frame?.count ?? 0 });
			return { ok: true };
		},
		report() {
			return { seen: seen.length, last: seen.at(-1) ?? null };
		},
	};
}

export function createObserverOff() {
	return {
		name: "off",
		observe() {
			return { ok: true };
		},
		report() {
			return EMPTY_REPORT;
		},
	};
}
