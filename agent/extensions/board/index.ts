/**
 * board — the ONE widget below the input. Producers publish a Section through the typed Board (lib/agent-ui/sections.ts);
 * this host renders them in a fixed ORDER, so a section that repaints never jumps (pi's setWidget re-inserts a key at the
 * end; the old `*:painted` repaint chain only held while every producer listened to every other).
 * Also ONE toggle (Yong, 2026-09-17: "one expand and a collapse … every section will be toggled"). Default expanded;
 * `ctrl+]` flips; data sections fold here, `render` producers listen on `board:fold` and publish their one-row summary.
 * And per-section off (`/board off|on|only <id>`): visible = has items AND not switched off; an off section that has
 * items is named in one dim tell line. Fold and off are per process, on purpose: a fold you cannot see is a worker you
 * think is gone.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { linkMark, linkText, styledRow, type Palette, type Row } from "../../lib/agent-ui/board.ts";
import { hexUnderline, linkUnderline } from "../../lib/agent-ui/identity.ts";
import { showPanel } from "../../lib/agent-ui/panel-ui.ts";
import { sectionLines } from "../../lib/agent-ui/section.ts";
import { compose, hostBoard, switchOff, type Section } from "../../lib/agent-ui/sections.ts";

export default function (pi: ExtensionAPI) {
  let folded = false;
  let off = new Set<string>();
  let ui: { hasUI?: boolean; ui: { setWidget: (k: string, v: unknown, o?: { placement: "belowEditor" }) => void } } | undefined;
  let current: Section[] = [];
  const paletteOf = (theme: any): Palette => ({ fg: (t, x) => theme.fg(t, x), bold: (x) => theme.bold(x), link: getCapabilities().hyperlinks ? hyperlink : undefined });
  const repaint = () => {
    if (!ui?.hasUI) return;
    if (!current.length) { ui.ui.setWidget("board", undefined); return; }
    const sections = current, opts = { folded, off };
    ui.ui.setWidget("board", (_tui: unknown, theme: any) => ({ render: (width: number) => compose(sections, width, paletteOf(theme), opts), invalidate() {} }), { placement: "belowEditor" });
  };
  const host = hostBoard(pi, (sections) => { current = sections; repaint(); });
  pi.on("session_start", async (_e, ctx) => { ui = ctx as any; host.ready(); repaint(); });
  pi.on("session_shutdown", async () => { host.dispose(); ui?.ui.setWidget("board", undefined); ui = undefined; });
  type Ctx = { ui?: { notify?: (t: string, k?: string) => void } };
  const set = (v: boolean, ctx?: Ctx) => {
    folded = v;
    pi.events.emit("board:fold", { folded });
    repaint();
    ctx?.ui?.notify?.(folded ? "board folded — ctrl+] to expand" : "board expanded", "info");
  };
  pi.registerShortcut("ctrl+]", { description: "Fold / expand every status section below the input", handler: async (ctx) => set(!folded, ctx as any) });
  pi.registerCommand("board", {
    description: "board fold | expand | toggle — every status section at once (ctrl+]) · off <id> | on [id] | only <id> — per section · demo = a swatch of every row and link style",
    handler: async (args, ctx) => {
      const [verb, id] = (args ?? "").trim().split(/\s+/);
      if (verb === "demo") { await showPanel(ctx as any, (inner, theme) => demoLines(theme, inner)); return; }
      if (verb === "on" || verb === "off" || verb === "only") {
        const r = switchOff(off, verb, id || undefined, current.map((s) => s.id));
        off = r.off; repaint();
        (ctx as Ctx).ui?.notify?.(r.message, r.ok ? "info" : "warning");
        return;
      }
      set(verb === "fold" ? true : verb === "expand" ? false : !folded, ctx as Ctx);
    },
  });

  // A sample sheet, rendered by the real renderer: every attention level, both link kinds, folded form, inline URLs. Peeked, never kept.
  const demoLines = (theme: any, width: number): string[] => {
    const pal: Palette = { fg: (t, x) => theme.fg(t, x), bold: (x) => theme.bold(x), link: getCapabilities().hyperlinks ? hyperlink : undefined };
    const url = "https://app.devin.ai/sessions/508f299565d64c2aa0e551a8ccf9431a", prUrl = "https://github.com/acme/app/pull/73061";
    const rows: Row[] = [
      { name: "reviewer", pane: "%5", state: "waiting", detail: "waiting on YOU · merge #73061?", ageMs: 95_000, waiting: { on: "you", why: "merge?", sinceMs: 95_000 }, url, prUrl },
      { name: "historian", pane: "%7", state: "stalled", detail: "thinking 4m · no tokens", ageMs: 240_000, url },
      { name: "sqs-kept-causes-spec", pane: "devin", state: "working", detail: "opened PR #73061 · CI running", ageMs: 1_800_000, url, prUrl },
      { name: "implementer", pane: "%6", state: "tool", detail: "bash · npm test", ageMs: 12_000, url },
      { name: "pr73061_ci", pane: "bg", state: "working", detail: "00:45Z 73061=OPEN checks=pending", ageMs: 600_000, url: "file:///tmp/pi-bg/pr73061_ci.log" },
      { name: "monitors-production", pane: "devin", state: "idle", detail: "paused · All five replies posted verbatim", ageMs: 7_200_000, url },
      { name: "researcher", pane: "%8", state: "done", detail: "reported · 3 findings", ageMs: 3_600_000, url },
      { name: "gone-worker", pane: "%9", state: "gone", detail: "left the room", ageMs: 60_000 },
    ];
    // one row that SAYS something: every body part, as a bg job's .board.json would hand it (lib/agent-ui/section.ts)
    const k6: Row = { name: "k6_burst", pane: "bg", state: "working", detail: "k6-20260918T222100Z · 300/s vs staging_key", ageMs: 252_000, url: "file:///tmp/pi-bg/k6_burst.log", body: {
      progress: { value: 0.42, label: "4m12 / 10m · ~5m48" },
      stats: [{ label: "rps", value: "298" }, { label: "p95", value: "412ms" }, { label: "fail", value: "0.8%" }, { label: "VUs", value: "610/1200" }, { label: "429s", value: "24" }, { label: "dropped", value: "0", tone: "quiet" }],
      series: { label: "rps", points: Array.from({ length: 60 }, (_, i) => (i === 41 ? 120 : 250 + Math.round(60 * Math.abs(Math.sin(i / 7))))), unit: "/s" },   // a shape: 250–310 with one dip
      links: [{ label: "log", url: "file:///tmp/pi-bg/k6_burst.log" }, { label: "dashboard", url: "https://app.datadoghq.com/dashboard/REPLACE-ME" }, { label: "events", url: "https://app.datadoghq.com/logs?query=k6-burst" }, { label: "k6-20260918T222100Z", url: "file:///tmp/k6_k6-20260918T222100Z.json" }],
    } };
    const link = (label: string, u: string) => pal.link ? pal.link(linkMark(label), u) : label;
    const demo = { title: "demo", noun: "row", hint: "/board demo", rows: [...rows.slice(0, 3), k6] };
    const lines = [
      theme.fg("dim", "── rows, one per attention level (name = link · #N = link) ──"),
      ...rows.map((r) => styledRow(r, width, pal)),
      "",
      theme.fg("dim", "── a data section with one row that says something, expanded then folded ──"),
      ...sectionLines(demo, width, pal, false),
      ...sectionLines(demo, width, pal, true),
      "",
      theme.fg("dim", "── underline styles (SGR 4:n, same slate) — linkMark uses 4:4 ──"),
      ["1 single", "2 double", "3 curly", "4 dotted", "5 dashed"].map((n) => hexUnderline(theme.fg("text", n.slice(2)), linkUnderline(), Number(n[0]))).join("    ") + theme.fg("dim", `   underline ${linkUnderline()} (derived from theme)`),
      "",
      theme.fg("dim", "── links in prose: always accent + mark (linkText) ──"),
      `${theme.fg("text", "Devin opened ")}${linkText(pal, "github.com/acme/app/pull/73061", prUrl)}${theme.fg("text", " and paused; the plan is in ")}${linkText(pal, "plan.md", "file:///Users/me/.pi/agent/AGENTS.md")}${theme.fg("text", ", the grammar in ")}${linkText(pal, "status_grammar", "obsidian://open?vault=obsidian_notes&file=pi%2Fdesign%2Fstatus_grammar")}${theme.fg("text", ".")}`,
      `${theme.fg("muted", "muted prose with a link: see ")}${linkText(pal, "session 508f2995", url)}${theme.fg("muted", " for the trail.")}`,
      `${theme.fg("text", "control — bare OSC 8, no mark, text colour: ")}${pal.link ? pal.link("clickable but unmarked", url) : "clickable but unmarked"}`,
    ];
    return lines;
  };
  // A producer that loads after us asks for the current state.
  pi.events.on("board:fold?", () => pi.events.emit("board:fold", { folded }));
}
