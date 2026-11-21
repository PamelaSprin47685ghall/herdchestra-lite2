// Join admission: can the parent's next request hold this child record?
//
// The estimate is deliberately conservative and states its own evidence. A
// known window and a measured request produce a real verdict; an unknown
// window or an unmeasured request is not silently treated as zero or as
// infinity. The caller decides what to do with an unproven case, and the
// station keeps the ready result whenever admission refuses.

export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8192;
export const DEFAULT_SAFETY_MARGIN_TOKENS = 1024;

function finiteCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validWindow(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Price a record by its characters at the model's measured density.
 *
 * `baseTokens` is the live outbound watermark. A non-finite base stays
 * unmeasured; it is never rounded down to zero.
 */
export function estimateJoinTokens({ baseTokens, recordChars, tokensPerChar } = {}) {
  const base = finiteCount(baseTokens) ? baseTokens : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(base)) return Number.POSITIVE_INFINITY;
  const chars = finiteCount(recordChars) ? recordChars : 0;
  const density =
    typeof tokensPerChar === "number" && Number.isFinite(tokensPerChar) && tokensPerChar >= 0
      ? tokensPerChar
      : 0;
  return base + Math.ceil(chars * density);
}

/**
 * Compare a projected request with a known window.
 *
 * The boundary is strict: `projected + reserve + margin` must be below the
 * window. Equality is a refusal, because the provider may count framing the
 * estimate does not model.
 */
export function joinAdmission({ window, projected, reserve, margin } = {}) {
  const limit = validWindow(window) ? window : null;
  const outputReserve = finiteCount(reserve) ? reserve : DEFAULT_OUTPUT_RESERVE_TOKENS;
  const safetyMargin = finiteCount(margin) ? margin : DEFAULT_SAFETY_MARGIN_TOKENS;
  const measured = finiteCount(projected) ? projected : null;
  if (limit === null) {
    return {
      ok: true,
      source: "unknown-window",
      limit: null,
      projected: measured,
      reserve: outputReserve,
      margin: safetyMargin,
    };
  }
  if (measured === null) {
    return {
      ok: true,
      source: "unknown-request",
      limit,
      projected: null,
      reserve: outputReserve,
      margin: safetyMargin,
    };
  }
  const total = measured + outputReserve + safetyMargin;
  if (total < limit) {
    return {
      ok: true,
      source: "measured",
      limit,
      projected: measured,
      reserve: outputReserve,
      margin: safetyMargin,
      headroom: limit - total,
    };
  }
  return {
    ok: false,
    code: "JOIN_CONTEXT_EXCEEDED",
    reason:
      `The next request would be about ${measured} tokens plus ${outputReserve} ` +
      `output reserve and ${safetyMargin} margin, over the ${limit}-token window.`,
    limit,
    projected: measured,
    reserve: outputReserve,
    margin: safetyMargin,
    overBy: total - limit,
  };
}
