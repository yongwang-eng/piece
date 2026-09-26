import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { completeSimple, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	convertToLlm,
	getAgentDir,
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type InputSource,
} from "./pi-local.ts";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { UnmarkedPasteGuard } from "./paste-guard.ts";

const WIDGET_KEY = "next-prompt-suggestion";
const DEFAULT_MAX_CHARS = 80;
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_MODEL = "openai/gpt-5-mini";
const GLOBAL_CONFIG_RELATIVE_PATH = ["extensions", "prompt-suggestions", "config.json"];
const PROJECT_CONFIG_RELATIVE_PATH = [".pi", "prompt-suggestions.json"];
const PROMPT_RELATIVE_PATH = ["prompts", "suggestion-system-prompt.md"];
const GHOST_CURSOR = "\x1b[7m \x1b[0m";
type GhostStyler = (text: string) => string;
const fallbackGhostStyler: GhostStyler = (text) => `\x1b[90m${text}\x1b[39m`;
const ALLOWED_SINGLE_WORD_SUGGESTIONS = new Set([
	"yes",
	"yeah",
	"yep",
	"yea",
	"yup",
	"sure",
	"ok",
	"okay",
	"push",
	"commit",
	"deploy",
	"stop",
	"continue",
	"check",
	"exit",
	"quit",
	"no",
]);

type SuggestionDisplayMode = "ghost" | "belowEditor";

interface PromptSuggestionsConfig {
	enabled: boolean;
	acceptTab: boolean;
	display: SuggestionDisplayMode;
	maxChars: number;
	maxTokens: number;
	model?: string;
}

type PromptSuggestionsConfigInput = Partial<PromptSuggestionsConfig>;
type PiMode = "tui" | "rpc" | "json" | "print";
type MaybeModeContext = ExtensionContext & { mode?: PiMode };

let suggestion: string | undefined;
let generationId = 0;
let lastCtx: ExtensionContext | undefined;
let lastInputSource: InputSource | undefined;
let currentConfig: PromptSuggestionsConfig = mergeConfigInputs();
let currentEditor: SuggestionEditor | undefined;

class SuggestionEditor extends CustomEditor {
	private readonly pasteGuard = new UnmarkedPasteGuard();

	requestRender(): void {
		this.tui.requestRender(true);
	}

	cancelPendingInput(): void {
		this.pasteGuard.cancel();
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (currentConfig.display !== "ghost" || !suggestion || this.getText().length > 0) return lines;
		return renderGhostSuggestionLines(
			lines,
			width,
			suggestion,
			(text) => lastCtx?.ui.theme.fg("muted", text) ?? fallbackGhostStyler(text),
		);
	}

	handleInput(data: string): void {
		if (this.getText().length === 0 && suggestion) {
			if (matchesKey(data, Key.right) || (currentConfig.acceptTab && matchesKey(data, Key.tab))) {
				this.setText(suggestion);
				clearSuggestion();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				this.setText(suggestion);
				clearSuggestion();
				super.handleInput(data);
				return;
			}
		}

		if (suggestion && isUserEditKey(data)) {
			clearSuggestion();
		}

		if (this.pasteGuard.handle(data, (input) => super.handleInput(input))) return;
		super.handleInput(data);
	}
}

export default function promptSuggestions(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		currentConfig = loadConfig(ctx.cwd, (message) => debug(ctx, message));
		lastInputSource = undefined;
		clearSuggestion(ctx);
		if (!isSuggestionContextSupported(ctx, lastInputSource)) {
			currentEditor = undefined;
			return;
		}
		// Intentional: ghost-text rendering owns the editor component while enabled.
		// This may replace another custom editor extension; use belowEditor display to avoid that tradeoff.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			currentEditor = new SuggestionEditor(tui, theme, keybindings);
			return currentEditor;
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		clearSuggestion(ctx);
	});

	pi.on("input", (event, ctx) => {
		lastCtx = ctx;
		lastInputSource = event.source;
		clearSuggestion(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearSuggestion(ctx);
		currentEditor?.cancelPendingInput();
		if (isSuggestionContextSupported(ctx, lastInputSource)) ctx.ui.setEditorComponent(undefined);
		currentEditor = undefined;
		lastCtx = undefined;
		lastInputSource = undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		lastCtx = ctx;
		clearSuggestion(ctx);
		if (!isSuggestionContextSupported(ctx, lastInputSource)) return;

		const config = loadConfig(ctx.cwd, (message) => debug(ctx, message));
		if (!config.enabled) return debug(ctx, "skipped: disabled by config");
		if (!ctx.hasUI) return;
		if (ctx.hasPendingMessages()) return debug(ctx, "skipped: pending messages");
		if (ctx.ui.getEditorText().trim().length > 0) return debug(ctx, "skipped: editor is not empty");

		const model = resolveSuggestionModel(ctx, config.model);
		if (!model) return debug(ctx, "skipped: no model selected");

		const id = ++generationId;
		debug(ctx, "generating...");

		try {
			const text = await generateSuggestion(event.messages, ctx, model, config);
			debug(ctx, `raw: ${JSON.stringify(truncatePlain(text, 160))}`);
			if (id !== generationId) return debug(ctx, "ignored: stale result");
			if (ctx.hasPendingMessages()) return debug(ctx, "ignored: pending messages appeared");
			if (ctx.ui.getEditorText().trim().length > 0) return debug(ctx, "ignored: editor became non-empty");

			const clean = sanitizeSuggestion(text, config.maxChars);
			if (!clean) return debug(ctx, `rejected: ${JSON.stringify(truncatePlain(text, 160))}`);

			showSuggestion(clean, ctx);
			debug(ctx, `shown: ${clean}`);
		} catch (error) {
			debug(ctx, `error: ${error instanceof Error ? error.message : String(error)}`);
			// Suggestion generation is best-effort and must never interrupt normal use.
		}
	});
}

function clearSuggestion(ctx = lastCtx): void {
	const hadSuggestion = suggestion !== undefined;
	generationId++;
	suggestion = undefined;
	if (!ctx || !isSuggestionContextSupported(ctx, lastInputSource)) return;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	if (hadSuggestion && currentConfig.display === "ghost") currentEditor?.requestRender();
}

function isSuggestionContextSupported(ctx: ExtensionContext, inputSource?: InputSource): boolean {
	return isSuggestionModeSupported(getContextMode(ctx), inputSource, ctx.hasUI);
}

function isSuggestionModeSupported(mode: PiMode | undefined, inputSource?: InputSource, hasUI = true): boolean {
	if (mode !== undefined) return mode === "tui";
	if (!hasUI) return false;
	return inputSource !== "rpc";
}

function getContextMode(ctx: ExtensionContext): PiMode | undefined {
	const mode = (ctx as MaybeModeContext).mode;
	if (mode === "tui" || mode === "rpc" || mode === "json" || mode === "print") return mode;
	return getCliMode();
}

function getCliMode(): PiMode | undefined {
	for (let index = 0; index < process.argv.length; index++) {
		const arg = process.argv[index];
		const value = arg === "--mode" ? process.argv[index + 1] : arg.startsWith("--mode=") ? arg.slice("--mode=".length) : undefined;
		if (value === "rpc" || value === "json") return value;
		if (value === "text") return "print";
		if (arg === "--print" || arg === "-p") return "print";
	}
	return undefined;
}

function showSuggestion(text: string, ctx = lastCtx): void {
	clearSuggestion(ctx);
	suggestion = text;
	renderSuggestion(ctx);
}

function renderSuggestion(ctx = lastCtx): void {
	if (!ctx || !suggestion) return;
	currentConfig = loadConfig(ctx.cwd, (message) => debug(ctx, message));
	if (currentConfig.display === "ghost") {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		currentEditor?.requestRender();
		return;
	}
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render: (width: number) => [truncateToWidth(theme.fg("dim", `→ ${suggestion}`), width)],
			invalidate: () => {},
		}),
		{ placement: "belowEditor" },
	);
}

function renderGhostSuggestionLines(
	lines: string[],
	width: number,
	text: string,
	styleGhost: GhostStyler = fallbackGhostStyler,
): string[] {
	const contentLineIndex = lines.length >= 3 ? 1 : lines.findIndex((line) => line.includes(GHOST_CURSOR));
	if (contentLineIndex === -1) return lines;

	const available = Math.max(0, width - 1);
	const ghost = styleGhost(truncateToWidth(text, available));
	const rendered = GHOST_CURSOR + ghost;
	return lines.map((line, index) =>
		index === contentLineIndex ? rendered + " ".repeat(Math.max(0, width - visibleWidth(rendered))) : line,
	);
}

async function generateSuggestion(
	messages: AgentEndEvent["messages"],
	ctx: ExtensionContext,
	model: Model<any>,
	config: PromptSuggestionsConfig,
): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		debug(ctx, `auth unavailable: ${"error" in auth ? auth.error : "unknown error"}`);
		return "";
	}

	const llmMessages = convertToLlm(messages);
	const context = buildSuggestionContext(llmMessages);
	debug(ctx, `context: ${JSON.stringify(truncatePlain(context, 240))}`);
	const options = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		maxTokens: config.maxTokens,
		reasoning: model.reasoning ? ("minimal" as const) : undefined,
	};

	const response = await completeSimple(
		model,
		{
			systemPrompt: loadSuggestionSystemPrompt(ctx.cwd, (message) => debug(ctx, message)),
			messages: [
				{
					role: "user",
					content: context,
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	debug(
		ctx,
		`response: ${response.stopReason}; ${response.content.map((part) => part.type).join(",")}; ${response.errorMessage ?? ""}`,
	);
	if (response.diagnostics?.length) {
		debug(ctx, `diagnostics: ${JSON.stringify(response.diagnostics).slice(0, 500)}`);
	}
	return extractAssistantText(response);
}

function loadSuggestionSystemPrompt(cwd: string, onWarning?: (message: string) => void): string {
	const packagePromptPath = join(resolvePackageRoot(cwd), ...PROMPT_RELATIVE_PATH);
	try {
		return readFileSync(packagePromptPath, "utf-8").trim();
	} catch (error) {
		onWarning?.(`prompt load failed: ${packagePromptPath}: ${error instanceof Error ? error.message : String(error)}`);
		return FALLBACK_SUGGESTION_SYSTEM_PROMPT;
	}
}

function resolvePackageRoot(cwd: string): string {
	if (existsSync(join(import.meta.dirname, ...PROMPT_RELATIVE_PATH))) return import.meta.dirname;

	let dir = import.meta.dirname;
	while (dir !== join(dir, "..")) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "index.ts"))) return dir;
		dir = join(dir, "..");
	}
	return cwd;
}

const FALLBACK_SUGGESTION_SYSTEM_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into pi.]\n\nReply with only a short natural next prompt, or nothing if unclear.`;

function buildSuggestionContext(messages: Message[]): string {
	const recent = messages.slice(-8).map(formatMessageForSuggestion).filter(Boolean);
	return `Recent conversation from the just-finished agent turn:\n\n${recent.join("\n\n")}`;
}

function formatMessageForSuggestion(message: Message): string {
	const role = getMessageRole(message);
	const text = extractMessageText(message).trim();
	if (!text) return `${role}: [no text]`;
	return `${role}: ${truncatePlain(text, 2_000)}`;
}

function getMessageRole(message: unknown): string {
	if (isRecord(message) && typeof message.role === "string") return message.role;
	if (isRecord(message) && typeof message.type === "string") return message.type;
	return "message";
}

function extractMessageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(message);
	return content
		.map((part) => {
			if (!isRecord(part) || typeof part.type !== "string") return "";
			if (part.type === "text" && typeof part.text === "string") return part.text;
			if (part.type === "thinking") return "";
			if (part.type === "toolCall" && typeof part.name === "string") return `[tool call: ${part.name}]`;
			if (part.type === "image") return "[image]";
			return "";
		})
		.join("\n");
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function sanitizeSuggestion(text: string, maxChars = DEFAULT_MAX_CHARS): string | undefined {
	let clean = text.trim();
	if (!clean) return undefined;
	if (clean.includes("\n")) return undefined;

	clean = clean.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
	clean = clean.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim();
	clean = clean.replace(/\.$/, "").trim();

	if (!clean) return undefined;
	if (clean.length > maxChars) return undefined;
	if (clean.endsWith("?")) return undefined;
	if (/[.!?].+\S/.test(clean)) return undefined;
	if (/[\n*]|\*\*/.test(clean)) return undefined;
	if (/^\w+:\s/.test(clean)) return undefined;
	if (/^\(.*\)$|^\[.*\]$/.test(clean)) return undefined;

	const lower = clean.toLowerCase();
	const wordCount = clean.split(/\s+/).length;
	if (lower === "done") return undefined;
	if (isMetaSuggestion(lower)) return undefined;
	if (isErrorSuggestion(lower)) return undefined;
	if (wordCount > 12) return undefined;
	if (wordCount < 2 && !isAllowedSingleWordSuggestion(lower, clean)) return undefined;
	if (/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)\b/i.test(clean)) return undefined;
	if (/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/i.test(clean)) return undefined;

	return clean;
}

function isMetaSuggestion(lower: string): boolean {
	return (
		lower === "nothing found" ||
		lower.startsWith("nothing to suggest") ||
		lower.startsWith("no suggestion") ||
		/\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
		/^\W*silence\W*$/.test(lower)
	);
}

function isErrorSuggestion(lower: string): boolean {
	return (
		lower.startsWith("api error:") ||
		lower.startsWith("prompt is too long") ||
		lower.startsWith("request timed out") ||
		lower.startsWith("invalid api key") ||
		lower.startsWith("image was too large")
	);
}

function isAllowedSingleWordSuggestion(lower: string, clean: string): boolean {
	if (clean.startsWith("/")) return true;
	return ALLOWED_SINGLE_WORD_SUGGESTIONS.has(lower);
}

function isUserEditKey(data: string): boolean {
	if (data.length === 1 && data.charCodeAt(0) >= 32) return true;
	return (
		matchesKey(data, Key.backspace) ||
		matchesKey(data, Key.delete) ||
		matchesKey(data, Key.enter) ||
		matchesKey(data, Key.tab)
	);
}

function truncatePlain(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function loadConfig(cwd: string, onWarning?: (message: string) => void): PromptSuggestionsConfig {
	const globalPath = join(getAgentDir(), ...GLOBAL_CONFIG_RELATIVE_PATH);
	const projectPath = join(cwd, ...PROJECT_CONFIG_RELATIVE_PATH);
	return mergeConfigInputs(
		readConfigFile(globalPath, onWarning),
		readConfigFile(projectPath, onWarning),
	);
}

function readConfigFile(path: string, onWarning?: (message: string) => void): PromptSuggestionsConfigInput {
	if (!existsSync(path)) return {};
	try {
		return parseConfigInput(JSON.parse(readFileSync(path, "utf-8")), path, onWarning);
	} catch (error) {
		onWarning?.(`config ignored: ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function parseConfigInput(
	value: unknown,
	path = "config",
	onWarning?: (message: string) => void,
): PromptSuggestionsConfigInput {
	if (!isRecord(value)) {
		onWarning?.(`config ignored: ${path}: expected object`);
		return {};
	}

	const config: PromptSuggestionsConfigInput = {};
	if ("enabled" in value) {
		if (typeof value.enabled === "boolean") config.enabled = value.enabled;
		else onWarning?.(`config ignored: ${path}: enabled must be boolean`);
	}
	if ("model" in value) {
		if (typeof value.model === "string" && value.model.trim()) config.model = value.model.trim();
		else onWarning?.(`config ignored: ${path}: model must be non-empty string`);
	}
	if ("acceptTab" in value) {
		if (typeof value.acceptTab === "boolean") config.acceptTab = value.acceptTab;
		else onWarning?.(`config ignored: ${path}: acceptTab must be boolean`);
	}
	if ("display" in value) {
		if (value.display === "ghost" || value.display === "belowEditor") config.display = value.display;
		else onWarning?.(`config ignored: ${path}: display must be \"ghost\" or \"belowEditor\"`);
	}
	if ("maxChars" in value) {
		if (isPositiveInteger(value.maxChars)) config.maxChars = value.maxChars;
		else onWarning?.(`config ignored: ${path}: maxChars must be positive integer`);
	}
	if ("maxTokens" in value) {
		if (isPositiveInteger(value.maxTokens)) config.maxTokens = value.maxTokens;
		else onWarning?.(`config ignored: ${path}: maxTokens must be positive integer`);
	}
	return config;
}

function mergeConfigInputs(...configs: PromptSuggestionsConfigInput[]): PromptSuggestionsConfig {
	return {
		enabled: true,
		acceptTab: false,
		display: "ghost",
		maxChars: DEFAULT_MAX_CHARS,
		maxTokens: DEFAULT_MAX_TOKENS,
		model: DEFAULT_MODEL,
		...Object.assign({}, ...configs),
	};
}

function resolveSuggestionModel(ctx: ExtensionContext, configuredModel: string | undefined): Model<any> | undefined {
	if (!configuredModel) return ctx.model;
	const parsed = parseModelSpec(configuredModel);
	if (!parsed) {
		debug(ctx, `configured model ignored: expected provider/model, got ${configuredModel}`);
		return ctx.model;
	}
	const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
	if (!model) {
		debug(ctx, `configured model not found: ${configuredModel}`);
		return ctx.model;
	}
	return model;
}

function parseModelSpec(spec: string): { provider: string; model: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function debug(ctx: ExtensionContext, message: string): void {
	// TEMP diagnostic 2026-09-11: always log to a file (no UI noise) — revert once the missing-ghost-text cause is found.
	try {
		appendFileSync("/tmp/next-suggestion-debug.log", `${new Date().toISOString()} ${message}\n`);
	} catch {
		// ignore
	}
	if (process.env.PI_PROMPT_SUGGESTIONS_DEBUG !== "1") return;
	ctx.ui.setStatus("next-suggestion", `suggestion: ${message}`);
	ctx.ui.notify(`next-suggestion: ${message}`, "info");
	try {
		appendFileSync(join(ctx.cwd, "next-suggestion-debug.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Debug logging must not affect the extension.
	}
}

export const __test__ = {
	buildSuggestionContext,
	convertToLlm,
	extractAssistantText,
	extractMessageText,
	formatMessageForSuggestion,
	getMessageRole,
	isSuggestionModeSupported,
	loadSuggestionSystemPrompt,
	mergeConfigInputs,
	parseConfigInput,
	parseModelSpec,
	renderGhostSuggestionLines,
	sanitizeSuggestion,
	truncatePlain,
};
