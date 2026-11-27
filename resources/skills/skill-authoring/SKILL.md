---
name: skill-authoring
description: Use when creating, splitting, or maintaining a skill. Keep one responsibility per skill and one owner per fact.
---

# Skill Authoring

The enabled constitution policy applies; this skill adds only the packaging method for skills. Use prompt-craft for the text and polish for line-level fidelity.

A skill is a responsibility, not a folder. If you cannot state what it owns and what it refuses, it is not ready.

## One responsibility

The constitution policy is stance. The framing policy is method. The testing policy is process. Prompt-craft is authoring. Polish is line editing. Each answers a different question; if two answer the same question, one is redundant.

A skill may use another skill's concept, but it must not restate its rules. Link the owner. A pointer is cheaper than a copy and cannot drift.

## One owner per fact

One fact, one home. If the same rule appears in two skills, decide which skill can enforce or decide it, and make the other a pointer. If neither can own it, the rule is not a rule; it is a preference.

A skill is not a diary. Run-specific state, dates, results, and one-off values belong in the ledger or the return report. The skill holds the reusable procedure, not the run.

## When to create

Extend the existing skill first. Create a new one only when the responsibility is genuinely different: a different trigger, a different decision, a different failure mode. A new name is not a new responsibility.

A new skill needs a one-sentence job, a description that tells the model when to load it, and a clear non-goal. If you cannot write the non-goal, the boundary is not real.

Required-reading skills carry stance; on-demand skills carry deep method. Do not make every skill required; that turns the prefix into a manual. The persistent rules name the required skills and the triggers for the rest.

## Structure

The entry is a map, not a warehouse. It states the job, the first move, the boundary, and links to siblings for detail. Siblings hold long procedures and examples; the entry stays stable.

No code, no diary, no duplicated policy. If a detail belongs to one run, it belongs in the return report. If it belongs to one tool, it belongs in the tool document. If it belongs to judgment, it belongs in the skill.

## Maintenance

Adding a skill is a contract change: update the persistent list, the prompt tests, the README, and the changelog in the same change. A skill the model never loads is a file, not a capability.

Removing or renaming a skill: update every pointer and test. A stale pointer is worse than no pointer.

When two skills drift, merge or split. Do not add a third skill to mediate. A mediator is a second source of truth with better manners.

## Why this skill exists

I used to add a new skill every time a rule did not fit. The package became a shelf of near-duplicates; the model had to choose, and the boundaries blurred. I also copied the same paragraph into two skills so each would be self-contained; the copies drifted, and the model followed the older one. So now I extend the owner or cut the rule, and I never create a skill to avoid a decision. This skill is the reminder: one responsibility, one owner, link the rest.
