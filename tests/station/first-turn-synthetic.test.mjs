import { describe, expect, test } from "bun:test";
import { firstTurnMessage } from "../../src/station/domain/context.mjs";

describe("firstTurnMessage synthetic marking", () => {
	test("a shared-opening user turn is synthetic but still attributed to the user", () => {
		const message = firstTurnMessage({ role: "user", content: "shared opening" });
		expect(message.role).toBe("user");
		expect(message.synthetic).toBe(true);
		expect(message.attribution).toBe("user");
	});

	test("an assistant turn keeps assistant attribution and carries no synthetic flag", () => {
		const message = firstTurnMessage({ role: "assistant", content: "done" });
		expect(message.role).toBe("assistant");
		expect(message.attribution).toBe("assistant");
		expect(message.synthetic).toBeUndefined();
	});
});
