---
name: prompt-craft
description: Use when authoring or revising model-facing text: system prompts, tool descriptions, receipts, errors, and skills.
---

# Prompt Craft

The standing constitution applies; this skill adds only the authoring method for model-facing text. Use polish for line-level fidelity; use this skill to decide what the text must do and where it lives.

A prompt is not a manual. It is a control surface: it should change the model's next move. If a sentence only documents the system, it is in the wrong layer.

## The layers

The stable system prefix carries stance and the choices that apply every turn. It should not carry mechanics that a schema, receipt, or error can state at the moment of action.

A tool description carries the call shape and the judgment needed to choose the tool. It should not re-teach the system's state machine.

A receipt or error carries the current state and the next move at the point of action. It should not become a tutorial.

A skill carries deep discipline loaded on demand. It should not become a diary or a rule dump.

One fact, one owner. If a rule appears in two layers, decide which layer can enforce or decide it, and link the other. A duplicate is cheaper to write and more expensive to keep true.

## Behavior, not mechanism

System-guaranteed facts need only simple use. Do not teach the model why the gate exists; teach what to do at the gate. The model does not need to understand the lock to walk through the door.

No: "The return tool is child-only."
Yes: "A child finishes by returning its record; the parent receives it."

Judgment needs the principle. The principle can come from economics, decision-framing, systems, or the author's own logic. Do not import a mechanism the model cannot use, and do not mistake a mechanism for a reason.

A rule that needs a paragraph of internals to justify itself is probably in the wrong layer. Move the internals to the tool document; keep the behavior where the model acts.

I used to add another paragraph every time the model missed a rule. The prompt grew and the behavior did not. The missing piece was a decision, not a sentence. So now I find the smallest field the model actually reads, and change that.

## Language

Keep the surface calm and the criterion hard. Prefer goal to outcome, acceptance to checking. Prefer the conditional to the permission: "Make your own contribution if appropriate." Do not remind the reader of a choice they should make; that is a license or a scold.

Use evidence or proof only to shift a burden, never as a ritual. Keep a negation for a real constraint or an observed failure; delete the defensive "this is not X" unless X is a real confusion.

The constitution's language rules are the stance; this section is how to apply them when authoring. When in doubt, state the action and the condition, not the prohibition and the reassurance.

## Examples and confessions

At a key point, one concrete example beats a paragraph of explanation. Put it where the model is about to choose, not in a preface.

The most effective pattern is the confession: "I used to ... it blew up ... so now I ... never ..." It gives the rule a scar. Use it at the few points where the model must not drift; use it everywhere and it becomes a tic.

A confession should name a real failure, not a generic weakness. "I forgot to test" is weather. "I ran the full suite after every one-line edit and learned nothing" is a scar.

## The contract

Every model-facing section should have a test or a smoke check. Assert the behavior-bearing sentence or the mapping, not the whole prose.

Watch the word budget. A longer prompt is not a stronger prompt; it is a higher attention tax. If a sentence cannot change the next move, delete it. If deleting it would leave a hole, the hole is a missing decision, not a missing paragraph.

When you move text between layers, update the pointer and the test in the same change. A stale pointer is worse than no pointer.

A prompt is good when the model does the right thing without being able to recite why. That is not anti-intellectual; it is the division of labor between system and judgment.
