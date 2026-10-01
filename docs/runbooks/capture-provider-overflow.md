# Capture provider overflow evidence

- **Status**: Available for maintainer use; live fixtures still required for W7 step 7
- **Date**: 2026-10-02
- **Related**: [ADR-0096](../decisions/0096-a-request-is-measured-before-it-is-sent.md), [LLM provider seam](../reference/shared-core/llm-provider-seam.md), [keychain and secrets](../reference/desktop/keychain-and-secrets.md)

W7's overflow classifier must be pinned to dated responses from the official Anthropic,
OpenAI, DeepSeek and Gemini APIs. The maintainer runs this command with their own keys.
Offline command tests use synthetic responses and do not satisfy that prerequisite.

## Prepare

1. Build before piping any credential: `pnpm turbo run build --filter=@relavium/llm`.
2. Run `pnpm capture:overflow --help`. Select an official model available to your account
   and look up its input window. Input size here is **characters, not tokens**; the command
   appends a short fixed instruction. Choose a synthetic size exceeding the model's window
   for an overflow capture. Each invocation makes one request and can be billed if accepted.
3. Choose a new destination in a directory you own. Existing files and links are refused
   before a request is sent. Output is created with mode `0600` on POSIX systems.
4. Retrieve one key directly from your OS keychain and pipe it to stdin. Never put a key
   in an argument, environment variable, shell history, prompt file or capture destination.
   The [keychain contract](../reference/desktop/keychain-and-secrets.md) owns service and
   account naming. Disable shell tracing before running the pipeline.

For macOS, edit the account and model placeholders below before running. `MODEL_ID` is a
literal placeholder; `anthropic:KEY_ID` must identify your existing keychain entry.
The `1048576` size is an example, **not a guarantee of overflow** for your chosen model.

```bash
security find-generic-password -s relavium -a 'anthropic:KEY_ID' -w |
  pnpm capture:overflow --provider anthropic --model MODEL_ID \
    --input-chars 1048576 --out ./anthropic-overflow.json
```

Repeat for `--provider openai`, `deepseek` and `gemini`, using the corresponding existing
keychain account, actual model and a distinct destination. A key retrieval failure produces
no request. On other operating systems, use the keychain's direct stdout retrieval mechanism
and the same stdin boundary; the command does not read keys from environment variables.

## Probe Anthropic's context stop reason separately

ADR-0096 also requires evidence for the near-window truncation path. Run a separate
Anthropic capture with `--purpose context-stop-probe --max-output 4096`, a new destination,
and input close enough to the model's window that the requested continuation reaches it.
The fixed instruction asks for ascending integers rather than an immediate short answer.
Choose the model and input size using its documented window; the tool does not count tokens,
calibrate automatically or retry. An ordinary `400` overflow response does not establish the
streaming stop-reason path. An accepted response with a different stop reason does not prove
that the path is unsupported; review it and adjust the probe explicitly if necessary.
See Anthropic's [context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
for `model_context_window_exceeded` and the distinction between input rejection and output truncation.

## Review and accept the evidence

The saved artifact records the tool version, ISO capture date, provider, model, purpose,
synthetic input size, output cap, HTTP status and exact decoded UTF-8 JSON response body.
It retains no request body, authentication header or arbitrary transport error. The command
refuses the entire response if it finds the supplied key or a credential shape recognised
by Relavium's secret scrubber, including JSON-escaped strings and property names. Review
the resulting artifact for sensitive content before committing it.

An HTTP status alone is not an overflow verdict: authentication, request-size or unsupported
parameter errors are unsuitable classifier fixtures. Inspect the provider's actual error
body and retain its identifying fields, capture date and model. Step 7 adds the approved
fixtures and replay assertions in the existing adapter conformance suite; Gemini replay must
preserve the recorded body and message. Do not invent a replacement response or claim a probe
was captured when only an offline test ran.

## Bounds and failure handling

The tool accepts only the four fixed official HTTPS endpoints and synthetic ASCII input;
it accepts no custom URL, file input, user prompt or tools. It makes one non-streaming request,
with redirects and retries disabled. The input limit is 8,388,608 characters and the requested
output cap is 1–4,096 tokens (default 64). Stdin must finish within 60 seconds and contain one
printable key of 8–512 characters, with surrounding whitespace allowed and a 1,024-character
pipe limit. Headers and response reads share a separate absolute 60-second deadline. Responses
must be JSON, at most 1 MiB and at most 16,384 chunks, including empty chunks.

SIGINT/SIGTERM cancels capture. A failed capture removes its reserved file when it still owns
that file; a replacement file is preserved. Success prints only the HTTP status. Failure prints
a fixed refusal code, never a response body, key, model, path or arbitrary error cause. A saved
artifact is evidence to review, not an assertion that the provider rejected the request.

Request construction follows the official [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create),
[OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat),
[DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
and [Gemini generateContent API](https://ai.google.dev/api/generate-content).
