import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The `withGlyphForm` hazard, closed ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5). `withGlyphForm`
 * puts a glyph form in force for the SYNCHRONOUS function it runs and restores it when the function returns. A component that returns JSX
 * from inside it has its CHILDREN rendered after it returned: an implicit reader (`glyph`, `statusCell`, `glyphWithWord`, …) inside a child
 * component then answers in the Unicode form, in a frame that is otherwise plain (the probe: a parent returns
 * `withGlyphForm(true, () => <><Text>{glyph('completed')}</Text><Child /></>)` and the child calls `glyph('completed')`: the frame reads `ok`
 * and then `✓`).
 *
 * The rule, held to every `.tsx` non-test source file by this test, on the syntax tree:
 *
 * 1. an implicit reader may be written **lexically inside the function argument of a `withGlyphForm(…)` call**; or
 * 2. inside a **function of the file that is not exported** and whose every reference is a **direct call** that is itself in a place the rule
 *    allows (a function called from such a callback, or from such a function, and so on). A function used as a JSX tag (`<Child />`) is
 *    NOT a direct call: it runs after the wrapper has returned, so it is outside the rule; or
 * 3. the file reads the form with `glyphOf(role, ascii)` only, which names the form it wants and needs no wrapper.
 *
 * A model written in a `.ts` file (a pure function of state that returns rows) is not read here: it is held by the view that calls it, which
 * wraps the call (rule 1), and `glyph-forms.test.tsx` mounts every surface in the plain form and fails on a Unicode glyph in a plain frame.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** The functions of `glyphs.ts` that read the form in force, found by reading `glyphs.ts`: those that touch `activeForm`, and those that call one. */
function implicitReadersOfGlyphs(text: string): ReadonlySet<string> {
  const sf = ts.createSourceFile('glyphs.ts', text, ts.ScriptTarget.Latest, true);
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of sf.statements)
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined)
      functions.set(statement.name.text, statement);
  /** Whether `node` reads `activeForm` or calls one of `readers` (a property that merely shares a reader's name, `entry.glyph`, is neither). */
  const touches = (node: ts.Node, readers: ReadonlySet<string>): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(child) && child.text === 'activeForm') found = true;
      else if (
        ts.isCallExpression(child) &&
        ts.isIdentifier(child.expression) &&
        readers.has(child.expression.text)
      )
        found = true;
      else ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const readers = new Set<string>();
  // `withGlyphForm` writes the form and is not a reader; the others read it, directly or through another reader.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, declaration] of functions) {
      if (readers.has(name) || name === 'withGlyphForm' || declaration.body === undefined) continue;
      if (touches(declaration.body, readers)) {
        readers.add(name);
        changed = true;
      }
    }
  }
  return readers;
}

const GLYPHS_SOURCE = readFileSync(join(SRC, 'render', 'tui', 'glyphs.ts'), 'utf8');
/** Implicit readers that live in another module and wrap one (so a call to them reads the form in force too). */
const EXTERNAL_READERS: Readonly<Record<string, string>> = {
  statusGlyph: 'render/tui/format.ts',
};
const READERS = new Set([
  ...implicitReadersOfGlyphs(GLYPHS_SOURCE),
  ...Object.keys(EXTERNAL_READERS),
]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly reader: string;
  readonly why: string;
}

/** The local names `file` has for the implicit readers it imports (`import { glyph as g }` is `g`), and for `withGlyphForm`. */
function importedNames(
  sf: ts.SourceFile,
  readers: ReadonlySet<string>,
): { readonly readers: ReadonlyMap<string, string>; readonly wrapper: ReadonlySet<string> } {
  const local = new Map<string, string>();
  const wrapper = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (readers.has(imported)) local.set(element.name.text, imported);
      if (imported === 'withGlyphForm') wrapper.add(element.name.text);
    }
  }
  return { readers: local, wrapper };
}

/** The top-level function-like units of a file: a function declaration, or a `const` initialised with an arrow or function expression. */
interface Unit {
  readonly name: string;
  readonly node: ts.Node;
  readonly exported: boolean;
}

function topLevelUnits(sf: ts.SourceFile): Unit[] {
  const units: Unit[] = [];
  for (const statement of sf.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      units.push({ name: statement.name.text, node: statement, exported });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        )
          units.push({ name: declaration.name.text, node: statement, exported });
      }
    }
  }
  return units;
}

/** Whether `node` is written inside the function argument of a call to the wrapper `withGlyphForm`. */
function insideWrapper(node: ts.Node, wrapper: ReadonlySet<string>): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      wrapper.has(current.expression.text)
    ) {
      const callback = current.arguments.at(-1);
      if (
        callback !== undefined &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        node.pos >= callback.pos &&
        node.end <= callback.end
      )
        return true;
    }
  }
  return false;
}

/** The violations of the rule above in one source file: each implicit read that rules 1 and 2 do not place inside a wrapper. */
function formScopeViolations(
  file: string,
  text: string,
  readers: ReadonlySet<string> = READERS,
): Violation[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = importedNames(sf, readers);
  if (names.readers.size === 0) return [];
  const units = topLevelUnits(sf);
  const unitOf = (node: ts.Node): Unit | undefined =>
    units.find((unit) => node.pos >= unit.node.pos && node.end <= unit.node.end);

  /** Every use of the identifier `name` in the file that is not its own declaration. */
  const referencesTo = (unit: Unit): ts.Identifier[] => {
    const found: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === unit.name) {
        const parent = node.parent;
        const isDeclaration =
          (ts.isFunctionDeclaration(parent) && parent.name === node) ||
          (ts.isVariableDeclaration(parent) && parent.name === node);
        const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
        const isLabel = ts.isPropertyAssignment(parent) && parent.name === node;
        const isAttribute = ts.isJsxAttribute(parent) && parent.name === node;
        if (!isDeclaration && !isMember && !isLabel && !isAttribute) found.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };

  const memo = new Map<string, boolean>();
  /** Whether everything that can reach `unit` does so by a direct call from a place the rule allows. */
  const reachedOnlyByAllowedCalls = (unit: Unit, trail: ReadonlySet<string>): boolean => {
    const known = memo.get(unit.name);
    if (known !== undefined) return known;
    if (unit.exported || trail.has(unit.name)) return false;
    const references = referencesTo(unit);
    const next = new Set([...trail, unit.name]);
    const allowed =
      references.length > 0 &&
      references.every((reference) => {
        const call = reference.parent;
        if (!ts.isCallExpression(call) || call.expression !== reference) return false;
        return allowedPlace(call, next);
      });
    memo.set(unit.name, allowed);
    return allowed;
  };

  /** Whether code written at `node` runs inside a wrapper, or inside a function that is only ever called from one. */
  const allowedPlace = (node: ts.Node, trail: ReadonlySet<string>): boolean => {
    if (insideWrapper(node, names.wrapper)) return true;
    const unit = unitOf(node);
    return unit !== undefined && reachedOnlyByAllowedCalls(unit, trail);
  };

  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const reader = names.readers.get(node.expression.text);
      if (reader !== undefined && !allowedPlace(node, new Set())) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const unit = unitOf(node);
        violations.push({
          file,
          line,
          reader,
          why:
            unit === undefined
              ? 'at the top level of the module'
              : unit.exported
                ? `in the exported function ${unit.name}, which a caller can run outside a wrapper`
                : `in ${unit.name}, which is not only called from inside a wrapper (a JSX tag is not a call)`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function viewFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (['surface-matrix', 'legend-golden', 'node_modules'].includes(entry)) continue;
      files.push(...viewFiles(path));
    } else if (/\.tsx$/u.test(entry) && !/\.test\.tsx$/u.test(entry)) files.push(path);
  }
  return files;
}

describe('an implicit glyph reader runs inside the form it is meant to read (the withGlyphForm hazard)', () => {
  const files = viewFiles(SRC);

  it('reads the implicit readers from glyphs.ts itself: `glyph`, `statusCell`, `glyphWithWord`, `plainFormInForce` and what wraps them', () => {
    expect([...implicitReadersOfGlyphs(GLYPHS_SOURCE)].sort()).toEqual([
      'glyph',
      'glyphWithWord',
      'plainFormInForce',
      'statusCell',
    ]);
    // the writer and the explicit-form functions are not readers
    for (const name of ['withGlyphForm', 'glyphOf', 'statusCellOf', 'blankStatusCell'])
      expect(READERS.has(name), name).toBe(false);
    // the external readers still wrap one, so the entry cannot go stale
    for (const [name, file] of Object.entries(EXTERNAL_READERS)) {
      const source = readFileSync(join(SRC, ...file.split('/')), 'utf8');
      expect(source, `${name} is defined in ${file}`).toMatch(
        new RegExp(`function ${name}\\b`, 'u'),
      );
    }
  });

  it('finds every `.tsx` source file (the scan is not empty)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no `.tsx` source writes an implicit reader outside a withGlyphForm callback, or a function only called from one', () => {
    const violations = files.flatMap((path) =>
      formScopeViolations(relative(SRC, path).split(sep).join('/'), readFileSync(path, 'utf8')).map(
        (violation) =>
          `${violation.file}:${String(violation.line)}  ${violation.reader}(…) ${violation.why}`,
      ),
    );
    expect(
      violations,
      'wrap the call in withGlyphForm(!color, …), or read the form by name with glyphOf(role, !color)',
    ).toEqual([]);
  });
});

describe('the scope check sees the hazard it is for (it is run on text it is given, not on the repository)', () => {
  const check = (text: string): string[] =>
    formScopeViolations('x.tsx', text).map(
      (violation) => `${violation.reader}@${String(violation.line)}`,
    );
  const header =
    "import { glyph, glyphOf, statusCell, glyphWithWord, withGlyphForm } from './glyphs.js';\n";

  it('flags the probe: a child component that reads the form after the wrapper has returned', () => {
    expect(
      check(
        `${header}
function Child() {
  return <Text>{glyph('completed')}</Text>;
}
export function Parent(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => (
    <>
      <Text>{glyph('completed')}</Text>
      <Child />
    </>
  ));
}`,
      ),
    ).toEqual(['glyph@4']);
  });

  it('allows a read written inside the callback of the wrapper, in any nesting', () => {
    expect(
      check(
        `${header}
export function Parent(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => <Text>{items.map((item) => glyph('completed') + item)}</Text>);
}`,
      ),
    ).toEqual([]);
  });

  it('allows a function that is only called, directly, from the callback of the wrapper (and one only called from that)', () => {
    expect(
      check(
        `${header}
function rule() { return glyph('thinRule'); }
function Body() { return <Text>{rule()}{statusCell('failed')}</Text>; }
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => Body());
}`,
      ),
    ).toEqual([]);
  });

  it('flags a function that is called from the wrapper AND used as a JSX tag, or called from outside it', () => {
    expect(
      check(
        `${header}
function Body() { return <Text>{glyph('failed')}</Text>; }
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => Body());
}
export function Other() { return <Body />; }`,
      ),
    ).toEqual(['glyph@3']);
    expect(
      check(
        `${header}
function rule() { return glyph('thinRule'); }
export function View(props: { plain: boolean }) {
  return <Text>{rule()}{withGlyphForm(props.plain, () => rule())}</Text>;
}`,
      ),
    ).toEqual(['glyph@3']);
  });

  it('flags an exported function, a top-level read and a reference that is not a call', () => {
    expect(
      check(`${header}export function Row() { return <Text>{glyphWithWord('failed')}</Text>; }`),
    ).toEqual(['glyphWithWord@2']);
    expect(check(`${header}const mark = glyph('failed');`)).toEqual(['glyph@2']);
    expect(
      check(
        `${header}
function pick() { return glyph('failed'); }
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => <List render={pick} />);
}`,
      ),
    ).toEqual(['glyph@3']);
  });

  it('allows `glyphOf(role, ascii)` anywhere, since it names the form it wants', () => {
    expect(
      check(
        `${header}
function Child(props: { plain: boolean }) { return <Text>{glyphOf('failed', props.plain)}</Text>; }
export function View() { return <Child plain />; }`,
      ),
    ).toEqual([]);
  });

  it('reads an aliased import, and ignores a local function that only shares the name', () => {
    expect(
      check(
        `import { glyph as mark, withGlyphForm as inForm } from './glyphs.js';
export function View(props: { plain: boolean }) { return inForm(props.plain, () => <T>{mark('failed')}</T>); }
function Other() { return <T>{mark('failed')}</T>; }`,
      ),
    ).toEqual(['glyph@3']);
    expect(
      check("function glyph() { return 'x'; }\nexport function A() { return <T>{glyph()}</T>; }"),
    ).toEqual([]);
  });
});
