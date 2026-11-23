import { describe, expect, test } from "bun:test";

// Red contract: one shared decision for every model/tool-supplied external URL.
//
// Both renderers that currently emit `target="_blank"` links
// (`ToolStepCard.tsx` web results and `TuiSurfaceOverlay.tsx` web nodes) must
// use these helpers instead of putting raw content into `href`. Otherwise a
// model-supplied `javascript:` or `data:` URL executes in a page that holds
// the manager token, and a valid external page can navigate the opener.
//
// Expected production module:
//   host-omp-ui/web/src/lib/safe-links.ts
//
//   sanitizeExternalUrl(value: unknown): string | null
//     - returns a trimmed absolute http:/https: URL, preserving the rest of
//       the text; returns null for anything else.
//   externalLinkAttributes(value: unknown):
//     { href: string; target: "_blank"; rel: "noreferrer noopener" } | null
//
// The implementation may use the URL parser, but must reject control
// characters before parsing: browsers strip tabs/newlines, so a naive parse
// would turn "java\tscript:..." into a working javascript: URL.
import {
	externalLinkAttributes,
	sanitizeExternalUrl,
} from "../../host-omp-ui/web/src/lib/safe-links.ts";

describe("sanitizeExternalUrl", () => {
	test("keeps ordinary http and https links intact", () => {
		const links = [
			"https://example.com/docs",
			"http://localhost:8080/a?b=c#d",
			"https://例え.テスト/路径?q=%E4%B8%AD",
			"HTTPS://Example.COM/Upper",
		];
		for (const link of links) {
			expect(sanitizeExternalUrl(link)).toBe(link);
		}
	});

	test("trims surrounding whitespace but returns the same link", () => {
		expect(sanitizeExternalUrl("  https://example.com/a  ")).toBe(
			"https://example.com/a",
		);
		expect(sanitizeExternalUrl("\nhttps://example.com/b\t")).toBe(
			"https://example.com/b",
		);
	});

	test("rejects executable and local-file schemes", () => {
		const unsafe = [
			"javascript:alert(document.domain)",
			"JaVaScRiPt:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"data:image/svg+xml;base64,PHN2Zz4=",
			"file:///etc/passwd",
			"vbscript:msgbox(1)",
			"blob:https://example.com/123",
			"about:blank",
			"chrome://settings",
		];
		for (const value of unsafe) {
			expect(sanitizeExternalUrl(value)).toBeNull();
		}
	});

	test("rejects tab/newline/carriage-return disguised schemes", () => {
		const unsafe = [
			"java\tscript:alert(1)",
			"java\nscript:alert(1)",
			"java\rscript:alert(1)",
			"\u0000javascript:alert(1)",
			"\u0001javascript:alert(1)",
		];
		for (const value of unsafe) {
			expect(sanitizeExternalUrl(value)).toBeNull();
		}
	});

	test("rejects protocol-relative, relative, anchor, and non-string input", () => {
		const unsafe = ["//evil.example/steal", "/relative/path", "#anchor", "", "   "];
		for (const value of unsafe) {
			expect(sanitizeExternalUrl(value)).toBeNull();
		}
		expect(sanitizeExternalUrl(undefined)).toBeNull();
		expect(sanitizeExternalUrl(null)).toBeNull();
		expect(sanitizeExternalUrl({ toString: () => "https://example.com" })).toBeNull();
		expect(sanitizeExternalUrl(42)).toBeNull();
	});

	test("rejects malformed absolute URLs rather than passing them through", () => {
		expect(sanitizeExternalUrl("https://")).toBeNull();
		expect(sanitizeExternalUrl("https://exa mple.com")).toBeNull();
		expect(sanitizeExternalUrl("http://[bad")).toBeNull();
	});
});

describe("externalLinkAttributes", () => {
	test("provides safe window-opening attributes for a valid link", () => {
		expect(externalLinkAttributes("https://example.com/x")).toEqual({
			href: "https://example.com/x",
			target: "_blank",
			rel: "noreferrer noopener",
		});
	});

	test("returns null for an unsafe link so callers render text, not an anchor", () => {
		expect(externalLinkAttributes("javascript:alert(1)")).toBeNull();
		expect(externalLinkAttributes("data:text/html,hi")).toBeNull();
		expect(externalLinkAttributes("file:///etc/passwd")).toBeNull();
		expect(externalLinkAttributes("//evil.example")).toBeNull();
	});

	test("never keeps a protocol the page cannot safely open", () => {
		for (const scheme of ["javascript:", "data:", "file:", "blob:", "vbscript:"]) {
			expect(externalLinkAttributes(`${scheme}payload`)).toBeNull();
		}
	});
});
