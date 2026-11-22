# Phase 4b contracts — tool_call domain

Status: red, not run. Source is owned by the 4b implementation; this note is
the interface and the case list. The test file is
`tests/station/domain/tool-call.test.mjs`.

## API

`src/station/domain/tool-call.mjs` exports one pure function:

```js
decideToolCall({ state, processed, dispatch, call, policy, relay }) -> {
  verdict: "allow" | "block" | "readonly" | "wait",
  controls: { process: boolean, directAmend: { args: object } | null },
  todo: { free: true, persist: true, grant: false } | null,
  charge: { request: ChargeRequest, alreadyCharged: boolean } | null,
  persist: boolean,
  block: { reason: string } | null,
}
```

Inputs are plain snapshots, not the Station and not methods:

| Input | Shape |
|---|---|
| `state` | `{ autopilot, relay: { handoffPending }, charges }` |
| `processed` | `{ handled, hasCall }` for this `toolCallId` |
| `dispatch` | `{ found, groupKey, beatTools }` from the carrying message |
| `call` | `{ toolName, toolCallId, input }` |
| `policy` | `MAIN_AGENT`, `READ_ONLY_SUBAGENT`, or `READ_WRITE_SUBAGENT` |
| `relay` | `{ ownerId, handoffPending, owesLedger, timeLimitMs? }` |

`ChargeRequest` is the exact argument object the station gives
`chargeBranch(state, ledger, ...)`:

```js
{ ownerId, toolCallId, toolName, groupKey, beatTools, input }
```

The domain does not mutate `state`, `processed`, `dispatch`, `call`, `relay`,
or the charge request. The station commits `processed`/`dispatch`/charges and
persists; `charge` is an intent, not a mutation. A charge refusal is still the
station's: it calls `chargeBranch`, and on `{ ok: false }` returns
`{ block: true, reason }`. `tests/branch-charge.test.mjs` remains the
accounting contract.

## Case list

| Case | Expected |
|---|---|
| branch `read` | `verdict:"allow"`, `controls.process:true`, `charge.request` exact, `alreadyCharged:false`, `persist:true` |
| no carrying message | same, `groupKey:undefined`, `beatTools:[]` |
| already in `state.charges` | `allow`, `alreadyCharged:true`, `persist:true`; station may skip the charge |
| input purity | deep clone of the input equals the input after the call |
| `READ_ONLY_SUBAGENT` | `verdict:"readonly"`, `controls.process:false`, `charge:null`, `persist:false`; the host owns denial |
| `todo` under RW subagent | `allow`, `todo:{free:true,persist:true,grant:false}`, `charge:null`, `persist:true` |
| `pin`, `scope_fork`, `scope_join`, `scope_return` | `allow`, `charge:null`, `persist:false`, no directAmend |
| `amend` unhandled | `controls.process:true`, `directAmend:{args}`; `charge:null`, `persist:false` |
| `amend` handled | `directAmend:null`; no dispatch |
| `amend` JSON-string input | `directAmend.args` parsed |
| `steer` | not in `CONTROL_TOOLS`; normal charge request, `persist:true` |
| `ask` autopilot | `verdict:"block"`, reason non-empty, `charge:null`, `persist:false` |
| `ask` no autopilot | `allow`, `charge:null`, `persist:false` |
| `wait` | `verdict:"wait"`, `charge:null`, `persist:false` |
| `scope_join`/`scope_return` with `relay.timeLimitMs` | free; the decision never applies the deadline |
| root + `handoffPending` | `verdict:"block"`, reason contains `RELAY_HANDOFF_PENDING`, `controls.process:false`, `charge:null` |
| child + `handoffPending` | `allow`; child tools are not blocked by the root relay |

## Decisions and boundaries

1. **Read-only is a bypass, not a station denial.** The current
   `onToolCall` returns before `processControlsForTool` for a read-only
   subagent; the host's policy owns the actual denial. The contract names the
   verdict `"readonly"` so the station can preserve that order.
2. **`todo` is free but not granted here.** The grant stays in
   `ensureTools`/`syncTodo`; the gate only returns `todo` metadata and persists.
   `grant:false` is explicit so a caller cannot mistake the gate for the
   grant.
3. **`steer` is not a control tool.** `CONTROL_TOOLS` is
   `scope_fork|scope_join|scope_return|amend|pin`; `steer` is a normal charged
   tool. The test pins this boundary.
4. **`charge` is an intent.** The domain returns the request and
   `alreadyCharged`; the station executes `chargeBranch` and converts a
   refusal. Do not call `chargeBranch` inside the domain: it mutates
   `state.charges` and the fork ledger.
5. **The join/return deadline is not the gate's decision.** They are free
   control tools. `admitToolDispatch` remains responsible for the
   `scope_join`/`scope_return` time-limit exception; the existing
   `tests/fork-tool-deadline.test.mjs` pins it.
6. **Double entry remains an integration concern.** `activation/hooks.mjs`
   binds the host `tool_call` event to `station.onToolCall`, and
   `host/tool-dispatch.mjs` calls `station.admitToolDispatch`, which also calls
   `onToolCall`. Phase 4b must either make `admitToolDispatch` the only entry or
   dedupe by `toolCallId`. The `processed.handled` cases above are the
   contract; the integration test should add a duplicate-entry case if the
   second path remains.
7. **Order.** `controls.process` is true for every path after the read-only
   and relay blocks, matching the current `processControlsForTool` call before
   the todo/control/ask/wait/charge branches. `charge` is only present for
   normal tools; `todo`, control tools, `ask`, and `wait` are free.
8. **Persist.** Normal tools and `todo` persist; control tools persist inside
   their own execution; blocked/read-only/ask/wait paths do not. A normal
   already-charged call still persists (the current no-op write) to avoid a
   behavior change; the station may later drop it.

## Existing tests the implementation must update

The intent named `tests/tool-gate.test.mjs` and
`tests/control-tools.test.mjs`; neither file exists in this tree. The real
equivalents are:

- `tests/tool-dispatch-routing.test.mjs` — host dispatch routing, not the
  station decision.
- `tests/fork-todo-gate.test.mjs` — `onToolCall` todo/handoff behavior.
- `tests/child-relay-isolation.test.mjs` — root vs child handoff gate.
- `tests/fork-budget-birth.test.mjs` — `onToolCall` accounting on a new fork.
- `tests/fork-tool-deadline.test.mjs` — `admitToolDispatch` and the clock.
- `tests/branch-charge.test.mjs` — `chargeBranch` root/no-branch/exhausted and
  idempotence.
- `tests/pin-tool.test.mjs` — pin routing/port refusal.
- `tests/todo-any-level.test.mjs` — todo availability at every level.

The implementation must keep these green and adapt only the call sites that
move to `decideToolCall`. The new test file should not be edited to fit the
implementation; if a case is wrong, record the correction here first.

## Ownership

- 4b worker: `src/station/domain/tool-call.mjs`, `src/station/gates.mjs`
  (`onToolCall`), and the tool tests above.
- Station integrator: `src/station/station.mjs` (snapshot construction and
  `admitToolDispatch` dedupe), submitted as exact snippets. Do not let two
  workers edit `station.mjs`.

Acceptance: the new test file passes, the listed existing tests pass, and
`onToolCall` contains no inline policy/relay/todo/charge branching beyond
snapshot construction, one `decideToolCall` call, commit, and return.

## Implementation notes (4b)

- `src/station/domain/tool-call.mjs` decides only; it imports
  `CONTROL_TOOLS`/`parseArgs` from `station/messages.mjs`, the relay
  blocked-reason text, and the errors doc. No Station or host import, no
  mutation.
- `onToolCall` caches its verdict per `toolCallId` in `station.toolGate`
  (bounded 512). The host `tool_call` event and `admitToolDispatch` share one
  decision; `admitToolDispatch` reconstructs the call arguments from the
  carrying message when it is the first entry.
- `processControlsForTool` runs after the decision and before `directAmend`;
  the amend commit re-checks `processed.hasHandled` because the scan may have
  handled it first.
- Focused verification so far: new test 18/18; named existing tests 70/70;
  hooks/model-facing/prompts/forkjoin/join/start-admission/blocked/dispatch
  86/86; todo 22/22. The full suite belongs to the integrator.
