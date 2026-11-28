/**
 * Does a line of typed text look like a provider API key? (MVP-11, ADR-0146 §6.)
 *
 * The Home keeps what a person typed while no provider key exists, so that setup can open without losing the message. A pasted key is the
 * one thing it must NOT keep or send: a message that is sent enters the session TRANSCRIPT (`history.db`, an unencrypted database that cannot
 * be deleted from), and a notice that echoes the line would hold a credential too. (The INPUT history, the Up and `Ctrl+R` recall, is in
 * memory only and is never written to disk; it is kept clean for the next person at the keyboard, not for the database.) This predicate
 * decides that, and only that.
 *
 * It is deliberately NOT the diagnostic scrubber (`scrubSecrets` / `secretMaskRanges`). That one answers a different question, 'is there
 * anything in this blob that must not be printed', and errs towards masking: `Basic auth`, `bearer of bad news`, `https://user@host` and
 * `?token=abc` all trip it, which discarded ordinary messages with a notice that said 'API key'. Here a false positive costs a typed message
 * and a false negative leaks a key, so the rule is the real key FORMATS and nothing wider:
 *
 *  - Anthropic          `sk-ant-` then a long run of letters, digits, `_` and `-`;
 *  - OpenAI             `sk-proj-` / `sk-svcacct-` / `sk-admin-` / `sk-None-` then the same, or the older `sk-` and a long alphanumeric run;
 *  - OpenRouter         `sk-or-v1-` then the same run;
 *  - DeepSeek           `sk-` and a long alphanumeric run (32 hex);
 *  - any other `sk-<word>-` key (a custom endpoint's): `sk-`, one word of letters, an optional `v<digits>-`, then at least 32 characters of
 *                       the key alphabet that hold BOTH a letter and a digit (so a package name such as `sk-learn-intelex-2024-02` is not one);
 *  - Google (Gemini)    `AIza` then a long run of letters, digits, `_` and `-`;
 *  - Groq and xAI       `gsk_` / `xai-` then a long alphanumeric run (the keys a custom endpoint is given);
 *  - any `NAME_API_KEY=value` assignment (a pasted line of a `.env` file), in any case, when the value looks like a credential: at least 20
 *                       characters of letters, digits and `_-./+=`, optionally quoted, so `const API_KEY = getKey(config)` and
 *                       `the variable API_KEY = process.env.X` are code and prose, not a key.
 *
 * **What is looked at is the text after it is folded** (see {@link fold}): compatibility-normalised (a fullwidth `ｓｋ－ａｎｔ－…` becomes ASCII),
 * with every character that draws nothing removed (zero-width, soft hyphen, BOM, bidi controls, the combining grapheme joiner, the variation
 * selectors, the Hangul fillers, the tag characters: `INVISIBLE_CHARS`, the one definition the run card uses too), with combining marks
 * removed, and the Unicode dashes and the minus sign read as `-`. So a prefix cannot be hidden by anything a terminal draws as nothing.
 *
 * **The prefix of an unspecific form is not glued to a letter or digit.** The old `sk-` form, the `sk-<word>-` form, `AIza`, `gsk_` and `xai-`
 * need no ASCII letter or digit before them (`(?<![A-Za-z0-9])`), because their prefix is short enough to sit inside ordinary words: `task-`,
 * `risk-`, `disk-` and `flask-` followed by twenty letters are text, not keys. An underscore or a punctuation mark before is allowed, so
 * `mykey_sk-...` is still found. The `sk-ant-`, `sk-proj-`, `sk-or-v1-` ... forms are specific enough to be found anywhere.
 *
 * **Accepted limits** (a false negative the rule takes on purpose, because the alternative is a false positive on ordinary text):
 *  - A key SPLIT by whitespace or a newline inside its first 20 characters is not detected. Whitespace is never joined: that would turn
 *    `task - management ...` into `sk-management ...` and discard an ordinary message.
 *  - A key of a provider or a custom endpoint whose format is none of the above is not detected: the rule is the formats the CLI knows.
 *  - A homoglyph of a prefix letter (a Cyrillic `ѕ` for `s`) is not folded to ASCII: NFKD does not do it.
 *
 * Every pattern is a literal prefix followed by ONE bounded character class, so each runs in time linear in the line; none has a nested or
 * overlapping quantifier. The assignment's name class and its separators are disjoint from what follows them for the same reason, and the
 * one pattern with two runs (`sk-<word>-` then the key alphabet) cannot restart inside the run it just read, because the run's alphabet
 * contains the word's. The fold is linear too.
 */

import { INVISIBLE_CHARS } from './invisible-chars.js';

/** Combining marks: `s` and a combining acute would otherwise sit between the letters of a prefix. */
const COMBINING_MARKS = /\p{Mn}/gu;

/** The hyphen look-alikes: U+2010 to U+2015 (hyphen, non-breaking hyphen, figure, en and em dash, horizontal bar), the minus sign, the small and the fullwidth hyphen-minus. */
const DASHES = /[‐-―−﹘﹣－]/gu;

/** The text as the patterns read it: compatibility-decomposed, nothing invisible, no combining mark, one kind of hyphen. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(INVISIBLE_CHARS, '')
    .replace(COMBINING_MARKS, '')
    .replace(DASHES, '-');
}

/** Not glued to an ASCII letter or digit on its left: the prefix starts a word, or follows `_` or punctuation. */
const WORD_START = String.raw`(?<![A-Za-z0-9])`;

const KEY_SHAPES: readonly RegExp[] = [
  // The specific prefixes: found anywhere, however they are glued.
  /sk-ant-[A-Za-z0-9_-]{16,}/u,
  /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/u,
  /sk-None-[A-Za-z0-9_-]{20,}/u,
  /sk-or-v1-[A-Za-z0-9_-]{20,}/u,
  // The unspecific prefixes: a word start on the left.
  new RegExp(`${WORD_START}sk-[A-Za-z0-9]{20,}`, 'u'),
  new RegExp(`${WORD_START}AIza[A-Za-z0-9_-]{30,}`, 'u'),
  new RegExp(`${WORD_START}gsk_[A-Za-z0-9]{20,}`, 'u'),
  new RegExp(`${WORD_START}xai-[A-Za-z0-9]{20,}`, 'u'),
  // A pasted `.env` line. The name is anything that ends in `API_KEY`, in any case; the value must look like a credential.
  /API_KEY\s*=\s*["']?[A-Za-z0-9_\-./+=]{20,}/iu,
];

/** `sk-<word>-` then a run of the key alphabet; the run is checked for BOTH a letter and a digit by {@link genericKey}. */
const GENERIC_SK = new RegExp(`${WORD_START}sk-[A-Za-z]+-(?:v[0-9]+-)?([A-Za-z0-9_-]{32,})`, 'gu');

/** Whether any `sk-<word>-` run in the folded text is a key: 32 or more characters, a letter AND a digit among them. */
function genericKey(visible: string): boolean {
  for (const match of visible.matchAll(GENERIC_SK)) {
    const run = match[1] ?? '';
    if (/[A-Za-z]/u.test(run) && /[0-9]/u.test(run)) return true;
  }
  return false;
}

/** True when `text` contains something shaped like a provider key, or a `NAME_API_KEY=value` assignment. */
export function looksLikeProviderKey(text: string): boolean {
  const visible = fold(text);
  return KEY_SHAPES.some((shape) => shape.test(visible)) || genericKey(visible);
}

/**
 * What a chat answers a slash-led line that holds a provider key with (round 2, A3, K3): a pasted key after a stray `/`, or as the argument of
 * a command. The line is not run, shown or kept: the `unknown command '<64 characters>'` echo and the argument echoes of the validators would
 * each have put up to 64 characters of the key into the transcript. A chat has no `/providers`, so the sentence says where it is.
 */
export const KEY_SHAPED_COMMAND_NOTICE =
  'That looked like an API key, so the line was not run, shown or kept. Connect a provider from the Home with /providers.';
