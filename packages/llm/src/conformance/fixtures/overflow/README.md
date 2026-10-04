# Live overflow evidence

These are actual official-provider responses captured with `w7-overflow-capture-v1` on
2026-10-04 using only its fixed synthetic input. The parent reviewed the complete artifacts
for overflow semantics and sensitive content, then copied each file byte-for-byte. Request
IDs belong to the recorded responses. No authentication header or request body is retained.
The [capture runbook](../../../../../../docs/runbooks/capture-provider-overflow.md) owns the procedure.

| Artifact | Model | HTTP / identifying evidence | SHA256 |
| --- | --- | --- | --- |
| [Anthropic](2026-10-04-anthropic-overflow.json) | `claude-haiku-4-5-20251001` | 400; `invalid_request_error`, prompt 1,103,792 > 200,000 tokens | `7a0fa5757876281f77903bf2ea96f76729ad10fb6f7b0c6a255ceb575f6593ba` |
| [OpenAI](2026-10-04-openai-overflow.json) | `gpt-4o-mini-2024-07-18` | 400; `context_length_exceeded`, messages 206,970 > 128,000 tokens | `968c3b35fe3e2185b3f0fb6a0264041ee732e7ceff1f9164d67b0ccecfa3a553` |
| [DeepSeek](2026-10-04-deepseek-overflow.json) | `deepseek-flash` | 400; actual context-length message, request 3,752,897 > 1,048,576 tokens | `2b3f9890e9dbcfb5ac621646b150b3e7afc068a6dee02aebac80d197c1c7ac2e` |

**The five-artifact prerequisite is incomplete.** Gemini returned a free-tier input-quota 429;
the first Anthropic context-stop probe ended normally, and its second probe returned an input
overflow 400. None is the missing evidence. Those diagnostic responses stay private and are
excluded from this fixture set. Gemini overflow and a separate Anthropic response carrying
`model_context_window_exceeded` are still required before W7 Step 7 classification is committed.
These three artifacts alone do not accept Steps 7–8 or alter the current classifier.
