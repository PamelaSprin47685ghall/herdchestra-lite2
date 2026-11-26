let hostTui = null;
try {
	hostTui = await import("@oh-my-pi/pi-tui");
} catch {
	hostTui = null;
}

export function getHostTui() {
	return hostTui;
}
