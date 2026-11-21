---
name: tdd-crowdsource
description: Write or delegate contract tests, then pin the latest dispatch plan before starting each ready implementation batch.
---

# TDD Crowdsource

For each ready group of implementation slices: **write their red contracts → pin the current dispatch plan → dispatch green**. Repeat as work becomes ready. Do not wait for unrelated red contracts or running green slices.

## Red: write the contract, do not run it

The lead can write the tests or delegate them. Give each red writer a slice, the consumer behavior to cover, and ownership of its test files. Before dispatching green for a slice, confirm its tests are on disk and cover the behavior that slice must deliver: results, relevant errors and boundaries, and any promised ordering. Test observable behavior. Isolate outside collaborators where needed.

**Do not run the tests in red.** The dispatch pin replaces the red test run. It records the written contract and authorizes green; it is not evidence that a test failed or passed.

## Pin and dispatch the ready green slices

As soon as a slice has a red contract and its real prerequisites are available, include it in the next dispatch. Red and green may run in parallel on different slices. Pin again before each new green batch using the latest state; an older pin does not authorize a new dispatch.

Pin the best available concurrency plan: the ready slices and their worker count, what is already running, what remains blocked and why, and the remaining critical path. For each dispatch, name the contract files and cases, read and write sets, acceptance criteria, wall time and tool budget, and whether the slice is a leaf or a subtree. Name the integrator and the owner of each shared file. Order overlapping writes or give them to one owner; do not create edges for convenience.

```text
pin({
  finding: "Red contracts on disk: <slice → test file and cases>; not run.",
  assumption: "Slices: <read set, write set, acceptance, leaf or subtree>; running: <slices>.",
  deduction: "Remaining dependencies: <blocked slices and reasons>; critical path: <chain and time>.",
  conclusion: "Dispatch now: <ready slices, worker count, time and tool budgets>; integrator and file owners: <names>."
})
```

In the next message, dispatch all green slices in that pin together with `scope_fork`. Give every worker the contract path, ownership, acceptance criteria, and verification assignment. When new work becomes ready, pin the updated plan and dispatch it without waiting for unrelated work. At every depth, a subtree lead follows the same sequence within its time limit and keeps the parent contract intact. Escalate a needed contract change before implementing it.

## Green: verify or hand verification to the parent

Run a focused check when it is useful and the required inputs are ready. If the check needs sibling changes, a shared environment, or an integration point, prefer to hand it to the parent rather than wait or duplicate their run. A child can return completed implementation without running tests: first pin **`暂不测试` (not tested yet)** with the check to run, the condition it needs, and the parent or integrator who will run it. The receiving lead can carry that check to the next integration point.

```text
pin({
  conclusion: "暂不测试 — <check or command>; run after <condition>; owner: <parent or integrator>."
})
```

Report only observed test results. A verification handoff is useful, not a failure; it does not turn an unrun check into a pass.

## Design record

Keep the design record as a skill under `.agent/skills/<name>/SKILL.md`. Record the boundaries, consumer contracts and test paths, dependency and ownership decisions, dispatch pins, and open verification work. Pin the record's path so the next lead can find it.
