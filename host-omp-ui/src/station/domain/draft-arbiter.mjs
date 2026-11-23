// Pure draft arbitration. The Station owns the draft and its trail; this
// module answers "does this incoming text become a new revision?" and returns
// the next trail. No state is read or written here.

const TRAIL_LIMIT = 8;

// The trail is a bounded cross-origin echo detector. A remote write echoed
// back by the editor is indistinguishable from typing once it reaches the
// Station; an A -> B -> A alternation across origins is the one shape real
// editing does not produce.
export function arbitrateDraft({ rev, text, trail }, incoming) {
  const origin = incoming.origin;
  const nextText = incoming.text;
  if (nextText === text) return { kind: "noop", rev, trail };

  const last = trail.at(-1);
  const beforeLast = trail.at(-2);
  if (
    last && beforeLast &&
    last.origin !== origin &&
    beforeLast.origin === origin &&
    beforeLast.text === nextText &&
    last.text !== nextText
  ) {
    // A -> B -> A across origins is an echo, not an edit. Drop the trail
    // before it becomes a revision the other side mirrors back again.
    return { kind: "echo", rev, trail: [] };
  }

  const nextTrail = [...trail, { text: nextText, origin }];
  if (nextTrail.length > TRAIL_LIMIT) nextTrail.shift();
  return { kind: "accept", rev: rev + 1, trail: nextTrail };
}
