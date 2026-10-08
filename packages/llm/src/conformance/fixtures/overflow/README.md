# Live overflow evidence

These are actual official-provider responses captured with `w7-overflow-capture-v1` and `v4` on
2026-10-04 and 2026-10-08 using only its fixed synthetic input. The parent reviewed the complete artifacts
for overflow semantics and sensitive content, then copied each file byte-for-byte. Request
IDs belong to the recorded responses. No authentication header or request body is retained.
The [capture runbook](../../../../../../docs/runbooks/capture-provider-overflow.md) owns the procedure.

| Artifact | Model | HTTP / identifying evidence | SHA256 |
| --- | --- | --- | --- |
| [Anthropic](2026-10-04-anthropic-overflow.json) | `claude-haiku-4-5-20251001` | 400; `invalid_request_error`, prompt 1,103,792 > 200,000 tokens | `7a0fa5757876281f77903bf2ea96f76729ad10fb6f7b0c6a255ceb575f6593ba` |
| [OpenAI](2026-10-04-openai-overflow.json) | `gpt-4o-mini-2024-07-18` | 400; `context_length_exceeded`, messages 206,970 > 128,000 tokens | `968c3b35fe3e2185b3f0fb6a0264041ee732e7ceff1f9164d67b0ccecfa3a553` |
| [DeepSeek](2026-10-04-deepseek-overflow.json) | `deepseek-flash` | 400; actual context-length message, request 3,752,897 > 1,048,576 tokens | `2b3f9890e9dbcfb5ac621646b150b3e7afc068a6dee02aebac80d197c1c7ac2e` |
| [Gemini](2026-10-08-gemini-overflow.json) | `gemini-3.5-flash-lite` | 400; `INVALID_ARGUMENT`, input exceeds 1,048,576-token maximum | `a00ffc0290206585834730f176ab1871bb91e79eea4e22ac58dfa8372ec56318` |
| [Anthropic native context stop](2026-10-08-anthropic-context-stop.json) | `claude-haiku-4-5-20251001` | 200; `model_context_window_exceeded`, 199,885 input / 12,792 output tokens | `0f8ed2eb3b5b1f6dc6419e16e25d97ea5ce42b05d06e9f75ef85426a21dabc9e` |

**All five required artifacts are present.** The v4 native-stop probe completed at
`2026-10-08T20:25:27.454Z`, after both independent capture-tool reviews. Its complete response
contains only sequential synthetic integer text (6 through 4,600), provider identifiers,
usage and null diagnostic fields. The native stop is separate from Anthropic's input rejection.
These artifacts satisfy the evidence prerequisite, not Step 7 classification, Step 8 recovery
or whole-wave acceptance. No classifier change is established by this index.

The earlier four-artifact checkpoint and unsuitable probes remain recorded below. The paid Tier 1 Gemini project returned
the genuine input-overflow body above; its earlier free-tier quota 429 remains unsuitable.
Anthropic's new 2026-10-08 probe used an actual token-count calibration of 199,762 input tokens,
but ended with `end_turn`, not `model_context_window_exceeded`. That diagnostic remains private,
as do the two earlier unsuitable probes. A separate Anthropic response carrying the native
context-window stop was still required at that checkpoint. Those four artifacts alone did not
accept Steps 7–8 or alter the classifier.

Two subsequent v2 probes are also unsuitable and remain private: one returned input-overflow
400 (`200002 > 200000`) despite a 199,986 token-count estimate; the next accepted 199,884 input
tokens but declined the million-integer continuation and ended with `end_turn` / 173 output
tokens. Neither is native context-stop evidence. The reviewed v3 fixed assistant-prefill probe
then reached its absolute 60-second response deadline and left an empty private artifact; it
captured no response and is unsuitable evidence. The v4 probe retains the same synthetic request
and gives only the explicitly validated Anthropic context-stop purpose a 180-second response
deadline. Both independent reviews and the explicit attempt within the approved budget are
now complete; the longer wait alone did not guarantee either result. Earlier v1–v3 artifacts
remain byte-for-byte unchanged. Only the genuine successful v4 response is added here.
