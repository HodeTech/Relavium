/**
 * Does a line of typed text look like a provider API key? (MVP-11, ADR-0146 §6.)
 *
 * The Home keeps what a person typed while no provider key exists, so that setup can open without losing the message. A pasted key is the
 * one thing it must NOT keep: the prompt, the input history (an unencrypted database that cannot be deleted from) and a notice that echoes
 * the line would each hold a credential. This predicate decides that, and only that.
 *
 * It is deliberately NOT the diagnostic scrubber (`scrubSecrets` / `secretMaskRanges`). That one answers a different question, 'is there
 * anything in this blob that must not be printed', and errs towards masking: `Basic auth`, `bearer of bad news`, `https://user@host` and
 * `?token=abc` all trip it, which discarded ordinary messages with a notice that said 'API key'. Here a false positive costs a typed message
 * and a false negative leaks a key, so the rule is the four providers' real key FORMATS and nothing wider:
 *
 *  - Anthropic          `sk-ant-` then a long run of letters, digits, `_` and `-`;
 *  - OpenAI             `sk-proj-` / `sk-svcacct-` / `sk-admin-` then the same, or the older `sk-` and a long alphanumeric run;
 *  - DeepSeek           `sk-` and a long alphanumeric run (32 hex);
 *  - Google (Gemini)    `AIza` then a long run of letters, digits, `_` and `-`;
 *  - any `NAME_API_KEY=value` assignment (a pasted line of a `.env` file).
 *
 * The older `sk-` form takes only letters and digits on purpose: with `-` allowed, `task-management-and-planning-tool` and
 * `sk-learn-intelex-2024-02` (a package name) are keys. No pattern requires a word boundary before its prefix, so a key that follows a word
 * character (`mykey_sk-...`, `xAIza...`) is still found; the characters that cannot be seen (zero-width, soft hyphen, BOM, bidi controls: the
 * Unicode `Cf` category) are removed first, so one placed inside a prefix does not hide it.
 *
 * Every pattern is a literal prefix followed by ONE bounded character class, so each runs in time linear in the line; none has a nested or
 * overlapping quantifier. The assignment's name class and its separators are disjoint from what follows them for the same reason.
 */

/** Unicode format characters: zero-width, soft hyphen, BOM, word joiner, bidi controls, tag characters. They draw nothing. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

const KEY_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/u,
  /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/u,
  /sk-[A-Za-z0-9]{20,}/u,
  /AIza[A-Za-z0-9_-]{30,}/u,
  /\b[A-Z0-9_]*API_KEY\s*=\s*\S{12,}/u,
];

/** True when `text` contains something shaped like a key of one of the four providers, or a `NAME_API_KEY=value` assignment. */
export function looksLikeProviderKey(text: string): boolean {
  const visible = text.replace(FORMAT_CHARACTERS, '');
  return KEY_SHAPES.some((shape) => shape.test(visible));
}
