import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TABLE_GLYPHS } from './glyphs.js';

/**
 * The proof that the glyph table is the ONE place the application writes a status or marker glyph ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §5): every non-test source file of `apps/cli/src` is scanned, comments aside, for a glyph of the table written as a character or as a
 * `\uXXXX` escape, and the files that read the table are counted. A glyph written anywhere else, or fewer than nine tables importing the
 * module, fails here.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** The glyphs this scan looks for: every glyph of the table and the ones that left it (the pause sign and the play sign). */
const SCANNED = [...new Set([...TABLE_GLYPHS, '⏸', '▶', '❯'])];

/**
 * Files that still write one of the table's characters, and why none of them is a status or a marker: a mask hides the characters of a secret
 * (`••••` for a key, a password), and a bullet is the character of a markdown list of text a model wrote, which the host lays out and does not
 * annotate. None says a state or marks a position, and none is drawn as a host marker.
 */
const NOT_A_TABLE_GLYPH: Readonly<Record<string, string>> = {
  'engine/providers.ts': 'the mask of a provider key in a listing (`••••abcd`)',
  'home/run-launch.ts': 'the mask of a secret field in the run launcher’s summary (`name=••••`)',
  'render/tui/native-prompt-channel.ts':
    'the mask a password prompt echoes for each typed character',
  'render/markdown/parser.ts': 'the bullet of a list in a model’s markdown, laid out as content',
  'render/markdown/layout.ts':
    'the rules and borders of a model’s markdown (a horizontal rule, a table’s frame), laid out as content',
  'render/scrollback.ts':
    'the header and footer of the transcript dump written to the terminal’s own scrollback',
  'render/tui/banner.ts':
    'the banner’s box, which has its own ASCII box under colour off (ADR-0068)',
};

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

/** The code of a file: every line that is not a comment, with a trailing `// …` comment cut off. */
function codeLines(text: string): readonly { readonly line: number; readonly code: string }[] {
  const lines: { line: number; code: string }[] = [];
  let block = false;
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (block) {
      if (trimmed.includes('*/')) block = false;
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) block = true;
      return;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const trailing = /\s\/\/\s/u.exec(raw);
    lines.push({ line: index + 1, code: trailing === null ? raw : raw.slice(0, trailing.index) });
  });
  return lines;
}

const escapes = (character: string): string[] => {
  const hex = (character.codePointAt(0) ?? 0).toString(16);
  return [`\\u${hex.padStart(4, '0')}`, `\\u${hex.padStart(4, '0').toUpperCase()}`, `\\u{${hex}}`];
};

describe('the glyph table is the only place a status or marker glyph is written', () => {
  const files = sourceFiles(SRC).filter((path) => !path.endsWith('render/tui/glyphs.ts'));

  it('no non-test source file writes a glyph of the table, except the masks and the list bullet that are not one', () => {
    const found = new Map<string, string[]>();
    for (const path of files) {
      const name = relative(SRC, path);
      for (const { line, code } of codeLines(readFileSync(path, 'utf8'))) {
        const hit = SCANNED.find(
          (character) =>
            code.includes(character) || escapes(character).some((form) => code.includes(form)),
        );
        if (hit !== undefined)
          found.set(name, [...(found.get(name) ?? []), `${String(line)}: ${hit}`]);
      }
    }
    const unexpected = [...found.entries()].filter(
      ([name]) => NOT_A_TABLE_GLYPH[name] === undefined,
    );
    expect(unexpected, 'a glyph of the table is written outside glyphs.ts').toEqual([]);
    // every exception is real: a file that no longer writes one has to leave the list
    for (const name of Object.keys(NOT_A_TABLE_GLYPH)) {
      expect(found.has(name), `${name} no longer writes a glyph: remove it from the list`).toBe(
        true,
      );
    }
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
