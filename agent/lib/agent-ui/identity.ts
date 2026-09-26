/**
 * Worker identity rendering — the SAME identity, in the SAME colour, on every surface (pane border label,
 * footer, main's board row). Pure; no pi imports.
 *
 * Colour is stable per worker (#N mod palette), never derived from pane position — a worker keeps its colour
 * all day while panes open and close around it. Red is reserved for attention (◆ blocked / stalled).
 *
 * This file is also the ONE home of every hard-coded colour in our UI (see the block below); a hex elsewhere fails a test.
 */

import { readFileSync } from "node:fs";

export interface Identity {
  id?: number;
  name: string;
  role?: string;
  presence?: string;      // starting | idle | working | blocked | stalled | gone
  run?: string;
  model?: string;
  tools?: number;
  elapsedText?: string;
}

// ── The ONLY hard-coded colours our UI paints. Everything else is a theme tone (theme.fg("accent" | "dim" | …)).
// Two kinds earn a hex: IDENTITY (this worker, this model — stable, many distinct hues the theme cannot supply) and
// DECORATION (the link underline — no theme tone exists), and decorations DERIVE from the active theme's vars below.

/** 6 distinguishable hues on both dark and light terminals; red deliberately absent (attention only). */
export const PALETTE = ["#89b4fa", "#a6e3a1", "#f9e2af", "#cba6f7", "#94e2d5", "#fab387"] as const;
export const ATTENTION = "#f38ba8";
export const COMPACTING = "#f9e2af";
export const INK_DARK = "#1e1e2e";
/** tmux tab dot (lib/tmux-dot): working breathes green→dim, blocked is a solid attention-red ◆, unread is peach. */
export const DOT_COLORS = { working: ["#a6e3a1", "#577a5b"], blocked: [ATTENTION, ATTENTION], unread: ["#fab387", "#fab387"] } as const;

/** One fixed colour per model Yong runs, so a glance at the footer says which one without reading. */
export const MODEL_COLORS: Record<string, string> = {
  "claude-fable-5-1": "#d97757",   // Claude's icon orange — the default
  "claude-fable-5": "#5fb3a1",     // teal — far from the default's orange so the two fables never blur
  "claude-opus-5": "#b294bb",      // lavender
  "claude-sonnet-5": "#6fa8dc",    // sky
  "gpt-6-astra": "#8fbf6f",        // green
  "gpt-5.6-sol": "#d4b35a",        // gold
  "gpt-5.6-terra": "#a8785a",      // rust-brown
};
const MODEL_FALLBACK = ["#d78fb0", "#7fb8c9", "#c9b87f", "#9fb87f", "#b89fd1", "#d1a08f"];

const hash = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

export function colorFor(id: number | undefined, name = ""): string {
  const hex = id && id > 0 ? PALETTE[(id - 1) % PALETTE.length] : PALETTE[hash(name) % PALETTE.length];   // no id yet → stable on the name
  return themeVars().light ? mix(hex, "#000000", 0.35) : hex;   // pastels vanish on a light canvas; deepen them there
}

export function modelColorFor(modelId: string): string { return MODEL_COLORS[modelId] ?? MODEL_FALLBACK[hash(modelId) % MODEL_FALLBACK.length]; }

/** Truecolor foreground for a hex; the one place the SGR 38;2 sequence is spelled out. */
export const hexFg = (text: string, hex: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m${text}\x1b[39m`;

/** Dotted underline in a hex colour (SGR 4:4 + 58;2); the one place that sequence is spelled out. */
export const hexUnderline = (text: string, hex: string, style = 4) => `\x1b[4:${style}m\x1b[58;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m${text}\x1b[59m\x1b[24m`;

/** Linear mix in sRGB, t of the way from a to b. */
export function mix(a: string, b: string, t: number): string {
  const c = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(c(a, i) + (c(b, i) - c(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

/** The active theme's vars (settings.json → themes/<name>.json; tone → var → hex), read once. Fallbacks = yong-claude-quiet. */
export function themeVars(): { canvas: string; quiet: string; accent: string; light: boolean } {
  if (_vars) return _vars;
  const fb = { canvas: "#14191e", quiet: "#737373", accent: "#79c0ff" };
  try {
    const root = `${process.env.HOME}/.pi/agent`;
    const name = JSON.parse(readFileSync(`${root}/settings.json`, "utf8")).theme as string;
    const t = JSON.parse(readFileSync(`${root}/themes/${name}.json`, "utf8")) as { vars?: Record<string, string>; colors?: Record<string, string> };
    const hex = (key: string) => { const v = t.colors?.[key] ?? t.vars?.[key] ?? ""; return /^#[0-9a-f]{6}$/i.test(v) ? v : t.vars?.[v] ?? ""; };
    const canvas = hex("canvas") || hex("background") || fb.canvas, quiet = hex("dim") || fb.quiet, accent = hex("accent") || fb.accent;
    _vars = { canvas, quiet, accent, light: luminance(canvas) > 0.5 };
  } catch { _vars = { ...fb, light: false }; }
  return _vars;
}
let _vars: ReturnType<typeof themeVars> | undefined;
const luminance = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);

/** The link underline: halfway from the canvas to the quiet/accent midpoint — visible, never louder than dim text. */
export const linkUnderline = () => { const v = themeVars(); return mix(v.canvas, mix(v.quiet, v.accent, 0.5), 0.5); };

export const GLYPH: Record<string, string> = { starting: "◌", idle: "○", working: "●", tool: "⚙", compacting: "◐", blocked: "◆", stalled: "◆", gone: "✕" };

export function needsAttention(presence?: string): boolean { return presence === "blocked" || presence === "stalled"; }

/** `#2 beta` — the short handle used everywhere. */
export function handle(i: Identity): string { return `${i.id ? `#${i.id} ` : ""}${i.name}`; }

/** The tmux pane border label — the worker's TAB. Role only when it adds information (role ≠ name, D45). */
export function paneTitle(i: Identity): string {
  const g = GLYPH[i.presence ?? "idle"] ?? "○";
  const role = i.role && i.role !== i.name && i.role.replace(/[^a-z0-9]+/gi, "-").toLowerCase() !== i.name ? i.role : undefined;
  return [`${g} ${handle(i)}`, role, i.presence && i.presence !== "idle" && i.presence !== "working" ? i.presence : undefined].filter(Boolean).join(" · ");
}

/**
 * Per-pane tmux `pane-border-format`: a highlighted block in the worker's colour (red when it needs attention), like the
 * active-pane tab in Yong's global format — a worker pane is never the active one, so without this it renders dim.
 */
export function paneBorderFormat(i: Identity): string {
  const bg = needsAttention(i.presence) ? ATTENTION : i.presence === "compacting" ? COMPACTING : colorFor(i.id, i.name);
  return `#[fg=${INK_DARK},bg=${bg},bold] #{pane_title} #[default]`;
}

/**
 * Footer segments in MAIN's footer shape (compact-footer): handle · model · context · cost · turns · uptime.
 * The handle is plain bold in the worker's colour — the highlight lives on the tab (paneBorderFormat), not here.
 */
export function footerParts(i: Identity & { contextText?: string; costText?: string; turns?: number }): string[] {
  return [
    handle(i),
    i.model ? i.model.replace(/^[^/]+\//, "") : "",
    i.contextText ?? "",
    i.costText ?? "",
    i.turns !== undefined ? `${i.turns} turn${i.turns === 1 ? "" : "s"}` : "",
    i.elapsedText ? `↑ ${i.elapsedText}` : "",
  ].filter(Boolean);
}

/** tmux `pane-border-style` (the border LINES): worker colour normally, attention red when blocked/stalled. */
export function paneBorderStyle(i: Identity): string {
  const c = needsAttention(i.presence) ? ATTENTION : i.presence === "compacting" ? COMPACTING : colorFor(i.id, i.name);
  return `fg=${c}`;
}
