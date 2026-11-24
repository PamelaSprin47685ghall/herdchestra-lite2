// The catalog is the one place the host's five arguments meet a ticket's
// declared parameters. `forkTicket` takes four arguments and a host bag, so
// that is exactly what it must be called with: an extra argument in the host
// position loses the bag, and the loss is silent because a dropped argument
// raises nothing.

import { expect, test } from "bun:test";
import { createTools } from "../src/tools/catalog.mjs";

function toolNamed(name, { station, tickets }) {
	const tools = createTools({ stationFor: () => station, tickets });
	return tools.find((tool) => tool.name === name);
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
	const fork = toolNamed("scope_fork", {
		station: brokenStation("station refused the fork"),
		tickets,
	});

	const result = await fork.execute("call-fork-1", {}, null, () => {}, {});

	expect(result.details.code).toBe("FORK_INTERNAL_ERROR");
	expect(recorded).toHaveLength(1);
	expect(recorded[0].kind).toBe("fork");
	expect(recorded[0].meta.phase).toBe("fork");
	expect(recorded[0].meta.toolCallId).toBe("call-fork-1");
	expect(recorded[0].error.message).toBe("station refused the fork");
});

test("scope_fork answers even when the host bag carries no report port", async () => {
	const fork = toolNamed("scope_fork", {
		station: brokenStation("boot"),
		tickets: {},
	});

	const result = await fork.execute("call-fork-2", {}, null, () => {}, {});

	expect(result.isError).toBe(true);
	expect(result.details.code).toBe("FORK_INTERNAL_ERROR");
	expect(result.content[0].text).toContain("boot");
});
