/**
 * Pure helpers for the thought ticker: turn an accumulating thinking buffer into
 * a compact "thinking area" — a trail of reasoning phases plus the live tail of
 * the current one.
 *
 * OpenAI reasoning summaries arrive as parts separated by "\n\n" (pi-ai appends
 * that on `reasoning_summary_part.done`), each usually opening with a bold
 * headline. Anthropic-style raw thinking has no headlines; we fall back to the
 * last sentence(s).
 */

const SENTENCE_END = /(?<=[.!?])\s+|\n{2,}/;
const HEADLINE = /^\s*\*\*(.+?)\*\*\s*$/;

export interface Step {
  /** Phase headline without markdown, or undefined when the part has none. */
  title?: string;
  /** Remaining prose of the part (may be empty). */
  body: string;
}

/** Split the thinking buffer into reasoning parts; a part = headline + body. */
export function parseSteps(buffer: string): Step[] {
  return buffer
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [first, ...rest] = part.split("\n");
      const match = first.match(HEADLINE);
      if (match) return { title: match[1].trim(), body: rest.join(" ").trim() };
      return { body: part };
    });
}

/** Last `maxSentences` complete-ish sentences of `text`, whitespace-normalized. */
export function tail(text: string, maxSentences = 2): string {
  const parts = text
    .split(SENTENCE_END)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.slice(-maxSentences).join(" ");
}

/** Greedy word-wrap into at most `maxLines` lines of `width` columns, keeping the END of the text. */
export function wrapTail(text: string, width: number, maxLines: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.length > width ? `${word.slice(0, Math.max(1, width - 1))}…` : word;
    }
  }
  if (current) lines.push(current);
  const kept = lines.slice(-maxLines);
  if (kept.length < lines.length && kept[0]) kept[0] = `…${kept[0].slice(1)}`;
  return kept;
}

export function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

export function formatStepDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function formatSilence(silentMs: number): string {
  return `(no reasoning stream for ${Math.floor(silentMs / 1000)}s — model is thinking silently)`;
}

export interface TrailLine {
  kind: "done" | "current" | "tail" | "silence";
  text: string;
}

/**
 * Build the thinking area. `stepStarts[i]` = wall-clock ms when part i began;
 * `now` is used for the running step. Returns at most `maxLines` lines.
 */
export function buildTrail(
  steps: Step[],
  stepStarts: number[],
  now: number,
  width: number,
  maxLines: number,
  lastDeltaAt: number,
  silenceAfterMs: number,
): TrailLine[] {
  const lines: TrailLine[] = [];
  const titled = steps.filter((s) => s.title);

  if (titled.length === 0) {
    // Raw-thinking fallback: just the sentence tail.
    const text = tail(steps.map((s) => s.body).join(" "));
    for (const t of wrapTail(text, width - 2, Math.max(1, maxLines - 1))) lines.push({ kind: "tail", text: t });
  } else {
    const current = steps[steps.length - 1];
    const doneSteps = steps.slice(0, -1).filter((s) => s.title);
    for (const step of doneSteps.slice(-(maxLines - 2))) {
      const i = steps.indexOf(step);
      const next = stepStarts[i + 1] ?? now;
      // Summaries are flushed late and sometimes together; a sub-2s gap is an artifact, not a phase length.
      const gap = stepStarts[i] !== undefined ? next - stepStarts[i] : 0;
      const dur = gap >= 2_000 ? ` · ${formatStepDuration(gap)}` : "";
      lines.push({ kind: "done", text: clip(`▸ ${step.title}${dur}`, width) });
    }
    if (current.title) {
      lines.push({ kind: "current", text: clip(`● ${current.title}`, width) });
      const body = tail(current.body, 1);
      if (body) lines.push({ kind: "tail", text: clip(`  …${body}`, width) });
    } else {
      const body = tail(current.body, 1);
      if (body) lines.push({ kind: "current", text: clip(`● ${body}`, width) });
    }
  }

  const silentMs = now - lastDeltaAt;
  if (lastDeltaAt && silentMs > silenceAfterMs) {
    lines.push({ kind: "silence", text: formatSilence(silentMs) });
  }
  return lines.slice(-maxLines);
}

/** Tools whose rendered call IS the answer Yong reads (`waiting_on_you` paints the ◆ card). A turn that ends on one of these
 *  is not silent — nudging it forces a "(Waiting on you.)" line under the card, the exact noise the card exists to remove. */
export const ANSWERING_TOOLS = new Set(["waiting_on_you"]);
export const paintsAnswer = (toolName: string): boolean => ANSWERING_TOOLS.has(toolName);
