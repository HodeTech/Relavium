/**
 * The one command-line grammar: a quote-aware tokenizer and its inverse
 * ([ADR-0118](../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §3).
 *
 * A command is an **argv** — a program and its literal arguments, spawned without a shell. Three places have to
 * agree on how a line of text becomes that argv, and until this module they did not:
 *
 * - the `!` escape tokenized a typed line (and silently ran an open quote to the end of the line);
 * - the allowlist compared a *space-joined string*, so the entry `cat a b` admitted both `["cat","a b"]` and
 *   `["cat a","b"]` and an entry typed with quotes never matched anything;
 * - the card (and any hint a person could paste) has to show an argv as a line that parses back to the same argv.
 *
 * So there is one tokenizer, one quoter that inverts it, and the allowlist compares **tokens**. The grammar is the
 * `!` escape's, kept deliberately small:
 *
 * - whitespace (space, tab, CR, LF) outside quotes separates tokens, and runs of it collapse;
 * - a single or double quote opens a span that ends at the same quote character; everything inside, whitespace
 *   included, is literal; adjacent quoted and unquoted spans **join** into one token (`a"b c"d` is `ab cd`);
 * - there are **no escapes and no expansion**: a backslash, `$x`, `*`, `;`, `|` and `&&` are ordinary characters,
 *   which is what they are under `shell: false`;
 * - an empty quoted span (`""`) is a token, so an empty argument is expressible;
 * - an unclosed quote is **reported**, never tolerated: {@link CommandLineTokens.unterminatedQuote}. Running an
 *   open quote to the end of the line would change what runs, so every caller refuses it.
 *
 * Pure and platform-free by construction: it lives in `@relavium/shared` because the config and workflow schemas
 * validate allowlist entries with it, the engine's registry compares with it and the CLI both tokenizes `!` lines and
 * quotes the hints with it. A second copy anywhere is how the three would drift apart again.
 */

/** The tokens of one command line and whether a quote was left open. */
export interface CommandLineTokens {
  readonly tokens: readonly string[];
  /** `true` when the line ended inside a quote. `tokens` then holds what was read, which no caller should run. */
  readonly unterminatedQuote: boolean;
}

const isBreak = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** Split a line into argv tokens by the grammar above. */
export function tokenizeCommandLine(line: string): CommandLineTokens {
  const tokens: string[] = [];
  let current = '';
  let started = false; // distinguishes an empty quoted token `""` from no token
  let quote: "'" | '"' | undefined;
  for (const ch of line) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (isBreak(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return { tokens, unterminatedQuote: quote !== undefined };
}

/** A token needs quoting when it is empty or holds whitespace or a quote character. */
function needsQuoting(token: string): boolean {
  if (token === '') return true;
  for (const ch of token) {
    if (isBreak(ch) || ch === "'" || ch === '"') return true;
  }
  return false;
}

/** Quote one token so {@link tokenizeCommandLine} reads it back as exactly that token. */
function quoteToken(token: string): string {
  if (token === '') return "''"; // an empty argument is a quoted empty span, not nothing
  if (!needsQuoting(token)) return token;
  // Single quotes hold every character but a single quote; that one is emitted as a double-quoted span between two
  // single-quoted ones (`it's` → `'it'"'"'s'`), which the adjacent-span rule joins back into one token.
  let out = '';
  let run = '';
  for (const ch of token) {
    if (ch === "'") {
      if (run !== '') {
        out += `'${run}'`;
        run = '';
      }
      out += `"'"`;
    } else {
      run += ch;
    }
  }
  if (run !== '') out += `'${run}'`;
  return out;
}

/**
 * The inverse of {@link tokenizeCommandLine}: a line a person could paste that parses back to exactly `argv`
 * (`tokenizeCommandLine(quoteCommandLine(argv)).tokens` equals `argv`, for any strings). Tokens that need no
 * quoting stay bare, so an ordinary command reads as typed.
 */
export function quoteCommandLine(argv: readonly string[]): string {
  return argv.map(quoteToken).join(' ');
}

/**
 * Whether an allowlist entry is a usable command line: it tokenizes to at least one token and leaves no quote open.
 * Config and workflow schemas refuse an entry for which this is `false` (a quote left open used to be a silent
 * non-match, now it is a loud error naming the field).
 */
export function isUsableCommandLine(entry: string): boolean {
  const parsed = tokenizeCommandLine(entry);
  // The program is the first token and cannot be empty: `''` or `'' x` tokenizes but could never name anything to run,
  // so accepting it would be the silent non-match this check exists to remove.
  return !parsed.unterminatedQuote && parsed.tokens.length > 0 && parsed.tokens[0] !== '';
}

/**
 * Whether `argv` equals the command line `entry`, element by element (ADR-0118 §3). An entry that cannot be tokenized
 * never matches. Comparing tokens, not text, is what makes `cat a b` admit `["cat","a","b"]` and *not*
 * `["cat","a b"]`.
 */
export function argvMatchesCommandLine(argv: readonly string[], entry: string): boolean {
  const parsed = tokenizeCommandLine(entry);
  if (parsed.unterminatedQuote || parsed.tokens.length === 0) return false;
  if (parsed.tokens.length !== argv.length) return false;
  return parsed.tokens.every((token, index) => token === argv[index]);
}

/**
 * The fixed, value-free message and issue marker for an allowlist entry that is not a command line. A config loader that
 * must not print `issue.message` (it can echo a rejected value for other codes) recognizes this one issue by its marker
 * and prints the fixed text, so a person with an open quote is told the quote is the problem.
 */
export const COMMAND_LINE_ENTRY_ISSUE = 'command_line_entry';
export const COMMAND_LINE_ENTRY_MESSAGE =
  'must be a command line with balanced quotes (single or double), at least one token and a non-empty program';
