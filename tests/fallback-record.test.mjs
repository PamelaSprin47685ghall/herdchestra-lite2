import { describe, expect, test } from "bun:test";

import { createForkWiring } from "../src/scope/fork-wiring.mjs";
import { ledgerFor, outcomeOf } from "../src/scope/fork-registry.mjs";
import { spawnChildTicket } from "../src/tools/spawn-ticket.mjs";
import { markReady, registerFork } from "../src/scope/forkjoin.mjs";

// A child that stops without scope_return must still hand the parent a record
// in the digest format: the assistant's own words and the names of the tools
// it called. Thinking, tool results, tool arguments and user broadcasts are
// the child's working noise and must never reach the parent.

function specFor(forkId) {
	return {
		forkId,
		childDepth: 1,
		fsm: "probe",
		// A host can rewrite the receipt. Keep it non-matching so the
		// timestamp fallback is the only way to find the boundary.
		receipt: "host rewrote the receipt",
		parentOwnerId: "root",
	};
}

describe("the fallback record for a child that never returns", () => {
	test("renders only assistant text and bare tool names", async () => {
		const wiring = createForkWiring();
		const ledger = ledgerFor(wiring.registry, "fallback");
		registerFork(ledger, {
			forkId: "f1",
			ownerId: "root",
			levelKey: "L",
			fsm: "probe",
			depth: 0,
		});

		const messages = [];
		const session = {
			messages,
			prompt: async () => {
				messages.push({ role: "user", content: "a broadcast the parent does not need", timestamp: 1 });
				messages.push({
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private reasoning" },
						{ type: "text", text: "did the work" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/private/file" } },
					],
					timestamp: 2,
				});
				messages.push({
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: "a large tool result body",
					isError: false,
					timestamp: 3,
				});
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "finished" }],
					timestamp: 4,
				});
				// Close the bracket without freezing a record: this is the shape
				// a host-side stop leaves behind, where the spawner renders the
				// fallback record itself.
				markReady(ledger, "f1", { ok: true });
			},
			agent: { state: { messages, stopReason: "stop" } },
		};

		await spawnChildTicket(specFor("f1"), {
			registry: wiring.registry,
			ledger,
			createSession: async () => ({ ok: true, session }),
		});

		const record = outcomeOf(wiring.registry, "f1").record;
		expect(record).toBe("did the work\n[read]\nfinished");
		expect(record).not.toContain("private reasoning");
		expect(record).not.toContain("a large tool result body");
		expect(record).not.toContain("/private/file");
		expect(record).not.toContain("a broadcast the parent does not need");
		expect(record).not.toContain("[call ");
		expect(record).not.toContain("[result ");
		expect(record).not.toContain("[thinking]");
		expect(record).not.toContain("[user]");
	});
});
