# ADR 0001 — Stage names: retiring the S1–S5 labels

- Status: accepted
- Date: 2026-11-19

## Context

The first implementation identified the five workflow stages as `S1`–`S5`.
Those labels say nothing about what a stage is for, and they leaked into the
runtime: the `scope.begin.stage` schema, the stage prompts, and the tool
contracts all spoke in codes. A reader had to carry a lookup table in their
head, and every new reader had to learn one.

## Decision

Runtime surfaces carry the descriptive two-word name only. The values of
`scope.begin.stage` are:

| Former code | Stage value | Responsibility | Allowed when |
|---|---|---|---|
| S1 | `decision-framing` | Intent, non-goals, the decision and its bounds (supports `ask`) | `herdMode === true` only |
| S2 | `acceptance-cases` | User-experience acceptance: case design, hand-run tests, a 0-100 rubric | `herdMode === false` only |
| S3 | `architecture-design` | Module boundaries, data flow, the development guide | `herdMode === false` only |
| S4 | `orchestration-plan` | Literate pseudocode, invariants, worker choreography | `herdMode === false` only |
| S5 | `direct-execution` | Implement, run the real checks, accept, deliver | `herdMode === false` only |

The mapping above is history. It exists so old conversations and old sessions
can be read. No runtime enumeration, schema, prompt, or tool contract may use
`S1`–`S5`.

## Consequences

- The stage table appears exactly once, here. The design record links to it
  instead of repeating it, so the two cannot drift.
- `stage-contract` tests pin the five values and reject the codes.
- Renaming a stage again costs one entry in the enum, one prompt section, and
  one ADR; nothing else.

## Non-goals

- This record does not define the stage semantics. Those live in
  [the stage design record](../design/stages.md).
