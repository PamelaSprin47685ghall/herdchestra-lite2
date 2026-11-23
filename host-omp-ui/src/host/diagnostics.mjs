// Bounded in-process diagnostics ring. This runs inside omp's extension host,
// where one uncaught throw tears down the whole session; every caller records
// and degrades instead of rethrowing.
const MAX_ENTRIES = 100;
const entries = [];
let sequence = 0;

export function record(domain, error, context) {
	const entry = {
		seq: ++sequence,
		ts: Date.now(),
		domain,
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
		context,
	};
	entries.push(entry);
	if (entries.length > MAX_ENTRIES) entries.shift();
	return entry;
}

export function listDiagnostics(limit = MAX_ENTRIES) {
	return entries.slice(-limit);
}

export function clearDiagnostics() {
	entries.length = 0;
}

export function guard(domain, fn) {
	try {
		return fn();
	} catch (error) {
		record(domain, error);
		return undefined;
	}
}
