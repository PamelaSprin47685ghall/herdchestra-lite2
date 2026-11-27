import type { ToolExecution, UiMessage } from "../protocol/types";

type IndexedMessages = { readonly length: number; readonly [index: number]: UiMessage };
import {
  isToolBlock,
  mergeToolBlock,
  toolBlockId,
} from "../protocol/tool-view";

export type StepFormat = "markdown" | "pre";

export type StepEntry =
  | {
      key: string;
      kind: "thinking";
      text: string;
      format: StepFormat;
      messageId?: string;
      streaming: boolean;
    }
  | {
      key: string;
      kind: "text";
      text: string;
      format: StepFormat;
      messageId?: string;
      streaming: boolean;
    }
  | {
      key: string;
      kind: "input";
      text: string;
      format: StepFormat;
      messageId?: string;
      streaming: boolean;
    }
  | {
      key: string;
      kind: "tool";
      tool: ToolExecution;
      format: StepFormat;
      messageId?: string;
      streaming: boolean;
    };

function hasVisibleText(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

// One turn boundary rule for both views. The copy that used to live here lacked
// the `synthetic` guard, so an injected input opened a turn on the web while the
// station folded it into a step.
import { isRealUser } from "../../../shared/transcript-groups.mjs";

export { isRealUser };

export function resolveHistoryCursor(
  oldestId: string | null | undefined,
  messages: { readonly [index: number]: { id: string } },
): string | null {
  return oldestId ?? messages[0]?.id ?? null;
}

export interface StepSegment {
  id: string;
  steps: readonly StepEntry[];
}

export type TurnGroup =
  | { kind: "user"; id: string; message: UiMessage }
  | {
      kind: "processing";
      id: string;
      messages: UiMessage[];
      segments: readonly StepSegment[];
      totalSteps: number;
      hasStreamingStep: boolean;
      runningTools: number;
      steps: StepEntry[];
      body: string;
      streaming: boolean;
      bodyFinished: boolean;
      stepsFinished: boolean;
    }
  | { kind: "terminal"; id: string; message: UiMessage }
  | { kind: "boundary"; id: string; message: UiMessage }
  | { kind: "other"; id: string; message: UiMessage };

/**
 * The settled prefix of a grouping: groups whose entire input lies before
 * `sealedCount` messages.
 *
 * A streaming frame rewrites the tail of the list, so every group before that
 * tail can be reused by reference instead of regrouped. The prefix is only
 * valid for the message list it was built from; a caller must verify that
 * before resuming, which `firstDifference` answers for what changed.
 */
/**
 * A persistent sequence of settled groups.
 *
 * A streaming frame rewrites the tail of the conversation, so every group before
 * that tail is unchanged by reference. Holding those groups in a plain array
 * forced a copy of the whole settled prefix on every frame — `[...sealed]` — and
 * the prefix grows with the session, so the price of a frame grew with it too.
 *
 * This is a 32-way trie with path copying: appending one group copies the nodes
 * on one path, never the earlier ones. Positional reads descend the same path,
 * so a renderer that asks for `groups[i]` costs the depth of the tree rather
 * than a materialisation.
 *
 * It reads like an array where it has to (a numeric index view, `length`,
 * `slice`, iteration) so the scroll and grouping code keeps working unchanged,
 * and it is deliberately *not* an array: a caller that reaches for `push` gets
 * no such method, because the way to add a group is to derive a new sequence.
 */
const GROUP_BITS = 5;
const GROUP_WIDTH = 1 << GROUP_BITS;
const GROUP_MASK = GROUP_WIDTH - 1;

type GroupNode = readonly unknown[];

function groupCapacity(shift: number): number {
  return GROUP_WIDTH ** (shift / GROUP_BITS + 1);
}

function groupAssoc(
  node: GroupNode | undefined,
  shift: number,
  index: number,
  value: TurnGroup,
): GroupNode {
  if (shift === 0) {
    const leaf = Array.isArray(node) ? (node as readonly TurnGroup[]).slice() : [];
    (leaf as TurnGroup[])[index & GROUP_MASK] = value;
    return leaf;
  }
  const children = Array.isArray(node) ? (node as readonly GroupNode[]).slice() : [];
  const slot = Math.floor(index / 2 ** shift) % GROUP_WIDTH;
  (children as GroupNode[])[slot] = groupAssoc(
    children[slot],
    shift - GROUP_BITS,
    index,
    value,
  );
  return children;
}

function groupCollect(
  node: GroupNode | undefined,
  shift: number,
  out: TurnGroup[],
): void {
  if (!Array.isArray(node)) return;
  if (shift === 0) {
    for (const group of node as readonly TurnGroup[]) {
      if (group !== undefined) out.push(group);
    }
    return;
  }
  for (const child of node as readonly GroupNode[]) {
    groupCollect(child, shift - GROUP_BITS, out);
  }
}

/** The array index a property key names, or null when it names something else. */
function groupIndexKey(prop: string | symbol): number | null {
  if (typeof prop !== "string" || prop.length === 0 || prop.length > 10) return null;
  const index = Number(prop);
  if (!Number.isInteger(index) || index < 0) return null;
  return String(index) === prop ? index : null;
}

export interface GroupLog {
  readonly [index: number]: TurnGroup | undefined;
}

export class GroupLog implements Iterable<TurnGroup> {
  private constructor(
    private readonly root: GroupNode | undefined,
    private readonly shift: number,
    /**
     * How many groups this version holds.
     *
     * Carried, not counted. Walking the trie to answer `length` made every
     * `length` read cost the settled history, and the grouping code reads it on
     * every frame — so the frame cost grew with the conversation, which is what
     * this sequence exists to prevent. `append` and `replace` know the answer
     * by construction, and nothing else can change a version.
     */
    private readonly size: number,
  ) {
    // A class cannot declare a numeric index signature, so the value answers one
    // at run time. Consumers keep writing `groups[i]`, and a positional read
    // descends the trie instead of materialising the list.
    return groupIndexable(this);
  }

  static empty(): GroupLog {
    return new GroupLog(undefined, 0, 0);
  }

  static from(groups: readonly TurnGroup[] | GroupLog): GroupLog {
    if (groups instanceof GroupLog) return groups;
    let log = GroupLog.empty();
    for (const group of groups) log = log.append(group);
    return log;
  }

  get length(): number {
    return this.size;
  }

  at(index: number): TurnGroup | undefined {
    // `Array.prototype.at` semantics: a negative index counts from the end.
    const resolved = index < 0 ? this.length + index : index;
    if (!Number.isInteger(resolved) || resolved < 0 || resolved >= this.size) return undefined;
    let node: GroupNode | undefined = this.root;
    let shift = this.shift;
    while (shift > 0) {
      if (!Array.isArray(node)) return undefined;
      node = (node as readonly GroupNode[])[Math.floor(resolved / 2 ** shift) % GROUP_WIDTH];
      shift -= GROUP_BITS;
    }
    if (!Array.isArray(node)) return undefined;
    return (node as readonly TurnGroup[])[resolved & GROUP_MASK];
  }

  /** Append one group. Copies one path, never the earlier groups. */
  append(value: TurnGroup): GroupLog {
    const length = this.size;
    if (length === 0) return new GroupLog([value], 0, 1);
    if (length < groupCapacity(this.shift)) {
      return new GroupLog(
        groupAssoc(this.root, this.shift, length, value),
        this.shift,
        length + 1,
      );
    }
    const shift = this.shift + GROUP_BITS;
    return new GroupLog(
      groupAssoc([this.root], shift, length, value),
      shift,
      length + 1,
    );
  }

  /** Replace one position, as a frame that re-derives its open turn needs. */
  replace(index: number, value: TurnGroup): GroupLog {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) return this;
    return new GroupLog(
      groupAssoc(this.root, this.shift, index, value),
      this.shift,
      this.size,
    );
  }

  /**
   * Materialise a range, matching `Array.prototype.slice` for every bound form.
   *
   * Only the subtrees that overlap the range are visited. Building the whole
   * list first and slicing it made a caller that wants the visible window pay
   * for the entire history — the same mistake as copying the settled prefix,
   * one layer down.
   */
  slice(from = 0, to = this.size): TurnGroup[] {
    const bound = (value: number): number => {
      // The array rules, including the two that are easy to lose: a non-numeric
      // bound is zero, and a negative one counts from the end.
      if (Number.isNaN(value)) return 0;
      const whole = Math.trunc(value);
      if (whole === Number.NEGATIVE_INFINITY) return 0;
      if (whole === Number.POSITIVE_INFINITY) return this.size;
      const offset = whole < 0 ? this.size + whole : whole;
      return Math.min(this.size, Math.max(0, offset));
    };
    const start = bound(from);
    const end = bound(to);
    const out: TurnGroup[] = [];
    if (end <= start) return out;
    this.collectRange(start, end, out);
    return out;
  }

  /** Push the groups in `[from, to)` onto `out`, skipping disjoint subtrees. */
  private collectRange(from: number, to: number, out: TurnGroup[]): void {
    const walk = (node: GroupNode | undefined, shift: number, base: number): void => {
      if (!Array.isArray(node)) return;
      if (shift === 0) {
        const leaf = node as readonly TurnGroup[];
        const first = Math.max(0, from - base);
        const last = Math.min(leaf.length, to - base);
        for (let offset = first; offset < last; offset += 1) {
          const group = leaf[offset];
          if (group !== undefined) out.push(group);
        }
        return;
      }
      // One level down covers `span` positions per slot, so a slot wholly
      // outside the range costs a comparison and nothing else.
      const span = GROUP_WIDTH ** (shift / GROUP_BITS);
      const children = node as readonly GroupNode[];
      for (let slot = 0; slot < children.length; slot += 1) {
        const childBase = base + slot * span;
        if (childBase + span <= from) continue;
        if (childBase >= to) return;
        walk(children[slot], shift - GROUP_BITS, childBase);
      }
    };
    walk(this.root, this.shift, 0);
  }

  toArray(): TurnGroup[] {
    const out: TurnGroup[] = [];
    groupCollect(this.root, this.shift, out);
    return out;
  }

  /**
   * The array methods the grouping and scroll code already calls.
   *
   * They are declared here rather than reached through `toArray()` so a caller
   * that maps over the groups does not first materialise a copy of the whole
   * sequence. Each one walks the trie directly.
   */
  map<T>(project: (group: TurnGroup, index: number) => T): T[] {
    const out: T[] = [];
    let index = 0;
    for (const group of this) {
      out.push(project(group, index));
      index += 1;
    }
    return out;
  }

  filter(predicate: (group: TurnGroup, index: number) => boolean): TurnGroup[] {
    const out: TurnGroup[] = [];
    let index = 0;
    for (const group of this) {
      if (predicate(group, index)) out.push(group);
      index += 1;
    }
    return out;
  }

  find(predicate: (group: TurnGroup, index: number) => boolean): TurnGroup | undefined {
    let index = 0;
    for (const group of this) {
      if (predicate(group, index)) return group;
      index += 1;
    }
    return undefined;
  }

  findIndex(predicate: (group: TurnGroup, index: number) => boolean): number {
    let index = 0;
    for (const group of this) {
      if (predicate(group, index)) return index;
      index += 1;
    }
    return -1;
  }

  some(predicate: (group: TurnGroup, index: number) => boolean): boolean {
    return this.findIndex(predicate) >= 0;
  }

  every(predicate: (group: TurnGroup, index: number) => boolean): boolean {
    let index = 0;
    for (const group of this) {
      if (!predicate(group, index)) return false;
      index += 1;
    }
    return true;
  }

  forEach(visit: (group: TurnGroup, index: number) => void): void {
    let index = 0;
    for (const group of this) {
      visit(group, index);
      index += 1;
    }
  }

  *[Symbol.iterator](): IterableIterator<TurnGroup> {
    // Walk the trie in place. Materialising the list first allocated an array of
    // every settled group on each pass, and `map`, `filter`, `find`,
    // `findIndex`, `some`, `every` and `forEach` are all built on this iterator
    // — so that allocation repeated at the frame rate this type exists to keep
    // flat. Iteration is still Θ(length) in time; what it no longer does is pay
    // for a second copy of the history.
    const walk = function* (
      node: GroupNode | undefined,
      shift: number,
    ): IterableIterator<TurnGroup> {
      if (!Array.isArray(node)) return;
      if (shift === 0) {
        for (const group of node as readonly TurnGroup[]) {
          if (group !== undefined) yield group;
        }
        return;
      }
      for (const child of node as readonly GroupNode[]) {
        yield* walk(child, shift - GROUP_BITS);
      }
    };
    yield* walk(this.root, this.shift);
  }
}

function groupIndexable(log: GroupLog): GroupLog {
  return new Proxy(log, {
    get(target, prop, receiver) {
      const index = groupIndexKey(prop);
      if (index !== null) return target.at(index);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      const index = groupIndexKey(prop);
      if (index !== null) return index < target.length;
      return Reflect.has(target, prop);
    },
  });
}

export interface TurnGroupCache {
  /**
   * The settled groups, as a persistent sequence.
   *
   * A frame appends to the live tree without copying the prefix it inherited,
   * which is the difference between a frame that costs the tail it rewrote and
   * one that costs the whole conversation so far.
   */
  sealed: GroupLog;
  sealedCount: number;
}

/**
 * True when every message before `count` is the very same object in both lists.
 *
 * This is the only sound test for reusing a settled prefix, and it is stated
 * exactly as the question the reuse asks: are the inputs those groups were
 * built from still identical? Comparing from the tail cannot answer it. Two
 * equal trailing elements say nothing about the element before them, so a list
 * that changed at both ends reports only the later change, and a list that
 * gained one message at the front reports "everything matches" while every
 * index has shifted by one. Both would reuse a group that no longer describes
 * the messages it is drawn from — a stale turn on screen, not a slow frame.
 *
 * The scan is one reference comparison per settled message and allocates
 * nothing; the cost it replaces is rebuilding every group before that point,
 * which parses every message it covers.
 */
export function sealedPrefixHolds(
  previous: IndexedMessages,
  next: IndexedMessages,
  count: number,
): boolean {
  if (count <= 0) return true;
  // A shorter list cannot still hold the prefix those groups were built for.
  if (next.length < count || previous.length < count) return false;
  for (let index = 0; index < count; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function groupTurnMessages(
  messages: IndexedMessages,
  resume: TurnGroupCache | null,
): { groups: GroupLog; cache: TurnGroupCache } {
  // A prefix longer than the list it is resumed against cannot be reused: the
  // messages those groups covered are not all present any more.
  const usable = resume !== null && resume.sealedCount <= messages.length ? resume : null;
  // The settled groups live in a persistent sequence, so a frame that rewrites
  // the tail names the prefix it inherited rather than copying it. `tail` holds
  // only the groups this frame produced that are not yet settled — at most the
  // closed run and whatever single-message groups followed it.
  let sealed = usable ? usable.sealed : GroupLog.empty();
  // Where the settled prefix ends. The next run starts here and stays open, so
  // a frame that rewrites the tail keeps this boundary and reuses the prefix.
  let sealedCount = usable ? usable.sealedCount : 0;
  let sealedGroupCount = sealed.length;
  const tail: TurnGroup[] = [];
  let run: UiMessage[] = [];
  const flush = (allowBody = true) => {
    if (!run.length) return;
    const segments: StepSegment[] = [];
    const pairedToolIds = new Set<string>();
    let totalSteps = 0;
    let hasStreamingStep = false;
    let runningTools = 0;
    let body = "";
    let bodyFinished = true;
    let stepsFinished = true;
    run.forEach((message, index) => {
      const pairedResult =
        message.role === "toolResult" &&
        typeof message.toolCallId === "string" &&
        pairedToolIds.has(message.toolCallId);
      const built = pairedResult
        ? {
            steps: [] as StepEntry[],
            body: "",
            bodyFinished: true,
            stepsFinished: true,
            hasStreamingStep: false,
            runningTools: 0,
          }
        : buildSteps(message);
      for (const step of built.steps) {
        if (step.kind !== "tool") continue;
        pairedToolIds.add(step.tool.id);
        if (step.tool.toolCallId) pairedToolIds.add(step.tool.toolCallId);
      }
      if (built.steps.length) {
        segments.push({ id: message.id, steps: built.steps });
        totalSteps += built.steps.length;
      }
      hasStreamingStep = hasStreamingStep || built.hasStreamingStep;
      runningTools += built.runningTools;
      stepsFinished = stepsFinished && built.stepsFinished;
      if (allowBody && index === run.length - 1 && message.role === "assistant") {
        body = built.body;
        bodyFinished = built.bodyFinished;
      } else if (hasVisibleText(built.body)) {
        const step: StepEntry = {
          key: `body-${message.id}`,
          kind: "text",
          text: built.body,
          format:
            message.role === "toolResult" ||
            message.role === "developer" ||
            message.role === "user"
              ? "pre"
              : "markdown",
          messageId: message.id,
          streaming: false,
        };
        segments.push({ id: message.id, steps: [step] });
        totalSteps += 1;
      }
    });
    const group = {
      kind: "processing" as const,
      id: run[0].id,
      messages: run,
      segments,
      totalSteps,
      hasStreamingStep,
      runningTools,
      body,
      streaming: run.some((message) => message.streaming),
      bodyFinished,
      stepsFinished,
      steps: [] as StepEntry[],
    };
    Object.defineProperty(group, "steps", {
      get() {
        return segments.flatMap((segment) => segment.steps as StepEntry[]);
      },
    });
    tail.push(group);
    run = [];
  };
  for (let index = sealedCount; index < messages.length; index += 1) {
    const message = messages[index];
    if (isRealUser(message)) {
      flush(true);
      // The run that just closed and the user message that opens the next turn
      // are both settled: a streaming frame rewrites assistant text, never
      // these. Settling moves them into the persistent prefix once, so later
      // frames inherit them without copying anything.
      tail.push({ kind: "user", id: message.id, message });
      for (const group of tail) sealed = sealed.append(group);
      tail.length = 0;
      sealedCount = index + 1;
      sealedGroupCount = sealed.length;
      continue;
    }
    if (message.role === "user") {
      run.push(message);
      continue;
    }
    if (
      message.role === "assistant" ||
      message.role === "developer" ||
      message.role === "custom"
    ) {
      run.push(message);
      continue;
    }
    if (message.role === "toolResult" && run.length) {
      run.push(message);
      continue;
    }
    flush();
    if (message.role === "bashExecution" || message.role === "pythonExecution") {
      tail.push({ kind: "terminal", id: message.id, message });
    } else if (
      message.role === "compactionSummary" ||
      message.role === "branchSummary"
    ) {
      tail.push({ kind: "boundary", id: message.id, message });
    } else {
      tail.push({ kind: "other", id: message.id, message });
    }
    // These groups hold one message each and are not rewritten by a frame.
    for (const group of tail) sealed = sealed.append(group);
    tail.length = 0;
    sealedCount = index + 1;
    sealedGroupCount = sealed.length;
  }
  // The trailing run stays open: this call may be regrouping a frame still
  // writing into it, so it is not part of the reusable prefix.
  flush();
  // The frame's own groups are appended to the inherited prefix. When nothing
  // was settled this frame, `sealed` is the very sequence the previous frame
  // handed over — the prefix is shared, not copied, which is the whole point.
  const groups = tail.reduce((log, group) => log.append(group), sealed);
  return { groups, cache: { sealed, sealedCount } };
}

/**
 * Groups one user turn into a single processing block. Every intermediate
 * assistant text becomes a step; only the final assistant text is body.
 */
export function buildTurnGroups(messages: IndexedMessages): TurnGroup[] {
  return groupTurnMessages(messages, null).groups.toArray();
}

/** The lineage a persistent sequence carries; a plain array carries none. */
interface MessageProvenance {
  diffFrom(older: unknown): number;
}

function sequenceProvenance(messages: unknown): MessageProvenance | null {
  if (messages === null || typeof messages !== "object") return null;
  const candidate = messages as Partial<MessageProvenance>;
  return typeof candidate.diffFrom === "function"
    ? (candidate as MessageProvenance)
    : null;
}

/**
 * Whether a cached grouping may still describe the prefix of `messages`.
 *
 * The question is exactly "are the messages those groups were built from still
 * the same objects, in the same places?" — so it is answered from the
 * sequence's own lineage, not from a counter. A counter is a per-state-tree
 * fact: a session switch, a reload, or any rebuild that resets it can land at
 * the successor of a value the cache happens to hold, and the two values then
 * describe two different conversations. The lineage cannot: `diffFrom` compares
 * versions, and a sequence that is not an ancestor of this one answers 0, which
 * sends the caller to a full regroup.
 *
 * A sequence with no lineage (a plain array, which some paths still produce) is
 * never reused. Guessing there is what a stale turn on screen looks like.
 */
export function canReuseGroups(
  previous: { messages: IndexedMessages; cache: TurnGroupCache } | null,
  messages: IndexedMessages,
): boolean {
  if (previous === null) return false;
  if (previous.messages === messages) return true;
  const current = sequenceProvenance(messages);
  const cached = sequenceProvenance(previous.messages);
  if (current === null || cached === null) return false;
  // An ancestor answers with the exact first index that differs; anything else
  // answers 0, which only a zero-length settled prefix may accept — and
  // resuming against an empty prefix rebuilds everything anyway.
  return current.diffFrom(cached) >= previous.cache.sealedCount;
}

/**
 * The same grouping, resuming from a prefix a previous call had settled.
 *
 * `resume` is only sound while every message before `resume.sealedCount` is
 * the same object as when the cache was built. `firstDifference` answers that
 * check for the frames a stream produces, where only the tail moves.
 */
export function buildTurnGroupsResumable(
  messages: IndexedMessages,
  resume: TurnGroupCache | null,
): { groups: GroupLog; cache: TurnGroupCache } {
  return groupTurnMessages(messages, resume);
}

export function shouldShowStreamingFooter(group: TurnGroup): boolean {
  return (
    group.kind === "processing" &&
    group.streaming &&
    group.totalSteps === 0 &&
    group.body === ""
  );
}

/**
 * Whether the last step group should stay open. A group with running steps is
 * active. The last group stays active while the session is still streaming, or
 * while it has no final body yet, so gaps between message_end and the next
 * message/tool never collapse it by accident.
 */
export function isStepGroupActive({
  isLastGroup,
  sessionStreaming,
  hasBody,
  runningStepsOrTools,
}: {
  isLastGroup: boolean;
  sessionStreaming: boolean;
  hasBody: boolean;
  runningStepsOrTools: boolean;
}): boolean {
  if (runningStepsOrTools) return true;
  if (!isLastGroup) return false;
  return sessionStreaming || !hasBody;
}

export function flattenStepWindow(
  segments: readonly StepSegment[],
  start: number,
  end: number,
): StepEntry[] {
  const result: StepEntry[] = [];
  let offset = 0;
  for (const segment of segments) {
    const next = offset + segment.steps.length;
    if (next > start && offset < end) {
      const from = Math.max(0, start - offset);
      const to = Math.min(segment.steps.length, end - offset);
      result.push(...(segment.steps.slice(from, to) as StepEntry[]));
    }
    offset = next;
    if (offset >= end) break;
  }
  return result;
}

const stepCache = new WeakMap<
  UiMessage,
  {
    signature: string;
    steps: StepEntry[];
    body: string;
    bodyFinished: boolean;
    stepsFinished: boolean;
    hasStreamingStep: boolean;
    runningTools: number;
  }
>();

function stepSignature(message: UiMessage): string {
  return JSON.stringify([message.id, message.role, message.attribution, message.streaming, message.blocks]);
}

export function buildSteps(message: UiMessage): {
  steps: StepEntry[];
  body: string;
  bodyFinished: boolean;
  stepsFinished: boolean;
  hasStreamingStep: boolean;
  runningTools: number;
} {
  const signature = stepSignature(message);
  const cached = stepCache.get(message);
  if (cached && cached.signature === signature) return cached;
  const result = computeSteps(message);
  stepCache.set(message, { signature, ...result });
  return result;
}

function computeSteps(message: UiMessage): {
  steps: StepEntry[];
  body: string;
  bodyFinished: boolean;
  stepsFinished: boolean;
  hasStreamingStep: boolean;
  runningTools: number;
} {
  const blocks = message.blocks ?? [];
  if (message.role === "custom") {
    const text = (message as UiMessage & { text?: string }).text;
    return {
      steps: hasVisibleText(text)
        ? [
            {
              key: `${message.id}-custom`,
              kind: "text",
              text,
              format: "pre",
              messageId: message.id,
              streaming: false,
            },
          ]
        : [],
      body: "",
      bodyFinished: !message.streaming,
      stepsFinished: true,
      hasStreamingStep: false,
      runningTools: 0,
    };
  }
  const steps: StepEntry[] = [];
  const seen = new Set<string>();
  let body = "";
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === "thinking") {
      const start = index;
      const parts: string[] = [];
      while (index < blocks.length) {
        const current = blocks[index];
        if (!current || current.type !== "thinking") break;
        if (hasVisibleText(current.text)) parts.push(current.text);
        index += 1;
      }
      index -= 1;
      if (parts.length) {
        steps.push({
          key: `${message.id}-think-${start}`,
          kind: "thinking",
          text: parts.join("\n"),
          format: "markdown",
          messageId: message.id,
          streaming: false,
        });
      }
      continue;
    }
    if (isToolBlock(block)) {
      const id = toolBlockId(block);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      steps.push({
        key: `tool-${id}`,
        kind: "tool",
        tool: mergeToolBlock(block, {}),
        format: "pre",
        messageId: message.id,
        streaming: false,
      });
      continue;
    }
    if (block.type === "text") {
      const start = index;
      const parts: string[] = [];
      while (index < blocks.length) {
        const current = blocks[index];
        if (!current || current.type !== "text") break;
        if (hasVisibleText(current.text)) parts.push(current.text);
        index += 1;
      }
      index -= 1;
      const text = parts.join("\n");
      if (!hasVisibleText(text)) continue;
      const forceSteps =
        message.role === "toolResult" ||
        message.role === "developer" ||
        (message.role === "user" && !isRealUser(message));
      const laterStep = blocks
        .slice(index + 1)
        .some((next) => next.type === "thinking" || isToolBlock(next));
      if (laterStep || forceSteps) {
        steps.push({
          key: `${message.id}-step-${start}`,
          kind:
            message.role === "user" && message.herdSkill !== true
              ? "input"
              : "text",
          text,
          format: forceSteps ? "pre" : "markdown",
          messageId: message.id,
          streaming: false,
        });
      } else {
        body = text;
      }
    }
  }
  if (message.streaming && body === "" && steps.length > 0) {
    steps[steps.length - 1].streaming = true;
  }
  return {
    steps,
    body,
    bodyFinished: !(message.streaming && (body !== "" || steps.length === 0)),
    stepsFinished: !steps.some((step) => step.streaming),
    hasStreamingStep: steps.some((step) => step.streaming),
    runningTools: steps.filter(
      (step) => step.kind === "tool" && step.tool.status === "running",
    ).length,
  };
}
