/**
 * A tiny, dependency-free reducer for the TUI surface wire (`TspOp[]`).
 *
 * The real `@oh-my-pi/pi-tui` reconciler sends positional tuples:
 *   ["add", id, parent, before, { id, k, p, c }]
 *   ["set", id, props], ["text", id, "append"|"replace", text], ...
 * while the written contract and older tests use object ops. Both are
 * accepted here; the renderer only ever sees `SurfaceNode` trees.
 */
import type { OverlaySummary, SurfaceDocument, SurfaceNode, TspNode } from "./types";
import { isRecord } from "./guards";

export function createSurfaceDocument(): SurfaceDocument {
  return {
    root: { id: "root", kind: "col", props: {}, children: [] },
    focus: null,
    settled: [],
    sf: null,
    seq: 0,
  };
}

const record = (value: unknown) => (isRecord(value) ? value : undefined);

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const MAX_TEXT_CHARS = 1_000_000;
function capText(value: string): string {
  return value.length > MAX_TEXT_CHARS
    ? `${value.slice(0, MAX_TEXT_CHARS)}\n… [truncated]`
    : value;
}

export function normalizeSurfaceNode(raw: unknown, fallbackId = "node"): SurfaceNode {
  const value = record(raw) ?? {};
  const props = record(value.p) ?? record(value.props) ?? {};
  const id = textOf(value.id) ?? textOf(value.key) ?? fallbackId;
  const kind =
    textOf(value.k) ??
    textOf(value.kind) ??
    textOf(value.type) ??
    textOf(props.kind) ??
    "text";
  const rawChildren = Array.isArray(value.c)
    ? value.c
    : Array.isArray(value.children)
      ? value.children
      : [];
  const children = rawChildren.map((child, index) =>
    normalizeSurfaceNode(child, `${id}.${index}`),
  );
  const text =
    textOf(value.text) ??
    (typeof props.text === "string" ? props.text : undefined);
  return {
    id,
    kind,
    text,
    props,
    children,
  };
}

export function normalizeSurfaceDocument(raw: unknown): SurfaceDocument {
  const value = record(raw);
  if (!value) return createSurfaceDocument();
  const root = value.root ? normalizeSurfaceNode(value.root, "root") : undefined;
  if (!root) return createSurfaceDocument();
  const focus = typeof value.focus === "string" ? value.focus : null;
  const settled = Array.isArray(value.settled)
    ? value.settled.filter((item): item is string => typeof item === "string")
    : [];
  return {
    root,
    focus,
    settled,
    sf: textOf(value.sf) ?? null,
    seq: Number.isFinite(Number(value.s)) ? Number(value.s) : 0,
  };
}

function cloneNode(node: SurfaceNode): SurfaceNode {
  return {
    ...node,
    props: node.props ? { ...node.props } : {},
    children: node.children.map(cloneNode),
  };
}

export function cloneSurfaceDocument(document: SurfaceDocument): SurfaceDocument {
  return {
    ...document,
    root: cloneNode(document.root),
    settled: [...document.settled],
  };
}

export function findSurfaceNode(
  document: SurfaceDocument,
  id: string,
): SurfaceNode | undefined {
  if (id === document.root.id) return document.root;
  const stack = [...document.root.children];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    stack.push(...node.children);
  }
  return undefined;
}

function findParent(node: SurfaceNode, id: string): SurfaceNode | undefined {
  for (const child of node.children) {
    if (child.id === id) return node;
    const found = findParent(child, id);
    if (found) return found;
  }
  return undefined;
}

function removeNode(document: SurfaceDocument, id: string): void {
  const parent = findParent(document.root, id);
  if (!parent) return;
  parent.children = parent.children.filter((child) => child.id !== id);
}

function insertNode(
  parent: SurfaceNode,
  node: SurfaceNode,
  before: string | null | undefined,
  index?: number,
): void {
  const at = before
    ? parent.children.findIndex((child) => child.id === before)
    : typeof index === "number"
      ? index
      : -1;
  if (at >= 0 && at <= parent.children.length) {
    parent.children.splice(at, 0, node);
  } else {
    parent.children.push(node);
  }
}

function nodeFromObjectOp(op: Record<string, unknown>): SurfaceNode {
  const source = record(op.node) ?? op;
  return normalizeSurfaceNode(source, textOf(op.id) ?? "node");
}

function parentIdOf(op: Record<string, unknown>, node: SurfaceNode): string {
  return (
    textOf(op.parent) ??
    textOf(op.parentId) ??
    textOf(node.props?.parentId) ??
    "root"
  );
}

function applyObjectOp(document: SurfaceDocument, raw: unknown): void {
  const op = record(raw);
  if (!op) return;
  const name = textOf(op.op) ?? textOf(op.type);
  if (!name) return;
  const id = textOf(op.id);

  if (name === "add") {
    const node = nodeFromObjectOp(op);
    const parentId = parentIdOf(op, node);
    const parent = findSurfaceNode(document, parentId) ?? document.root;
    // Re-adding an existing node moves it, matching the wire contract.
    removeNode(document, node.id);
    insertNode(
      parent,
      node,
      textOf(op.before),
      Number.isFinite(Number(op.index)) ? Number(op.index) : undefined,
    );
    return;
  }

  if (!id) {
    if (name === "focus") document.focus = null;
    return;
  }

  if (name === "set") {
    const node = findSurfaceNode(document, id);
    const props = record(op.props);
    if (node && props) node.props = { ...(node.props ?? {}), ...props };
    return;
  }
  if (name === "text") {
    const node = findSurfaceNode(document, id);
    if (!node) return;
    const next = typeof op.text === "string" ? op.text : "";
    node.text = capText(op.mode === "append" ? `${node.text ?? ""}${next}` : next);
    return;
  }
  if (name === "splice") {
    const node = findSurfaceNode(document, id);
    if (!node) return;
    if (Array.isArray(op.items)) {
      const at = Math.max(0, Number(op.index ?? 0));
      const remove = Math.max(0, Number(op.remove ?? 0));
      node.children.splice(
        at,
        remove,
        ...op.items.map((item, index) =>
          normalizeSurfaceNode(item, `${id}.${at + index}`),
        ),
      );
      return;
    }
    const at = Math.max(0, Number(op.at ?? op.index ?? 0));
    const remove = Math.max(0, Number(op.del ?? op.remove ?? 0));
    const text = typeof op.text === "string" ? op.text : "";
    const current = node.text ?? "";
    node.text = capText(`${current.slice(0, at)}${text}${current.slice(at + remove)}`);
    return;
  }
  if (name === "move") {
    const node = findSurfaceNode(document, id);
    if (!node) return;
    const parent = findSurfaceNode(document, parentIdOf(op, node)) ?? document.root;
    removeNode(document, id);
    insertNode(
      parent,
      node,
      textOf(op.before),
      Number.isFinite(Number(op.index)) ? Number(op.index) : undefined,
    );
    return;
  }
  if (name === "del" || name === "settle") {
    removeNode(document, id);
    if (name === "settle" && !document.settled.includes(id)) {
      document.settled = [...document.settled, id];
    }
    return;
  }
  if (name === "focus") {
    document.focus = id;
  }
  // reveal / scroll / suspend / resume are terminal-only concerns.
}

function applyTupleOp(document: SurfaceDocument, raw: readonly unknown[]): void {
  const [name, id, a, b, c] = raw as [string, string, unknown, unknown, unknown];
  if (name === "add") {
    const node = normalizeSurfaceNode(c, id);
    const parent = findSurfaceNode(document, String(a ?? "root")) ?? document.root;
    removeNode(document, node.id);
    insertNode(parent, node, typeof b === "string" ? b : null);
    return;
  }
  if (name === "set") {
    const node = findSurfaceNode(document, id);
    const props = record(a);
    if (node && props) node.props = { ...(node.props ?? {}), ...props };
    return;
  }
  if (name === "text") {
    const node = findSurfaceNode(document, id);
    if (!node) return;
    const next = typeof b === "string" ? b : "";
    node.text = a === "append" ? `${node.text ?? ""}${next}` : next;
    return;
  }
  if (name === "splice") {
    const node = findSurfaceNode(document, id);
    if (!node) return;
    const at = Math.max(0, Number(a ?? 0));
    const remove = Math.max(0, Number(b ?? 0));
    const text = typeof c === "string" ? c : "";
    const current = node.text ?? "";
    node.text = capText(`${current.slice(0, at)}${text}${current.slice(at + remove)}`);
    return;
  }
  if (name === "move") {
    const node = findSurfaceNode(document, id);
    if (!node) return;
    const parent = findSurfaceNode(document, String(a ?? "root")) ?? document.root;
    removeNode(document, id);
    insertNode(parent, node, typeof b === "string" ? b : null);
    return;
  }
  if (name === "del" || name === "settle") {
    removeNode(document, id);
    if (name === "settle" && !document.settled.includes(id)) {
      document.settled = [...document.settled, id];
    }
    return;
  }
  if (name === "focus") {
    document.focus = typeof id === "string" ? id : null;
  }
}

export function applySurfaceOps(
  document: SurfaceDocument,
  ops: unknown,
): SurfaceDocument {
  const next = cloneSurfaceDocument(document);
  if (!Array.isArray(ops)) return next;
  for (const op of ops) {
    try {
      if (Array.isArray(op)) applyTupleOp(next, op);
      else applyObjectOp(next, op);
    } catch {
      // A malformed painter op must never take the transcript down.
    }
  }
  return next;
}

export function flattenSurface(document: SurfaceDocument): Record<string, TspNode> {
  const flat: Record<string, TspNode> = {};
  const walk = (node: SurfaceNode, parentId: string | null) => {
    if (node.id !== "root") {
      const props = { ...(node.props ?? {}) };
      if (node.text !== undefined) props.text = node.text;
      flat[node.id] = {
        id: node.id,
        kind: node.kind,
        text: node.text,
        props,
        parentId,
      };
    }
    for (const child of node.children) walk(child, node.id);
  };
  walk(document.root, null);
  return flat;
}

export function findRegion(
  document: SurfaceDocument,
  region: "main" | "dock" | "layer",
): SurfaceNode | undefined {
  const direct = document.root.children.find((child) => child.id === region);
  if (direct) return direct;
  return (
    findSurfaceNode(document, region) ??
    document.root.children.find((child) => child.kind === region)
  );
}

export function overlaysFromDocument(
  document: SurfaceDocument,
): OverlaySummary[] {
  const layer = findRegion(document, "layer");
  if (!layer) return [];
  return layer.children.map((node) => ({
    id: node.id,
    kind: node.kind,
    title:
      textOf(node.props?.title) ??
      textOf(node.props?.label) ??
      node.text?.slice(0, 80),
  }));
}

export function normalizeOverlays(raw: unknown): OverlaySummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index): OverlaySummary | null => {
      if (typeof entry === "string") return { id: entry };
      const value = record(entry);
      if (!value) return null;
      const component = record(value.component);
      const id =
        textOf(value.id) ??
        textOf(value.key) ??
        textOf(component?.id) ??
        `overlay-${index}`;
      return {
        id,
        kind:
          textOf(value.kind) ??
          textOf(component?.kind) ??
          textOf(component?.name),
        title:
          textOf(value.title) ??
          textOf(value.label) ??
          textOf(component?.title),
      };
    })
    .filter((entry): entry is OverlaySummary => Boolean(entry));
}
