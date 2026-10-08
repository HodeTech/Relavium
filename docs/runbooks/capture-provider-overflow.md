# Capture provider overflow evidence

- **Status**: Available for maintainer use; live fixtures still required for W7 step 7
- **Date**: 2026-10-08
- **Related**: [ADR-0096](../decisions/0096-a-request-is-measured-before-it-is-sent.md), [LLM provider seam](../reference/shared-core/llm-provider-seam.md), [keychain and secrets](../reference/desktop/keychain-and-secrets.md)

W7's overflow classifier must be pinned to dated responses from the official Anthropic,
OpenAI, DeepSeek and Gemini APIs. The maintainer runs this command with their own keys.
Offline command tests use synthetic responses and do not satisfy that prerequisite.

## Prepare

1. Build before piping any credential: `pnpm turbo run build --filter=@relavium/llm`.
2. Run `node tools/overflow-capture/capture.mjs --help`. Select an official model available to your account
   and look up its input window. Input size here is **characters, not tokens**; the command
   appends a short fixed instruction. Choose a synthetic size exceeding the model's window
   for an overflow capture. Each invocation makes one request and can be billed if accepted.
3. Choose a new destination in a directory you own. Existing files and links are refused
   before a request is sent. Output is created with mode `0600` on POSIX systems.
4. Retrieve one key directly from your OS keychain and pipe it to stdin. Never put a key
   in an argument, environment variable, shell history, prompt file or capture destination.
   The [keychain contract](../reference/desktop/keychain-and-secrets.md) owns service and
   account naming. Disable shell tracing before running the pipeline.

Invoke the runner directly with Node as shown below. Package-manager script banners echo
arguments before validation, so a `pnpm run` wrapper would defeat the runner's safe refusal
when a key is accidentally placed in a model or destination argument.

For macOS, edit the account and model placeholders below before running. `MODEL_ID` is a
literal placeholder; `anthropic:KEY_ID` must identify your existing keychain entry.
The `1048576` size is an example, **not a guarantee of overflow** for your chosen model.

```bash
security find-generic-password -s relavium -a 'anthropic:KEY_ID' -w |
  node tools/overflow-capture/capture.mjs --provider anthropic --model MODEL_ID \
    --input-chars 1048576 --out ./anthropic-overflow.json
```

Repeat for `--provider openai`, `deepseek` and `gemini`, using the corresponding existing
keychain account, actual model and a distinct destination. A key retrieval failure produces
no request. On other operating systems, use the keychain's direct stdout retrieval mechanism
and the same stdin boundary; the command does not read keys from environment variables.

## Probe Anthropic's context stop reason separately

ADR-0096 also requires evidence for the near-window truncation path. Run a separate
Anthropic capture with `--purpose context-stop-probe --max-output 16384`, a new destination,
and input close enough to the model's window that the requested continuation reaches it.
Version `w7-overflow-capture-v4` retains v3's parser-test integer sequence through 6,000 and supplies
the fixed synthetic assistant prefix `1 2 3 4 5`. Unlike v2's million-integer request, this gives
the model a started, smaller continuation; it still does not guarantee a native stop. Use a model
that supports [assistant prefilling](https://platform.claude.com/docs/en/build-with-claude/working-with-messages),
such as Haiku 4.5; Claude 4.6 and later do not support it. Its explicit larger
output bound is available only for this Anthropic purpose; ordinary overflow captures retain
their 4,096-token maximum. Previously captured v1–v3 artifacts keep their exact recorded bytes.
Choose the model and input size using its documented window; the tool does not count tokens,
calibrate automatically or retry. An ordinary `400` overflow response does not establish the
streaming stop-reason path. An accepted response with a different stop reason does not prove
that the path is unsupported; review it and adjust the probe explicitly if necessary.
See Anthropic's [context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
for `model_context_window_exceeded` and the distinction between input rejection and output truncation.

The reviewed v3 near-window Haiku 4.5 probe reached the capture's absolute 60-second response
deadline and left an empty destination. It is unsuitable provider evidence and remains private;
no response or native stop reason was captured. Version v4 gives only the explicitly validated
Anthropic `context-stop-probe` a 180-second response deadline, allowing more time for its bounded
non-streaming continuation. The longer wait does not guarantee a response or the desired stop
reason. [A client timeout may still be billed](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage), so reserve the request's maximum charge when usage
is unavailable and choose another attempt only explicitly within the approved budget.

## Review and accept the evidence

The saved artifact records the tool version, ISO capture date, provider, model, purpose,
synthetic input size, output cap, HTTP status and exact decoded UTF-8 JSON response body.
It retains no request body, authentication header or arbitrary transport error. The command
refuses the entire response if it finds the supplied key or a credential shape recognised
by Relavium's secret scrubber, including JSON-escaped strings and property names. Review
the resulting artifact for sensitive content before committing it.
The completed artifact is also checked, so the supplied key cannot remain in metadata or a field name.

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
output cap is 1–4,096 tokens (default 64), or up to 16,384 only for an explicitly selected
Anthropic `context-stop-probe`. Choose that larger cap against the approved call budget;
an accepted near-200K Haiku 4.5 probe with 16,384 output tokens has an approximately 0.282 USD
maximum token charge at the [published 1 USD input / 5 USD output per million-token rates](https://platform.claude.com/docs/en/about-claude/pricing).
This is a bounded request estimate, not a provider invoice or tax cap. Stdin must finish within 60 seconds and contain one
printable key of 8–512 characters, with surrounding whitespace allowed and a 1,024-character
pipe limit. Headers and response reads share a separate absolute 60-second deadline for ordinary
overflow captures on every provider, or 180 seconds only for the validated Anthropic
`context-stop-probe`. Header arrival and subsequent body chunks never renew that deadline. Responses
must be JSON, at most 1 MiB and at most 16,384 chunks, including empty chunks.

Catchable SIGINT/SIGTERM signals cancel capture on POSIX. Windows `child.kill()` termination is
forceful and cannot run the signal handler; inspect any reserved destination after termination.
A failed capture may leave an empty, partial or complete artifact (for example, a write can finish
before fsync, destination identity or close fails). Inspect it before use. The command never
deletes the caller-selected pathname: checking an inode and then unlinking is not atomic, so such
cleanup could delete a concurrent replacement. Review a failed destination yourself and choose a
new path for the next attempt. The command never overwrites a replacement that refers to a
different file/inode; a hard link to the reserved inode still aliases that same object.
Success prints only the HTTP status. Failure prints a fixed refusal code, never a response body,
key, model, path or arbitrary error cause. A saved artifact is evidence to review, not an assertion
that the provider rejected the request.

Request construction follows the official [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create),
[OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat),
[DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
and [Gemini generateContent API](https://ai.google.dev/api/generate-content).
