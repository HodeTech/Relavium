import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HINT_LITERAL_FILES, NOT_A_LEGEND } from './hint-ledger.js';
import { hintLiterals, isHintShaped, type HintLiteral } from './hint-shape.js';
import { PRODUCERS } from './producers.js';
import { CLI_SRC } from './source-literal.js';
import golden from './legend.golden.json' with { type: 'json' };

/**
 * **The completeness guard** ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3): the golden only
 * protects the producers it knows, so this test reads every production source file under `apps/cli/src` and fails when one writes a
 * hint-shaped string that no producer covers. Strings are read from the syntax tree (a comment never counts); the shape is
 * {@link isHintShaped} (`hint-shape.ts`): a strong key token (`Esc`, `Ctrl+X`, `Shift+Tab`, `PgUp`, an arrow group, ...), a bracketed key
 * and a word (`[Ctrl+Y] Allow`), `press` and a letter, `any other key`, or `Enter`/`Tab`/`Space` anywhere but as the verb that starts a
 * sentence. A string that is only a key (`'Esc'`: the `keys` field of a legend item) is not.
 *
 * Three lists, all in `hint-ledger.ts`: the files that may write such a string and how many each writes (the list the conversion to the
 * builder shrinks), the places that need not be producers (`NOT_A_LEGEND`, a reason each), and the producers themselves
 * (`producers.ts`). Every string of a listed file must also be in the golden: its fixed words must appear in the rows recorded for
 * a producer of that file, so a recorder that skipped a sentence is caught by the sentence, not by luck.
 */

const TEST_FILE = /\.test\.tsx?$/u;

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (/\.tsx?$/u.test(entry) && !TEST_FILE.test(entry)) found.push(path);
  }
  return found;
}

/** The production files of the CLI, as `apps/cli/src`-relative paths with `/` separators. */
const FILES: readonly string[] = walk(CLI_SRC)
  .map((path) => relative(CLI_SRC, path).split(sep).join('/'))
  .sort();

const allowed = (file: string, literal?: HintLiteral): boolean =>
  NOT_A_LEGEND.some(
    (entry) =>
      (entry.file.endsWith('/') ? file.startsWith(entry.file) : file === entry.file) &&
      (entry.contains === undefined || literal?.text.includes(entry.contains) === true),
  );

const LITERALS: ReadonlyMap<string, readonly HintLiteral[]> = new Map(
  FILES.filter((file) => !allowed(file)).flatMap((file) => {
    const found = hintLiterals(readFileSync(`${CLI_SRC}${file}`, 'utf8'), file).filter(
      (literal) => !allowed(file, literal),
    );
    return found.length === 0 ? [] : [[file, found] as const];
  }),
);

const collapse = (text: string): string => text.replace(/\s+/gu, ' ');

/** What the golden holds for the producers of `file`, white space collapsed the way a literal is. */
function recordedFor(file: string): string {
  const rows: string[] = [];
  for (const producer of PRODUCERS) {
    if (producer.file !== file) continue;
    const states: unknown = Reflect.get(golden, producer.id);
    if (typeof states !== 'object' || states === null) continue;
    for (const row of Object.values(states)) if (typeof row === 'string') rows.push(collapse(row));
  }
  return rows.join('\n');
}

/** The words of a literal that are fixed (an interpolation splits it), each of which the golden must hold. */
const fixedWords = (literal: HintLiteral): string[] =>
  literal.text
    .split('${…}')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const where = (file: string, literal: HintLiteral): string =>
  `${file}:${String(literal.line)} ${JSON.stringify(literal.text.slice(0, 120))}`;

describe('the completeness guard: no hint is written that the golden does not know', () => {
  it('finds the production source it guards', () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES).toContain('render/tui/legend.ts');
    expect(FILES.some((file) => TEST_FILE.test(file))).toBe(false);
  });

  it('has no hint-shaped string in a file that the ledger does not list', () => {
    const unowned = [...LITERALS].filter(([file]) => HINT_LITERAL_FILES[file] === undefined);
    const report = unowned.flatMap(([file, found]) => found.map((literal) => where(file, literal)));
    expect(
      report,
      `A file writes a hint-shaped string that no producer covers. Add a producer to producers.ts and a recorder that drives it through its states, then list the file and its count in hint-ledger.ts (HINT_LITERAL_FILES); or, if the string is not a legend, allow it in NOT_A_LEGEND with a reason:\n${report.join('\n')}`,
    ).toEqual([]);
  });

  it('has exactly the ledger’s count of hint-shaped strings in every listed file', () => {
    const drift = Object.entries(HINT_LITERAL_FILES).flatMap(([file, count]) => {
      const found = LITERALS.get(file) ?? [];
      return found.length === count
        ? []
        : [
            `${file}: the ledger says ${String(count)}, the file writes ${String(found.length)}${found.length === 0 ? ' (converted to the builder: delete the entry)' : ''}\n${found.map((literal) => `    ${where(file, literal)}`).join('\n')}`,
          ];
    });
    expect(
      drift,
      `More strings: give each a recorder state and raise the count. Fewer: a producer was converted to the builder, so lower the count (delete the entry at zero).\n${drift.join('\n')}`,
    ).toEqual([]);
  });

  it('lists only files that exist and that a producer is registered for', () => {
    const producerFiles = new Set(PRODUCERS.map((producer) => producer.file));
    for (const file of Object.keys(HINT_LITERAL_FILES)) {
      expect(existsSync(`${CLI_SRC}${file}`), `${file} does not exist`).toBe(true);
      expect(producerFiles.has(file), `${file} has no producer in producers.ts`).toBe(true);
    }
  });

  it('has every fixed word of every listed string in the golden rows of a producer of that file', () => {
    const missing: string[] = [];
    for (const file of Object.keys(HINT_LITERAL_FILES)) {
      const recorded = recordedFor(file);
      for (const literal of LITERALS.get(file) ?? []) {
        const absent = fixedWords(literal).filter((word) => !recorded.includes(word));
        if (absent.length > 0)
          missing.push(`${where(file, literal)}\n    not in the golden: ${JSON.stringify(absent)}`);
      }
    }
    expect(
      missing,
      `A string the file writes is in no recording of a producer of that file; extend the recorder so it is driven:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

describe('NOT_A_LEGEND', () => {
  it('gives a reason for every entry, names a path that exists, and has no allowance that matches nothing', () => {
    for (const entry of NOT_A_LEGEND) {
      expect(entry.reason.trim().length, `${entry.file} has no reason`).toBeGreaterThan(20);
      expect(existsSync(`${CLI_SRC}${entry.file}`), `${entry.file} does not exist`).toBe(true);
      if (entry.contains === undefined) continue;
      const file = entry.file;
      const matches = hintLiterals(readFileSync(`${CLI_SRC}${file}`, 'utf8'), file).filter(
        (literal) => literal.text.includes(entry.contains ?? ''),
      );
      expect(
        matches.length,
        `${file}: the allowance for ${JSON.stringify(entry.contains)} is stale`,
      ).toBeGreaterThan(0);
    }
  });

  it('does not allow a producer’s own file, so an allowance cannot hide a legend the golden has', () => {
    const producerFiles = new Set(PRODUCERS.map((producer) => producer.file));
    for (const entry of NOT_A_LEGEND) {
      expect(
        [...producerFiles].filter((file) =>
          entry.file.endsWith('/') ? file.startsWith(entry.file) : file === entry.file,
        ),
        `${entry.file} is allowed and is a producer`,
      ).toEqual([]);
    }
  });
});

describe('the shape of a hint-shaped string', () => {
  const YES: readonly string[] = [
    '↑/↓ select · Enter run · Esc cancel',
    'Esc or Ctrl+C stops the turn',
    '[Ctrl+Y] Allow   [Ctrl+G] Allow this session',
    '[d] withdraw',
    '[v] Full diff',
    'Press d again.',
    'Any other key cancels',
    'Enter to send · Ctrl+J newline',
    'Enter says why',
    'Press Enter to return to Relavium.',
    '/ commands · ↓ Continue · type a message to chat · Ctrl+C twice to exit',
    'Shift+Tab or /mode changes the current mode.',
    'Notice 1–17 of 60 · PgUp/PgDn to read',
    'Esc to stop',
    'a bare Ctrl-D ends it',
  ];
  const NO: readonly string[] = [
    'Esc',
    'Ctrl+C',
    '[Enter]',
    'Esc / Ctrl+C',
    'Enter a different key',
    'Enter 0 to record it as free.',
    'Enter value',
    'Escape the quote',
    'The Home is where the run is shown.',
    'no matching command',
    '[x]',
    'Entered the directory',
    '',
  ];
  it.each(YES)('is one: %s', (text) => {
    expect(isHintShaped(text)).toBe(true);
  });
  it.each(NO)('is not one: %s', (text) => {
    expect(isHintShaped(text)).toBe(false);
  });
});
