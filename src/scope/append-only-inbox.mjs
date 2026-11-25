// The root mailbox is the one ledger field that grows with a conversation, and
// the snapshot runs on every structural change — a new root message is one.
// Reusing the stored copies of its prefix is only sound if the prefix cannot
// move, and "cannot move" has to be a property of the object, not a promise in a
// comment: an earlier attempt inferred it from the last entry matching, which
// silently dropped an edit made in the middle.
//
// So the array is closed. It answers to `push` and to nothing else. Sorting,
// splicing, reversing, deleting, replacing an entry or assigning `length` all
// throw where they happen, and every entry is frozen when it is stored, so a
// write through a delivered entry fails at the write instead of vanishing into
// a snapshot that never read it. Foreign arrays (a ledger rebuilt by hand, a
// legacy snapshot, a test) are not this object and are never reused
// incrementally: the snapshot copies them whole, which is what it always did.

const OWNED = new WeakSet();
const VERSIONS = new WeakMap();

const INDEX = /^(?:0|[1-9][0-9]*)$/;

function refuse(method) {
  return new TypeError(
    `rootInbox is append-only: ${method} is not allowed. Push a new entry, or assign a new array to ledger.rootInbox.`,
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/**
 * A stored entry, detached from whatever the caller still holds.
 *
 * `push` freezes what it keeps, and freezing the caller's own object would be a
 * change the caller did not ask for — a shared literal would start throwing in
 * code that has nothing to do with the mailbox. The copy is JSON-shaped because
 * the snapshot that stores it is JSON-shaped: a value the journal cannot hold
 * would make the whole snapshot unstringifiable.
 */
function detach(value, seen) {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return value;
  // A function, a symbol or a bigint is not JSON data. Keeping one would leave a
  // stored entry that the snapshot cannot stringify as a whole — a bigint makes
  // `JSON.stringify` throw — so it is dropped here, the same answer the deep copy
  // has always given. Dropping only this value keeps the rest of the entry.
  if (kind !== "object") return undefined;
  if (seen.has(value)) {
    // A cycle cannot be written as JSON, and recursing into one used to end in a
    // stack overflow from inside `push`. Refusing names the real problem at the
    // write instead.
    throw new TypeError(
      "rootInbox entries must be acyclic: a cycle cannot be journaled. Push a copy without the cycle.",
    );
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const out = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) out[index] = detach(value[index], seen);
    seen.delete(value);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  seen.add(value);
  const out = {};
  for (const key of Object.keys(value)) {
    const child = detach(value[key], seen);
    if (child === undefined) continue;
    // `__proto__` must stay a data key.
    Object.defineProperty(out, key, {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(value);
  return out;
}

/**
 * Build the append-only mailbox.
 *
 * `push` reaches the array through this proxy, so the two writes it performs —
 * the new index, then `length` — are the only writes allowed. Everything else
 * lands in the `set`, `deleteProperty` or `defineProperty` trap and throws.
 */
export function createAppendOnlyInbox() {
  const target = [];
  let proxy;
  OWNED.add(proxy = new Proxy(target, {
    set(object, key, value) {
      if (key === "length") {
        // A growing `length` would leave a hole that no `push` recorded, and the
        // append counter would not move — a snapshot would then answer "nothing
        // changed" for a mailbox that lost an entry. `push` does not need this
        // write: it stores the index first, which already extends the array, and
        // only then confirms the length it produced. So the only acceptable
        // length write is the one that changes nothing.
        const next = Number(value);
        if (next === object.length) return true;
        throw refuse("a length write");
      }
      if (typeof key !== "string" || !INDEX.test(key)) throw refuse(`a write to ${String(key)}`);
      const index = Number(key);
      // `push` writes the index that is about to become the new end.
      if (index !== object.length) throw refuse(`a write to index ${index}`);
      // The stored entry is a detached, frozen copy: the caller keeps its own
      // object, and nothing can reach the stored one to change it later.
      object[index] = deepFreeze(detach(value, new Set()));
      VERSIONS.set(proxy, (VERSIONS.get(proxy) ?? 0) + 1);
      return true;
    },
    deleteProperty(_object, key) {
      throw refuse(`delete of ${String(key)}`);
    },
    defineProperty(object, key, descriptor) {
      // The two writes `push` performs reach `set`, not this trap; anything
      // that arrives here is a redefinition and would change a stored entry.
      throw refuse(`a redefinition of ${String(key)}`);
    },
    setPrototypeOf() {
      throw refuse("a prototype change");
    },
  }));
  VERSIONS.set(proxy, 0);
  return proxy;
}

/**
 * Adopt an outside list as a closed mailbox.
 *
 * A ledger can arrive from a legacy snapshot or be assembled by hand, and its
 * mailbox then is a plain array whose entries nobody promised are stable. It is
 * copied once, here, so that appends are governed by the same boundary from
 * then on. The existing entries are kept: adopting is a change of container,
 * not a statement that the list was empty.
 */
export function adoptInbox(value) {
  const inbox = createAppendOnlyInbox();
  if (Array.isArray(value)) {
    for (const entry of value) inbox.push(entry);
  }
  return inbox;
}

/** How many entries have been appended. Only grows, by exactly one per push. */
export function inboxVersion(inbox) {
  return VERSIONS.get(inbox) ?? 0;
}

/**
 * True when `value` is one of our mailboxes: an array that cannot be changed
 * except by appending. Only such an array may reuse a stored prefix; a plain
 * array is untrusted and is copied whole.
 */
export function isAppendOnlyInbox(value) {
  return OWNED.has(value);
}

/**
 * How many leading entries a snapshot's mailbox shares with the snapshot before
 * it.
 *
 * The snapshot is the only place that can prove this: a closed mailbox cannot be
 * reordered or edited, so an append leaves the stored prefix exactly as it was.
 * The journal then starts its own prefix check at this index instead of at zero,
 * which turns a per-frame walk over the whole conversation into a comparison of
 * nothing. The mark is non-enumerable: it never reaches JSON, and a copy that
 * loses it only pays the scan it used to pay.
 */
const SHARED_PREFIX = Symbol.for("herd.inboxSharedPrefix");

export function markSharedPrefix(inbox, count, base) {
  if (!Array.isArray(inbox)) return inbox;
  if (!Number.isInteger(count) || count <= 0 || base === undefined) return inbox;
  // The mark is bound to the array it was computed against. A count alone is
  // relative to the snapshot before this one, and a consumer whose baseline is
  // older — or one that kept a baseline across a mailbox replacement — would
  // then skip a comparison it still needs and store the wrong suffix. Identity
  // of the base is the whole proof; a different base means no skip.
  //
  // The base is held weakly on purpose. A snapshot's mark points at the array
  // of the snapshot before it, and that array carries its own mark, so a strong
  // reference would chain every snapshot ever taken behind the newest one. A
  // collected base only costs the scan this mark would have saved.
  const ref = typeof WeakRef === "function" ? new WeakRef(base) : null;
  if (ref === null) return inbox;
  Object.defineProperty(inbox, SHARED_PREFIX, { value: { count, base: ref }, configurable: true });
  return inbox;
}

/** The shared prefix, but only for the baseline the mark was computed against. */
export function sharedPrefixFor(inbox, base) {
  const mark = inbox?.[SHARED_PREFIX];
  if (mark === undefined || base === undefined) return 0;
  if (typeof mark.base.deref !== "function" || mark.base.deref() !== base) return 0;
  return Number.isInteger(mark.count) && mark.count > 0 ? mark.count : 0;
}
