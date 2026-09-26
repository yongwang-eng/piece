import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBrowserTool } from "../../../lib/browser/tool.ts";

export default function browser(pi: ExtensionAPI) {
  registerBrowserTool(pi);
}
