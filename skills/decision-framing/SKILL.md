---
name: decision-framing
description: Use when the default is winning by inertia, the goal is unclear, or a plan is premature.
---

# Frame the decision

The standing constitution applies; this skill adds only the decision method.

A decision begins with attention. You are part of the situation you are trying to understand; the question you ask changes the room. Treat your own question as part of the situation, and the user as a co-observer rather than a specimen. The observer effect is a warning: your question is never neutral, so ask it as a collaborator.

1. Observation begins with the goal.
   Start from the user's side: who acts, what becomes true, what they see, what stays out. A goal is a state the work makes true, not an activity. Make it concrete enough that a successor can accept it. A goal you cannot recognize in a finished artifact is a mood, not a goal. A short announcement or FAQ can expose assumptions better than a plan.

2. Notice the default and your own part in it.
   Name what a competent, risk-averse actor would do without thinking: smallest diff, fewest files, serialize the work, add a review, optimize the metric, wait for certainty. That default is a local optimum; it is stable because its cost is pushed out of sight. Name the cost: the critical path, the lost option, the false confidence, the work that never gets done. The default is usually cheaper on the ledger and more expensive on the critical path. Then name your own part in the room: what your question invites the user to see, what it leaves in shadow, and what a different question would have opened.

3. Infer the model.
   Move from observation to a candidate explanation by induction, abduction, and TSI. Induction finds the pattern in the cases. Abduction finds the best explanation for the observation. TSI changes the schema under which the same observation is described, so a different pattern becomes visible. Treat the model as a Bayesian posterior, not a verdict: start from a prior, update on observation, and keep the uncertainty visible. A model that explains every observation equally well explains nothing; look for what would make it wrong. Compare the real alternatives against objectives, constraints, and tradeoffs. Lead with the hardest fact. Imagine the failure six months out; name the assumption that would cause it, then test or bound it. Remove requirements and couplings that do not serve the goal. Prefer the reversible move when the downside is real; demand more when the door is irreversible.

4. Minimize the residual.
   The residual is the gap between what the model predicts and what you observe. A random residual is noise; a structured residual is a missing variable or a wrong model. Do not minimize it by narrowing the data, ignoring the outlier, or calling the gap acceptable. Add the missing variable, change the schema, or bound the error. Then find the smallest lever: the field, sentence, constraint, or interface that every downstream decision reads. A small change in a high-sensitivity variable beats a large change in a low-sensitivity one. See the whole in the small.

5. Ask one question, only below 95%.
   Revisit the model until confidence reaches 95%. The posterior is a distribution, not a point; 95% is a decision threshold, not a property of the world. Research or ask only if the answer could change the bet. A question whose either answer changes nothing is a request for reassurance, not information. Give the draft, the default you refuse, and a recommended default; ask what to correct. Do not ask for permission; do not batch questions; do not ask what you can decide. With autopilot on, take the recommended default and record the residual; do not manufacture a question. A framing turn may stop to wait for the user when autopilot is off.

6. Make the bet, act, and show.
   State the non-default move and its asymmetry: the downside is bounded, the upside is real, and the cost of being wrong is less than the cost of never trying. Say what it buys if right, what it costs if wrong, and why the upside is worth that cost. Once the bet is clear, act. Present the concrete result, not a plan for it, before asking the next question. Do not re-litigate a settled bet.

7. Record what the next person needs.
   Pin the goal, the selected and rejected alternatives, the default refused, the bet, what would prove the bet wrong, the fatal assumptions, the non-goals, and the residuals. A residual is not a new idea; it is the part of this decision that needs another decision. A record that cannot tell the next person what would prove it wrong is a diary, not a decision. Write the record under `.agent/skills/<name>/SKILL.md`, not `docs/`. Pin the path. Leave a path a successor can accept.

## Leverage

See the whole in the small. Induce from the cases first; axiomatize only what the cases have earned. Axioms are compressed inductions, not starting points. Do not axiomatize before induction.
