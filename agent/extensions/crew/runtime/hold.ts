/**
 * Hold / resume — one standard payload instead of N hand-written "STOP WORK" messages (pausing the an earlier ticket crew took
 * five bespoke crew_sends; resuming took another). The text is the contract every worker gets, verbatim.
 */
export function holdMessage(reason: string | undefined): string {
  return [
    "[HOLD] Stop work now and stay idle until main sends [RESUME].",
    reason ? `Why: ${reason}` : undefined,
    "Do not start new tasks, do not consult, do not tidy or clean up anything.",
    "If you have uncommitted scratch or a half-written file, leave it in place and reply with ONE line naming what exists and where.",
    "Your context and folder are preserved; nothing you did is being questioned.",
  ].filter(Boolean).join("\n");
}

export function resumeMessage(text: string | undefined): string {
  return [
    "[RESUME] The hold is lifted. Continue from where you stopped.",
    text ? `Direction: ${text}` : "Direction unchanged — pick up your last in-flight step.",
  ].join("\n");
}

export const HELD_DETAIL = "⏸ held";
