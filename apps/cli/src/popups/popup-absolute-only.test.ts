/**
 * The overlay slot is the ONLY absolutely positioned node of the CLI, it is the LAST child of every host's root, and a popup reads no key of
 * its own ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2): z-order is tree order,
 * and the spike showed that a later sibling is drawn over a popup while the bounds check still passes, so the guarantee that nothing covers a
 * popup's rows is structural and is pinned here on the syntax tree of every non-test source file (a comment never counts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** The one file allowed to position a node absolutely. */
const SLOT_FILE = 'popups/popup-slot.tsx';

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) files.push(path);
  }
  return files;
}

const FILES = sourceFiles(SRC).map((path) => relative(SRC, path).split(sep).join('/'));

function parse(file: string): ts.SourceFile {
  const text = readFileSync(join(SRC, file), 'utf8');
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Every place a node is positioned absolutely: a JSX `position="absolute"` (or `{'absolute'}`), or an object's `position: 'absolute'`. */
function absolutePlaces(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const isAbsolute = (node: ts.Node | undefined): boolean => {
    if (node === undefined) return false;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text === 'absolute';
    if (ts.isJsxExpression(node)) return isAbsolute(node.expression);
    return false;
  };
  const visit = (node: ts.Node): void => {
    const named = (name: ts.Node): boolean => ts.isIdentifier(name) && name.text === 'position';
    if (ts.isJsxAttribute(node) && named(node.name) && isAbsolute(node.initializer))
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    if (ts.isPropertyAssignment(node) && named(node.name) && isAbsolute(node.initializer))
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe('one overlay slot, the only absolutely positioned layer', () => {
  it('no source file but the slot positions a node absolutely, and the slot does it once', () => {
    const found = FILES.flatMap((file) =>
      absolutePlaces(parse(file)).map((line) => `${file}:${String(line)}`),
    );
    expect(found.length).toBe(1);
    expect(found[0]?.startsWith(`${SLOT_FILE}:`)).toBe(true);
  });

  it('the pattern finds both spellings (the check checks)', () => {
    const sf = ts.createSourceFile(
      'probe.tsx',
      `const a = <Box position="absolute" />; const b = <Box position={'absolute'} />; const c = { position: 'absolute' }; const d = <Box position="relative" />;`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect(absolutePlaces(sf)).toHaveLength(3);
  });

  it.each([
    ['render/tui/home-app.tsx', 3],
    ['render/tui/chat-ink.tsx', 1],
  ])(
    'in %s the slot is the last child of the root of every branch (%s branches)',
    (file, branches) => {
      const sf = parse(file);
      // Every JSX element whose children include the slot (`{slot}` or `<PopupSlot`): the slot must be its LAST child.
      let checked = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
          const children = node.children.filter(
            (child) => !(ts.isJsxText(child) && child.text.trim() === ''),
          );
          const holdsSlot = (child: ts.JsxChild): boolean =>
            (ts.isJsxExpression(child) &&
              child.expression !== undefined &&
              ts.isIdentifier(child.expression) &&
              child.expression.text === 'slot') ||
            (ts.isJsxSelfClosingElement(child) && child.tagName.getText(sf) === 'PopupSlot');
          const at = children.findIndex(holdsSlot);
          if (at >= 0) {
            checked += 1;
            expect(
              at,
              `${file}: the slot is not the last child at line ${String(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)}`,
            ).toBe(children.length - 1);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(checked).toBe(branches);
    },
  );

  it('notifications are never absolute: the channel draws on the hint row through the views, and has no view of its own', () => {
    const text = readFileSync(join(SRC, 'popups/notifications.ts'), 'utf8');
    expect(text).not.toMatch(/from 'ink'|from 'react'/u);
  });
});

describe('one active key reader at a time (ADR-0148 §2)', () => {
  it('no file of the popups opens a key reader of its own: the host’s root routes every key to the popup', () => {
    const readers = FILES.filter((file) => file.startsWith('popups/')).filter((file) =>
      /\buse(?:Input|Paste)\s*\(/u.test(readFileSync(join(SRC, file), 'utf8')),
    );
    expect(readers).toEqual([]);
  });
});
