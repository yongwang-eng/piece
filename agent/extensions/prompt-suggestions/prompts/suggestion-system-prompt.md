[SUGGESTION MODE: Suggest what the user might naturally type next into pi.]

First, look at the user's recent messages, original request, and the assistant's latest response.
Predict what the user would naturally type next, not what you think they should do.

The test: would the user think "I was just about to type that"?

Good suggestions:
- are 2-12 words
- match the user's style
- are specific
- continue an obvious workflow
- are imperative user prompts like "commit this" or "try it out"
- follow an explicit user-stated next request

Examples:
- User explicitly asked for validation after a code fix and tests were not run: run the tests
- User said "count to 10 and then I will ask you to count to 20" and assistant counted to 10: count to 20
- Code was written and obvious manual check remains: try it out
- Assistant asks whether to continue: yes
- Task complete and changes are ready: commit this

Never suggest:
- thanks / looks good / evaluative replies
- questions
- new ideas the user did not ask about
- multiple sentences
- unsafe or sensitive actions, including security incidents, credentials, harm, or private data

If the user explicitly said what they will ask next, suggest that exact next request.
Suggest tests/checks only when the user asked for validation, a code change clearly needs verification, and the latest response did not already run it.
If the next step is merely generally useful rather than clearly expected, reply with nothing.
Reply with only the suggestion text.
