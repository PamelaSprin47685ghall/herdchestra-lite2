import { isRecord } from "../protocol/guards";

export type InstanceCapabilities = {
  canCompose: boolean;
  canUseTuiSurface: boolean;
  canAttachments: boolean;
  canSlashCommands: boolean;
};

export type ManagerSession = {
  id?: string;
  title?: string | null;
  cwd?: string | null;
};

/** One manager-owned OMP instance as carried by `manager.instances`. */
export type ManagerInstance = {
  instanceId: string;
  mode?: string;
  capabilities?: Partial<InstanceCapabilities> | null;
  session?: ManagerSession | null;
};

const CAPABILITY_KEYS = [
  "canCompose",
  "canUseTuiSurface",
  "canAttachments",
  "canSlashCommands",
] as const satisfies readonly (keyof InstanceCapabilities)[];

/**
 * Runtime gate for transport data. Keep this in sync with ManagerInstance:
 * the type is only as trustworthy as this check.
 */
export function isManagerInstance(value: unknown): value is { instanceId: string } {
  return isRecord(value) && typeof value.instanceId === "string" && value.instanceId.length > 0;
}

/** Normalize optional transport metadata without hiding an active instance. */
export function normalizeManagerInstance(value: unknown): ManagerInstance | null {
  if (!isManagerInstance(value) || !isRecord(value)) return null;
  const session = isRecord(value.session) ? value.session : null;
  const source = isRecord(value.capabilities) ? value.capabilities : {};
  const capabilities: Partial<InstanceCapabilities> = {};
  for (const key of CAPABILITY_KEYS) {
    const entry = source[key];
    if (typeof entry === "boolean") capabilities[key] = entry;
  }
  return {
    instanceId: value.instanceId,
    mode: typeof value.mode === "string" ? value.mode : undefined,
    capabilities,
    session: session ? {
      id: typeof session.id === "string" && session.id ? session.id : undefined,
      title: typeof session.title === "string" ? session.title : undefined,
      cwd: typeof session.cwd === "string" ? session.cwd : undefined,
    } : null,
  };
}

export function instanceSessionState(instance: unknown): "live" | "starting" {
  if (!isRecord(instance) || !isRecord(instance.session)) return "starting";
  return typeof instance.session.id === "string" && instance.session.id.length > 0 ? "live" : "starting";
}

export function resolveInstanceCapabilities(instance: ManagerInstance | null | undefined): InstanceCapabilities {
  const tui = instance?.mode === "tui";
  const caps = instance?.capabilities;
  const value = (key: keyof InstanceCapabilities, fallback: boolean) => {
    const entry = caps?.[key];
    return typeof entry === "boolean" ? entry : fallback;
  };
  return {
    canCompose: value("canCompose", true),
    canUseTuiSurface: value("canUseTuiSurface", tui),
    canAttachments: value("canAttachments", tui),
    canSlashCommands: value("canSlashCommands", tui),
  };
}

export function capabilitiesForSession(
  instances: readonly ManagerInstance[],
  sessionId: string | null | undefined,
): InstanceCapabilities | null {
  if (!sessionId) return null;
  const instance = instances.find((item) => item.session?.id === sessionId);
  return instance ? resolveInstanceCapabilities(instance) : null;
}
