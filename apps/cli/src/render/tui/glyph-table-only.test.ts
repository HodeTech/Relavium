import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { TABLE_GLYPHS } from './glyphs.js';

/**
 * The proof that the glyph table is the place the application writes a status or marker glyph, and that any other symbol character in
 * non-test source is there for a stated reason ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5). It is
 * the INVERSE of a list of the table's glyphs: every string, template and JSX text of every non-test source file of `apps/cli/src` is read
 * from the syntax tree (so a comment never counts and a `\uXXXX` escape is the character it spells), and ANY symbol character in it (arrows,
 * mathematical and technical symbols, the box-drawing and block blocks, geometric shapes, dingbats, braille, emoji) must be covered by an
 * entry of {@link ALLOWED}, which names the characters, the files where they may stand (or every file) and the reason. A glyph of the table
 * written anywhere else, a NEW symbol nobody listed, an entry that no longer matches anything, or fewer than nine tables importing the
 * module, fails here.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/**
 * What counts as a symbol character: the arrows through the miscellaneous symbols and arrows (U+2190 to U+2BFF: arrows, mathematical and
 * technical symbols, box drawing, block elements, geometric shapes, dingbats, braille), and every emoji and pictograph block
 * (U+1F300 and up), plus every character of the table (the bullet is U+2022) and the ones that left it.
 */
const SYMBOL = /[\u2190-\u2BFF\u{1F300}-\u{1FAFF}]/u;
const TABLE_AND_RETIRED = new Set([...TABLE_GLYPHS, '⏸', '▶', '❯']);
const isSymbol = (character: string): boolean =>
  SYMBOL.test(character) || TABLE_AND_RETIRED.has(character);

const LEAD_REASON =
  'a prose lead-in with its sentence beside it, so no state hangs on the glyph; no plain form yet (Phase 2.6.L)';

interface Allowance {
  /** The characters this entry allows. */
  readonly characters: RegExp;
  /** The files (relative to `src`) where they may stand; absent, every file. Each listed file must still hold one. */
  readonly files?: readonly string[];
  readonly reason: string;
}

/**
 * Every symbol character the non-test source writes outside the table, and why none is a status or a marker the host could confuse with
 * one. A new character, or an old one in a new file, is a decision: add an entry with its reason, or take the glyph from the table.
 */
const ALLOWED: readonly Allowance[] = [
  {
    characters: /[←↑→↓]/u,
    reason:
      'the arrow keys name a key (`↑/↓ select`, `↑in ↓out`) and the arrow of a sentence (`a → b`); neither is a status or a marker, and the scroll markers are `▲ ▼` of the table',
  },
  {
    characters: /⇒/u,
    files: ['commands/descriptors.ts', 'program.ts'],
    reason: 'the “implies” of a help sentence (`omit ⇒ all runs`)',
  },
  {
    characters: /[−≥⌃]/u,
    files: ['render/provider-key-shape.ts', 'render/tui/run-card-model.ts', 'test-support.ts'],
    reason:
      'a character a PATTERN matches (the minus sign among the dashes of a key, the Mac control sign of a chord token) or a figure in a message (`≥1`); none is drawn as a marker',
  },
  {
    characters: /[\u2800-\u28FF]/u,
    files: ['render/tui/format.ts'],
    reason:
      'the frames of the animated spinner: a mark that is not a table glyph and carries no state',
  },
  {
    characters: /[│└]/u,
    files: [
      'render/tui/home-app.tsx',
      'render/tui/native-prompt-view.tsx',
      'render/tui/question-card.ts',
      'render/tui/question-card-record.ts',
      'render/tui/run-card-model.ts',
      'render/tui/tab-host.ts',
    ],
    reason:
      'the vertical gutter and the corner of a card or a strip: the box-drawing block is host-blanked in every author text, and the row floor does not move',
  },
  {
    characters: /[\u2500-\u257F]/u,
    files: ['render/markdown/layout.ts', 'render/markdown/parser.ts'],
    reason:
      'the rules and borders of a model’s markdown (a horizontal rule, a table’s frame), laid out as content',
  },
  {
    characters: /[\u2500-\u257F]/u,
    files: ['render/scrollback.ts'],
    reason: 'the header and footer of the transcript dump written to the terminal’s own scrollback',
  },
  {
    characters: /[\u2500-\u257F]/u,
    files: ['render/tui/banner.ts'],
    reason: 'the banner’s box, which has its own ASCII box under colour off (ADR-0068)',
  },
  {
    characters: /•/u,
    files: ['engine/providers.ts', 'home/run-launch.ts', 'render/tui/native-prompt-channel.ts'],
    reason:
      'the mask of a secret: `••••` for a provider key, a secret field, or each character of a password',
  },
  {
    characters: /•/u,
    files: ['render/markdown/parser.ts'],
    reason: 'the bullet of a list in a model’s markdown, laid out as content',
  },
  {
    characters: /✎/u,
    files: ['render/tui/run-view-model.ts'],
    reason: `${LEAD_REASON}: the lead of \`patch proposed (N files)\``,
  },
  {
    characters: /✻/u,
    files: ['render/tui/chat-projection.ts'],
    reason: `${LEAD_REASON}: the lead of the reasoning line`,
  },
  {
    characters: /⟳/u,
    files: [
      'chat/repl-info.ts',
      'render/tui/chat-projection.ts',
      'render/tui/session-view-model.ts',
    ],
    reason: `${LEAD_REASON}: the lead of a compaction notice`,
  },
  {
    characters: /✂/u,
    files: ['chat/repl-info.ts', 'render/tui/session-view-model.ts'],
    reason: `${LEAD_REASON}: the lead of a trimming notice`,
  },
  {
    characters: /✨/u,
    files: ['chat/repl-info.ts'],
    reason: `${LEAD_REASON}: the lead of the fresh-conversation notice`,
  },
  {
    characters: /📎/u,
    files: ['render/tui/attachment-bar.tsx', 'render/tui/attachments.ts'],
    reason: `${LEAD_REASON}: the lead of the attachment bar and of the stored attachment note`,
  },
  {
    characters: /⧗/u,
    files: ['render/tui/run-view-model.ts'],
    reason: `${LEAD_REASON}: the lead of \`media job submitted\``,
  },
  {
    characters: /[\u{1F300}-\u{1FAFF}]/u,
    files: [
      'engine/tool-host/lower-host-fixture.ts',
      'engine/tool-host/macos-write-benchmark.ts',
      'render/markdown/fixtures/stream-corpus.ts',
    ],
    reason:
      'an emoji a fixture or a benchmark writes on purpose, to exercise width and grapheme handling',
  },
];

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly character: string;
}

/**
 * Every symbol character in the strings, templates, JSX text and regular expressions of `text` (comments are not read), with the line it
 * stands on. A string is read as the character it spells: a `\u2713` escape is `✓`.
 */
function symbolsIn(file: string, text: string): Hit[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Hit[] = [];
  const read = (node: ts.Node, value: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    for (const character of value) if (isSymbol(character)) hits.push({ file, line, character });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node) ||
      ts.isRegularExpressionLiteral(node)
    )
      read(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const isAllowed = (hit: Hit): boolean =>
  ALLOWED.some(
    (entry) =>
      entry.characters.test(hit.character) &&
      (entry.files === undefined || entry.files.includes(hit.file)),
  );

const isTestFile = (name: string): boolean => /\.test\.tsx?$/u.test(name);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'surface-matrix' || entry === 'legend-golden' || entry === 'node_modules')
        continue;
      files.push(...sourceFiles(path));
    } else if (/\.tsx?$/u.test(entry) && !isTestFile(entry)) files.push(path);
  }
  return files;
}

const hitsOf = (path: string): Hit[] =>
  symbolsIn(relative(SRC, path).split(sep).join('/'), readFileSync(path, 'utf8'));

describe('every symbol character of the application’s source is the table’s or has a stated reason', () => {
  const files = sourceFiles(SRC).filter((path) => !path.endsWith('render/tui/glyphs.ts'));

  it('no non-test source file writes a symbol character that no entry of the allow-list covers', () => {
    const unexpected = files
      .flatMap(hitsOf)
      .filter((hit) => !isAllowed(hit))
      .map(
        (hit) =>
          `${hit.file}:${String(hit.line)}  ${hit.character} (U+${(hit.character.codePointAt(0) ?? 0).toString(16)})`,
      );
    expect(
      unexpected,
      'a symbol character is written outside glyphs.ts: draw it through the table (add a role) or add an entry to ALLOWED with its reason',
    ).toEqual([]);
  });

  it('keeps the allow-list honest: every entry, and every file of every entry, still holds a character it allows', () => {
    const hits = files.flatMap(hitsOf);
    const stale: string[] = [];
    for (const entry of ALLOWED) {
      expect(entry.reason.length, String(entry.characters)).toBeGreaterThan(30);
      const matching = hits.filter((hit) => entry.characters.test(hit.character));
      if (entry.files === undefined) {
        if (matching.length === 0) stale.push(`${String(entry.characters)} is written nowhere`);
        continue;
      }
      for (const file of entry.files) {
        if (!matching.some((hit) => hit.file === file))
          stale.push(
            `${file} no longer writes ${String(entry.characters)}: remove it from the entry`,
          );
      }
    }
    expect(stale).toEqual([]);
  });

  it('the allow-list lets a glyph of the table through only as a mask, a markdown bullet or rule, the banner and scrollback boxes, and the pencil’s lead', () => {
    const tableHits = files
      .flatMap(hitsOf)
      .filter((hit) => TABLE_AND_RETIRED.has(hit.character) && isAllowed(hit))
      .map((hit) => `${hit.file} ${hit.character}`);
    expect([...new Set(tableHits)].sort()).toEqual([
      'engine/providers.ts •',
      'home/run-launch.ts •',
      'render/markdown/layout.ts ─',
      'render/markdown/parser.ts •',
      'render/scrollback.ts ─',
      'render/tui/banner.ts ─',
      'render/tui/native-prompt-channel.ts •',
      'render/tui/run-view-model.ts ✎',
    ]);
  });

  it('at least nine status tables, selection markers and scroll markers read the table', () => {
    const readers = files.filter((path) =>
      /from '(?:\.\.?\/)+(?:render\/tui\/)?glyphs\.js'/u.test(readFileSync(path, 'utf8')),
    );
    const names = readers.map((path) => relative(SRC, path));
    expect(names.length).toBeGreaterThanOrEqual(9);
    // the tables the plan names
    for (const name of [
      'render/tui/format.ts',
      'history/history-model.ts',
      'chat/doctor.ts',
      'render/tui/home-projection.ts',
      'render/tui/tab-host-active.ts',
      'render/tui/run-screen.ts',
      'render/tui/run-card-model.ts',
      'render/tui/palette-view.tsx',
      'render/tui/sheet-frame.ts',
    ]) {
      expect(names, `${name} reads the glyph table`).toContain(name);
    }
  });
});

describe('the symbol scan sees what it should (it is run on text it is given, not on the repository)', () => {
  const hits = (text: string, file = 'x.ts'): string[] =>
    symbolsIn(file, text).map((hit) => hit.character);

  it.each([
    ['a string', "const a = 'status ✓';", ['✓']],
    ['an escape', "const a = '\\u2713';", ['✓']],
    ['a code-point escape', "const a = '\\u{1F525}';", ['🔥']],
    ['a template', 'const a = `x ${b} ▲`;', ['▲']],
    ['a template head and tail', 'const a = `◉ ${b} ◌`;', ['◉', '◌']],
    ['a regular expression', 'const a = /[✗]/u;', ['✗']],
    ['a symbol nobody listed', "const a = '✱ new';", ['✱']],
    ['an emoji', "const a = '🔥 hot';", ['🔥']],
    ['a box-drawing character', "const a = '╠═╣';", ['╠', '═', '╣']],
    ['a bullet, which is a glyph of the table', "const a = '• item';", ['•']],
  ])('finds %s', (_name, text, expected) => {
    expect(hits(text)).toEqual(expected);
  });

  it('finds a symbol in JSX text', () => {
    expect(hits('export const a = <Text>◐ working</Text>;', 'x.tsx')).toEqual(['◐']);
  });

  it.each([
    ['a line comment', '// ✓ done\nconst a = 1;'],
    ['a block comment', '/* ▲ ▼ */ const a = 1;'],
    ['a doc comment', '/** the `✓` of the table */\nexport const a = 1;'],
    ['ordinary prose punctuation', "const a = 'a — b … c · d “e” ’f’ é 漢';"],
  ])('does not read %s', (_name, text) => {
    expect(hits(text)).toEqual([]);
  });

  it('names the line the symbol stands on', () => {
    expect(symbolsIn('x.ts', "const a = 1;\nconst b = 2;\nconst c = '✗';\n")).toEqual([
      { file: 'x.ts', line: 3, character: '✗' },
    ]);
  });

  it('an entry covers only its own files: the same glyph in another file is a violation', () => {
    expect(isAllowed({ file: 'render/tui/run-view-model.ts', line: 1, character: '✎' })).toBe(true);
    expect(isAllowed({ file: 'render/tui/other.ts', line: 1, character: '✎' })).toBe(false);
    expect(isAllowed({ file: 'render/tui/other.ts', line: 1, character: '↑' })).toBe(true);
    expect(isAllowed({ file: 'render/tui/other.ts', line: 1, character: '✓' })).toBe(false);
    expect(isAllowed({ file: 'render/tui/other.ts', line: 1, character: '•' })).toBe(false);
  });
});
