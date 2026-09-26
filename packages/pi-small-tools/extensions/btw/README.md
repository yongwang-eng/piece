# /btw — read-only side questions

`/btw <question>` opens a cancellable answer panel without adding the question or answer to the session transcript. Main's conversation and task stay unchanged.

- **Model:** the selected session model/provider, using pi's model registry and existing auth. No alternate provider or extra credentials.
- **Context:** active-branch context via `buildSessionContext`, including the compaction summary; text only, newest 60,000 characters. Images, reasoning blocks, and tool-call arguments are omitted. Tool-result text is included. This is not a fresh file/web lookup.
- **Display:** editor-replacement panel, like `/ctx`, rather than a floating overlay. The panel owns keyboard input until dismissed and restores the editor's text afterward.
- **Controls:** Escape cancels/closes; Enter closes the answer; ↑/↓ scroll.
- **Limits:** 2,048 output tokens; 90-second abort deadline. Each invocation is an additional model request; it is not included in main's transcript usage totals.
- **Persistence:** none. Dismissed answers cannot be recovered from the session. No copy/promotion/follow-up feature in this slice.
- **Lifecycle:** shutdown/reload aborts the request; late completion cannot repaint a dismissed panel. Main may continue working while the side panel is open.

Implementation follows pi's `qna.ts`/BorderedLoader and non-overlay `ui.custom` pattern. Side-question reference: [pi-fitch-kit write-prompt.ts](https://github.com/fitchmultz/pi-fitch-kit/blob/main/extensions/write-prompt.ts); this version deliberately omits its draft/accept/copy workflow.

Tests: `node --test extensions/btw/*.test.mjs`. `routing.test.mjs` exercises installed Pi fullscreen input routing and custom-panel lifecycle with a stub model and main interrupt target: Escape closes only the loading/answered panel, preserves editor text, and a subsequent Escape reaches main. The reported one-tap main abort was not reproduced on the original overlay; these checks do not establish its cause.

UI/model smoke after reload, while main is running: `/btw What feature did we just build?` Verify the panel answers from context, Escape closes it, and neither question nor answer enters the transcript. A second request cancelled immediately checks cancellation.
