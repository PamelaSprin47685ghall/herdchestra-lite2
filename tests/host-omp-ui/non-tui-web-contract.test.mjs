import { describe, test, expect } from "bun:test";

/**
 * Red contract for instance capabilities in the Web client.
 *
 * The manager exposes every live instance with its mode and the capabilities
 * the instance actually has:
 *
 *   { instanceId, mode: "tui" | "rpc" | "print" | ..., 
 *     capabilities: { canCompose, canUseTuiSurface, canAttachments, canSlashCommands },
 *     session: { id, ... } }
 *
 * The Web client must resolve those capabilities once, in a pure domain
 * function, and let the composer/surface follow the selected instance:
 *
 * - A TUI instance still composes, attaches files, uses slash commands and
 *   shows the TUI surface.
 * - An RPC/print instance keeps plain-text composition (the host accepts
 *   `sendUserMessage` without an editor) but must not pretend that missing
 *   attachments, slash commands or a TUI surface work.
 * - Explicit `false` from the instance always wins, even on a TUI.
 * - Missing fields fall back conservatively by mode; a missing capability
 *   must never make the whole non-TUI instance read-only.
 * - Switching RPC -> TUI -> RPC must re-resolve from the selected instance;
 *   capability objects must not leak between instances.
 *
 * Minimal production API (new module):
 *
 *   host-omp-ui/web/src/lib/instance-capabilities.ts
 *
 *   export type InstanceCapabilities = {
 *     canCompose: boolean;
 *     canUseTuiSurface: boolean;
 *     canAttachments: boolean;
 *     canSlashCommands: boolean;
 *   };
 *
 *   export function resolveInstanceCapabilities(instance): InstanceCapabilities
 *   export function capabilitiesForSession(instances, sessionId): InstanceCapabilities | null
 *
 * `resolveInstanceCapabilities` accepts a descriptor with optional `mode`
 * and optional `capabilities` (unknown/malformed values are ignored, not
 * coerced). `capabilitiesForSession` finds the live instance whose
 * `session.id` matches and resolves it; an absent session returns null.
 *
 * ComposerDock must consume the resolved object instead of consulting only
 * `disabled`: `canCompose` gates the textarea, `canAttachments` gates the
 * file picker, `canSlashCommands` gates slash submissions, and
 * `canUseTuiSurface` gates the surface entry. Unavailable controls need a
 * visible reason; they must not submit and fail silently.
 */

const MODULE = "../../host-omp-ui/web/src/lib/instance-capabilities.ts";

async function loadCapabilities() {
	try {
		return await import(MODULE);
	} catch (error) {
		throw new Error(`Red contract: cannot load ${MODULE}: ${error.message}`);
	}
}

const ALL_ON = {
	canCompose: true,
	canUseTuiSurface: true,
	canAttachments: true,
	canSlashCommands: true,
};

const TEXT_ONLY = {
	canCompose: true,
	canUseTuiSurface: false,
	canAttachments: false,
	canSlashCommands: false,
};

function instance(id, mode, capabilities) {
	return {
		instanceId: `host-${id}`,
		mode,
		...(capabilities === undefined ? {} : { capabilities }),
		session: { id, title: `Session ${id}`, cwd: `/work/${id}` },
	};
}

describe("explicit instance capabilities", () => {
	test("explicit false wins over the TUI defaults", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(
			resolveInstanceCapabilities({
				mode: "tui",
				capabilities: {
					canCompose: false,
					canAttachments: false,
					canSlashCommands: false,
					canUseTuiSurface: false,
				},
			}),
		).toEqual({
			canCompose: false,
			canUseTuiSurface: false,
			canAttachments: false,
			canSlashCommands: false,
		});
	});

	test("the advertised RPC capabilities are honored, including partial grants", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(
			resolveInstanceCapabilities({
				mode: "rpc",
				capabilities: {
					canCompose: true,
					canSlashCommands: true,
					canAttachments: false,
				},
			}),
		).toEqual({
			canCompose: true,
			canUseTuiSurface: false,
			canAttachments: false,
			canSlashCommands: true,
		});
	});

	test("a TUI can explicitly advertise only the safe subset", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(
			resolveInstanceCapabilities({
				mode: "tui",
				capabilities: { canUseTuiSurface: false, canAttachments: false },
			}),
		).toEqual({
			canCompose: true,
			canUseTuiSurface: false,
			canAttachments: false,
			canSlashCommands: true,
		});
	});
});

describe("conservative fallback by mode", () => {
	test("a TUI with no capability fields keeps all capabilities", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(resolveInstanceCapabilities({ mode: "tui" })).toEqual(ALL_ON);
	});

	test("RPC with no capability fields keeps text composition only", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(resolveInstanceCapabilities({ mode: "rpc" })).toEqual(TEXT_ONLY);
	});

	test("print mode with no capability fields keeps text composition only", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(resolveInstanceCapabilities({ mode: "print" })).toEqual(TEXT_ONLY);
	});

	test("a missing or unknown mode falls back to text composition, not read-only", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(resolveInstanceCapabilities({})).toEqual(TEXT_ONLY);
		expect(resolveInstanceCapabilities({ mode: "unknown-mode" })).toEqual(TEXT_ONLY);
		expect(resolveInstanceCapabilities(null)).toEqual(TEXT_ONLY);
		expect(resolveInstanceCapabilities(undefined)).toEqual(TEXT_ONLY);
	});

	test("malformed capability values are ignored instead of coerced", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(
			resolveInstanceCapabilities({
				mode: "rpc",
				capabilities: {
					canCompose: "true",
					canAttachments: 1,
					canSlashCommands: null,
					canUseTuiSurface: {},
				},
			}),
		).toEqual(TEXT_ONLY);
	});

	test("partial capability objects still use the mode fallback for missing keys", async () => {
		const { resolveInstanceCapabilities } = await loadCapabilities();

		expect(
			resolveInstanceCapabilities({
				mode: "rpc",
				capabilities: { canSlashCommands: true },
			}),
		).toEqual({
			canCompose: true,
			canUseTuiSurface: false,
			canAttachments: false,
			canSlashCommands: true,
		});

		expect(
			resolveInstanceCapabilities({
				mode: "tui",
				capabilities: { canUseTuiSurface: false },
			}),
		).toEqual({
			canCompose: true,
			canUseTuiSurface: false,
			canAttachments: true,
			canSlashCommands: true,
		});
	});
});

describe("selection follows the instance, not the previous one", () => {
	test("RPC -> TUI -> RPC re-resolves each selected session", async () => {
		const { capabilitiesForSession } = await loadCapabilities();
		const instances = [
			instance("rpc-live", "rpc"),
			instance("tui-live", "tui"),
			instance("rpc-granted", "rpc", {
				canCompose: true,
				canSlashCommands: true,
			}),
		];

		expect(capabilitiesForSession(instances, "rpc-live")).toEqual(TEXT_ONLY);
		expect(capabilitiesForSession(instances, "tui-live")).toEqual(ALL_ON);
		expect(capabilitiesForSession(instances, "rpc-granted")).toEqual({
			canCompose: true,
			canUseTuiSurface: false,
			canAttachments: false,
			canSlashCommands: true,
		});
		// Going back must not reuse the TUI result.
		expect(capabilitiesForSession(instances, "rpc-live")).toEqual(TEXT_ONLY);
	});

	test("an absent, historical, or unknown session has no live capabilities", async () => {
		const { capabilitiesForSession } = await loadCapabilities();
		const instances = [instance("live", "rpc")];

		expect(capabilitiesForSession(instances, null)).toBeNull();
		expect(capabilitiesForSession(instances, undefined)).toBeNull();
		expect(capabilitiesForSession(instances, "")).toBeNull();
		expect(capabilitiesForSession(instances, "history-only")).toBeNull();
		expect(capabilitiesForSession([], "live")).toBeNull();
	});

	test("resolving one instance never mutates the source descriptor or another result", async () => {
		const { resolveInstanceCapabilities, capabilitiesForSession } = await loadCapabilities();
		const rpc = instance("rpc-live", "rpc");
		const tui = instance("tui-live", "tui");

		const rpcCapabilities = capabilitiesForSession([rpc, tui], "rpc-live");
		rpcCapabilities.canAttachments = true;
		rpcCapabilities.canUseTuiSurface = true;

		expect(capabilitiesForSession([rpc, tui], "rpc-live")).toEqual(TEXT_ONLY);
		expect(capabilitiesForSession([rpc, tui], "tui-live")).toEqual(ALL_ON);
		expect(rpc.capabilities).toBeUndefined();
		expect(tui.capabilities).toBeUndefined();

		const first = resolveInstanceCapabilities({ mode: "rpc" });
		first.canSlashCommands = true;
		expect(resolveInstanceCapabilities({ mode: "rpc" })).toEqual(TEXT_ONLY);
	});
});

/**
 * The manager can register an instance before its session id exists
 * (`select` explicitly waits for `agent.update` to supply it), and transport
 * metadata can be malformed one field at a time. Validation must keep the
 * instance visible and degrade only the bad metadata:
 *
 *   isManagerInstance(value)
 *     - only `instanceId: string` is required;
 *     - `mode: null`, a missing `session.id`, and malformed capability fields
 *       do not invalidate the instance.
 *
 *   instanceSessionState(instance): "live" | "starting"
 *     - "starting" when the instance exists but has no string `session.id`,
 *       so the UI shows a starting state instead of a fake interactive view;
 *     - "live" when `session.id` is a string.
 *
 * `capabilitiesForSession` never matches an instance without a real id.
 */
describe("metadata faults never erase a live instance", () => {
	test("a starting instance without a session id stays visible and is marked starting", async () => {
		const { isManagerInstance, instanceSessionState } = await loadCapabilities();
		const starting = {
			instanceId: "host-starting",
			mode: "tui",
			session: { title: "New session", cwd: "/work/new" },
		};

		expect(isManagerInstance(starting)).toBe(true);
		expect(instanceSessionState(starting)).toBe("starting");
		expect(instanceSessionState(instance("live", "tui"))).toBe("live");
	});

	test("a single malformed capability degrades that field only", async () => {
		const { isManagerInstance, resolveInstanceCapabilities } = await loadCapabilities();
		const value = {
			instanceId: "host-partial-caps",
			mode: "tui",
			capabilities: { canAttachments: "yes", canSlashCommands: false },
			session: { id: "partial-caps" },
		};

		expect(isManagerInstance(value)).toBe(true);
		expect(resolveInstanceCapabilities(value)).toEqual({
			canCompose: true,
			canUseTuiSurface: true,
			canAttachments: true,
			canSlashCommands: false,
		});
	});

	test("mode null is unknown metadata, not an invalid instance", async () => {
		const { isManagerInstance, resolveInstanceCapabilities } = await loadCapabilities();
		const value = { instanceId: "host-null-mode", mode: null, session: { id: "null-mode" } };

		expect(isManagerInstance(value)).toBe(true);
		expect(resolveInstanceCapabilities(value)).toEqual(TEXT_ONLY);
	});

	test("a malformed session object does not hide the instance or invent a session", async () => {
		const { isManagerInstance, instanceSessionState, capabilitiesForSession } = await loadCapabilities();
		const starting = { instanceId: "host-bad-session", mode: "rpc", session: "not-a-session" };

		expect(isManagerInstance(starting)).toBe(true);
		expect(instanceSessionState(starting)).toBe("starting");
		expect(capabilitiesForSession([starting], "not-a-session")).toBeNull();
		expect(capabilitiesForSession([starting], undefined)).toBeNull();
	});

	test("a session-less instance is never matched under the string 'undefined'", async () => {
		const { capabilitiesForSession } = await loadCapabilities();
		const instances = [
			{ instanceId: "host-waiting", mode: "rpc", session: { title: "Starting" } },
			instance("live", "tui"),
		];

		expect(capabilitiesForSession(instances, "undefined")).toBeNull();
		expect(capabilitiesForSession(instances, "live")).toEqual(ALL_ON);
	});
});
