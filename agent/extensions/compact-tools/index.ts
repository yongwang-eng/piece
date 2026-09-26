import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstLine, formatDuration, SPINNER_FRAMES } from "./summary.ts";

type ToolName = "bash" | "edit" | "read" | "write";
type Args = Record<string, unknown>;

type ToolFactory = (cwd: string) => {
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => any;
};

const FACTORIES: Record<ToolName, ToolFactory> = {
  bash: createBashTool,
  edit: createEditTool,
  read: createReadTool,
  write: createWriteTool,
};

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

type Timing = { startedAt: number; endedAt?: number };

function title(tool: ToolName, args: Args, theme: any, timing: Timing | undefined, frame: number): string {
  const raw = tool === "bash" ? String(args.command ?? "…") : String(args.path ?? "…");
  const display = raw.startsWith(homedir()) ? `~${raw.slice(homedir().length)}` : raw;
  const target = display.length > 110 ? `${display.slice(0, 107)}…` : display;
  const prefix = tool === "bash" ? "$" : tool;
  const running = timing !== undefined && timing.endedAt === undefined;
  const bullet = running ? theme.fg("accent", SPINNER_FRAMES[frame % SPINNER_FRAMES.length]) : theme.fg("dim", "•");
  const clock = timing
    ? theme.fg(running ? "muted" : "dim", ` · ${formatDuration((timing.endedAt ?? Date.now()) - timing.startedAt)}`)
    : "";
  return `${bullet} ${theme.fg("dim", `${prefix} ${target}`)}${clock}`;
}

function expandedDetails(tool: ToolName, args: Args, output: string): string {
  if (output) return output;
  if (tool === "bash") return String(args.command ?? "");
  if (tool === "write") return String(args.content ?? "");
  if (tool === "edit") {
    return (Array.isArray(args.edits) ? args.edits : [])
      .map((edit: any) => `- ${edit.oldText ?? ""}\n+ ${edit.newText ?? ""}`)
      .join("\n");
  }
  return String(args.path ?? "");
}

export default function (pi: ExtensionAPI) {
  const timings = new Map<string, Timing>();

  pi.on("tool_execution_start", (event) => {
    timings.set(event.toolCallId, { startedAt: Date.now() });
  });
  pi.on("tool_execution_end", (event) => {
    const timing = timings.get(event.toolCallId);
    if (timing) timing.endedAt = Date.now();
  });
  // An aborted run can leave a tool mid-flight; freeze its clock so the next tick stops its spinner.
  const freeze = () => { for (const timing of timings.values()) timing.endedAt ??= Date.now(); };
  pi.on("agent_end", freeze);
  pi.on("session_shutdown", freeze);

  for (const tool of Object.keys(FACTORIES) as ToolName[]) {
    const factory = FACTORIES[tool];
    const prototype = factory(process.cwd());

    pi.registerTool({
      name: tool,
      label: tool,
      description: prototype.description,
      parameters: prototype.parameters as any,
      renderShell: "self",
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return factory(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall(rawArgs, theme, context) {
        const timing = timings.get(context.toolCallId);
        const state = context.state as { tick?: ReturnType<typeof setInterval>; frame?: number };
        const running = timing !== undefined && timing.endedAt === undefined;
        if (running && !state.tick) {
          // Drive the spinner + live clock on this line only while this call is in flight.
          state.frame = 0;
          state.tick = setInterval(() => {
            state.frame = (state.frame ?? 0) + 1;
            context.invalidate();
          }, 120);
          state.tick.unref?.();
        } else if (!running && state.tick) {
          clearInterval(state.tick);
          state.tick = undefined;
        }
        return new Text(title(tool, rawArgs as Args, theme, timing, state.frame ?? 0), 0, 0);
      },
      renderResult(result, options, theme, context) {
        const output = textOutput(result);
        if (options.isPartial) return new Text("", 0, 0);
        if (context.isError) return new Text(theme.fg("error", `✗ ${firstLine(output) || "failed"}`), 0, 0);
        if (!options.expanded) return new Text("", 0, 0);
        const details = expandedDetails(tool, context.args as Args, output);
        return new Text(details ? `\n${theme.fg("toolOutput", details)}` : "", 0, 0);
      },
    });
  }

}
