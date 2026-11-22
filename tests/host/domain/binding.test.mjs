import { describe, expect, test } from "bun:test";

import { planStationBinding } from "../../../host-omp/src/host/domain/binding.mjs";

describe("planStationBinding", () => {
	test("a headless root registers no UI and shows nothing", () => {
		expect(
			planStationBinding({ owner: {}, hasUI: false, ui: {} }),
		).toEqual({ registerOwnerUI: false, displayKind: "none" });
	});

	test("a root with UI registers the owner surface and uses it", () => {
		expect(planStationBinding({ owner: {}, ui: { id: "ui" } })).toEqual({
			registerOwnerUI: true,
			displayKind: "owner",
		});
	});

	test("a child prefers its holder, then its own display", () => {
		expect(
			planStationBinding({
				owner: {},
				childIdentity: { displayHolder: { currentDisplay: () => null }, display: {} },
				ui: {},
			}),
		).toEqual({ registerOwnerUI: false, displayKind: "holder" });
		expect(
			planStationBinding({
				owner: {},
				childIdentity: { displayHolder: null, display: {} },
				ui: {},
			}),
		).toEqual({ registerOwnerUI: false, displayKind: "child" });
	});

	test("a headless child registers nothing", () => {
		expect(
			planStationBinding({
				childIdentity: { displayHolder: null, display: null },
				hasUI: false,
			}),
		).toEqual({ registerOwnerUI: false, displayKind: "none" });
	});
});
