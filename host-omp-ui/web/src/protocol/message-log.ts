import type { UiMessage } from "./types";

/**
 * An immutable message history with structural sharing.
 *
 * A streaming frame replaces one message. Holding the history as a plain
 * array made that replacement copy every element — Θ(history) references per
 * tick, and the GC that follows — because React reports a change by identity.
 *
 * This is a persistent vector: a 32-way trie with path copying. Replacing one
 * message copies at most `log32(length)` nodes and their 32-slot children
 * lists, so the work is bounded by the depth of the tree rather than by the
 * session's length. Appending, in the steady state, does the same and adds one
 * leaf slot.
 *
 * Provenance travels with each version. `dirtyFrom` is the first index that
 * differs from the version this one was derived from — exact, because every
 * mutation names its own index and no other index can move. A consumer that
 * remembers work done for a prefix asks `diffFrom(snapshot)`; that walks the
 * retained ancestry and reports 0 unless `snapshot` is provably an ancestor.
 * Reading `dirtyFrom` alone would be wrong: it is relative to the immediate
 * predecessor, while a consumer may hold a version several mutations back.
 */
const BITS = 5;
const WIDTH = 1 << BITS;
const MASK = WIDTH - 1;

/**
 * How many past versions a log keeps reachable.
 *
 * A consumer of a stream holds the version it last rendered and compares
 * against the newest one, so a handful covers the retries and superseded
 * frames that occur between two renders. Keeping a bounded window is what
 * stops the ancestry from pinning every trie this process ever built: each
 * version shares almost all its nodes with its predecessor, so eight retained
 * roots cost about eight paths, not eight histories.
 */
const MAX_ANCESTORS = 8;

/**
 * A bounded, reference-free record of one predecessor.
 *
 * Keeping the predecessor *objects* made the window meaningless: each retained
 * log carried its own retained logs, so the chain reached back to the first log
 * the process ever built and pinned every trie along it — the growth this type
 * exists to remove, reintroduced by its own provenance. A record keeps only
 * what an answer needs — the predecessor's identity, its length, and the
 * accumulated first difference — so eight retained rows cost eight numbers and
 * keep no tree alive.
 *
 * Identity is a version number rather than the object, for the same reason: a
 * number cannot retain a trie, and it cannot alias another log.
 */
interface Ancestor {
  readonly version: number;
  readonly length: number;
  /** Earliest index at which this version differs from the one holding it. */
  readonly dirty: number;
}

/** A leaf holds messages directly; an inner node holds 32 slots of nodes. */
type Node = readonly unknown[];

/**
 * The message sequence the renderer reads.
 *
 * It answers positional access, so consumers keep writing `messages[i]`, and it
 * carries the structural-sharing operations that make a frame cost the depth of
 * the tree instead of the length of the history. It is deliberately *not* an
 * array: `Array.isArray` cannot be made true for a non-array (the check reads
 * the value's internal class, which no proxy can change), so a consumer that
 * branches on it would take the wrong path. Modelling the sequence honestly
 * keeps that assumption out of the type system instead of hiding it behind a
 * cast, and any such branch is now a type error rather than a silent wrong
 * answer.
 */
export interface MessageLog {
  /**
   * Positional access, answered at run time by the index view the constructor
   * installs (`log[3]` is `log.at(3)`).
   *
   * A class cannot declare a numeric index signature, so it is declared here and
   * merged into the class's instance type. That is what lets every consumer keep
   * writing `messages[i]` while the value is a persistent vector rather than an
   * array — no cast, and no `.toArray()` in a hot path.
   *
   * The type is `UiMessage` rather than `UiMessage | undefined`, matching an
   * array read under this project's compiler settings: an out-of-range read is
   * `undefined` at run time, and a caller must keep its indices inside
   * `length`. Widening it would force a non-null assertion at every call site
   * for a case that is a bug, not a state.
   */
  readonly [index: number]: UiMessage;
}

/**
 * A message sequence: a persistent vector that reads like an array.
 *
 * It is deliberately *not* `UiMessage[]`. `Array.isArray` reads a value's
 * internal class, which no proxy can change, so a consumer branching on it takes
 * the array path for a non-array either way; the honest type keeps array-only
 * operations (`.push`, `.sort`, `.splice`) out of reach, where they would fail
 * at run time instead. Anything that genuinely needs an array asks for
 * `toArray()`.
 */
export type MessageSequence = MessageLog;

/** Version handed to the next log, so identity survives without a reference. */
let nextVersion = 1;

/**
 * One `slice` bound, normalised the way `Array.prototype.slice` does it.
 *
 * A non-numeric bound is zero, a negative one counts from the end, and the
 * result is clamped to the list. The clamp matters in both directions: an
 * over-long bound must not read past the end, and a still-negative one must not
 * start before the beginning.
 */
function bound(value: number, length: number): number {
  if (Number.isNaN(value)) return 0;
  const whole = Math.trunc(value);
  if (whole === Number.NEGATIVE_INFINITY) return 0;
  if (whole === Number.POSITIVE_INFINITY) return length;
  const offset = whole < 0 ? length + whole : whole;
  return Math.min(length, Math.max(0, offset));
}

/** Total positions addressable by a tree of the given depth. */
function capacityFor(shift: number): number {
  return WIDTH ** (shift / BITS + 1);
}

/** A new tree over `items`, built bottom-up so no message is copied twice. */
function buildTree(items: readonly UiMessage[]): {
  root: Node | undefined;
  shift: number;
} {
  if (items.length === 0) return { root: undefined, shift: 0 };
  let level: Node[] = [];
  for (let start = 0; start < items.length; start += WIDTH) {
    level.push(items.slice(start, start + WIDTH));
  }
  let shift = 0;
  while (level.length > 1) {
    const parents: Node[] = [];
    for (let start = 0; start < level.length; start += WIDTH) {
      parents.push(level.slice(start, start + WIDTH));
    }
    level = parents;
    shift += BITS;
  }
  return { root: level[0], shift };
}

/**
 * Set one position, copying the nodes on the path to it.
 *
 * Only the visited path is copied; every sibling subtree is shared with the
 * input tree, which is what keeps the cost at the depth of the tree.
 */
function assocPath(
  node: Node | undefined,
  shift: number,
  index: number,
  value: UiMessage,
): Node {
  if (shift === 0) {
    // A leaf: a flat list of up to 32 messages.
    const leaf = Array.isArray(node) ? (node as readonly UiMessage[]).slice() : [];
    (leaf as UiMessage[])[index & MASK] = value;
    return leaf;
  }
  const children = Array.isArray(node) ? (node as readonly Node[]).slice() : [];
  const slot = Math.floor(index / 2 ** shift) % WIDTH;
  (children as Node[])[slot] = assocPath(
    children[slot],
    shift - BITS,
    index,
    value,
  );
  return children;
}

/**
 * Yield the messages under `node` in index order, without materialising them.
 *
 * `map`, `filter`, `find`, `findIndex`, `some` and `every` are all built on
 * this walk, so it runs at whatever rate a caller iterates. Building an array
 * first would allocate a second copy of the history on every pass.
 */
function* walk(
  node: Node | undefined,
  shift: number,
): IterableIterator<UiMessage> {
  if (!Array.isArray(node)) return;
  if (shift === 0) {
    for (const message of node as readonly UiMessage[]) {
      // A leaf is dense except for the trailing gap a wrap can leave.
      if (message !== undefined) yield message;
    }
    return;
  }
  for (const child of node as readonly Node[]) {
    yield* walk(child, shift - BITS);
  }
}

function collect(node: Node | undefined, shift: number, out: UiMessage[]): void {
  for (const message of walk(node, shift)) out.push(message);
}

/**
 * The numeric-index view of a log.
 *
 * A class cannot carry a numeric index signature, so the runtime object answers
 * one instead: `log[3]` is `log.at(3)`. Consumers written against an array keep
 * reading positions; they simply stop paying for the array.
 *
 * Only canonical non-negative integer keys are intercepted. Everything else —
 * methods, `length`, symbols, `Symbol.iterator` — goes to the class unchanged,
 * so `map`, `find` and `[...log]` behave exactly as before.
 */
function indexable(log: MessageLog): MessageLog;
function indexable(log: MessageLog): MessageLog {
  return new Proxy(log, {
    get(target, prop, receiver) {
      const index = numericKey(prop);
      if (index !== null) return target.at(index);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      const index = numericKey(prop);
      if (index !== null) return index < target.length;
      return Reflect.has(target, prop);
    },
    set(target, prop, value) {
      const index = numericKey(prop);
      if (index !== null) {
        // A write through an index used to land an ordinary own property while
        // reads kept answering from `at()`, so the value was silently dropped:
        // the caller believed it had changed the message and nothing had. The
        // sequence cannot be changed in place — a version is immutable by
        // construction — so the attempt fails at the call site instead of
        // disappearing.
        throw new TypeError(
          `MessageLog is immutable: use replace(${index}, message) to derive a new history.`,
        );
      }
      return Reflect.set(target, prop, value);
    },
  });
}

/** The array index a property key names, or null when it names something else. */
function numericKey(prop: string | symbol): number | null {
  if (typeof prop !== "string") return null;
  if (prop.length === 0 || prop.length > 10) return null;
  const index = Number(prop);
  if (!Number.isInteger(index) || index < 0) return null;
  // Reject padding and exponent forms ("01", "1e3"): only the canonical
  // decimal spelling of an index may reach `at`.
  return String(index) === prop ? index : null;
}

export class MessageLog implements Iterable<UiMessage> {
  /**
   * Globally unique identity, assigned once per instance.
   *
   * Comparing versions replaces comparing objects: `diffFrom` must recognise a
   * predecessor that the caller still holds, and a number does that without
   * taking a reference to it. Versions are never reused, so two logs can never
   * answer as the same one.
   */
  readonly version: number;

  private constructor(
    private readonly root: Node | undefined,
    private readonly shift: number,
    readonly length: number,
    /** First index that differs from the version this one derives from. */
    readonly dirtyFrom: number,
    /** Recent predecessors, newest first. Bounded by MAX_ANCESTORS. */
    private readonly ancestors: readonly Ancestor[],
  ) {
    this.version = nextVersion++;
    // A class cannot declare a numeric index signature, but a value can honour
    // one at run time. Consumers reach into `messages[index]` and `[...messages]`
    // throughout the renderer, and they must keep working after the history
    // becomes a persistent vector. Answering indices from `at()` keeps a
    // positional read at the depth of the trie instead of turning it into a
    // full materialisation — which is the cost this type exists to remove.
    return indexable(this);
  }

  static empty(): MessageLog {
    return new MessageLog(undefined, 0, 0, 0, []);
  }

  /**
   * A log over `items`.
   *
   * A log handed back in is already a log: copying it would discard its
   * provenance and reintroduce the per-frame copy this type exists to remove.
   * An array has no recorded lineage, so its `dirtyFrom` claims nothing about
   * the prefix and starts at 0.
   */
  static from(items: readonly UiMessage[] | MessageLog, dirtyFrom = 0): MessageLog {
    if (items instanceof MessageLog) return items;
    const { root, shift } = buildTree(items);
    return new MessageLog(root, shift, items.length, dirtyFrom, []);
  }

  get isEmpty(): boolean {
    return this.length === 0;
  }

  /**
   * The ancestry to record for a version derived from this one.
   *
   * This version enters the window at distance one. The rows already there stay
   * with their first difference raised to at least this one's: the path to each
   * of them now passes through this change too, so the earliest index at which
   * they differ from the new version is the earlier of the two.
   */
  private lineage(): readonly Ancestor[] {
    const inherited = this.ancestors.map((ancestor) => ({
      version: ancestor.version,
      length: ancestor.length,
      dirty: Math.min(ancestor.dirty, this.dirtyFrom),
    }));
    return [
      { version: this.version, length: this.length, dirty: this.dirtyFrom },
      ...inherited,
    ].slice(0, MAX_ANCESTORS);
  }

  at(index: number): UiMessage | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      return undefined;
    }
    let node: Node | undefined = this.root;
    let shift = this.shift;
    while (shift > 0) {
      if (!Array.isArray(node)) return undefined;
      node = (node as readonly Node[])[Math.floor(index / 2 ** shift) % WIDTH];
      shift -= BITS;
    }
    if (!Array.isArray(node)) return undefined;
    return (node as readonly UiMessage[])[index & MASK];
  }

  /** Replace one message. Copies one path, never the history. */
  replace(index: number, value: UiMessage): MessageLog {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      return this;
    }
    const root = assocPath(this.root, this.shift, index, value);
    return new MessageLog(root, this.shift, this.length, index, this.lineage());
  }

  /** Append one message. The prefix keeps its positions and its nodes. */
  append(value: UiMessage): MessageLog {
    if (this.length === 0) {
      return new MessageLog([value], 0, 1, 0, this.lineage());
    }
    if (this.length < capacityFor(this.shift)) {
      const root = assocPath(this.root, this.shift, this.length, value);
      return new MessageLog(root, this.shift, this.length + 1, this.length, this.lineage());
    }
    // The tree is full: one more level, with the old root as its first child.
    const shift = this.shift + BITS;
    const root = assocPath([this.root], shift, this.length, value);
    return new MessageLog(root, shift, this.length + 1, this.length, this.lineage());
  }

  /**
   * Prepend messages, oldest first.
   *
   * Every position moves, so no prefix survives: the result claims nothing and
   * retains no ancestry. This runs once per loaded history page, not per frame.
   */
  prepend(items: readonly UiMessage[]): MessageLog {
    if (items.length === 0) return this;
    const { root, shift } = buildTree([...items, ...this.toArray()]);
    return new MessageLog(root, shift, this.length + items.length, 0, []);
  }

  /**
   * First index at which this log differs from `older`, or 0 when `older` is
   * not a retained ancestor.
   *
   * The check is by identity, so an unrelated log that happens to hold equal
   * messages answers 0 — conservatively, which makes a consumer regroup rather
   * than reuse a prefix it cannot prove. Reading `dirtyFrom` alone would answer
   * about the immediate predecessor instead of the version in hand.
   */
  diffFrom(older: MessageLog | null | undefined): number {
    if (!older) return 0;
    if (older.version === this.version) return this.length;
    // The first link is this version's own: it is how far this one differs from
    // the parent whose row sits first in the window. Each row then contributes
    // its own link onwards. Reading only the matched row would answer about the
    // parent's own predecessor instead of about the parent.
    let dirty = this.dirtyFrom;
    for (const ancestor of this.ancestors) {
      // A matched version is the same log — versions are never reused, so this
      // cannot confuse two histories that merely hold equal messages.
      if (ancestor.version === older.version) {
        return Math.min(dirty, older.length);
      }
      dirty = Math.min(dirty, ancestor.dirty);
    }
    return 0;
  }

  /**
   * Materialise a range. Bounds follow `Array.prototype.slice` exactly,
   * including the parts that are easy to get wrong: a negative bound counts
   * from the end, and a non-numeric bound is zero rather than "no value".
   * `slice(NaN)` on an array returns a copy; computing `Math.min(length, NaN)`
   * answered `[]`, which is a different list, not a rounding of the same one.
   */
  slice(from = 0, to = this.length): UiMessage[] {
    const start = bound(from, this.length);
    const end = bound(to, this.length);
    const out: UiMessage[] = [];
    for (let index = Math.max(0, start); index < end; index += 1) {
      const message = this.at(index);
      if (message !== undefined) out.push(message);
    }
    return out;
  }

  /** Materialise the whole history. Θ(length); callers that need it pay once. */
  toArray(): UiMessage[] {
    const out: UiMessage[] = [];
    collect(this.root, this.shift, out);
    return out;
  }

  /**
   * The history as a plain array.
   *
   * Without this, `JSON.stringify(messages)` serialised the trie's internals —
   * `{"root":[…],"shift":2,…}` — so anything that persisted, compared, or sent
   * the conversation over a wire saw the storage layout instead of the
   * messages. `JSON.stringify` honours `toJSON`, so the serde surface is again
   * the list of messages it is meant to be.
   */
  toJSON(): UiMessage[] {
    return this.toArray();
  }

  /**
   * Positional search, matching `Array.prototype.indexOf` on the same list.
   *
   * A negative start counts from the end, as an array does. Comparing `index >=
   * fromIndex` directly made every negative start mean "from the beginning",
   * so `indexOf(x, -1)` answered 0 for an element at the head instead of -1.
   */
  indexOf(target: UiMessage, fromIndex = 0): number {
    const start =
      fromIndex >= 0
        ? fromIndex
        : Math.max(0, this.length + Math.trunc(fromIndex) || 0);
    let index = 0;
    for (const message of this) {
      if (index >= start && message === target) return index;
      index += 1;
    }
    return -1;
  }

  /**
   * Fold over the history, in order.
   *
   * Consumers that reduced over an array reached for `.reduce`; without it they
   * fail at run time rather than reading the sequence, and the sequence is what
   * the state holds now.
   */
  reduce<T>(
    project: (accumulator: T, message: UiMessage, index: number) => T,
    initial: T,
  ): T {
    let accumulator = initial;
    let index = 0;
    for (const message of this) {
      accumulator = project(accumulator, message, index);
      index += 1;
    }
    return accumulator;
  }

  *[Symbol.iterator](): IterableIterator<UiMessage> {
    // Walk the trie in place. Materialising the history first allocated one
    // array of every message for each pass — and a pass is what `map`, `filter`
    // and `findIndex` are built from, so the allocation repeated at the frame
    // rate this type exists to keep flat. Iteration is still Θ(length) in time;
    // what it no longer does is pay for a second copy of the history.
    yield* walk(this.root, this.shift);
  }

  map<T>(project: (message: UiMessage, index: number) => T): T[] {
    const out: T[] = [];
    let index = 0;
    for (const message of this) {
      out.push(project(message, index));
      index += 1;
    }
    return out;
  }

  forEach(visit: (message: UiMessage, index: number) => void): void {
    let index = 0;
    for (const message of this) {
      visit(message, index);
      index += 1;
    }
  }

  find(predicate: (message: UiMessage, index: number) => boolean): UiMessage | undefined {
    let index = 0;
    for (const message of this) {
      if (predicate(message, index)) return message;
      index += 1;
    }
    return undefined;
  }

  findIndex(predicate: (message: UiMessage, index: number) => boolean): number {
    let index = 0;
    for (const message of this) {
      if (predicate(message, index)) return index;
      index += 1;
    }
    return -1;
  }

  some(predicate: (message: UiMessage, index: number) => boolean): boolean {
    return this.findIndex(predicate) >= 0;
  }

  every(predicate: (message: UiMessage, index: number) => boolean): boolean {
    let index = 0;
    for (const message of this) {
      if (!predicate(message, index)) return false;
      index += 1;
    }
    return true;
  }

  filter(predicate: (message: UiMessage, index: number) => boolean): UiMessage[] {
    const out: UiMessage[] = [];
    let index = 0;
    for (const message of this) {
      if (predicate(message, index)) out.push(message);
      index += 1;
    }
    return out;
  }

  concat(rest: readonly UiMessage[]): UiMessage[] {
    return [...this.toArray(), ...rest];
  }
}
