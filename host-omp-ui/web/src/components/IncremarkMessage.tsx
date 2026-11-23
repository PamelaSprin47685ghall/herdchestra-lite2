import { memo, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { IncremarkContent, ThemeProvider, type DesignTokens } from "@incremark/react";
import { highlightCode } from "@herd/deer-flow-ui/ai-elements/shiki-highlight";

const INCREMARK_OPTIONS = {
  gfm: true,
  math: true,
  htmlTree: false,
  typewriter: { enabled: false },
};

const typography = {
  fontFamily: {
    base: 'Charter, "TsangerJinKai02", "Songti SC", Georgia, serif',
    mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
  },
  lineHeight: { tight: 1.25, normal: 1.55, relaxed: 1.7 },
};

const lightTheme = {
  color: {
    text: { primary: "#141413", secondary: "#504e49", tertiary: "#6b6a64" },
    background: { base: "#f5f4ed", elevated: "#faf9f5", overlay: "#e8e6dc" },
    border: { subtle: "#e8e6dc", default: "#d8d5c8", strong: "#c9c5b6" },
    brand: { primary: "#9b2c2c", primaryHover: "#7b1f1f", primaryLight: "#EEF2F7" },
    code: {
      inlineBackground: "#e8e6dc",
      inlineText: "#3d3d3a",
      blockBackground: "#f5f4ed",
      blockText: "#3d3d3a",
      headerBackground: "#e8e6dc",
    },
  },
  typography,
  border: { radius: { sm: "3px", md: "6px", lg: "10px" } },
} as unknown as Partial<DesignTokens>;

const darkTheme = {
  color: {
    text: { primary: "#f5f4ed", secondary: "#e8e6dc", tertiary: "#d8d5c8" },
    background: { base: "#141413", elevated: "#30302e", overlay: "#3d3d3a" },
    border: { subtle: "#3d3d3a", default: "#3d3d3a", strong: "#504e49" },
    brand: { primary: "#f08a7e", primaryHover: "#f7aca2", primaryLight: "#30302e" },
    code: {
      inlineBackground: "#30302e",
      inlineText: "#f5f4ed",
      blockBackground: "#30302e",
      blockText: "#f5f4ed",
      headerBackground: "#3d3d3a",
    },
  },
  typography,
  border: { radius: { sm: "3px", md: "6px", lg: "10px" } },
} as unknown as Partial<DesignTokens>;

const darkListeners = new Set<() => void>();
let darkObserver: MutationObserver | null = null;
let darkSnapshot = false;

function readDark() {
  if (typeof document === "undefined") return false;
  const next = document.documentElement.classList.contains("dark");
  darkSnapshot = next;
  return next;
}

function subscribeDark(callback: () => void) {
  if (typeof document === "undefined") return () => {};
  darkListeners.add(callback);
  if (!darkObserver) {
    darkObserver = new MutationObserver(() => {
      readDark();
      for (const listener of darkListeners) listener();
    });
    darkObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  return () => {
    darkListeners.delete(callback);
    if (darkListeners.size === 0) {
      darkObserver?.disconnect();
      darkObserver = null;
    }
  };
}

function useIsDark() {
  return useSyncExternalStore(subscribeDark, readDark, () => false);
}

function DiffStyleCodeBlock({ node }: { node: { lang?: string; value?: string } }) {
  const dark = useIsDark();
  const code = node.value ?? "";
  const lang = node.lang || "text";
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, lang as never)
      .then((output) => {
        if (cancelled) return;
        setHtml(dark ? output.replaceAll("var(--shiki-light", "var(--shiki-dark") : output);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang, dark]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-muted/30">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
        <span className="truncate font-mono">{lang}</span>
        <button
          type="button"
          aria-label="复制代码"
          title={copied ? "已复制" : "复制代码"}
          onClick={() => {
            navigator.clipboard?.writeText(code).then(() => setCopied(true)).catch(() => undefined);
          }}
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-accent/60"
        >
          {copied ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-3.5"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-3.5"
              aria-hidden="true"
            >
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          )}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto p-3 text-xs [&_code]:font-mono [&_pre]:m-0 [&_pre]:!bg-transparent [&_pre]:p-0"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-auto p-3 font-mono text-xs text-foreground">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

const INCREMARK_COMPONENTS = { code: DiffStyleCodeBlock } as never;

export const IncremarkMessage = memo(function IncremarkMessage({
  text,
  children,
  streaming = false,
  className,
}: {
  text?: string;
  children?: ReactNode;
  streaming?: boolean;
  className?: string;
}) {
  const dark = useIsDark();
  const content = text ?? (typeof children === "string" ? children : "");
  return (
    <div className={className}>
      <ThemeProvider theme={dark ? darkTheme : lightTheme}>
        <IncremarkContent
          content={content}
          isFinished={!streaming}
          incremarkOptions={INCREMARK_OPTIONS}
          components={INCREMARK_COMPONENTS}
        />
      </ThemeProvider>
    </div>
  );
});
