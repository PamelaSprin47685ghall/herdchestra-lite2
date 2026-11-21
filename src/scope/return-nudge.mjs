// The corrective prompt a child receives when it stops without returning.
//
// One text, two readers: the spawn ticket that delivers it, and the relay
// handoff that keeps it out of the user's archive. It is an instruction for
// one turn, not a requirement of the user. Pure. No I/O.

import { loadDoc } from "../prompts/index.mjs";

const S = loadDoc("receipts/scope");

export function childReturnNudge() {
	return S["fork.child-return-nudge"];
}
