// The display holder is a live slot shared by a root station and its nested
// stations. The interactive UI may arrive after a child session is created, so
// the holder queues the attach and wakes every waiting station when a port
// appears. The holder owns that lifecycle; the fork wiring only binds station
// fields to it.

// The holder reports failures through an injected sink, so the core module
// carries no host diagnostics dependency.
function noReport() {}

function isDisplayHolder(value) {
	return value !== null && typeof value === "object" && "current" in value;
}

function resolveDisplay(value) {
	if (typeof value === "function") return value();
	if (isDisplayHolder(value)) return value.current;
	return value;
}

function createDisplayHolder(initial = null, report = noReport) {
	const listeners = new Set();
	return {
		current: initial ?? null,
		subscribe(listener) {
			if (typeof listener !== "function") return () => {};
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		notify() {
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch (error) {
					report("fork", error, { phase: "display" });
				}
			}
		},
	};
}

/**
 * Bind one station to the display holder. A holder passed in is shared with
 * the caller; otherwise this binder owns a fresh holder. Pending child
 * sessions live here, not in the wiring.
 */
export function createDisplayBinder({ display = null, report = noReport } = {}) {
	let sharedHolder = isDisplayHolder(display) ? display : null;
	let holder = sharedHolder ?? createDisplayHolder(resolveDisplay(display), report);
	const pendingDisplay = new Map();
	const waitingDisplay = new Set();
	let unsubscribeDisplay = null;

	const currentDisplay = () => resolveDisplay(holder);

	function subscribeDisplay() {
		if (unsubscribeDisplay || typeof holder.subscribe !== "function") return;
		unsubscribeDisplay = holder.subscribe(() => flushPendingDisplay());
	}

	function releaseDisplaySubscriptionIfIdle() {
		if (waitingDisplay.size > 0) return;
		unsubscribeDisplay?.();
		unsubscribeDisplay = null;
	}

	function attachPendingDisplay(entry, port) {
		if (!entry.active || entry.attached) return;
		try {
			entry.detach = port.attach?.(entry.label, entry.session) ?? null;
			entry.attached = true;
		} catch (error) {
			report("fork", error, { phase: "display" });
		}
	}

	function flushPendingDisplay() {
		const port = currentDisplay();
		if (!port) return;
		for (const [session, entry] of pendingDisplay) {
			if (!entry.active) {
				pendingDisplay.delete(session);
				waitingDisplay.delete(session);
				continue;
			}
			if (entry.attached) {
				waitingDisplay.delete(session);
				continue;
			}
			attachPendingDisplay(entry, port);
			if (entry.attached) waitingDisplay.delete(session);
		}
		releaseDisplaySubscriptionIfIdle();
	}

	function attachDisplay(label, session) {
		const entry = { label, session, detach: null, attached: false, active: true };
		pendingDisplay.set(session, entry);
		const port = currentDisplay();
		if (port) attachPendingDisplay(entry, port);
		if (!entry.attached) {
			waitingDisplay.add(session);
			subscribeDisplay();
		}
		return () => {
			entry.active = false;
			entry.detach?.();
			entry.detach = null;
			entry.attached = false;
			pendingDisplay.delete(session);
			waitingDisplay.delete(session);
			releaseDisplaySubscriptionIfIdle();
		};
	}

	function setDisplayPort(port) {
		if (sharedHolder) {
			flushPendingDisplay();
			return;
		}
		holder.current = port ?? null;
		flushPendingDisplay();
		holder.notify?.();
	}

	function updateDisplay(next) {
		if (isDisplayHolder(next) && next !== holder) {
			unsubscribeDisplay?.();
			unsubscribeDisplay = null;
			sharedHolder = next;
			holder = next;
			if (waitingDisplay.size > 0) subscribeDisplay();
			flushPendingDisplay();
			return;
		}
		if (sharedHolder) {
			flushPendingDisplay();
			return;
		}
		holder.current = resolveDisplay(next);
		flushPendingDisplay();
		holder.notify?.();
	}

	return {
		currentDisplay,
		attachDisplay,
		setDisplayPort,
		updateDisplay,
		get holder() {
			return holder;
		},
	};
}
