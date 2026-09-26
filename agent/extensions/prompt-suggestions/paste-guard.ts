const BRACKETED_NEWLINE = "\x1b[200~\n\x1b[201~";

/**
 * tmux may deliver an unmarked multiline paste as Enter followed immediately
 * by more text. Delay raw Enter briefly so that burst becomes a pasted newline,
 * while an isolated Enter keeps its normal submit behavior.
 */
export class UnmarkedPasteGuard {
  private pendingEnter?: ReturnType<typeof setTimeout>;
  private pendingEnterData?: string;
  private readonly delayMs: number;

  constructor(delayMs = 8) {
    this.delayMs = delayMs;
  }

  handle(data: string, emit: (data: string) => void): boolean {
    if (this.pendingEnter) {
      clearTimeout(this.pendingEnter);
      this.pendingEnter = undefined;
      this.pendingEnterData = undefined;
      emit(BRACKETED_NEWLINE);
    }

    if (data === "\r" || data === "\n") {
      this.pendingEnterData = data;
      this.pendingEnter = setTimeout(() => {
        const enter = this.pendingEnterData;
        this.pendingEnter = undefined;
        this.pendingEnterData = undefined;
        if (enter) emit(enter);
      }, this.delayMs);
      return true;
    }

    return false;
  }

  cancel(): void {
    if (this.pendingEnter) clearTimeout(this.pendingEnter);
    this.pendingEnter = undefined;
    this.pendingEnterData = undefined;
  }
}
