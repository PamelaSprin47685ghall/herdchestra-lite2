// The core-tool table is the one place a ticket's four declared parameters and
// its host bag meet the caller. `forkTicket` takes (station, toolCallId, args,
// ctx, signal, host), so the table must bind the bag — an extra argument in the
// host position would lose it silently, because a dropped argument raises
// nothing. `scope_fork` is no longer a registered tool: the model reaches it
// through `js`, so this table is the only path.

import { expect, test } from "bun:test";
import { createCoreTools } from "../src/tools/catalog.mjs";

function coreTool(name, { tickets }) {
	return createCoreTools({ tickets })[name];
}

function brokenStation(message) {
	return {
		executeFork() {
			throw new Error(message);
		},
	};
}

test("scope_fork hands the ticket bundle to the ticket as its host bag", async () => {
	const recorded = [];
	const tickets = {
		report: {
			record: (kind, error, meta) => recorded.push({ kind, error, meta }),
		},
	};
	const station = brokenStation("station refused the fork");
	const fork = coreTool("scope_fork", { tickets });

	const result = await fork(station, "call-fork-1", {}, {}, null);

	expect(result.details.code).toBe("FORK_INTERNAL_ERROR");
	expect(recorded).toHaveLength(1);
	expect(recorded[0].kind).toBe("fork");
	expect(recorded[0].meta.phase).toBe("fork");
	expect(recorded[0].meta.toolCallId).toBe("call-fork-1");
	expect(recorded[0].error.message).toBe("station refused the fork");
});

test("scope_fork answers even when the host bag carries no report port", async () => {
	const station = brokenStation("boot");
	const fork = coreTool("scope_fork", { tickets: {} });

	const result = await fork(station, "call-fork-2", {}, {}, null);

	expect(result.isError).toBe(true);
	expect(result.details.code).toBe("FORK_INTERNAL_ERROR");
	expect(result.content[0].text).toContain("boot");
});
