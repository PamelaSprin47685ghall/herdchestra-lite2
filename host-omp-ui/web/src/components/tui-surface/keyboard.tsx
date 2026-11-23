import { Button } from "@herd/deer-flow-ui/ui/button";

const SPECIAL: Record<string, string> = {
  Escape: "\u001b", Enter: "\r",
  Backspace: "\u007f", Delete: "\u001b[3~", ArrowUp: "\u001b[A",
  ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D",
  Home: "\u001b[H", End: "\u001b[F", PageUp: "\u001b[5~", PageDown: "\u001b[6~",
};
const ARROWS: Record<string, string> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
const TILDE: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const FKEYS: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

export const KEYS: Array<{ label: string; data: string; title: string }> = [
  { label: "Esc", data: "\u001b", title: "Escape" },
  { label: "Tab", data: "\t", title: "Tab" },
  { label: "⇧Tab", data: "\u001b[Z", title: "Shift+Tab" },
  { label: "↑", data: "\u001b[A", title: "Arrow up" },
  { label: "↓", data: "\u001b[B", title: "Arrow down" },
  { label: "←", data: "\u001b[D", title: "Arrow left" },
  { label: "→", data: "\u001b[C", title: "Arrow right" },
  { label: "Enter", data: "\r", title: "Enter" },
  { label: "Ctrl+O", data: "\u000f", title: "Ctrl+O" },
];

export function KeyPassthrough({ onKeys }: { onKeys: (data: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
      {KEYS.map((key) => (
        <Button
          key={key.label}
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-1.5 font-mono text-[10px]"
          title={key.title}
          onClick={() => onKeys(key.data)}
        >
          {key.label}
        </Button>
      ))}
      <input
        aria-label="TUI 键盘透传"
        placeholder="聚焦此处向 TUI 键入"
        className="ml-auto h-7 min-w-36 rounded border bg-transparent px-2 text-xs"
        value=""
        onChange={() => {}}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (text) onKeys(`\u001b[200~${text}\u001b[201~`);
        }}
        onCompositionEnd={(event) => {
          if (event.data) onKeys(event.data);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key === "Process") return;
          if (event.metaKey || (event.ctrlKey && ["v", "c", "x"].includes(event.key.toLowerCase()))) {
            // Ctrl+C is a terminal interrupt; paste is handled by onPaste.
            if (!event.ctrlKey || event.key.toLowerCase() !== "c") return;
          }
          let data = event.key === "Tab" ? (event.shiftKey ? "\u001b[Z" : "\t") : SPECIAL[event.key];
          const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
          if (ARROWS[event.key] && modifier > 1) data = `\u001b[1;${modifier}${ARROWS[event.key]}`;
          else if (TILDE[event.key]) data = `\u001b[${TILDE[event.key]}${modifier > 1 ? `;${modifier}` : ""}~`;
          else if (FKEYS[event.key]) data = modifier > 1 ? `\u001b[1;${modifier}${FKEYS[event.key]}` : `\u001bO${FKEYS[event.key]}`;
          if (!data && event.ctrlKey && /^[a-z]$/i.test(event.key)) {
            data = String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
          } else if (!data && !event.ctrlKey && event.key.length === 1) {
            data = event.key;
          }
          if (!data) return;
          event.preventDefault();
          const encodedModifier = modifier > 1 && Boolean(ARROWS[event.key] || TILDE[event.key] || FKEYS[event.key]);
          onKeys(event.altKey && !encodedModifier ? `\u001b${data}` : data);
        }}
      />
    </div>
  );
}
