import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The proof that `emphasis.ts` is the ONE place the application draws bold, inverse and underline ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §5): every non-test source file of `apps/cli/src` is read from its syntax tree (so a comment or a word in a sentence never counts) for
 * (1) a raw `bold`, `inverse` or `underline` prop of ink's `<Text>` (a JSX attribute, or a property of an object that is spread into one),
 * which chalk draws and which vanishes where chalk is at level 0 (`NO_COLOR`, `--no-color`, `FORCE_COLOR=0`, `TERM=dumb`), and (2) a
 * string that writes one of the three SGR pairs by hand, which is the same rule written a second time.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const STYLES = new Set(['bold', 'inverse', 'underline']);
/**
 * The SGR sequences of the three styles and their closes: `ESC[1m`, `ESC[4m`, `ESC[7m`, `ESC[22m`, `ESC[24m`, `ESC[27m`. A literal that
 * starts with the sequence's tail (`[7m`) counts too: it is what is left of a template that writes the escape byte as `${ESC}[7m`.
 */
// eslint-disable-next-line no-control-regex -- the point of the pattern is the escape byte
const STYLE_SGR = /(?:\u001b|^)\[(?:1|4|7|22|24|27)m/u;

/**
 * Files that may carry a raw style prop, and why none of them is the host's own chrome. Each is checked to still need its entry, so the list
 * cannot rot into a licence.
 */
const RAW_PROP_ALLOWED: Readonly<Record<string, string>> = {
  'render/tui/emphasis.ts':
    'the rule itself: its table of the three pairs and the description of a set (a tone a test names)',
  'render/tui/markdown-text.tsx':
    'draws MODEL content (a markdown heading, strong text, a link) under its own colour gate; the highlight of a mouse selection is host feedback and is drawn through emphasis.ts; the markdown layer is never handed literal SGR from model text',
  'render/tui/text.tsx':
    'the one route of ink’s <Text> (ADR-0148 §4): under the dimmed backdrop of an open popup it passes `bold={false}` to REMOVE a bold (bold and dim share a close code, and ink’s cell encoder drops the dim after a bold-and-dim cell); it never asks for one',
  'render/tui/syntax-palette.ts':
    'the colours and weights of a highlighted CODE BLOCK in a model’s reply (ADR-0144), a model-content style under its own colour gate',
};

/** Files that may write an SGR pair by hand. */
const SGR_ALLOWED: Readonly<Record<string, string>> = {
  'render/tui/emphasis.ts': 'the rule itself',
};

const isTest = (name: string): boolean => /\.test\.tsx?$/u.test(name);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      // The surface matrix, the legend golden and the fixtures are test infrastructure, not the product's chrome.
      if (['surface-matrix', 'legend-golden', 'fixtures', 'node_modules'].includes(entry)) continue;
      files.push(...sourceFiles(path));
    } else if (/\.tsx?$/u.test(entry) && !isTest(entry)) files.push(path);
  }
  return files;
}

function parse(text: string, file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const propertyName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/** Every raw style prop in `text`: a JSX attribute or an object-literal property or type member named bold, inverse or underline. */
function rawStyleProps(text: string, file = 'file.tsx'): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && STYLES.has(node.name.getText())) found.push(node.name.getText());
    else if (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) {
      const name = propertyName(node.name);
      if (name !== undefined && STYLES.has(name)) found.push(name);
    } else if (ts.isShorthandPropertyAssignment(node) && STYLES.has(node.name.text))
      found.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return found;
}

/** Every string (or template) literal of `text` that writes one of the style pairs. */
function handWrittenSgr(text: string, file = 'file.ts'): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      STYLE_SGR.test(node.text)
    )
      found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return found;
}

const FILES = sourceFiles(SRC).map((path) => ({
  path,
  name: relative(SRC, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}));

describe('the guard reads what it is meant to', () => {
  it('finds a raw prop however it is written, and not a comment, a sentence or a name that is not a prop', () => {
    expect(rawStyleProps('const a = <Text bold>x</Text>;')).toEqual(['bold']);
    expect(rawStyleProps('const a = <Text color="red" inverse={on}>x</Text>;')).toEqual([
      'inverse',
    ]);
    expect(rawStyleProps('const a = <Text underline wrap="wrap">x</Text>;')).toEqual(['underline']);
    expect(rawStyleProps('const a = { color: "red", bold: true };')).toEqual(['bold']);
    expect(rawStyleProps('const bold = true; const a = { bold };')).toEqual(['bold']);
    expect(rawStyleProps('const a = { "inverse": true };')).toEqual(['inverse']);
    expect(rawStyleProps('type P = { readonly bold?: true };')).toEqual(['bold']);
    expect(
      rawStyleProps('// <Text bold>\n/* { inverse: true } */\nconst s = "bold inverse";'),
    ).toEqual([]);
    expect(rawStyleProps('function f(underline: string) { return underline; }')).toEqual([]);
    expect(rawStyleProps('const a = <Text emphasis="bold">x</Text>;')).toEqual([]);
  });

  it('finds a style pair written by hand, in a string and in a template, and not the same text in a comment', () => {
    expect(handWrittenSgr("const a = '\\u001b[7m';")).toHaveLength(1);
    expect(handWrittenSgr('const a = `\\u001b[1m${x}\\u001b[22m`;')).toHaveLength(2);
    expect(handWrittenSgr('const ESC = "\\u001b"; const a = `${ESC}[27m`;')).toHaveLength(1); // built from parts, as the rule's own module does
    expect(handWrittenSgr("const a = '\\u001b[31m';")).toEqual([]); // a colour is not one of the three
    expect(handWrittenSgr('// "\\u001b[7m"\nconst a = 1;')).toEqual([]);
  });
});

describe('no view draws bold, inverse or underline except through the one rule', () => {
  it('has no raw style prop outside the files that are named, with their reasons', () => {
    const offenders = FILES.flatMap((file) =>
      RAW_PROP_ALLOWED[file.name] === undefined
        ? rawStyleProps(file.text, file.path).map((prop) => `${file.name}: ${prop}`)
        : [],
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the allow-list honest: each named file still has a raw style prop, and still exists', () => {
    for (const name of Object.keys(RAW_PROP_ALLOWED)) {
      const file = FILES.find((candidate) => candidate.name === name);
      expect(file, `${name} exists`).toBeDefined();
      expect(
        rawStyleProps(file?.text ?? '', file?.path).length,
        `${name} still needs its entry`,
      ).toBeGreaterThan(0);
    }
  });

  it('writes no style pair by hand outside the rule’s own module', () => {
    const offenders = FILES.flatMap((file) =>
      SGR_ALLOWED[file.name] === undefined
        ? handWrittenSgr(file.text, file.path).map(
            (text) => `${file.name}: ${JSON.stringify(text)}`,
          )
        : [],
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the SGR allow-list honest: the rule’s module does write the pairs', () => {
    for (const name of Object.keys(SGR_ALLOWED)) {
      const file = FILES.find((candidate) => candidate.name === name);
      expect(file, `${name} exists`).toBeDefined();
      expect(handWrittenSgr(file?.text ?? '', file?.path).length, name).toBeGreaterThan(0);
    }
  });

  it('is scanning the product: the views of the TUI are among the files it reads', () => {
    const names = new Set(FILES.map((file) => file.name));
    for (const view of [
      'render/tui/palette-view.tsx',
      'render/tui/permissions-sheet-view.tsx',
      'render/tui/home-view.tsx',
      'render/tui/tool-review-view.tsx',
      'render/tui/prompt-view.tsx',
    ])
      expect(names.has(view), view).toBe(true);
  });
});
