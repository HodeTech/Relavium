import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The proof that the dimmed backdrop of an open popup reaches EVERY `Text` of the product
 * ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §4): the dimming is a leaf-level
 * route, `render/tui/text.tsx`, and a view that imports ink's own `Text` would draw a cell the route cannot dim. Every non-test, non-harness
 * source file of `apps/cli/src` is read from its syntax tree (so a comment, or a word in a sentence, never counts) for each way a module can
 * reach ink's `Text`: a named import (aliased or not, type-only too), a namespace import, a default import, a re-export, an
 * import-equals, a dynamic `import('ink')`, a `require('ink')` and an `import('ink')` type. Only the route may; and ink is imported for
 * `Text` nowhere else.
 *
 * The same read holds the two other ends of the route: the context is READ at paint time only by the route and by `Emph` (a hook in a
 * module that builds strings, or a cache key, would let dim into something that outlives the popup), and it is PROVIDED only by the two
 * hosts, around everything of the root that is not the overlay slot.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const ROUTE = 'render/tui/text.tsx';
/** Where `useBackdropDim` may be called: the route, and the one pair of the emphasis rule that has to know. */
const READERS = ['render/tui/emphasis-view.tsx', ROUTE];
/** Where `BackdropDim` may be rendered: the two roots that own an overlay slot. */
const PROVIDERS = ['render/tui/chat-ink.tsx', 'render/tui/home-app.tsx'];
/** The directories of test harnesses and fixtures: they mount and record the real views and are imported by no product file. */
const HARNESS_DIRECTORIES = new Set([
  'surface-matrix',
  'legend-golden',
  'fixtures',
  'node_modules',
]);

const isTest = (name: string): boolean => /\.test\.tsx?$/u.test(name);
const isHarnessName = (name: string): boolean => /test-support\.tsx?$|fixture/u.test(name);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!HARNESS_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(path));
    } else if (/\.tsx?$/u.test(entry.name) && !isTest(entry.name) && !isHarnessName(entry.name))
      files.push(path);
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

/** Whether a module specifier names ink (the package or a path inside it). */
const isInk = (specifier: string): boolean => specifier === 'ink' || specifier.startsWith('ink/');

/** The literal text of a specifier expression, or a template's fixed text; `undefined` when it is computed. */
function literalOf(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

/**
 * Every way `text` reaches ink's `Text`, as a short description each. A named import counts only for `Text` (`Box`, `useInput` and the rest
 * are not what is routed); a namespace import, a default import, a re-export of everything, a dynamic import and a require reach the whole
 * module, so they count whatever is read from them.
 */
function inkTextReaches(text: string, file = 'file.tsx'): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isInk(literalOf(node.moduleSpecifier) ?? '')) {
      const clause = node.importClause;
      if (clause?.name !== undefined) found.push('a default import of ink');
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings))
        found.push('a namespace import of ink');
      else if (bindings !== undefined)
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === 'Text')
            found.push(
              element.propertyName === undefined
                ? 'a named import of Text'
                : `an aliased import of Text (as ${element.name.text})`,
            );
    } else if (ts.isExportDeclaration(node) && isInk(literalOf(node.moduleSpecifier) ?? '')) {
      const clause = node.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) found.push('a re-export of ink');
      else if (
        clause.elements.some((element) => (element.propertyName ?? element.name).text === 'Text')
      )
        found.push('a re-export of Text');
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        isInk(literalOf(node.moduleReference.expression) ?? '')
      )
        found.push('an import-equals of ink');
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      isInk(literalOf(node.arguments[0]) ?? '')
    ) {
      found.push(
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? "a dynamic import('ink')"
          : "a require('ink')",
      );
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (isInk(literalOf(node.argument.literal) ?? '')) found.push("an import('ink') type");
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return found;
}

/** The names `text` imports from the route (`./text.js` or `../render/tui/text.js`, whatever the depth). */
function routeImports(text: string, file = 'file.tsx'): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalOf(node.moduleSpecifier) ?? '';
      const bindings = node.importClause?.namedBindings;
      if (
        /(?:^|\/)text\.js$/u.test(specifier) &&
        bindings !== undefined &&
        ts.isNamedImports(bindings)
      )
        for (const element of bindings.elements)
          names.push((element.propertyName ?? element.name).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return names;
}

/** Whether `text` draws a `<Text>` element (a JSX tag, not the word in a comment). */
function drawsATextElement(text: string, file = 'file.tsx'): boolean {
  let draws = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === 'Text'
    )
      draws = true;
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return draws;
}

/** Whether a `<BackdropDim>` element of `text` holds the overlay slot: a `<PopupSlot>` or the `{slot}` the hosts build it into. */
function dimmedSubtreeHoldsTheSlot(text: string, file = 'file.tsx'): boolean {
  let holds = false;
  const holdsSlot = (node: ts.Node): boolean => {
    let found = false;
    const look = (inner: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(inner) || ts.isJsxSelfClosingElement(inner)) &&
        inner.tagName.getText() === 'PopupSlot'
      )
        found = true;
      if (ts.isJsxExpression(inner) && inner.expression?.getText() === 'slot') found = true;
      ts.forEachChild(inner, look);
    };
    look(node);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'BackdropDim') {
      if (node.children.some(holdsSlot)) holds = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(text, file));
  return holds;
}

const FILES = sourceFiles(SRC).map((path) => ({
  name: relative(SRC, path).split(sep).join(posix.sep),
  text: readFileSync(path, 'utf8'),
}));

describe('the guard sees every way a module reaches ink’s Text (it is run on text it is given)', () => {
  it.each([
    ['a named import', "import { Text } from 'ink';"],
    ['a named import among others', "import { Box, Text, useInput } from 'ink';"],
    ['a multi-line named import', "import {\n  Box,\n  Text,\n} from 'ink';"],
    ['an aliased import', "import { Text as InkText } from 'ink';"],
    ['a type-only import', "import type { Text } from 'ink';"],
    ['a type-only specifier', "import { type Text } from 'ink';"],
    ['a namespace import', "import * as ink from 'ink';"],
    ['a default import', "import ink from 'ink';"],
    ['a re-export of Text', "export { Text } from 'ink';"],
    ['a re-export of everything', "export * from 'ink';"],
    ['an import-equals', "import ink = require('ink');"],
    ['a dynamic import', "const { Text } = await import('ink');"],
    [
      'a dynamic import of a path inside ink',
      "const t = await import('ink/build/components/Text.js');",
    ],
    ['a dynamic import in a template', 'const t = await import(`ink`);'],
    ['a require', "const { Text } = require('ink');"],
    ['an import type', "type T = import('ink').Text;"],
  ])('flags %s', (_name, text) => {
    expect(inkTextReaches(text).length, text).toBeGreaterThan(0);
  });

  it('flags a tsx file the same way', () => {
    expect(
      inkTextReaches("import { Text } from 'ink'; export const a = <Text>x</Text>;", 'x.tsx'),
    ).toEqual(['a named import of Text']);
  });

  it.each([
    ['the other names of ink', "import { Box, useInput, render, type DOMElement } from 'ink';"],
    ['the route', "import { Text } from './text.js';"],
    ['the route from another directory', "import { Text } from '../render/tui/text.js';"],
    ['a comment', "// import { Text } from 'ink';\nconst a = 1;"],
    ['a string that is not a specifier', 'const a = "import { Text } from \'ink\'";'],
    ['a package whose name starts with ink', "import { Text } from 'inkling';"],
    ['an import of something called Text from elsewhere', "import { Text } from './elsewhere.js';"],
    ['a re-export of another name of ink', "export { Box } from 'ink';"],
  ])('does not flag %s', (_name, text) => {
    expect(inkTextReaches(text), text).toEqual([]);
  });

  it('tells a file that draws a <Text> from one that only names it in a comment', () => {
    expect(drawsATextElement('const a = <Text>x</Text>;')).toBe(true);
    expect(drawsATextElement('const a = <Text wrap="wrap" />;')).toBe(true);
    expect(drawsATextElement('// <Text>\nconst a = <Box />;')).toBe(false);
  });

  it('reads the names a file takes from the route, and nothing else', () => {
    expect(routeImports("import { BackdropDim, Text } from './text.js';")).toEqual([
      'BackdropDim',
      'Text',
    ]);
    expect(routeImports("import { useBackdropDim as dim } from '../render/tui/text.js';")).toEqual([
      'useBackdropDim',
    ]);
    expect(
      routeImports("import { Text } from './context.js'; import { A } from './subtext.js';"),
    ).toEqual([]);
  });

  it('finds the overlay slot inside a dimmed element, however it is written', () => {
    expect(
      dimmedSubtreeHoldsTheSlot('const a = <BackdropDim dimmed><A />{slot}</BackdropDim>;'),
    ).toBe(true);
    expect(
      dimmedSubtreeHoldsTheSlot('const a = <BackdropDim dimmed><PopupSlot /></BackdropDim>;'),
    ).toBe(true);
    expect(
      dimmedSubtreeHoldsTheSlot(
        'const a = <BackdropDim dimmed><B><PopupSlot host={h} /></B></BackdropDim>;',
      ),
    ).toBe(true);
    expect(
      dimmedSubtreeHoldsTheSlot('const a = <><BackdropDim dimmed><A /></BackdropDim>{slot}</>;'),
    ).toBe(false);
    expect(
      dimmedSubtreeHoldsTheSlot(
        'const a = <><BackdropDim dimmed><A /></BackdropDim><PopupSlot /></>;',
      ),
    ).toBe(false);
  });
});

describe('the product draws all its text through the route', () => {
  it('reads the product: the route and the views are among the files it scans', () => {
    const names = new Set(FILES.map((file) => file.name));
    for (const name of [
      ROUTE,
      'render/tui/home-view.tsx',
      'render/tui/transcript-viewport.tsx',
      'render/tui/prompt-view.tsx',
      'render/tui/markdown-text.tsx',
      'render/tui/home-app.tsx',
      'render/tui/chat-ink.tsx',
      'popups/popup-slot.tsx',
    ])
      expect(names.has(name), name).toBe(true);
    expect(names.has('render/tui/surface-matrix/terminal.ts'), 'the harness is left out').toBe(
      false,
    );
  });

  it('no source file but the route imports ink’s Text', () => {
    const offenders = FILES.filter((file) => file.name !== ROUTE).flatMap((file) =>
      inkTextReaches(file.text, file.name).map((how) => `${file.name}: ${how}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the route still imports it (the allowance has not rotted)', () => {
    const route = FILES.find((file) => file.name === ROUTE);
    expect(inkTextReaches(route?.text ?? '', ROUTE)).toEqual([
      'an aliased import of Text (as InkText)',
    ]);
  });

  it('the views take their Text from the route: every file that draws a <Text> imports it from there', () => {
    const drawsText = FILES.filter(
      (file) => file.name !== ROUTE && drawsATextElement(file.text, file.name),
    );
    expect(drawsText.length).toBeGreaterThan(15);
    const missing = drawsText.filter(
      (file) => !routeImports(file.text, file.name).includes('Text'),
    );
    expect(missing.map((file) => file.name)).toEqual([]);
  });
});

describe('the context is read and provided where the route says, and never around the overlay slot', () => {
  it('only the route and the emphasis pair read the context at paint time', () => {
    const readers = FILES.filter((file) =>
      routeImports(file.text, file.name).includes('useBackdropDim'),
    )
      .map((file) => file.name)
      .sort();
    expect(readers).toEqual(READERS.filter((name) => name !== ROUTE).sort());
  });

  it('only the two roots that own an overlay slot provide it', () => {
    const providers = FILES.filter((file) =>
      routeImports(file.text, file.name).includes('BackdropDim'),
    )
      .map((file) => file.name)
      .sort();
    expect(providers).toEqual([...PROVIDERS].sort());
  });

  it('no module that builds a string in advance (a projection, a wrap, a markdown layout) knows the context', () => {
    const importers = FILES.filter(
      (file) =>
        !file.name.endsWith('.tsx') &&
        routeImports(file.text, file.name).some((name) => /BackdropDim/u.test(name)),
    );
    expect(importers.map((file) => file.name)).toEqual([]);
  });

  it.each(PROVIDERS)('%s keeps the overlay slot OUTSIDE every dimmed element', (name) => {
    const file = FILES.find((candidate) => candidate.name === name);
    expect(file, name).toBeDefined();
    expect(dimmedSubtreeHoldsTheSlot(file?.text ?? '', name)).toBe(false);
    expect(file?.text ?? '', `${name} renders the slot`).toMatch(/<PopupSlot\b|\{slot\}/u);
  });
});
