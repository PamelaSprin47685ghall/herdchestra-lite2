## persistent-rules

<skill version="1.0">Persistent operating rules

Read `skill://constitution` before work; it is the standing stance. Load `skill://prompt-craft` before changing model-facing text; load `skill://skill-authoring` before creating or splitting a skill; load `skill://polish` before polishing an existing text.

### Choose a workflow

Choose by task nature. A refactor counts as development: for a feature, refactor, or design change, in principle submit a ledger. For operations, maintenance, diagnostics, or delivery, in principle do not submit one. Judge by the work and let that judgment override the default.

Six skills ship with this plugin (constitution, decision-framing, polish, prompt-craft, skill-authoring, tdd-crowdsource). Load `skill://decision-framing` when the intended outcome or limits are unclear. The skills guide the work; the runtime enforces no order or stage flags.

Read `skill://tdd-crowdsource` before writing any code or test, including a one-line fix. For each ready batch, write or delegate its contract tests, pin the current dispatch plan instead of running Red, then fork the ready Green slices without waiting for unrelated contracts. Report only checks that ran; a child may pin deferred checks for its parent.

For work larger than one context, leave reviewable artifacts so the next branch can continue. Write stage artifacts as `.agent/skills/<name>/SKILL.md` with YAML `name` and `description`, not under `docs/`. Put long detail in sibling files linked from the entry.

### Run branches

- Root plans, forks, joins, and replies. Ordinary tools run in child scopes. Root can use the free control tools (`scope_fork`, `scope_join`, `amend`, `pin`, `todo`, `ask`, `wait`), read `skill://` paths, and resolve staged `ast_edit` previews. `scope_return` is child-only: it submits a branch's own record.
- Fork independent work as soon as its inputs exist. Give every child a self-contained intent, owned files, and acceptance evidence. Put parent context needed by a child in an earlier message: the child receives the prefix at fork time. When batching with other calls, place `scope_join` and `scope_return` last.
- A child reports its completed work and evidence with `scope_return`, never a final user-facing answer. `scope_join` receives one result; it is history, not a new instruction. A later join can fold the previous receipt with `elder_report`, replacing its work text but retaining structural calls, pins, and adoption notes.
- Each fork defines independent tool and time budgets. One assistant message costs at most one tool unit, divided by call count; exhausting one tool does not block the other calls. `amend` cannot cross or retract the latest scope operation.
- A fork's `time` is in seconds. Ordinary tools get the remaining time plus 1s, or 1s in overtime. Use shorter tool timeouts where appropriate. The clock pauses while `scope_join` or `scope_return` waits. Budget for the work and return when it is done.

### Language

- 强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。
</skill>

## manual-rules

<skill version="1.0">
### Close the work

- Autopilot is off by default. The user toggles it with `/herd-autopilot`. While it is off, `ask` is available, a natural stop may wait for the user, and the relay's ledger and handoff rules do not run. Use `wait` only while a branch is working.
</skill>

## autopilot-rules

<skill version="1.0">
### Close the work

- Only the user toggles autopilot with `/herd-autopilot`. While it is on, `ask` is blocked and a natural stop is a ledger submission, not a pause for the user.
- Any successful `todo` write, including an empty list, turns on the full flow. `todo view` is read-only. Child ledger writes do not evaluate the relay.
- A non-empty root ledger forbids a final reply. Join all outstanding child results before finishing; an empty evaluation with results outstanding is held and does not advance the relay.
- A successor may reply if it inherited an empty ledger and its first evaluation is also empty. This ends the full flow. Other empty evaluations arm a handoff unless the holder already has permission to reply. Without a ledger, a root stop can itself count as the empty evaluation. Follow the current relay receipt; reports and final answers belong in the message body.
</skill>

## child-rules

<skill version="1.0">
### Child duties

Fork child duty: complete the assigned slice, then return with `scope_return`. Do not evaluate a ledger, arm a handoff, or write the relay report.
</skill>
