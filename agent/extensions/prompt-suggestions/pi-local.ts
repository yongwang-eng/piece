import { homedir } from "node:os";
import { join } from "node:path";
import {
	Editor,
	type Component,
	type EditorComponent,
	type EditorOptions,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";

export type InputSource = "interactive" | "rpc" | "extension";
export type WidgetPlacement = "aboveEditor" | "belowEditor";
export type AgentMessage = Message | BashExecutionMessage | CustomMessage | BranchSummaryMessage | CompactionSummaryMessage;

export interface AgentEndEvent {
	messages: AgentMessage[];
}

export interface InputEvent {
	source: InputSource;
}

export interface ExtensionAPI {
	on(event: "agent_end", handler: (event: AgentEndEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "input", handler: (event: InputEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_start" | "agent_start" | "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
}

export interface ExtensionContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
	cwd: string;
	modelRegistry: ModelRegistry;
	model: Model<any> | undefined;
	hasPendingMessages(): boolean;
}

export interface ExtensionUIContext {
	theme: Theme;
	setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: { placement?: WidgetPlacement }): void;
	setEditorComponent(factory: EditorFactory | undefined): void;
	getEditorText(): string;
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;
export type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export interface Theme {
	fg(style: string, text: string): string;
}

export interface KeybindingsManager {
	matches(data: string, action: string): boolean;
}

export interface ModelRegistry {
	getApiKeyAndHeaders(model: Model<any>): Promise<ResolvedRequestAuth>;
	find(provider: string, model: string): Model<any> | undefined;
}

type ResolvedRequestAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error?: string };

interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

// Preserves Pi app keybindings while avoiding a runtime dependency on the host package.
export class CustomEditor extends Editor {
	private readonly keybindings: KeybindingsManager;
	actionHandlers = new Map<string, () => void>();
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	onAction(action: string, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		if (this.onExtensionShortcut?.(data)) return;
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			super.handleInput(data);
			return;
		}
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
		}
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}
		super.handleInput(data);
	}
}

export function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? expandHomePath(envDir) : join(homedir(), ".pi", "agent");
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message) => {
		switch (message.role) {
			case "bashExecution":
				return message.excludeFromContext
					? []
					: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: bashExecutionToText(message) }],
								timestamp: message.timestamp,
							},
						];
			case "custom":
				return [
					{
						role: "user" as const,
						content: typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content,
						timestamp: message.timestamp,
					},
				];
			case "branchSummary":
				return [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: message.timestamp,
					},
				];
			case "compactionSummary":
				return [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX }],
						timestamp: message.timestamp,
					},
				];
			case "user":
			case "assistant":
			case "toolResult":
				return [message];
			default:
				return [];
		}
	});
}

function bashExecutionToText(message: BashExecutionMessage): string {
	let text = `Ran \`${message.command}\`\n`;
	text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
	if (message.cancelled) text += "\n\n(command cancelled)";
	else if (message.exitCode !== null && message.exitCode !== undefined && message.exitCode !== 0) {
		text += `\n\nCommand exited with code ${message.exitCode}`;
	}
	if (message.truncated && message.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
	}
	return text;
}

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}
