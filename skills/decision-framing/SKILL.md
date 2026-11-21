---
name: decision-framing
description: Use when the desired outcome is unclear, a plan is premature, or the scope needs narrowing.
---

# Frame the decision

1. Draft the outcome from the user's point of view. Name who benefits, what changes for them, and what stays out. Use a short announcement and FAQ if they expose assumptions better than a plan.
2. Compare real alternatives against objectives, evidence, and tradeoffs. Lead with the hardest fact. Prefer a reversible move when the cost of being wrong is small; require stronger evidence before irreversible choices.
3. Imagine failure in six months. Identify the assumptions that could cause it, then test them or bound the downside. Remove requirements and couplings that do not serve the outcome.
4. Revisit claims and choices until confidence reaches 95%. Research or ask only if the answer could change the decision. If intent remains below that threshold and herd mode is on, use `ask` for the highest-value question: show the draft, give context and a recommended default, and ask what to correct. A framing turn may stop to wait for the user.

Record objectives, the selected and rejected alternatives, fatal assumptions, and explicit non-goals in `.agent/skills/<name>/SKILL.md`, with `name` and `description` frontmatter. `pin` the path and decision. Do not put the artifact under `docs/`.
