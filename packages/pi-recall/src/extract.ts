// Round 3: index what the model saw, as it saw it — `message` + `custom_message` lines; not thinking, not compaction
// summaries, not `custom` bookkeeping. Returns null for anything that is not a document.
export type Doc = { key: string; entry_id: string; parent_id: string | null; ts: string; role: string; kind: "user" | "assistant" | "tool_output" | "system"; tool: string | null; text: string };

export const MAX_CHARS = 50_000;   // guard, not a target: pi's own read tool truncates at 50 KB
export const CHUNK = 1200;         // what every eval (015b–017) was measured on — change it and the ratchet is void

const blockText = (b: any): string => {
  if (typeof b === "string") return b;
  switch (b?.type) {
    case "text": return b.text ?? "";
    case "toolCall": return `${b.name} ${JSON.stringify(b.arguments ?? b.input ?? "")}`;
    case "image": return "[image]";
    default: return "";             // thinking, signatures, unknown blocks
  }
};
const flatten = (c: unknown): string => (Array.isArray(c) ? c.map(blockText).filter(Boolean).join("\n") : typeof c === "string" ? c : "");

export function extract(e: any): Doc | null {
  if (!e || typeof e.id !== "string" || typeof e.timestamp !== "string") return null;
  let role: string, kind: Doc["kind"], text: string, tool: string | null = null;
  if (e.type === "message") {
    const m = e.message ?? {};
    switch (m.role) {
      case "user": role = "user"; kind = "user"; break;
      case "assistant": role = "assistant"; kind = "assistant"; break;
      case "toolResult": role = "toolResult"; kind = "tool_output"; tool = m.toolName ?? null; break;
      default: return null;         // bashExecution and future roles: not a conversation turn
    }
    text = flatten(m.content);
  } else if (e.type === "custom_message") {
    role = e.customType ?? "custom_message"; kind = "system"; text = flatten(e.content);
  } else return null;
  text = text.trim();
  if (!text) return null;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
  return { key: `${e.id}@${e.timestamp}`, entry_id: e.id, parent_id: e.parentId ?? null, ts: e.timestamp, role, kind, tool, text };
}

// Fixed 1 200-char chunks snapped back to a newline when one falls in the second half; no overlap, no cap on count.
export function chunk(text: string, size = CHUNK): { ci: number; start: number; end: number; text: string }[] {
  const out = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) { const nl = text.lastIndexOf("\n", end); if (nl > i + size / 2) end = nl; }
    out.push({ ci: out.length, start: i, end, text: text.slice(i, end) });
    i = end;
  }
  return out;
}
