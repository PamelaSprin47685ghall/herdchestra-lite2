export async function writeTextToClipboard(text: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
    const doc = globalThis.document;
    if (!doc?.createElement || !doc.body || !doc.execCommand) return false;
    const ta = doc.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-9999px";
    doc.body.appendChild(ta); ta.select();
    const ok = doc.execCommand("copy"); ta.remove();
    return ok;
  } catch { return false; }
}
export function installClipboardFallback(): void {}
