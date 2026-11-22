// The policy rules are pure domain decisions. They live in core so station
// code can import them without depending on the host layer. The host keeps
// this path as a re-export so existing host imports do not change.
export * from "../core/policy.mjs";
