// Diagnostics sink. This runs inside omp's extension host, where one uncaught
// throw tears down the whole session; every caller records and degrades instead
// of rethrowing.
let sequence = 0;

export function record(domain, error, context) {
	return {
		seq: ++sequence,
		ts: Date.now(),
		domain,
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
		context,
	};
}


