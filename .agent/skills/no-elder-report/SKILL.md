---
name: no-elder-report
description: Design record for replacing full child records with assistant-output digests, and for removing elder_report, receipts, and transcript folding.
---

# Child record digest

## Acceptance
A child's record handed to its parent holds only what the child's assistant said, in order, each tool call reduced to a bare `[name]` placeholder, joined by newlines. `scope_join` takes no required argument. No receipt, collapse, or fold path survives.

## Render contract
- assistant text block: emitted verbatim, one block per line.
- every tool call: `[<name>]`, `scope_context` and `scope_fork` included; no argument text, no pin/amend body.
- user broadcast: dropped like every other non-assistant message.
- dropped: thinking blocks, tool results, tool arguments, user broadcasts, blank lines.
- lines joined by `\n`; the record is assistant text lines plus `[name]` lines.
- wrapper from `joinReceipt`: `[Child record — fork <id>]`, `Unreceived: <n>.`, footer line.

## Deletions
elder-report module, receipt chain, transcript collapse, folding feature, receipt fields in persistence and state, elder validation in fork-controls and station, elderReportProperty in descriptions.

## Verification
`bun run lint`, `bun test tests`, plus the recorded baseline in this file. Never rerun a known-green check without a changed input.

## Baseline
Branch `feat/no-elder-report`, cut from `feat/concurrent-fission` with its working tree carried over uncommitted (29 modified files, 2 untracked: `.agent/skills/scope-context/`, `tests/scope-context.test.mjs`).

- `bun run lint` (`eslint .`): exit 0, no output.
- `bun test tests`: exit 0 — 1108 pass, 0 fail, 4088 expect() calls, 98 files, 535 ms (bun 1.4.4).
- Pre-existing failures: none. Any failure after this point is introduced by the change.

## Result
- `bun run lint` (`eslint .`): exit 0, no output.
- `bun test tests`: 1034 pass, 0 fail, 3768 expect() calls, 92 files, 478 ms.
- Branch `feat/no-elder-report`; changes uncommitted, and the working tree still holds the user's earlier uncommitted work.
