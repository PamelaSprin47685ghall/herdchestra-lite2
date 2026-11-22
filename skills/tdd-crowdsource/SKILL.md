---
name: tdd-crowdsource
description: Pin the user-side acceptance goal, write red contracts, then dispatch green slices with explicit verification ownership.
---

# TDD Crowdsource

The standing constitution applies; this skill adds only the development and acceptance method.

Tests are a means, not a ritual. The goal is a change a successor can take over: automated where it pays, manual where it does not. One acceptance goal before Red; one dispatch pin before Green; verification goes to the level with context and authority. Repeat as work becomes ready; unrelated red contracts or running Green slices do not gate the next dispatch.

Use skill://decision-framing when the goal itself is unclear. This skill assumes the goal exists and turns it into contracts, dispatch, and acceptance.

## Before Red

Write the goal from the user's side: who acts, what becomes true, what they see, what stays out. Ignore implementation feasibility for now. No scores, thresholds, rubrics, coverage targets, or quality points; those are proxies, not the goal. A test that cannot fail for a user-visible reason is coverage, not acceptance.

Pin it only when it changes the bet (`scope_context({ pin })`). If the work has no user-visible acceptance, skip the pin; do not manufacture ceremony.

When a manual step cannot be automated, create or extend the project's `.agent/skills/manual-acceptance/SKILL.md` entry, with surface-specific siblings such as `cli.md`, `tui.md`, and `relay.md`. One entry plus siblings is the single source of truth; do not copy the procedure into every task. Pin only the run-specific difference: environment, values, owner, what to observe, and what would make you adjust. The skill is a control loop, not a diary.

The acceptance goal is the source; tests derive from it. If a test cannot be derived, question the goal before writing the test.

## Red and dispatch

The lead writes the tests or delegates them. Give each red writer a slice, the consumer behavior to cover, and ownership of its test files. Cover results, relevant errors, boundaries, and any promised ordering. Before Green, confirm the tests are on disk and cover the behavior the slice must deliver. Test observable behavior; isolate outside collaborators where needed.

Do not run Red. The dispatch pin records the written contract and authorizes Green; a red run spends a turn to prove what the test already states, and proves nothing about the implementation. A red test you run to watch it fail buys nothing the written contract did not already buy.

As soon as a slice has a red contract and its real prerequisites, include it in the next dispatch. Red and Green may run in parallel on different slices. Pin again before each new Green batch; an older pin does not authorize a new one.

Pin the concurrency plan: ready slices, worker count, what is running, what is blocked and why, and the critical path. For each slice, name the contract files and cases, read and write sets, acceptance goal, wall time, tool budget, and whether it is a leaf or a subtree. Name the integrator and the owner of each shared file. Order overlapping writes or give them to one owner. Record the red contracts on disk and not run; the slices with their read and write sets; the remaining dependencies and critical path; and the dispatch now, with workers, budgets, integrators, and file owners. Edges follow dependencies, not convenience.

A batch of one names the overlap or dependency that made it one. If you cannot name it, run the slices together. A batch of one that cannot name its dependency is a queue with better manners.

The design record states module boundaries, consumer contracts, and failure isolation. Each slice builds against that record, not a private design; if the boundary is unknown, the slice is not ready.

In the next message, dispatch all Green slices in the pin with scope_fork. Give every worker the contract path, ownership, acceptance goal, and verification assignment. When new work becomes ready, pin the updated plan and dispatch it without waiting for unrelated work. A subtree lead follows the same sequence within its time limit and keeps the parent contract intact. Escalate a needed contract change before implementing it.

## Green, acceptance, and record

Run a focused check when its marginal value is positive and the required inputs are ready. If the check needs sibling changes, a shared environment, or an integration point, hand it to the parent or integrator instead of waiting or duplicating the run. A child that verifies everything has priced nothing.

A child may return completed work without running tests. Pin "not tested yet" with the check to run, the condition it needs, and the owner who will run it. The receiving lead carries that check to the next integration point; the next holder can accept it, assign it, or explicitly pass it upward. No level may let it disappear.

Verification belongs to the level with context and authority, not to every child by default. The parent, grandparent, or next holder may own it. Report only observed results; a verification handoff is useful, not a failure, and it does not turn an unrun check into a pass.

Manual acceptance is for the part automation cannot carry. Use that entry and its surface sibling; pin the run-specific difference. No rubric, no score. A rubric with a hundred points and no user in the room is a spreadsheet, not acceptance. The goal is a user-side experience, not a parent's review of a child. If the goal is met, say so and move. If not, name the residual and its owner. Do not turn acceptance into a second implementation review.

Keep the design record under .agent/skills/<name>/SKILL.md: boundaries, consumer contracts, test paths, dependency and ownership decisions, dispatch pins, open verification, and the acceptance skill path. Pin the record's path so the next lead can find it. Run-specific results belong in pins and the ledger, not in the skill.

## Test rituals to refuse

The defaults to refuse here are test ritual: everyone tests everything; run Red to prove failure; the child must verify; one giant batch; coverage is quality. Each has a cost: duplicated verification, wasted turns, moral hazard, hidden failure, Goodhart. Name the default and the cost before choosing the smaller move. Coverage is a map of what you touched, not a measure of what works.
