#!/usr/bin/env node
/*
 * Derive the dark palette from the light palette.
 *
 * Rule: HSV, hue and saturation unchanged, V -> 255 - V (V in 0..255).
 * The light :root block is the single source of truth; this script rewrites
 * the .dark palette block and every light-dark(light, dark) pair, so no dark
 * value is typed by hand.
 *
 * A literal flip can drop a text pair below its WCAG floor. Instead of
 * guarding the dark value, the script calibrates the LIGHT source: for each
 * ink token it finds the largest V (closest to the authored value) that keeps
 * both the light and the flipped-dark contrast at or above the floor. The
 * light value is written back; the dark value is always the strict flip of
 * the calibrated light.
 *
 *   node scripts/derive-dark-palette.mjs           # calibrate + rewrite app.css
 *   node scripts/derive-dark-palette.mjs --check   # verify, exit 1 on drift
 *   node scripts/derive-dark-palette.mjs --audit   # light/dark contrast report
 *   node scripts/derive-dark-palette.mjs --raw     # literal flip, no calibration
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, "..", "src", "styles", "app.css");

const args = new Set(process.argv.slice(2));
const RAW = args.has("--raw");

/* Rendered [ink, surface] relationships the UI depends on. Each pair must
   reach its floor in light mode and again after the strict dark flip. */
const PAIRS = [
  ["near-black", "parchment"],
  ["near-black", "ivory"],
  ["stone", "parchment"],
  ["stone", "warm-sand"],
  ["dark-warm", "warm-sand"],
  ["olive", "parchment"],
  ["link", "parchment"],
  ["link-hover", "parchment"],
  ["destructive", "parchment"],
  ["brand", "parchment"],
  ["brand", "brand-tint"],
  ["brand", "ivory"],
  ["brand-light", "parchment"],
  ["brand-light", "ivory"],
  ["brand-light", "warm-sand"],
  ["chart-1", "parchment"],
  ["chart-2", "parchment"],
  ["chart-3", "parchment"],
  ["chart-4", "parchment"],
  ["chart-5", "parchment"],
];

/* The light :root semantic block is mirrored here verbatim. Each slot points
   at the same palette token in both modes; the palette tokens themselves are
   flipped, so the dark slot resolves to the mirrored color with no hand-typed
   literal. --destructive and --chart-1..5 are palette tokens and stay derived. */
const DARK_SEMANTIC = [
  ["background", "var(--parchment)"],
  ["foreground", "var(--near-black)"],
  ["card", "var(--ivory)"],
  ["card-foreground", "var(--near-black)"],
  ["popover", "var(--ivory)"],
  ["popover-foreground", "var(--near-black)"],
  ["primary", "var(--brand)"],
  ["primary-foreground", "var(--ivory)"],
  ["secondary", "var(--warm-sand)"],
  ["secondary-foreground", "var(--dark-warm)"],
  ["muted", "var(--warm-sand)"],
  ["muted-foreground", "var(--stone)"],
  ["accent", "var(--brand-tint)"],
  ["accent-foreground", "var(--brand)"],
  ["border", "var(--line)"],
  ["input", "var(--border-soft)"],
  ["ring", "var(--brand-light)"],
  ["sidebar", "var(--ivory)"],
  ["sidebar-foreground", "var(--near-black)"],
  ["sidebar-primary", "var(--brand)"],
  ["sidebar-primary-foreground", "var(--ivory)"],
  ["sidebar-accent", "var(--warm-sand)"],
  ["sidebar-accent-foreground", "var(--dark-warm)"],
  ["sidebar-border", "var(--line)"],
  ["sidebar-ring", "var(--brand-light)"],
];

function parseHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
  return (
    "#" +
    rgb
      .map((c) =>
        Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"),
      )
      .join("")
  );
}

/** @returns {[number, number, number]} h in degrees, s and v in 0..1 */
function rgbToHsv([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb([h, s, v]) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((t) => (t + m) * 255);
}

/** Literal rule: HSV(H, S, 255 - V). */
function flip(lightHex) {
  const [h, s, v] = rgbToHsv(parseHex(lightHex));
  return toHex(hsvToRgb([h, s, 1 - v]));
}

/** Dark value of a palette token. Card and page background swap their
 *  sources before the flip, so the card stays lighter than the page in
 *  dark mode (a literal flip would sink it into a groove). */
function makeDarkOf(lightMap) {
  return (name) => {
    if (name === "parchment") return flip(lightMap.get("ivory"));
    if (name === "ivory") return flip(lightMap.get("parchment"));
    return flip(lightMap.get(name));
  };
}

function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function readCss() {
  return readFileSync(CSS_PATH, "utf8");
}

/** Literal color declarations of the palette :root block, in source order. */
function lightTokens(css) {
  const blocks = [...css.matchAll(/(?:^|\n):root \{\n([\s\S]*?)\n\}/g)].map(
    (m) => m[1],
  );
  const block = blocks.find((b) => /--parchment:\s*#/.test(b));
  if (!block) throw new Error("palette :root block not found");
  const tokens = [];
  for (const m of block.matchAll(
    /^\s*--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/gm,
  )) {
    tokens.push({ name: m[1], light: m[2].toLowerCase() });
  }
  if (tokens.length === 0) throw new Error("no literal colors in :root");
  return tokens;
}

const floorFor = (ink) =>
  ink.startsWith("chart-") || ink === "brand-light" ? 3 : 4.5;

/** Largest V (0..1) whose light and flipped-dark values meet every
 *  requirement. Returns null when no V does. */
function feasibleV(h, s, requirements) {
  let best = null;
  for (let vi = 0; vi <= 255; vi += 1) {
    const v = vi / 255;
    const lightHex = toHex(hsvToRgb([h, s, v]));
    const darkHex = toHex(hsvToRgb([h, s, 1 - v]));
    let ok = true;
    for (const r of requirements) {
      if (contrast(lightHex, r.lightHex) + 0.005 < r.ratio) {
        ok = false;
        break;
      }
      if (contrast(darkHex, r.darkHex) + 0.005 < r.ratio) {
        ok = false;
        break;
      }
    }
    if (ok) best = v;
  }
  return best;
}

/**
 * Calibrate every ink token against the authored light surfaces. Returns
 * [{name, light, dark, v0, v, lightMin, darkMin, changed, deadlock}].
 * The dark value is always flip(light); only the light V moves.
 */
function calibrate(tokens) {
  const light = new Map(tokens.map((t) => [t.name, t.light]));
  const darkOf = makeDarkOf(light);
  const byInk = new Map();
  for (const [ink, surface] of PAIRS) {
    if (!byInk.has(ink)) byInk.set(ink, []);
    byInk.get(ink).push({
      surface,
      lightHex: light.get(surface),
      darkHex: darkOf(surface),
      ratio: floorFor(ink),
    });
  }

  return tokens.map((t) => {
    const [h, s, v0] = rgbToHsv(parseHex(t.light));
    const requirements = byInk.get(t.name) ?? [];
    if (requirements.length === 0) {
      return {
        name: t.name,
        light: t.light,
        dark: darkOf(t.name),
        v0,
        v: v0,
        lightMin: null,
        darkMin: null,
        changed: false,
        deadlock: false,
      };
    }

    const best = RAW ? v0 : feasibleV(h, s, requirements);
    if (best === null) {
      return {
        name: t.name,
        light: t.light,
        dark: flip(t.light),
        v0,
        v: v0,
        lightMin: Math.min(
          ...requirements.map((r) => contrast(t.light, r.lightHex)),
        ),
        darkMin: Math.min(
          ...requirements.map((r) => contrast(flip(t.light), r.darkHex)),
        ),
        changed: false,
        deadlock: true,
      };
    }

    const v = Math.min(v0, best);
    const lightHex = toHex(hsvToRgb([h, s, v]));
    const darkHex = toHex(hsvToRgb([h, s, 1 - v]));
    return {
      name: t.name,
      light: lightHex,
      dark: darkHex,
      v0,
      v,
      lightMin: Math.min(
        ...requirements.map((r) => contrast(lightHex, r.lightHex)),
      ),
      darkMin: Math.min(
        ...requirements.map((r) => contrast(darkHex, r.darkHex)),
      ),
      changed: lightHex !== t.light,
      deadlock: false,
    };
  });
}

function darkBlock(rows) {
  return [
    ".dark {",
    "  color-scheme: dark;",
    "",
    "  /* Derived from the light :root block by scripts/derive-dark-palette.mjs.",
    "     H and S are unchanged; V is 255 - V. Do not edit by hand. */",
    ...rows.map((r) => `  --${r.name}: ${r.dark};`),
    "",
    "  /* Semantic wiring restored from the original dark theme. Palette values",
    "     above are derived; these slots keep their original references. */",
    ...DARK_SEMANTIC.map(([name, value]) => `  --${name}: ${value};`),
    "",
    "  font-weight: 300;",
    "}",
  ].join("\n");
}

/** Patch only the palette :root block (the one that defines --parchment). */
function patchLightPalette(css, changes) {
  let done = false;
  return css.replace(/(:root \{\n)([\s\S]*?)(\n\})/g, (m, head, body, tail) => {
    if (done || !/--parchment:\s*#/.test(body)) return m;
    done = true;
    let next = body;
    for (const [name, hex] of changes) {
      next = next.replace(
        new RegExp(`--${name}:\\s*#[0-9a-fA-F]{6};`),
        `--${name}: ${hex};`,
      );
    }
    return head + next + tail;
  });
}

/** Nearest dark V (same H/S) that gives an icon glyph 3:1 on its chip. */
function solveFg(fgLight, bgDark) {
  const [h, s, v0] = rgbToHsv(parseHex(fgLight));
  const literalV = 1 - v0;
  const literal = toHex(hsvToRgb([h, s, literalV]));
  if (contrast(literal, bgDark) + 0.005 >= 3) return literal;
  let best = literal;
  let bestDist = Infinity;
  for (let vi = 0; vi <= 255; vi += 1) {
    const v = vi / 255;
    const hex = toHex(hsvToRgb([h, s, v]));
    if (contrast(hex, bgDark) + 0.005 < 3) continue;
    const dist = Math.abs(v - literalV);
    if (dist < bestDist) {
      best = hex;
      bestDist = dist;
    }
  }
  return best;
}

/** File-type icon glyphs are decorative badges, not the 21 palette tokens.
 *  A strict flip makes three of them unreadable on the near-black chip, so
 *  keep the light glyph and move only the dark glyph to the nearest 3:1 V.
 *  This is the one guard outside the palette; --audit prints it. */
function guardIcons(css) {
  return css.replace(
    /(\.file-type-icon\[data-file-kind="[a-z]+"\] \{\n)([\s\S]*?)(\n\})/g,
    (m, head, body, tail) => {
      const bg = body.match(
        /background: light-dark\(\s*#[0-9a-fA-F]{6}\s*,\s*(#[0-9a-fA-F]{6})\s*\)/,
      );
      const fg = body.match(
        /color: light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)/,
      );
      if (!bg || !fg) return m;
      const fgLight = fg[1].toLowerCase();
      const guarded = solveFg(fgLight, bg[1]);
      return (
        head +
        body.replace(
          /color: light-dark\(\s*#[0-9a-fA-F]{6}\s*,\s*#[0-9a-fA-F]{6}\s*\)/,
          `color: light-dark(${fgLight}, ${guarded})`,
        ) +
        tail
      );
    },
  );
}

function writeDerived(css, rows) {
  const changes = rows
    .filter((r) => r.changed)
    .map((r) => [r.name, r.light]);
  const lightToDark = new Map(rows.map((r) => [r.light, r.dark]));
  let out = patchLightPalette(css, changes);
  out = out.replace(
    /(?:^|\n)\.dark \{\n[\s\S]*?\n\}/,
    (m) => (m.startsWith("\n") ? "\n" : "") + darkBlock(rows),
  );
  out = out.replace(
    /light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)/g,
    (_m, light) => {
      const l = light.toLowerCase();
      return `light-dark(${l}, ${lightToDark.get(l) ?? flip(l)})`;
    },
  );
  return guardIcons(out);
}

function printCalibration(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad("token", 14) +
      pad("light", 10) +
      pad("dark", 10) +
      pad("V old", 8) +
      pad("V new", 8) +
      pad("lightMin", 10) +
      pad("darkMin", 9) +
      "note",
  );
  for (const r of rows) {
    const vOld = Math.round(r.v0 * 255);
    const vNew = Math.round(r.v * 255);
    const note = r.deadlock
      ? "DEADLOCK (no V meets both sides)"
      : r.changed
        ? `calibrated ${vOld} -> ${vNew}`
        : "";
    console.log(
      pad(r.name, 14) +
        pad(r.light, 10) +
        pad(r.dark, 10) +
        pad(vOld, 8) +
        pad(vNew, 8) +
        pad(r.lightMin === null ? "-" : r.lightMin.toFixed(2), 10) +
        pad(r.darkMin === null ? "-" : r.darkMin.toFixed(2), 9) +
        note,
    );
  }
}

/* ---------- modes ---------- */

function check(css) {
  const tokens = lightTokens(css);
  const rows = calibrate(tokens);
  const actual = new Map();
  const block = css.match(/(?:^|\n)\.dark \{\n([\s\S]*?)\n\}/);
  if (block) {
    for (const m of block[1].matchAll(
      /^\s*--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/gm,
    )) {
      actual.set(m[1], m[2].toLowerCase());
    }
  }

  printCalibration(rows);
  let bad = 0;

  // Light source must already be calibrated: calibrate() reports changed
  // when the current V is above the largest feasible V.
  for (const r of rows) {
    if (r.deadlock) {
      console.log(`  ${r.name}: no feasible V (deadlock)`);
      bad += 1;
    } else if (r.changed) {
      console.log(
        `  ${r.name}: light source needs calibration (V ${Math.round(r.v0 * 255)} -> ${Math.round(r.v * 255)})`,
      );
      bad += 1;
    }
  }

  for (const r of rows) {
    const got = actual.get(r.name);
    if (got !== r.dark) {
      console.log(`  ${r.name}: dark ${got ?? "(missing)"} != ${r.dark}`);
      bad += 1;
    }
  }

  // Light-dark icon pairs are not palette tokens; guardIcons() keeps their
  // dark glyph at 3:1 while the light glyph stays authored.
  console.log(`\n${rows.length} tokens, ${bad} mismatch(es).`);
  return bad;
}

function audit(css) {
  const tokens = lightTokens(css);
  const rows = calibrate(tokens);
  const light = new Map(rows.map((r) => [r.name, r.light]));
  const dark = new Map(rows.map((r) => [r.name, r.dark]));
  const pad = (s, n) => String(s).padEnd(n);
  console.log("pair".padEnd(38) + "light   dark    floor  verdict");
  let fails = 0;
  for (const [fg, bg] of PAIRS) {
    const l = contrast(light.get(fg), light.get(bg));
    const d = contrast(dark.get(fg), dark.get(bg));
    const floor = floorFor(fg);
    const bad = [];
    if (l + 0.005 < floor) bad.push("light");
    if (d + 0.005 < floor) bad.push("dark");
    if (bad.length) fails += 1;
    console.log(
      `${fg} on ${bg}`.padEnd(38) +
        l.toFixed(2).padStart(5) +
        "  " +
        d.toFixed(2).padStart(5) +
        "  " +
        floor.toFixed(1).padStart(4) +
        "  " +
        (bad.length ? `BELOW(${bad.join(",")})` : "ok"),
    );
  }

  // Semantic slots restored from the original dark theme.
  const semantic = [
    ["primary-foreground", dark.get("ivory"), "primary", dark.get("brand"), 4.5],
    [
      "secondary-foreground",
      dark.get("dark-warm"),
      "secondary",
      dark.get("warm-sand"),
      4.5,
    ],
    ["muted-foreground", dark.get("stone"), "muted", dark.get("warm-sand"), 4.5],
    [
      "accent-foreground",
      dark.get("brand"),
      "accent",
      dark.get("brand-tint"),
      4.5,
    ],
    [
      "sidebar-accent-foreground",
      dark.get("dark-warm"),
      "sidebar-accent",
      dark.get("warm-sand"),
      4.5,
    ],
    [
      "sidebar-primary-foreground",
      dark.get("ivory"),
      "sidebar-primary",
      dark.get("brand"),
      4.5,
    ],
    ["ring", dark.get("brand-light"), "background", dark.get("parchment"), 3],
    ["border", dark.get("line"), "background", dark.get("parchment"), 3],
    ["input", dark.get("border-soft"), "background", dark.get("parchment"), 3],
    ["card", dark.get("ivory"), "background", dark.get("parchment"), 1.1],
  ];
  console.log("\nsemantic dark pairs");
  for (const [fgName, fgHex, bgName, bgHex, floor] of semantic) {
    const d = contrast(fgHex, bgHex);
    const bad = d + 0.005 < floor;
    if (bad) fails += 1;
    console.log(
      `${fgName} on ${bgName}`.padEnd(38) +
        "     " +
        "  " +
        d.toFixed(2).padStart(5) +
        "  " +
        floor.toFixed(1).padStart(4) +
        "  " +
        (bad ? "BELOW(dark)" : "ok"),
    );
  }

  console.log("\nfile-type icon glyphs");
  const iconRe =
    /\.file-type-icon\[data-file-kind="([a-z]+)"\] \{\n([\s\S]*?)\n\}/g;
  for (const m of css.matchAll(iconRe)) {
    const bg = m[2].match(
      /background: light-dark\(\s*#[0-9a-fA-F]{6}\s*,\s*(#[0-9a-fA-F]{6})\s*\)/,
    );
    const fg = m[2].match(
      /color: light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)/,
    );
    if (!bg || !fg) continue;
    const d = contrast(fg[2], bg[1]);
    const bad = d + 0.005 < 3;
    if (bad) fails += 1;
    console.log(
      `${m[1]} glyph on chip`.padEnd(38) +
        "     " +
        "  " +
        d.toFixed(2).padStart(5) +
        "  " +
        "3.0".padStart(4) +
        "  " +
        (bad ? "BELOW(dark)" : "ok"),
    );
  }

  const bg = contrast(dark.get("ivory"), dark.get("parchment"));
  console.log(
    `\ncard vs background: ${bg.toFixed(2)} (dark card = flip of light page bg, dark page bg = flip of light card; cards sit above the background)`
  );
  console.log(`${fails} pair(s) below floor.`);
}

if (args.has("--check")) {
  process.exit(check(readCss()) === 0 ? 0 : 1);
}

if (args.has("--audit")) {
  audit(readCss());
  process.exit(0);
}

{
  const original = readCss();
  const originalTokens = lightTokens(original);
  let css = original;
  for (let i = 0; i < 6; i += 1) {
    const tokens = lightTokens(css);
    const rows = calibrate(tokens);
    const out = writeDerived(css, rows);
    if (out === css) break;
    css = out;
  }
  writeFileSync(CSS_PATH, css);
  const finalTokens = lightTokens(css);
  const finalRows = calibrate(finalTokens);
  const origV = new Map(
    originalTokens.map((t) => [t.name, rgbToHsv(parseHex(t.light))[2]]),
  );
  for (const r of finalRows) {
    r.v0 = origV.get(r.name) ?? r.v0;
    r.changed = Math.round(r.v0 * 255) !== Math.round(r.v * 255);
  }
  printCalibration(finalRows);
  console.log(
    `\nwrote ${finalRows.length} derived dark tokens, ${finalRows.filter((r) => r.changed).length} light calibration(s).`,
  );
}
