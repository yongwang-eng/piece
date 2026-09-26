# Decision cards

## Contract

The governor supplies a briefing, not authorization. A card presents the question, context, implications, recommendation with reason, and original request. Prior rulings are labeled separately from the governor's evidence claims.

| Request | Controls |
|---|---|
| Escalated judgment, no explicit action | Validated named alternatives with exact directions and consequences |
| Human-only class with submitted action | Existing class controls, bound to the original action; generated options ignored |
| Human-only class missing its action | Get exact action / Do not proceed; no one-click authorization |
| Missing or malformed judgment briefing | Explicit free-text direction or more evidence, never blanket approval |

Generated choices are limited to non-human classes. They cannot supply the missing action for auth, irreversible, notify, money, policy, or scope requests. The original classification and consult id/hash resolution remain in place. A recommendation never answers a consult.

## Presentation and selection

`lib/governor/prompt.ts` requests and validates structured JSON. Legacy packet text remains parseable, but a legacy briefing without a plain question falls back to conservative controls. `lib/room/consult.ts` builds cards and options; `decision-picker.ts` renders the selected option's full action and implication.

Arrow keys select, Enter chooses, Escape leaves the consult open. Page Up/Down scroll long content; the viewport shows its line range. Selecting an alternative relays precisely its displayed action. Free-text judgment answers reject bare affirmatives. A consult answered elsewhere while the picker is open cannot be answered again by that stale picker.

## Verification

```sh
node --test lib/room/{consult,decision}.test.mjs extensions/crew/ui/decision-{picker,flow}.test.mjs
```

Tests execute the production initial/retry decision flows, parser and card functions, plus real pi-tui components at narrow widths. They cover exact-action preservation, missing-action refusal, selected-action relay, scrolling, cancel, stale cards and ambiguous affirmative input.

**Live acceptance remains necessary after reload.** Use a harmless presentation-choice consult whose only effect is a worker's final response format. Verify the governor produces an understandable packet and the human can choose without asking main to explain it. Never use a real credential, payment, notification or destructive action as the UI test.
