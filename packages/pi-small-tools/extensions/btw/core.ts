import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export function contextText(messages: Message[], limit = 60_000): string {
  const text = messages.map((message) => {
    const body = typeof message.content === "string" ? message.content : message.content
      .filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const label = message.role === "toolResult" ? `tool result: ${message.toolName}` : message.role;
    return body ? `[${label}]\n${body}` : "";
  }).filter(Boolean).join("\n\n");
  return text.length > limit ? `[earlier context omitted; recent text only]\n${text.slice(-limit)}` : text;
}

export function answerText(response: AssistantMessage): string {
  if (response.stopReason !== "stop") throw new Error(response.errorMessage || `Side answer stopped: ${response.stopReason}`);
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  if (!text) throw new Error("Side answer returned no text");
  return text;
}
