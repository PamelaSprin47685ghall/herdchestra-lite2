// The scope port: three container shapes behind one set of methods.
//
// `bare` is not an absence. It is the implementation you get when the session
// carries no scope machinery at all, so every method answers with the same
// refusal instead of pretending to work. `single` and `batch` are the real
// containers and arrive in their own slices; until then they are declared here
// so the table matches the port registry and a missing slice is visible rather
// than silently absent.

export const SCOPE_PORT = "scope";

/** The one refusal shape every scope implementation shares. */
export function scopeRefusal(detail = "the scope workbench is not installed") {
	return { ok: false, code: "SCOPE_UNAVAILABLE", port: SCOPE_PORT, detail };
}

/**
 * `bare`: no container exists.
 *
 * Every method refuses, and refusing changes nothing: no state is created, no
 * counter moves, and a second call answers exactly like the first.
 */
export function createBareScope() {
	return {
		name: "bare",
		begin() {
			return scopeRefusal("no scope can open in this shape");
		},
		end() {
			return scopeRefusal("no scope is open in this shape");
		},
		charge() {
			return scopeRefusal("nothing can be charged without a scope");
		},
		snapshot() {
			return scopeRefusal("there is no scope to describe");
		},
	};
}

/**
 * The implementation table, keyed the way the port registry names them.
 *
 * A `null` entry means "this slice has not landed yet". The contract test
 * skips nulls, so an unfinished implementation fails loudly at the table
 * rather than quietly at call time.
 */
export function createScopeImplementations(extras = {}) {
	return {
		bare: createBareScope(),
		single: extras.single ?? null,
		batch: extras.batch ?? null,
	};
}
