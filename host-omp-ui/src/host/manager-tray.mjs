// Manager-owned system tray: one icon while this process leads the Web manager.
// The desktop adapter is injected so tests never touch a real desktop session.
import { spawn } from "node:child_process";

function defaultOpenUrl(url) {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
				: ["xdg-open", [url]];
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}

function scrubToken(text, token) {
	return token ? String(text).split(token).join("[redacted]") : String(text);
}

export function createManagerTray({ url, token, adapter, openUrl = defaultOpenUrl, diagnostics } = {}) {
	const base = String(url ?? "").replace(/\/+$/, "");
	const target = `${base}/?token=${encodeURIComponent(token ?? "")}`;
	let handle = null;
	let starting = null;
	let generation = 0;

	function record(label, error) {
		const safe = new Error(scrubToken(error?.message ?? error, token));
		try {
			diagnostics?.record?.(label, safe);
		} catch {
			// Diagnostics must never take the host down.
		}
	}

	function open() {
		if (!handle) return;
		try {
			Promise.resolve(openUrl(target)).catch((error) => record("tray-open", error));
		} catch (error) {
			record("tray-open", error);
		}
	}

	async function start() {
		if (handle) return;
		if (starting) return starting;
		const currentGeneration = generation;
		starting = (async () => {
			try {
				const created = await adapter.create({ tooltip: "DeerFlow Web", onClick: open });
				if (generation !== currentGeneration) {
					await adapter.destroy(created);
				} else {
					handle = created;
				}
			} catch (error) {
				record("tray-start", error);
			} finally {
				starting = null;
			}
		})();
		return starting;
	}

	async function stop() {
		generation++;
		// Do not wait for an in-flight create: the generation check in start()
		// destroys the late handle as soon as create settles, and a leader that
		// is shutting down must not hang on a stuck desktop adapter.
		const current = handle;
		handle = null;
		if (!current) return;
		try {
			await adapter.destroy(current);
		} catch (error) {
			record("tray-stop", error);
		}
	}

	return {
		start,
		stop,
		click: open,
		get visible() {
			return handle !== null;
		},
	};
}
