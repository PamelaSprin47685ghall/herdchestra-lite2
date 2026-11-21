// Contract harness: one suite, every implementation of a port.
//
// A port promises the same behaviour to every caller no matter which
// implementation is wired. The only thing that keeps that promise honest is
// running the same assertions against each implementation, so this module
// turns a list of implementations into one `test` per implementation, with the
// implementation name in the test title and in every failure message.

import { describe, test } from "bun:test";

/** A refusal shape every port shares. */
export function refusal(port, code, detail) {
	return { ok: false, code, port, detail };
}

/**
 * Assert a result is the shared refusal shape with the given code.
 *
 * Ports answer with a discriminated union, not by throwing, so a refused call
 * is data the caller must handle. `expectRefusal` pins both halves: the code
 * and the shape.
 */
export function expectRefusal(result, code) {
	if (result?.ok !== false) {
		throw new Error(`expected a refusal with code ${code}, received ${JSON.stringify(result)}`);
	}
	if (result.code !== code) {
		throw new Error(`expected refusal code ${code}, received ${result.code}`);
	}
	if (typeof result.port !== "string" || result.port === "") {
		throw new Error("a refusal must name its port");
	}
	return result;
}

/** The smallest context a port may be handed in tests. */
export function fakeCtx(overrides = {}) {
	return {
		agent: { id: "test-agent" },
		sessionManager: null,
		now: () => 1_000,
		...overrides,
	};
}

/**
 * Run one case against one implementation, prefixing any failure with the
 * port, the implementation and the case. Exported so the harness can be tested
 * directly instead of through a registered bun test.
 */
export async function runCase(portName, implName, caseName, fn, ctx = fakeCtx()) {
	try {
		await fn(ctx);
	} catch (error) {
		error.message = `[${portName}/${implName}] ${caseName}: ${error.message}`;
		throw error;
	}
}

/**
 * Run one contract suite against every implementation.
 *
 * One implementation instance is shared by every case of that implementation.
 * A case must therefore assert the direction of the behaviour, not a count
 * that depends on how many cases ran before it.
 *
 * `cases` are named functions `(impl, ctx) => void | Promise<void>`; each runs
 * once per implementation. A failure is re-thrown with the implementation name
 * prefixed, because "the scope contract failed" without saying which
 * implementation is a bug report nobody can act on.
 */
export function defineContract(portName, { implementations = {}, cases = {} } = {}) {
	const names = Object.keys(implementations);
	if (names.length === 0) throw new Error(`port ${portName} has no implementations`);
	const caseNames = Object.keys(cases);
	if (caseNames.length === 0) throw new Error(`port ${portName} has no contract cases`);

	describe(`contract: ${portName}`, () => {
		for (const implName of names) {
			describe(`implementation: ${implName}`, () => {
				for (const caseName of caseNames) {
					test(caseName, () =>
						runCase(portName, implName, caseName, (ctx) =>
							cases[caseName](implementations[implName], ctx),
						),
					);
				}
			});
		}
	});
}
