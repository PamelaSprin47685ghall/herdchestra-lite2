// Host pi-tui singleton. Omp 19.2 rewrites this specifier onto the process copy,
// so reactive tracking and node identity match the terminal that paints us.
// A test runner without the package keeps the import optional.

let hostTui = null;
try {
	hostTui = await import("@oh-my-pi/pi-tui");
} catch {
	hostTui = null;
}

export function getHostTui() {
	return hostTui;
}

export function createReactiveSignal(tui, initialValue) {
	if (typeof tui?.signal === "function") return tui.signal(initialValue);
	let value = initialValue;
	const read = () => value;
	read.set = (next) => {
		value = next;
	};
	read.peek = () => value;
	return read;
}

export function batchUpdates(tui, fn) {
	if (typeof tui?.batch === "function") return tui.batch(fn);
	return fn();
}
