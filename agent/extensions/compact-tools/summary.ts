export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Per-step duration: sub-10s keeps a decimal so quick tools still read as distinct. */
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds);
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function lineCount(text: string): number {
  const lines = text.trimEnd();
  return lines ? lines.split("\n").length : 0;
}

export function summarize(tool: string, args: Record<string, unknown>, output: string): string {
  switch (tool) {
    case "read":
      return `${lineCount(output)} lines`;
    case "bash":
      return "done";
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits.length : 1;
      return `${edits} edit${edits === 1 ? "" : "s"} applied`;
    }
    case "write":
      return `${lineCount(String(args.content ?? ""))} lines written`;
    default:
      return "done";
  }
}
