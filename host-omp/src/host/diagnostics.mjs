// Diagnostics: a bounded ring of the last failures.
//
// The station records a failure in `lastError`, and the next failure
// overwrites it. One string is not a history. This ring keeps the last 64
// records, oldest first, so a user can see what broke and in which order.
//
// The buffer is synchronous and allocation-light. A record costs one object.
//
// A status line can fail on every render. An immediately repeated
// (domain, message) pair therefore counts as one record with a repeat count,
// so a flood of the same failure cannot push the earlier, rarer failures out
// of the ring.

const DEFAULT_LIMIT = 64;

/**
 * Build one isolated ring.
 *
 * @param {number} limit Number of records to keep.
 */
export function createDiagnostics(limit = DEFAULT_LIMIT) {
	const size = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
	const slots = new Array(size);
	let cursor = 0;
	let total = 0;

	/**
	 * Append one record. The oldest record is overwritten when the ring is
	 * full. A repeat of the newest (domain, message) adds to that record's
	 * `count` instead of taking a new slot.
	 *
	 * @param {string} domain Short source name, such as "usage" or "persist".
	 * @param {unknown} error Error or value that describes the failure.
	 * @param {unknown} [detail] Optional extra evidence.
	 */
	function record(domain, error, detail) {
		const message =
			error instanceof Error ? error.message : String(error ?? "");
		const newest = total > 0 ? slots[(cursor - 1 + size) % size] : undefined;
		if (newest && newest.domain === domain && newest.message === message) {
			newest.count += 1;
			newest.t = Date.now();
			if (detail !== undefined) newest.detail = detail;
			return newest;
		}
		const entry = { t: Date.now(), domain, message, count: 1 };
		if (detail !== undefined) entry.detail = detail;
		slots[cursor] = entry;
		cursor = (cursor + 1) % size;
		total += 1;
		return entry;
	}

	/** Return the retained records, oldest first. */
	function snapshot() {
		const count = Math.min(total, size);
		const out = new Array(count);
		for (let step = count; step > 0; step -= 1) {
			out[count - step] = slots[(cursor - step + size) % size];
		}
		return out;
	}

	/** Drop every record and reset the running count. */
	function reset() {
		slots.fill(undefined);
		cursor = 0;
		total = 0;
	}

	return {
		limit: size,
		record,
		snapshot,
		reset,
		total: () => total,
	};
}

const shared = createDiagnostics();

export const record = shared.record;
export const snapshot = shared.snapshot;
export const reset = shared.reset;
export const total = shared.total;

/**
 * Render the retained records as one report, oldest first.
 *
 * The ring owns the records, so it also owns their shape on screen: a caller that
 * only wants to show them must not re-derive the fields, the repeat count, or the
 * timestamp format. `reports` is the provider observer's latest snapshot, shown
 * under its own marker so the two sources stay distinguishable.
 */
export function formatDiagnostics(entries, reports = []) {
	const detail = (value) => {
		if (value === undefined) return "";
		try {
			return ` ${JSON.stringify(value)}`;
		} catch {
			return ` ${String(value)}`;
		}
	};
	const lines = (Array.isArray(entries) ? entries : []).map((entry) => {
		const repeat = entry.count > 1 ? ` ×${entry.count}` : "";
		return `${new Date(entry.t).toISOString()} [${entry.domain}] ${entry.message}${repeat}${detail(entry.detail)}`;
	});
	for (const report of Array.isArray(reports) ? reports : []) {
		lines.push(`[provider latest]${detail(report)}`);
	}
	return lines.join("\n");
}
