// The synchronous aggregate root. Every mutation computes the next value,
// commits it, and only then calls the injected ticket capability at the tail.
// A ticket's synchronous prefix therefore sees the committed snapshot, never a
// half-updated one. No async, no await, no in-flight ledger.

import {
  createInteractionLedger,
  openInteraction,
  resolveInteraction,
  closeInteraction,
  listOpenInteractions,
} from "./domain/interaction-race.mjs";
import { applyAgentEvent, messageOrdinalOfId } from "./domain/transcript-model.mjs";
import { createHistoryWindow } from "./domain/history-window.mjs";
import { stripAnsi } from "./domain/tool-artistry.mjs";
import { collectArtifacts } from "./domain/artifact-hydration.mjs";
import { capMessage } from "./domain/snapshot-fit.mjs";
import {
  MAX_HISTORY_LIMIT,
  normalizeHistoryLimit,
  planHistoryPage,
  TURN_ALIGN_LIMIT,
} from "./domain/history-page.mjs";
import { arbitrateDraft } from "./domain/draft-arbiter.mjs";
import { normalizeMetaPatch } from "./domain/meta-normalize.mjs";
import { applyTspOpsToDocument, createEmptyDocument } from "./domain/surface-fence.mjs";
import { parseClientCommand } from "./domain/protocol-codec.mjs";
import { projectSnapshot } from "./domain/snapshot-doc.mjs";

// The timer that coalesces deltas belongs to the ticket side, not the Station.
// Imported and re-exported here because callers import it from this module.
import { createDeltaMerger } from "../host/tickets/delta-merger.mjs";

export { createDeltaMerger };

function wireDelta(event, next) {
  const update = event.assistantMessageEvent;
  if (event.type === "message_start") {
    return { type: "transcript.delta", payload: { kind: "message_start", message: next.streaming } };
  }
  if (event.type === "message_update" && update) {
    if (update.type === "text_delta" || update.type === "thinking_delta") {
      return {
        type: "transcript.delta",
        payload: {
          kind: update.type,
          messageId: next.streaming?.id ?? event.message?.id,
          blockIndex: next.blockIndex ?? 0,
          delta: update.delta ?? "",
        },
      };
    }
    if (update.type === "toolcall_start" || update.type === "toolcall_delta" || update.type === "toolcall_end") {
      const block = update.type === "toolcall_end"
        ? next.streaming?.blocks?.find((item) => item.type === "toolCall" && item.id === update.toolCallId)
        : null;
      return {
        type: "transcript.delta",
        payload: {
          kind: update.type,
          messageId: next.streaming?.id ?? event.message?.id,
          toolCallId: update.toolCallId,
          toolName: update.toolName,
          argsText: update.argumentsDelta ?? "",
          args: block?.args,
          delta: update.argumentsDelta ?? "",
        },
      };
    }
  }
  if (event.type === "message_end") {
    return { type: "transcript.delta", payload: { kind: "message_end", messageId: next.streaming?.id ?? event.message?.id } };
  }
  if (event.type.startsWith("tool_execution_")) {
    return {
      type: "transcript.delta",
      payload: {
        kind:
          event.type === "tool_execution_start"
            ? "tool_start"
            : event.type === "tool_execution_update"
              ? "tool_update"
              : "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
        result: event.result,
        isError: Boolean(event.isError),
      },
    };
  }
  return null;
}

/**
 * Interpret a ticket result into broadcast decisions. The station owns this
 * rule set; wiring only carries the outcomes out. It stays a pure function so
 * the bridge can run without a station (tests) and the station can reuse it.
 */
export function ticketResultOutcomes(event, result) {
  const outcomes = [];
  const { clientId, requestId } = event?.payload ?? {};
  if (result?.ok !== false && result?.reported) {
    outcomes.push({ kind: "meta", patch: result.reported });
  }
  if (clientId && requestId) {
    outcomes.push({ kind: "receipt", clientId, requestId, ok: result?.ok !== false, code: result?.code });
  }
  if (result?.ok === false) {
    outcomes.push({ kind: "toast", level: "error", message: `${event.type}: ${result.code ?? "failed"}` });
  }
  return { outcomes };
}

const STOP_AFTER_HANDLER = Symbol("stop-after-handler");

// A client command names a synchronous domain transition. The factory receives
// exactly those transitions and the transport dispatch, never the station, so a
// handler cannot reach an onXxx entrypoint even by accident.
export function createClientCommandHandlers(transitions, dispatch) {
  return {
    "composer.draft": ({ clientId, payload }) => {
      transitions.applyDraft({ source: "web", ...payload, clientId });
    },
    "manager.history": ({ clientId, payload }) => {
      const page = transitions.historyPage({ before: payload.before, limit: payload.limit });
      dispatch({
        type: "sendClientFrame",
        payload: {
          clientId,
          frame: { type: "history.page", requestId: payload.requestId, ...page },
        },
      });
      return STOP_AFTER_HANDLER;
    },
    "composer.submit": ({ clientId, payload }) => {
      transitions.submitComposer({ ...payload, clientId });
    },
    "session.abort": ({ clientId, payload }) => {
      transitions.abort({ ...payload, clientId });
    },
    "session.set_model": ({ clientId, payload }) => {
      transitions.setModel({ ...payload, clientId });
    },
    "session.set_thinking": ({ clientId, payload }) => {
      transitions.setThinking({ ...payload, clientId });
    },
    "session.set_mode": ({ clientId, payload }) => {
      transitions.setMode({ ...payload, clientId });
    },
    "interaction.respond": ({ payload }) => {
      transitions.resolveInteraction(payload.requestId, "web", payload);
    },
    "surface.event": ({ payload }) => {
      transitions.applySurfaceEvent(payload);
    },
    "surface.keys": ({ payload }) => {
      transitions.applySurfaceKeys(payload);
    },
  };
}

export function createUiBridgeStation(options) {
  const capabilities = options?.capabilities ?? {};
  const ledger = createInteractionLedger();

  const state = {
    seq: 0,
    session: { id: null, file: null, title: null, cwd: options?.cwd ?? null },
    // The host already holds the whole branch; this station does not need a
    // second full copy of every message body. `messages` is a bounded window of
    // the tail — enough for a frame plus the turn-alignment back-scan — and
    // `history` remembers where that window sits in the branch so any older
    // page can be rebuilt on demand. `history.entries` is the host's own array,
    // kept by reference: nothing is copied until a message is displayed.
    messages: [],
    history: { entries: null, index: null, base: 0 },
    artifacts: [],
    todos: [],
    usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { total: 0 }, context: null },
    meta: { model: null, thinkingLevel: null, modes: null, busy: false, title: null, setStatus: null, setWorkingMessage: null, fence: null },
    draft: { rev: 0, origin: "tui", text: "", cursor: { line: 0, col: 0 }, images: [], texts: [], composer: {} },
    // Cross-origin draft trail. A remote write echoed back by the editor is
    // indistinguishable from typing once it reaches this layer; an A->B->A
    // alternation is the one shape real editing does not produce.
    draftTrail: [],
    // Latest autocomplete projection from the TUI editor. The TUI owns the
    // slash state machine; this is a mirror, never a second engine.
    completion: { open: false, prefix: "", items: [], selectedIndex: -1, enterAccepts: false },
    completionSig: "",
    streaming: null,
    toolExecutions: {},
    widgets: {},
    surface: createEmptyDocument(),
    toasts: [],
    models: [],
    sessions: [],
    queue: { steering: [], followUp: [] },
    fenceStatus: null,
  };

  function dispatch(event) {
    if (typeof capabilities.dispatch === "function") capabilities.dispatch(event);
  }

  // One merger per station. The dispatch closure is stable, so the old
  // module-level WeakMap added a lookup and left shutdown with nothing to
  // enumerate. The station owns the merger and can flush it directly.
  const deltaMerger = createDeltaMerger(dispatch, options?.schedule);

  function pendingInteractions() {
    return listOpenInteractions(ledger).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      payload: entry.payload,
    }));
  }

  // The window itself lives in the domain kernel: the rebase rule, the stitch
  // rule and the trim floor are one file's worth of invariants over the state
  // bag's `history` and `messages`.
  const history = createHistoryWindow(state);

  function currentHistoryIndex() {
    return history.currentIndex();
  }

  function historyTotal() {
    return history.total();
  }

  /**
   * The messages for ordinals `[from, to)`.
   *
   * Inside the held window this is a slice. Outside it, the range is rebuilt
   * from the branch, so an old page costs a tour of that page, not of the
   * session. A strip that crosses the window's head is stitched: the branch
   * answers what it has, and the window answers the live tail the branch has not
   * caught up with.
   */
  function messagesInRange(from, to) {
    return history.range(from, to);
  }

  function resetHistory(entries) {
    history.reset(entries);
  }

  function trimHistoryWindow() {
    history.trim();
  }

  // Interaction commits, one per transition. `openInteraction` and
  // `resolveInteraction` both dispatch, so an entrypoint that commits calls
  // these and never another entrypoint: a chain would send the frame twice.
  function commitOpenInteraction(request) {
    const result = openInteraction(ledger, request);
    if (!result.ok) return result;
    dispatch({ type: "interaction.open", payload: request });
    return result;
  }

  function commitResolveInteraction(id, source, value) {
    const result = resolveInteraction(ledger, id, source, value);
    if (!result.accepted) return result;
    dispatch({ type: "interaction.close", payload: { requestId: id, resolvedBy: source } });
    return result;
  }

  function snapshot(limit) {
    return projectSnapshot({
      state,
      total: historyTotal(),
      range: messagesInRange,
      interactions: pendingInteractions(),
      limit,
    });
  }

  // One session-switch transition shared by every entrypoint. Entrypoints must
  // not call each other; they all call this private synchronous transition.
  function switchSession(ctx) {
    const manager = ctx?.sessionManager;
    state.session = {
      id: manager?.getSessionId?.() ?? null,
      file: manager?.getSessionFile?.() ?? null,
      title: manager?.getSessionName?.() ?? null,
      cwd: ctx?.cwd ?? state.session.cwd,
    };
    // The branch is the source of truth and the host already holds it, so it is
    // adopted by reference. Only its tail becomes messages; the rest is rebuilt
    // when a page asks for it.
    resetHistory(manager?.getBranch?.() ?? []);
    state.artifacts = [];
    state.streaming = null;
    state.toolExecutions = {};
    state.queue = { steering: [], followUp: [] };
    dispatch({ type: "session.switched", seq: state.seq ?? 0, payload: { snapshot: snapshot() } });
    return { ok: true };
  }

  // Private synchronous transitions. An entrypoint must never call another
  // entrypoint: every one of them dispatches, so a chain sends the same frame
  // twice. The paths that commit meta or a draft call these instead.
  function commitMeta(patch) {
    const next = normalizeMetaPatch(patch);
    state.meta = { ...state.meta, ...next };
    dispatch({ type: "meta.update", payload: next });
    return { ok: true };
  }

  function commitDraft(input) {
    const text = String(input?.text ?? "");
    const origin = input?.source === "web" ? "web" : "tui";
    const clientId = input?.clientId;
    const requestId = input?.requestId;
    // Pure arbitration: the module decides, the Station commits.
    const decision = arbitrateDraft(
      { rev: state.draft.rev, text: state.draft.text, trail: state.draftTrail },
      { text, origin },
    );
    if (decision.kind === "noop") {
      if (origin === "web" && clientId && requestId) {
        dispatch({
          type: "sendClientFrame",
          payload: { clientId, frame: { type: "command.result", requestId, ok: true } },
        });
      }
      return { rev: state.draft.rev };
    }
    state.draftTrail = decision.trail;
    if (decision.kind === "echo") return { rev: state.draft.rev };
    const rev = decision.rev;
    state.draft = {
      ...state.draft,
      rev,
      origin,
      text,
      cursor: input?.cursor ?? state.draft.cursor,
      images: input?.images ?? state.draft.images,
      texts: input?.texts ?? state.draft.texts,
      composer: input?.composer ?? state.draft.composer,
    };
    dispatch({
      type: origin === "tui" ? "draft.sync" : "syncEditorDraft",
      payload: { rev, origin, text, cursor: state.draft.cursor, clientId, requestId },
    });
    return { rev };
  }

  const station = {
    snapshot,

    historyPage(input) {
      // The limit is answered before the cursor. An impossible page request is
      // impossible whether or not the cursor exists, and calling it
      // `stale_cursor` would send the client after a page it never asked for.
      if (normalizeHistoryLimit(input?.limit) === null) {
        return { ok: false, code: "invalid_limit" };
      }
      const index = currentHistoryIndex();
      if (!index) {
        const plan = planHistoryPage({
          messages: state.messages,
          before: input?.before,
          limit: input?.limit,
        });
        if (!plan.ok) return plan;
        return {
          ok: true,
          messages: plan.messages.map(capMessage),
          history: plan.history,
        };
      }
      // A cursor names a message. `idIndex` also holds entries that project to
      // no message, so an id can be known there and still resolve to nothing —
      // `messageOrdinalOfId` answers exactly what `findIndex` answered, which is
      // what makes an unknown cursor stale.
      const cursor = String(input?.before ?? "");
      let ordinal = messageOrdinalOfId(index, cursor);
      if (ordinal < 0) {
        // A cursor can name a message the branch has not caught up with yet: a
        // live message exists only in the window. It still has an ordinal — it
        // sits past the branch, at its own position in the window — so paging
        // from it is the same question as paging from any other message and
        // takes the same path below.
        //
        // Planning inside the window instead would cut the page short: a reader
        // at the start of a live run has fewer held messages before it than a
        // page holds, while the branch still has all of them. The page would
        // come back undersized and `hasMore` would describe history it never
        // looked at.
        const local = state.messages.findIndex((message) => message.id === cursor);
        if (local < 0) return { ok: false, code: "stale_cursor" };
        ordinal = state.history.base + local;
      }
      const floor = Math.max(0, ordinal - MAX_HISTORY_LIMIT - TURN_ALIGN_LIMIT);
      // The strip must include the cursor itself: the planner resolves `before`
      // against the messages it is given, and a strip that stops one short of it
      // would report a cursor that certainly exists as stale.
      const window = messagesInRange(floor, ordinal + 1);
      const plan = planHistoryPage({
        messages: window,
        before: input?.before,
        limit: input?.limit,
        origin: floor,
      });
      if (!plan.ok) return plan;
      return {
        ok: true,
        messages: plan.messages.map(capMessage),
        history: plan.history,
      };
    },

    pendingInteractionKind(id) {
      return listOpenInteractions(ledger).find((entry) => entry.id === id)?.kind;
    },

    openInteraction(request) {
      return commitOpenInteraction(request);
    },

    resolveInteraction(id, source, value) {
      return commitResolveInteraction(id, source, value);
    },

    closeInteraction(id) {
      const closed = closeInteraction(ledger, id);
      if (closed) dispatch({ type: "interaction.close", payload: { requestId: id, resolvedBy: "abort" } });
      return { ok: closed };
    },

    onTuiCompletionChanged(input) {
      const items = Array.isArray(input?.items)
        ? input.items.slice(0, 50).map((item) => ({
            value: String(item?.value ?? ""),
            label: String(item?.label ?? item?.value ?? ""),
            description: typeof item?.description === "string" ? item.description : undefined,
            hint: typeof item?.hint === "string" ? item.hint : undefined,
            disabled: item?.disabled === true,
          }))
        : [];
      const completion = {
        open: input?.open === true,
        prefix: String(input?.prefix ?? ""),
        items,
        selectedIndex: Number.isInteger(input?.selectedIndex) ? input.selectedIndex : -1,
        enterAccepts: input?.enterAccepts === true,
      };
      const sig = JSON.stringify(completion);
      if (sig === state.completionSig) return { open: completion.open };
      state.completionSig = sig;
      state.completion = completion;
      dispatch({ type: "completion.state", payload: completion });
      return { open: completion.open };
    },

    applyDraft(input) {
      return commitDraft(input);
    },

    submitComposer(input) {
      const payload = { text: String(input?.text ?? ""), mode: input?.mode ?? "default", attachments: input?.attachments ?? [], requestId: input?.requestId, clientId: input?.clientId };
      dispatch({ type: "submitComposer", payload });
      return { ok: true };
    },

    abort(input) {
      dispatch({ type: "abort", payload: { clientId: input?.clientId, requestId: input?.requestId } });
      return { ok: true };
    },

    setModel(input) {
      const payload = { provider: input?.provider, modelId: input?.modelId, clientId: input?.clientId, requestId: input?.requestId };
      dispatch({ type: "setModel", payload });
      return { ok: true };
    },

    setThinking(input) {
      const payload = { level: input?.level, clientId: input?.clientId, requestId: input?.requestId };
      dispatch({ type: "setThinking", payload });
      return { ok: true };
    },

    setMode(input) {
      const payload = {
        mode: input?.mode,
        action: input?.action,
        objective: input?.objective,
        tokenBudget: input?.tokenBudget,
        prompt: input?.prompt,
        clientId: input?.clientId,
        requestId: input?.requestId,
      };
      dispatch({ type: "setMode", payload });
      return { ok: true };
    },

    applySurfaceEvent(event) {
      dispatch({ type: "surfaceEvent", payload: event });
      return { ok: true };
    },

    applySurfaceKeys(input) {
      dispatch({ type: "surfaceKeys", payload: { data: String(input?.data ?? "") } });
      return { ok: true };
    },

    onSessionHydrate(session, entries) {
      state.session = { ...state.session, ...session };
      resetHistory(entries ?? []);
      // Artifacts describe the whole branch, not the window: a file written an
      // hour ago must still be listed. The branch is therefore read in chunks,
      // and each chunk is released before the next one is built. Projecting the
      // whole transcript here would hold every message body at once — for a long
      // session that is the largest allocation the station ever makes — to
      // answer a question about file paths.
      // Only a message that carries a tool call can contribute, so only those
      // are projected. The list is built from `block.type === "toolCall"`
      // blocks, and a message's blocks come from its `content` array (through
      // `blocksOf`, whose only tool-call branch is that exact type) or, for the
      // three execution roles below, from somewhere else entirely. Projecting
      // every message to find six file paths spent two thirds of hydration on a
      // whole-transcript tour; projecting the ones that can answer costs the
      // tool calls, which is what the answer is made of.
      const list = entries ?? [];
      const index = state.history.index;
      // Whole-branch projection lives in the domain kernel: only candidates are
      // read, and contiguous runs of them share one pairing-map allocation.
      state.artifacts = collectArtifacts({ entries: list, index });
      dispatch({ type: "snapshot", seq: state.seq ?? 0, payload: snapshot() });
      return { ok: true };
    },

    onSessionSwitch(ctx) {
      return switchSession(ctx);
    },

    onSessionClear(ctx) {
      return switchSession(ctx);
    },

    onSessionBranch(ctx) {
      return switchSession(ctx);
    },

    onAgentEvent(event) {
      const next = applyAgentEvent(
        {
          messages: state.messages,
          streaming: state.streaming,
          toolExecutions: state.toolExecutions,
        },
        event,
      );
      state.messages = next.messages;
      state.streaming = next.streaming;
      state.toolExecutions = next.toolExecutions;
      if (Object.keys(state.toolExecutions).length > 256) {
        state.toolExecutions = Object.fromEntries(Object.entries(state.toolExecutions).slice(-256));
      }
      // A live append can push the window past its bound. Dropping from the head
      // keeps the cost of a frame bounded by the window, not by the conversation;
      // the dropped messages stay reachable through the branch.
      trimHistoryWindow();
      state.meta = { ...state.meta, busy: event?.type !== "agent_end" };
      const delta = wireDelta(event, next);
      if (delta) {
        state.seq = (state.seq ?? 0) + 1;
        delta.seq = state.seq;
        deltaMerger.push(delta);
      }
      if (event?.type === "message_end" || event?.type === "agent_end") {
        deltaMerger.flush();
        dispatch({ type: "snapshot", seq: state.seq ?? 0, payload: snapshot() });
      }
      return { ok: true };
    },

    flushDeltas() {
      deltaMerger.flush();
    },

    onTodoUpdate(phases) {
      state.todos = Array.isArray(phases) ? phases : [];
      dispatch({ type: "todo.update", payload: { phases: state.todos } });
      return { ok: true };
    },

    onUsageUpdate(usage) {
      state.usage = { ...state.usage, ...(usage ?? {}) };
      dispatch({ type: "usage.update", payload: state.usage });
      return { ok: true };
    },

    onMetaUpdate(patch) {
      return commitMeta(patch);
    },

    onModelsUpdate(models) {
      state.models = Array.isArray(models) ? models : [];
      dispatch({ type: "meta.update", payload: { models: state.models } });
      return { ok: true };
    },

    onSessionsUpdate(sessions) {
      state.sessions = Array.isArray(sessions) ? sessions : [];
      dispatch({ type: "meta.update", payload: { sessions: state.sessions } });
      return { ok: true };
    },

    onQueueUpdate(queue) {
      state.queue = {
        steering: Array.isArray(queue?.steering) ? queue.steering : [],
        followUp: Array.isArray(queue?.followUp) ? queue.followUp : [],
      };
      dispatch({ type: "meta.update", payload: { queue: state.queue } });
      return { ok: true };
    },

    onWidgetUpdate(key, lines) {
      if (lines === null || lines === undefined) delete state.widgets[key];
      else state.widgets[key] = (Array.isArray(lines) ? lines : [String(lines)]).map((line) => stripAnsi(String(line)));
      dispatch({ type: "widget.update", payload: { key, lines: state.widgets[key] ?? null } });
      return { ok: true };
    },

    onNotify(message, level) {
      const toast = { level: level ?? "info", message: String(message ?? "") };
      state.toasts = [...state.toasts.slice(-19), toast];
      dispatch({ type: "toast", payload: toast });
      return { ok: true };
    },

    onSurfaceFrame(frame) {
      state.surface = applyTspOpsToDocument(state.surface, frame?.ops ?? []);
      dispatch({ type: "surface.frame", payload: frame });
      return { ok: true };
    },

    onClientConnected(clientId) {
      dispatch({ type: "client.connected", payload: { clientId } });
      return { ok: true };
    },

    onClientDisconnected(clientId) {
      dispatch({ type: "client.disconnected", payload: { clientId } });
      return { ok: true };
    },

    onClientCommand(clientId, raw) {
      const parsed = parseClientCommand(raw);
      if (!parsed.ok) {
        const command = raw && typeof raw === "object" ? raw : null;
        const requestId = command?.requestId ?? command?.payload?.requestId;
        if (typeof requestId === "string" && requestId) {
          dispatch({ type: "sendClientFrame", payload: { clientId, frame: { type: "command.result", requestId, ok: false, code: parsed.code } } });
        } else {
          dispatch({ type: "client.error", payload: { clientId, ...parsed } });
        }
        return parsed;
      }
      const { type, payload } = parsed;
      const handler = clientCommandHandlers[type];
      if (handler) {
        const outcome = handler({ clientId, payload: payload ?? {} });
        if (outcome === STOP_AFTER_HANDLER) return;
      }
      return { ok: true, type };
    },

    reconcileTicketResult(event, result) {
      const { outcomes } = ticketResultOutcomes(event, result);
      const rest = [];
      for (const outcome of outcomes) {
        // A meta patch is a state commit, and the commit broadcasts its own
        // frame: the wiring must not send it a second time.
        if (outcome.kind === "meta") commitMeta(outcome.patch);
        else rest.push(outcome);
      }
      return { outcomes: rest };
    },

    onTuiDraftChanged(draft) {
      return commitDraft({ source: "tui", ...draft });
    },

    onPlanReviewRequested(review) {
      return commitOpenInteraction({
        id: review?.reviewId ?? review?.id,
        kind: "plan_review",
        payload: review,
      });
    },

    onPlanReviewResolved(review) {
      return commitResolveInteraction(review?.reviewId ?? review?.id, "tui", review);
    },
  };

  const clientCommandHandlers = createClientCommandHandlers(
    {
      applyDraft: station.applyDraft,
      historyPage: station.historyPage,
      submitComposer: station.submitComposer,
      abort: station.abort,
      setModel: station.setModel,
      setThinking: station.setThinking,
      setMode: station.setMode,
      resolveInteraction: station.resolveInteraction,
      applySurfaceEvent: station.applySurfaceEvent,
      applySurfaceKeys: station.applySurfaceKeys,
    },
    dispatch,
  );

  return station;
}

