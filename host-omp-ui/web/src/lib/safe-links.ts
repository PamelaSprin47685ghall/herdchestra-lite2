// One decision for every model/tool-supplied external URL. The Web page holds
// the manager token, so a rendered `javascript:` or `data:` link would be a
// direct control path. Return the original text so display stays unchanged.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function sanitizeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Browsers strip tabs and newlines before parsing, so reject them first.
  if (CONTROL_CHARACTERS.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return trimmed;
}

export function externalLinkAttributes(
  value: unknown,
):
  | { href: string; target: "_blank"; rel: "noreferrer noopener" }
  | null {
  const href = sanitizeExternalUrl(value);
  if (!href) return null;
  return { href, target: "_blank", rel: "noreferrer noopener" };
}
