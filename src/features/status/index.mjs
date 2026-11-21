// Status port: one line of usage on screen, or nothing at all.
//
// `on` renders a string from a snapshot the caller owns. `off` answers with an
// empty string and keeps no state, so the host footer stays native. Both are
// total: no method throws, and a caller never has to ask which implementation
// it got.

const EMPTY = "";

export function createStatusOn() {
	let last = EMPTY;
	return {
		name: "on",
		render(snapshot) {
			if (!snapshot || typeof snapshot !== "object") return last;
			const parts = [];
			if (typeof snapshot.cost === "string" && snapshot.cost !== "") parts.push(snapshot.cost);
			if (typeof snapshot.tokens === "string" && snapshot.tokens !== "") parts.push(snapshot.tokens);
			if (typeof snapshot.model === "string" && snapshot.model !== "") parts.push(snapshot.model);
			last = parts.join(" · ");
			return last;
		},
	};
}

export function createStatusOff() {
	return {
		name: "off",
		render() {
			return EMPTY;
		},
	};
}
