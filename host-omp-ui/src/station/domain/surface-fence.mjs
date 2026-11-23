// A small document reducer for the structured surface frames produced by the
// TUI fence. It accepts both the wire form (`TspOp` positional tuples emitted
// by @oh-my-pi/pi-tui's Reconciler) and the flat object form used by the
// fallback reconciler and by older web clients. It is deliberately not a
// terminal emulator: nodes carry text and children, and the Web maps them to
// DeerFlow primitives.

export function createEmptyDocument() {
  return { root: { id: "root", children: [] }, focus: null, settled: [] };
}

function findNode(node, id) {
  if (!node) return undefined;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function findParent(node, id) {
  if (!node) return undefined;
  for (const child of node.children ?? []) {
    if (child.id === id) return node;
    const found = findParent(child, id);
    if (found) return found;
  }
  return undefined;
}

function removeNode(doc, id) {
  const parent = findParent(doc.root, id);
  if (!parent) return;
  parent.children = parent.children.filter((child) => child.id !== id);
}

function insertNode(doc, node, op) {
  const parent = findNode(doc.root, op.parent) ?? doc.root;
  parent.children = [...(parent.children ?? [])];
  let index = parent.children.length;
  if (typeof op.before === "string") {
    const at = parent.children.findIndex((child) => child.id === op.before);
    if (at >= 0) index = at;
  } else if (!op.before && typeof op.index === "number") {
    index = Math.max(0, Math.min(Math.trunc(op.index), parent.children.length));
  }
  parent.children.splice(index, 0, node);
}

const TEXT_KINDS = new Set(["text", "md", "code", "ansi", "math", "editor", "input", "shimmer", "doc"]);

function normalizeNode(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  const props = raw.props && typeof raw.props === "object" ? raw.props : raw.p && typeof raw.p === "object" ? raw.p : {};
  const kind = typeof raw.kind === "string" ? raw.kind : typeof raw.k === "string" ? raw.k : "node";
  const source = Array.isArray(raw.children) ? raw.children : Array.isArray(raw.c) ? raw.c : [];
  const node = { id, kind, props: { ...props } };
  if (typeof raw.text === "string") node.text = raw.text;
  else if (typeof props.text === "string") node.text = props.text;
  const children = [];
  for (const child of source) {
    const normalized = normalizeNode(child);
    if (normalized) children.push(normalized);
  }
  if (children.length > 0) node.children = children;
  return node;
}

// The wire protocol sends positional tuples; the fence test double and the
// fallback reconciler send objects. Normalize both to the object form so the
// rest of this reducer has one shape to reason about.
function normalizeOp(raw) {
  if (!Array.isArray(raw)) return raw;
  switch (raw[0]) {
    case "add":
      return { op: "add", id: raw[1], parent: raw[2], before: raw[3] ?? null, node: raw[4] };
    case "set":
      return { op: "set", id: raw[1], props: raw[2] ?? {} };
    case "text":
      return { op: "text", id: raw[1], mode: raw[2], text: raw[3] };
    case "splice":
      return { op: "splice", id: raw[1], index: raw[2], remove: raw[3], text: raw[4], tuple: true };
    case "move":
      return { op: "move", id: raw[1], parent: raw[2], before: raw[3] ?? null };
    case "del":
      return { op: "del", id: raw[1] };
    case "settle":
      return { op: "settle", id: raw[1] };
    case "focus":
      return { op: "focus", id: raw[1] ?? null };
    default:
      // reveal / scroll / suspend / resume carry no document content.
      return null;
  }
}

function setText(node, text, append) {
  node.text = append ? `${node.text ?? ""}${text}` : text;
  if (TEXT_KINDS.has(node.kind) || typeof node.props?.text === "string") {
    node.props = { ...(node.props ?? {}), text: node.text };
  }
}

function applyOp(doc, raw) {
  const op = normalizeOp(raw);
  if (!op || typeof op !== "object") return;
  switch (op.op) {
    case "add": {
      // Wire ops nest the node; flat object ops carry id/kind/props directly.
      const node = normalizeNode(op.node ?? op);
      if (!node) return;
      removeNode(doc, node.id);
      insertNode(doc, node, op);
      return;
    }
    case "set": {
      const node = findNode(doc.root, op.id);
      if (!node) return;
      const props = op.props && typeof op.props === "object" ? op.props : {};
      node.props = { ...(node.props ?? {}), ...props };
      if (typeof op.kind === "string") node.kind = op.kind;
      if (typeof props.text === "string") node.text = props.text;
      return;
    }
    case "text": {
      const node = findNode(doc.root, op.id);
      if (!node) return;
      setText(node, String(op.text ?? ""), op.mode === "append");
      return;
    }
    case "splice": {
      const node = findNode(doc.root, op.id);
      if (!node) return;
      if (op.tuple || (typeof op.text === "string" && !Array.isArray(op.items))) {
        // Wire `splice`: a character edit of the node's text.
        const text = String(op.text ?? "");
        const at = Math.max(0, Math.min(Number(op.index ?? 0), node.text?.length ?? 0));
        const remove = Math.max(0, Number(op.remove ?? 0));
        const current = node.text ?? "";
        setText(node, `${current.slice(0, at)}${text}${current.slice(at + remove)}`, false);
        return;
      }
      // Object `splice`: structural children replacement.
      const children = [...(node.children ?? [])];
      const index = Math.max(0, Number(op.index ?? 0));
      const remove = Math.max(0, Number(op.remove ?? 0));
      const items = (op.items ?? []).map((item) => normalizeNode(item)).filter(Boolean);
      children.splice(index, remove, ...items);
      node.children = children;
      return;
    }
    case "move": {
      const node = findNode(doc.root, op.id);
      if (!node) return;
      removeNode(doc, op.id);
      insertNode(doc, node, op);
      return;
    }
    case "del":
      removeNode(doc, op.id);
      return;
    case "settle": {
      if (!op.id || doc.settled.includes(op.id)) return;
      doc.settled = [...doc.settled, op.id];
      return;
    }
    case "focus":
      doc.focus = op.id ?? null;
      return;
    default:
      return;
  }
}

export function applyTspOpsToDocument(document, ops) {
  const doc = document ?? createEmptyDocument();
  for (const op of ops ?? []) applyOp(doc, op);
  return doc;
}

export function summarizeSurfaceFrame(frame) {
  const ops = frame?.ops ?? [];
  return {
    surfaceId: frame?.sf,
    seq: frame?.s,
    opCount: ops.length,
    kinds: ops.map((op) => (Array.isArray(op) ? op[0] : op?.op)),
  };
}
