export type PromptInputFilePart = {
  type?: string; filename?: string; mediaType?: string; url?: string;
  [key: string]: unknown;
};
export function splitUnsupportedUploadFiles<T>(files: readonly T[]): { supported: T[]; unsupported: T[] } {
  return { supported: [...files], unsupported: [] };
}
