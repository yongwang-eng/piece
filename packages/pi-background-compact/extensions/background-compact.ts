/**
 * pi-background-compact — background context compaction for pi.
 *
 * Two halves, one extension:
 *   service  — summarize→ready→apply state machine on pi's compaction seams; the summarizer
 *              rides the live prompt cache (byte-identical prefix + one appended instruction)
 *   trigger  — compact at an ABSOLUTE token threshold (economic policy), starting `lead`
 *              tokens early so the summary is ready before the threshold is crossed
 *
 * The conversation is never blocked: summarization runs off the critical path and the summary
 * is spliced in at the next settled boundary, guarded by a session fingerprint.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupService } from "../src/service.ts";
import { setupTrigger } from "../src/trigger.ts";

export default async function backgroundCompact(pi: ExtensionAPI) {
  await setupService(pi);
  setupTrigger(pi);
}
