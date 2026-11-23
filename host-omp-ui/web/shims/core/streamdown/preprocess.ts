export function stripLeakedSystemTags(markdown: string): string {
  return markdown.replace(/<\/?(?:memory|system|context)(?:\s[^>]*)?\/?>/g, "");
}
export function preprocessStreamdownMarkdown(markdown: string): string { return markdown; }
