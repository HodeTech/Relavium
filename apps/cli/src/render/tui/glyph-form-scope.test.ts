import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The `withGlyphForm` hazard, guarded ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5). `withGlyphForm`
 * puts a glyph form in force for the SYNCHRONOUS function it runs and restores it when the function returns. A component that returns JSX
 * from inside it has its CHILDREN rendered after it returned: an implicit reader (`glyph`, `statusCell`, `glyphWithWord`, …) inside a child
 * component then answers in the Unicode form, in a frame that is otherwise plain (the probe: a parent returns
 * `withGlyphForm(true, () => <><Text>{glyph('completed')}</Text><Child /></>)` and the child calls `glyph('completed')`: the frame reads `ok`
 * and then `✓`).
 *
 * The rule, held to every `.tsx` non-test source file by this test, on the syntax tree:
 *
 * 1. an implicit reader may be written **inside the function argument of a `withGlyphForm(…)` call**, and in code that RUNS there: a function
 *    that runs later does not (see the list of deferred places below), however it is nested; or
 * 2. inside a **function of the file that is not exported** and whose every reference is a **direct call** that is itself in a place the rule
 *    allows (a function called from such a callback, or from such a function, and so on). A function used as a JSX tag (`<Child />`) is
 *    NOT a direct call: it runs after the wrapper has returned, so it is outside the rule; or
 * 3. the file reads the form with `glyphOf(role, ascii)` only, which names the form it wants and needs no wrapper.
 *
 * **What is an implicit reader.** The functions of `glyphs.ts` that read the form in force, and, TRANSITIVELY, every function of a `.ts`
 * module that calls one outside a wrapper ({@link deriveReaders}): `statusGlyph` in `format.ts` is a reader, and so is whatever calls it. A
 * `.tsx` file that imports one by name is held to the rule for each call of it. The derivation follows an imported name and a local
 * function; it does not follow a re-export through a barrel, a reader handed over as a prop or through context, or a computed property
 * access (`glyphs['glyph']`): those would need type information, and a guard that claimed them would be a claim this one cannot keep.
 *
 * **Places that run LATER**, and so are outside a wrapper even when they are written inside one: a function in a JSX attribute
 * (`<List render={() => glyph('x')} />`), a function in a JSX child (a render prop, the children of `<Static>`), a component defined inside the
 * callback and used as a JSX tag, and a callback handed to a timer, an effect hook or a promise (`setTimeout`, `useEffect`, `.then`).
 *
 * **Shapes the rule refuses outright**, because they hide the call from it: a namespace import of a module that holds a reader
 * (`import * as g from './glyphs.js'`) and a reader used as a value (`const mark = glyph`, `list.map(glyph)`).
 *
 * A model written in a `.ts` file (a pure function of state that returns rows) is not held here: it is held by the view that calls it, which
 * wraps the call (rule 1), and `glyph-forms.test.tsx` mounts every surface in the plain form and fails on a Unicode glyph in a plain frame.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** The module of `glyphs.ts` as the other modules name it, relative to `src` and with no extension. */
const GLYPHS_MODULE = 'render/tui/glyphs';

/** A module's path relative to `src` with no extension, to the names it exports that read the form in force. */
type ReaderTable = ReadonlyMap<string, ReadonlySet<string>>;

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

// ── the syntax the rule reads ───────────────────────────────────────────────────────────────────────────────────────────────

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
const isFunctionNode = (node: ts.Node): node is FunctionNode =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);

/** Callees whose function argument runs after the call has returned. */
const DEFERRING_CALLEES: ReadonlySet<string> = new Set([
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
  'useImperativeHandle',
  'useCallback',
]);
/** Methods whose function argument runs after the call has returned. */
const DEFERRING_METHODS: ReadonlySet<string> = new Set(['then', 'catch', 'finally']);

function calleeName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

/** The JSX tag names a file uses, so that a function that is a component of the file is known to run after the place that returned its element. */
function jsxTagNames(sf: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName)) names.add(node.tagName.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** The name a function is bound to (`function C() {}`, `const C = () => …`), or `undefined` for an anonymous one. */
function boundName(fn: FunctionNode): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  const parent = fn.parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? parent.name.text
    : undefined;
}

/** Whether `node` is one of the arguments of `call` (`includes` on the typed list refuses a function declaration, which is no expression). */
function isArgumentOf(call: ts.CallExpression, node: ts.Node): boolean {
  const nodes: readonly ts.Node[] = call.arguments;
  return nodes.includes(node);
}

/** Whether `fn` runs AFTER the code that wrote it has returned: see the header for the places. */
function runsLater(fn: FunctionNode, tags: ReadonlySet<string>): boolean {
  const parent = fn.parent;
  if (ts.isJsxExpression(parent)) return true; // a JSX attribute's function, a render prop, the children of `<Static>`
  if (ts.isCallExpression(parent) && isArgumentOf(parent, fn)) {
    const name = calleeName(parent);
    if (name === undefined) return false;
    if (ts.isIdentifier(parent.expression) && DEFERRING_CALLEES.has(name)) return true;
    if (ts.isPropertyAccessExpression(parent.expression) && DEFERRING_METHODS.has(name))
      return true;
  }
  const name = boundName(fn);
  return name !== undefined && tags.has(name); // a component of the file: rendered after its parent returned
}

/** Methods that call their function argument before they return: a callback handed to one runs as part of the place that wrote it. */
const SYNCHRONOUS_METHODS: ReadonlySet<string> = new Set([
  'map',
  'filter',
  'flatMap',
  'forEach',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'sort',
  'toSorted',
  'from',
]);

/**
 * Whether calling `unit` runs the code at `node`, outside a wrapper: its READ. Walking outwards from `node`: the callback of a wrapper ends
 * the search (wrapped: no); a callback of a synchronous method (`map`) or a function called in place runs here, so the walk goes on; a
 * helper bound to a name takes the place of its calls (yes if any call of it is a read); any other closure is only BUILT by `unit` (stored,
 * returned, handed to a port or an event) and runs when someone else calls it: that caller's read, not the unit's.
 */
function readsWhenCalled(
  node: ts.Node,
  unit: ts.Node,
  wrapper: ReadonlySet<string>,
  seen: ReadonlySet<ts.Node> = new Set(),
): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined && current !== unit;
    current = current.parent
  ) {
    if (!isFunctionNode(current)) continue;
    let parent: ts.Node = current.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (ts.isCallExpression(parent)) {
      if (
        ts.isIdentifier(parent.expression) &&
        wrapper.has(parent.expression.text) &&
        parent.arguments.at(-1) === current
      )
        return false;
      if (parent.expression === current || ts.isParenthesizedExpression(parent.expression))
        continue;
      if (
        isArgumentOf(parent, current) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        SYNCHRONOUS_METHODS.has(parent.expression.name.text)
      )
        continue;
    }
    const name = boundName(current);
    if (name === undefined || seen.has(current)) return false;
    let read = false;
    const visit = (child: ts.Node): void => {
      if (
        ts.isCallExpression(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === name &&
        readsWhenCalled(child, unit, wrapper, new Set([...seen, current]))
      )
        read = true;
      ts.forEachChild(child, visit);
    };
    visit(unit);
    return read;
  }
  return true;
}

/**
 * Whether the code at `node` runs inside the function argument of a call to a wrapper: walking outwards, a function that runs later ends the
 * search (the answer is no), a function that is the callback of the wrapper ends it (yes), and any other function (a `map` callback, an
 * immediately used helper) runs as part of the place it is written in.
 */
function insideWrapper(
  node: ts.Node,
  wrapper: ReadonlySet<string>,
  tags: ReadonlySet<string>,
): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (!isFunctionNode(current)) continue;
    const call: ts.Node = current.parent;
    if (
      ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      wrapper.has(call.expression.text) &&
      call.arguments.at(-1) === current
    )
      return true;
    if (runsLater(current, tags)) return false;
  }
  return false;
}

// ── which names a file has for the readers ───────────────────────────────────────────────────────────────────────────────

/** The module `specifier` names, as a path relative to `src` with no extension, or `undefined` for a package. */
function resolveModule(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return posix
    .normalize(posix.join(posix.dirname(fromFile), specifier))
    .replace(/\.(?:[cm]?[jt]sx?)$/u, '');
}

interface Names {
  /** Local name → the reader it is (`import { glyph as g }` is `g`). */
  readonly readers: ReadonlyMap<string, string>;
  /** Local names of the wrapper `withGlyphForm`. */
  readonly wrapper: ReadonlySet<string>;
  /** Local namespace names (`import * as g`) of a module that holds a reader, to that module's readers. */
  readonly namespaces: ReadonlyMap<string, { readonly module: string; readonly line: number }>;
}

function namesOf(sf: ts.SourceFile, file: string, table: ReaderTable): Names {
  const readers = new Map<string, string>();
  const wrapper = new Set<string>();
  const namespaces = new Map<string, { module: string; line: number }>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = resolveModule(file, statement.moduleSpecifier.text);
    const held = module === undefined ? undefined : table.get(module);
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (module !== undefined && held !== undefined && held.size > 0)
        namespaces.set(bindings.name.text, {
          module,
          line: sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1,
        });
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (held?.has(imported) === true) readers.set(element.name.text, imported);
      if (module === GLYPHS_MODULE && imported === 'withGlyphForm') wrapper.add(element.name.text);
    }
  }
  return { readers, wrapper, namespaces };
}

/** The top-level function-like units of a file: a function declaration, or a `const` initialised with an arrow or function expression. */
interface Unit {
  readonly name: string;
  /** The statement that declares it (the span the unit occupies in the file). */
  readonly node: ts.Node;
  /** The function itself. */
  readonly fn: FunctionNode;
  readonly exported: boolean;
}

function topLevelUnits(
  sf: ts.SourceFile,
  wrappedAtEveryCall: ReadonlySet<string> = new Set(),
): Unit[] {
  const units: Unit[] = [];
  for (const statement of sf.statements) {
    const isExported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    const declared = ts.isFunctionDeclaration(statement)
      ? statement.name?.text
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations
            .map((declaration) => (ts.isIdentifier(declaration.name) ? declaration.name.text : ''))
            .find((name) => wrappedAtEveryCall.has(name))
        : undefined;
    const exported = isExported && !(declared !== undefined && wrappedAtEveryCall.has(declared));
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      units.push({ name: statement.name.text, node: statement, fn: statement, exported });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        )
          units.push({ name: declaration.name.text, node: statement, fn: initializer, exported });
      }
    }
  }
  return units;
}

// ── the readers of the whole source, derived ─────────────────────────────────────────────────────────────────────────────

/**
 * Functions that are NOT readers although they call one outside a wrapper in the text, each with the reason. An entry is for a function whose
 * reads the rule cannot see are safe (it wraps the call inside a closure it builds, or it is only ever run inside a wrapper); a test fails
 * for an entry that names a function that no longer calls a reader, so the list cannot go stale.
 */
const NOT_READERS: readonly {
  readonly module: string;
  readonly name: string;
  readonly reason: string;
}[] = [];

/**
 * The implicit readers of the source, by module: the readers of `glyphs.ts`, then every function of another `.ts` module that calls a reader
 * (one it imports, or one of its own) outside a wrapper, repeated until nothing is added. `modules` maps a module path to its text.
 */
function deriveReaders(
  modules: ReadonlyMap<string, string>,
  why: Map<string, string> = new Map(),
): Map<string, Set<string>> {
  const glyphsText = modules.get(GLYPHS_MODULE);
  const table = new Map<string, Set<string>>();
  if (glyphsText !== undefined)
    table.set(GLYPHS_MODULE, new Set(implicitReadersOfGlyphs(glyphsText)));
  const parsed = new Map<string, ts.SourceFile>();
  for (const [module, text] of modules) {
    if (module === GLYPHS_MODULE) continue;
    parsed.set(
      module,
      ts.createSourceFile(`${module}.ts`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    );
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [module, sf] of parsed) {
      const names = namesOf(sf, `${module}.ts`, table);
      const units = topLevelUnits(sf);
      const local = new Set(table.get(module) ?? []);
      /** A call at `node` of a reader: an imported one, one of this module's own, or a member of a namespace import. */
      const callsReader = (call: ts.CallExpression): boolean => {
        const callee = call.expression;
        if (ts.isIdentifier(callee))
          return names.readers.has(callee.text) || local.has(callee.text);
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
          const namespace = names.namespaces.get(callee.expression.text);
          return (
            namespace !== undefined && table.get(namespace.module)?.has(callee.name.text) === true
          );
        }
        return false;
      };
      for (let inner = true; inner; ) {
        inner = false;
        for (const unit of units) {
          if (local.has(unit.name)) continue;
          let reads: string | undefined;
          const visit = (node: ts.Node): void => {
            if (reads !== undefined) return;
            if (
              ts.isCallExpression(node) &&
              callsReader(node) &&
              readsWhenCalled(node, unit.fn, names.wrapper)
            )
              reads = `${module}.ts:${String(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)} calls ${node.expression.getText(sf)}`;
            else ts.forEachChild(node, visit);
          };
          visit(unit.node);
          if (reads !== undefined) {
            local.add(unit.name);
            why.set(`${module}:${unit.name}`, reads);
            inner = true;
          }
        }
      }
      const exported = new Set(units.filter((unit) => unit.exported).map((unit) => unit.name));
      const before = table.get(module)?.size ?? 0;
      const kept = new Set(
        [...local].filter(
          (name) =>
            exported.has(name) &&
            !NOT_READERS.some((entry) => entry.module === module && entry.name === name),
        ),
      );
      if (kept.size > 0) table.set(module, kept);
      if (kept.size !== before) changed = true;
    }
  }
  return table;
}

// ── what the rule is told about the repository ──────────────────────────────────────────────────────────────────────────────

/**
 * Exported functions of a `.tsx` that are pure models, exported so a test can call them, and that the file itself calls ONLY inside a wrapper.
 * Rule 2 refuses an exported function (a caller could run it outside a wrapper); for these the file's own references are checked instead
 * (every one must be a direct call inside a wrapper), and a caller outside the file is the test or the golden recorder, which are not product
 * code. A test fails for an entry that rule 2 would not have refused, so the list cannot go stale.
 */
const WRAPPED_AT_EVERY_CALL: readonly {
  readonly file: string;
  readonly unit: string;
  readonly reason: string;
}[] = [
  {
    file: 'render/tui/tool-review-view.tsx',
    unit: 'reviewScreen',
    reason:
      'the page and chrome of the review card, exported so a test derives "the page the host drew" from the function the host uses (its doc says so); ToolReviewHost calls it inside withGlyphForm',
  },
];

/**
 * Reads the rule refuses and that are not a frame drawn in the wrong form, each with the reason. A test fails for an entry that no
 * longer matches a read, so the list cannot go stale.
 */
const ALLOWED_READS: readonly {
  readonly file: string;
  readonly reader: string;
  readonly reason: string;
}[] = [
  {
    file: 'home/drive-home.tsx',
    reader: 'createHomeController',
    reason:
      'a controller, built once: its key router folds pure models whose reads give counts and cursors, and the rows it draws itself are built inside withGlyphForm(plainGlyphs, …) (home-controller.ts); the frames are drawn by the views, which wrap',
  },
  {
    file: 'home/drive-home.tsx',
    reader: 'prepareRestoredHistory',
    reason:
      'builds the transcript of a restored session: text stored in the transcript, in the Unicode form, as the live record of a question is (`questionTranscriptText`). That is text kept as data and not a frame; that a plain session shows `›` there is a gap of the transcript, not of this call',
  },
  {
    file: 'render/tui/home-app.tsx',
    reader: 'hostedRunLabel',
    reason:
      'only tested against `undefined` (is there a run label, so is a row reserved): the label is never drawn from this call',
  },
];

// ── the rule ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly reader: string;
  readonly why: string;
}

/** The violations of the rule above in one source file: each implicit read that rules 1 and 2 do not place inside a wrapper, and each shape that hides one. */
function formScopeViolations(
  file: string,
  text: string,
  table: ReaderTable,
  wrappedAtEveryCall: ReadonlySet<string> = new Set(),
): Violation[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = namesOf(sf, file, table);
  if (names.readers.size === 0 && names.namespaces.size === 0) return [];
  const tags = jsxTagNames(sf);
  const units = topLevelUnits(sf, wrappedAtEveryCall);
  const unitOf = (node: ts.Node): Unit | undefined =>
    units.find((unit) => node.pos >= unit.node.pos && node.end <= unit.node.end);
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

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
    if (insideWrapper(node, names.wrapper, tags)) return true;
    const unit = unitOf(node);
    return unit !== undefined && reachedOnlyByAllowedCalls(unit, trail);
  };

  const violations: Violation[] = [];
  const report = (node: ts.Node, reader: string, why: string): void =>
    void violations.push({ file, line: lineOf(node), reader, why });
  const placeOf = (node: ts.Node): string => {
    const unit = unitOf(node);
    if (unit === undefined) return 'at the top level of the module';
    return unit.exported
      ? `in the exported function ${unit.name}, which a caller can run outside a wrapper`
      : `in ${unit.name}, which is not only called from inside a wrapper (a JSX tag is not a call)`;
  };

  for (const [name, { module, line }] of names.namespaces)
    violations.push({
      file,
      line,
      reader: `${name}.*`,
      why: `is a namespace import of ${module}, which holds an implicit glyph reader: name the readers you use, so the guard can see each call`,
    });

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const reader = names.readers.get(callee.text);
        if (reader !== undefined && !allowedPlace(node, new Set()))
          report(node, reader, placeOf(node));
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const namespace = names.namespaces.get(callee.expression.text);
        if (namespace !== undefined && table.get(namespace.module)?.has(callee.name.text) === true)
          report(
            node,
            callee.name.text,
            `is called through the namespace ${callee.expression.text}`,
          );
      }
    } else if (ts.isIdentifier(node) && names.readers.has(node.text)) {
      const parent = node.parent;
      const isCallee = ts.isCallExpression(parent) && parent.expression === node;
      const isImport = ts.isImportSpecifier(parent) || ts.isImportClause(parent);
      const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isName =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isJsxAttribute(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isCallee && !isImport && !isMember && !isName)
        report(
          node,
          names.readers.get(node.text) ?? node.text,
          'is used as a value (an alias, an argument, a prop): the call it makes runs where it is called, which the guard cannot see',
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

// ── the repository ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The directories no product source lives in. */
const SKIPPED = ['surface-matrix', 'legend-golden', 'node_modules', 'fixtures'];

function sourceFilesUnder(directory: string, pattern: RegExp): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (SKIPPED.includes(entry)) continue;
      files.push(...sourceFilesUnder(path, pattern));
    } else if (
      pattern.test(entry) &&
      !/\.test\.tsx?$/u.test(entry) &&
      !/\.d\.ts$/u.test(entry) &&
      !/test-support\.tsx?$/u.test(entry)
    )
      files.push(path);
  }
  return files;
}

const moduleOf = (path: string): string =>
  relative(SRC, path)
    .split(sep)
    .join('/')
    .replace(/\.tsx?$/u, '');

/** The `.ts` modules of the source (the models, the helpers), by module path. */
const MODULE_TEXTS: ReadonlyMap<string, string> = new Map(
  sourceFilesUnder(SRC, /\.ts$/u).map((path) => [moduleOf(path), readFileSync(path, 'utf8')]),
);
const GLYPHS_SOURCE = MODULE_TEXTS.get(GLYPHS_MODULE) ?? '';
/** Why each derived function is a reader (`module:name` → the call outside a wrapper that made it one), for the message of a violation and for a reader of the guard. */
const WHY = new Map<string, string>();
const TABLE: ReaderTable = deriveReaders(MODULE_TEXTS, WHY);

describe('an implicit glyph reader runs inside the form it is meant to read (the withGlyphForm hazard)', () => {
  const files = sourceFilesUnder(SRC, /\.tsx$/u);

  it('reads the implicit readers from glyphs.ts itself: `glyph`, `statusCell`, `glyphWithWord`, `plainFormInForce`, `blankHostShapes` and what wraps them', () => {
    expect([...implicitReadersOfGlyphs(GLYPHS_SOURCE)].sort()).toEqual([
      'blankHostMarks',
      'blankHostShapes',
      'glyph',
      'glyphWithWord',
      'plainFormInForce',
      'statusCell',
    ]);
    // the writer and the explicit-form functions are not readers
    for (const name of ['withGlyphForm', 'glyphOf', 'statusCellOf', 'blankStatusCell'])
      expect(TABLE.get(GLYPHS_MODULE)?.has(name), name).toBe(false);
  });

  it('derives the readers of the other modules from their text, so a new wrapper of one is held to the rule without being listed', () => {
    // `statusGlyph` was a hand-written entry: it is found by reading `format.ts`
    expect(TABLE.get('render/tui/format')?.has('statusGlyph')).toBe(true);
    const derived = [...TABLE].filter(([module]) => module !== GLYPHS_MODULE);
    expect(derived.length).toBeGreaterThan(3);
    // each one says why: the call outside a wrapper that made it a reader
    expect(WHY.get('render/tui/format:statusGlyph')).toMatch(
      /^render\/tui\/format\.ts:\d+ calls glyph$/u,
    );
    // every derived reader is an export of its module
    for (const [module, names] of derived)
      for (const name of names)
        expect(MODULE_TEXTS.get(module), `${module}: ${name}`).toMatch(
          new RegExp(`export (?:async )?(?:function|const) ${name}\\b`, 'u'),
        );
  });

  it('keeps the list of functions that are not readers honest: each entry names a function that still calls a reader outside a wrapper', () => {
    for (const entry of NOT_READERS) {
      const text = MODULE_TEXTS.get(entry.module);
      expect(text, `${entry.module} exists`).toBeDefined();
      expect(text, `${entry.module}: ${entry.name} exists`).toMatch(
        new RegExp(`function ${entry.name}\\b|const ${entry.name}\\b`, 'u'),
      );
    }
  });

  it('finds every `.tsx` source file (the scan is not empty)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  /** The violations of every `.tsx` source file, with the two lists applied (or not). */
  const repositoryViolations = (applyLists: boolean): Violation[] =>
    files.flatMap((path) => {
      const file = `${moduleOf(path)}.tsx`;
      const wrapped = new Set(
        applyLists
          ? WRAPPED_AT_EVERY_CALL.filter((entry) => entry.file === file).map((entry) => entry.unit)
          : [],
      );
      return formScopeViolations(file, readFileSync(path, 'utf8'), TABLE, wrapped).filter(
        (violation) =>
          !applyLists ||
          !ALLOWED_READS.some((entry) => entry.file === file && entry.reader === violation.reader),
      );
    });

  it('no `.tsx` source writes an implicit reader outside a withGlyphForm callback, or a function only called from one', () => {
    const violations = repositoryViolations(true).map(
      (violation) =>
        `${violation.file}:${String(violation.line)}  ${violation.reader}(…) ${violation.why}`,
    );
    expect(
      violations,
      'wrap the call in withGlyphForm(!color, …), or read the form by name with glyphOf(role, !color)',
    ).toEqual([]);
  });

  it('keeps both lists honest: each entry still stands for a read the rule would refuse, and says why it may', () => {
    const bare = repositoryViolations(false);
    for (const entry of ALLOWED_READS) {
      expect(entry.reason.length, `${entry.file}: ${entry.reader}`).toBeGreaterThan(40);
      expect(
        bare.some((v) => v.file === entry.file && v.reader === entry.reader),
        `${entry.file}: ${entry.reader} is still refused`,
      ).toBe(true);
    }
    for (const entry of WRAPPED_AT_EVERY_CALL) {
      expect(entry.reason.length, `${entry.file}: ${entry.unit}`).toBeGreaterThan(40);
      expect(
        bare.some(
          (v) => v.file === entry.file && v.why.includes(`exported function ${entry.unit},`),
        ),
        `${entry.file}: ${entry.unit} is still refused as exported`,
      ).toBe(true);
    }
  });
});

describe('the scope check sees the hazard it is for (it is run on text it is given, not on the repository)', () => {
  /** A table of the readers of `glyphs.ts` and of any module the case plants (`modules` maps a path to its text). */
  const tableOf = (modules: Record<string, string> = {}): ReaderTable =>
    deriveReaders(new Map([[GLYPHS_MODULE, GLYPHS_SOURCE], ...Object.entries(modules)]));
  const check = (text: string, modules: Record<string, string> = {}): string[] =>
    formScopeViolations('render/tui/x.tsx', text, tableOf(modules)).map(
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

  describe('the six shapes that once escaped the guard each fail it (round-2 fix)', () => {
    it('a function in a JSX attribute inside the wrapper runs after it: `<Child render={() => glyph("x")} />`', () => {
      expect(
        check(
          `${header}
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => <Child render={() => glyph('x')} />);
}`,
        ),
      ).toEqual(['glyph@4']);
      // the same read in an attribute that is NOT a function runs inside the wrapper
      expect(
        check(
          `${header}
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => <Child mark={glyph('x')} />);
}`,
        ),
      ).toEqual([]);
    });

    it('the children of `<Static>` are a function that runs after the wrapper: `<Static items={xs}>{(x) => …}</Static>`', () => {
      expect(
        check(
          `${header}
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => (
    <Static items={xs}>{(x) => <Text key={x}>{glyph('x')}</Text>}</Static>
  ));
}`,
        ),
      ).toEqual(['glyph@5']);
    });

    it('a component defined inside the callback and used as a JSX tag runs after it: `const C = () => …; return <C />`', () => {
      expect(
        check(
          `${header}
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => {
    const C = () => <Text>{glyph('x')}</Text>;
    return <C />;
  });
}`,
        ),
      ).toEqual(['glyph@5']);
      expect(
        check(
          `${header}
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => {
    function C() { return <Text>{glyph('x')}</Text>; }
    return <C />;
  });
}`,
        ),
      ).toEqual(['glyph@5']);
      // a helper defined there and CALLED runs inside the wrapper
      expect(
        check(
          `${header}
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => {
    const rule = () => glyph('x');
    return <Text>{rule()}</Text>;
  });
}`,
        ),
      ).toEqual([]);
    });

    it('a namespace import hides the call: `import * as g from "./glyphs.js"; g.glyph("x")`', () => {
      const found = check(
        `import * as g from './glyphs.js';
export function Row() { return <Text>{g.glyph('x')}</Text>; }`,
      );
      expect(found).toEqual(['g.*@1', 'glyph@2']);
      // a namespace import of a module that holds no reader is nothing to the guard
      expect(check("import * as os from './os-things.js';\nexport const a = os.x;")).toEqual([]);
    });

    it('an alias hides the call: `const mark = glyph`, and a reader passed as an argument', () => {
      expect(
        check(`${header}const mark = glyph;\nexport function Row() { return <T>{mark('x')}</T>; }`),
      ).toEqual(['glyph@2']);
      expect(check(`${header}export function Row() { return <T>{list.map(glyph)}</T>; }`)).toEqual([
        'glyph@2',
      ]);
      expect(
        check(`${header}export function Row() { const { x: y } = { x: glyph }; return y; }`),
      ).toEqual(['glyph@2']);
      // a property that merely shares the name, and the import itself, are not uses
      expect(check(`${header}export const a = { glyph: 1 }.glyph;`)).toEqual([]);
    });

    it('a reader that another module wraps is a reader: `rowMark` in `marks.ts` calls `glyph`', () => {
      const marks = {
        'render/tui/marks': `import { glyph } from './glyphs.js';
export function rowMark(): string { return glyph('x'); }
export function wrapped(plain: boolean): string { return withGlyphForm(plain, () => glyph('x')); }
import { withGlyphForm } from './glyphs.js';`,
      };
      expect(
        check(
          `import { rowMark, wrapped } from './marks.js';
export function Row() { return <T>{rowMark()}{wrapped(true)}</T>; }`,
          marks,
        ),
      ).toEqual(['rowMark@2']);
      // inside a wrapper it is fine
      expect(
        check(
          `import { rowMark } from './marks.js';
import { withGlyphForm } from './glyphs.js';
export function Row(p: { plain: boolean }) { return withGlyphForm(p.plain, () => <T>{rowMark()}</T>); }`,
          marks,
        ),
      ).toEqual([]);
      // and through a second module that wraps the first
      expect(
        check(
          `import { twice } from './twice.js';
export function Row() { return <T>{twice()}</T>; }`,
          {
            ...marks,
            'render/tui/twice': `import { rowMark } from './marks.js';\nexport const twice = () => rowMark() + rowMark();`,
          },
        ),
      ).toEqual(['twice@2']);
    });
  });

  describe('the places that run later are outside a wrapper, wherever they are written', () => {
    const inCallback = (body: string): string[] =>
      check(`${header}
export function View(props: { plain: boolean }) {
  return withGlyphForm(props.plain, () => {
    ${body}
    return <T />;
  });
}`);

    it('a timer, an effect and a promise callback', () => {
      expect(inCallback("setTimeout(() => glyph('x'), 10);")).toEqual(['glyph@5']);
      expect(inCallback("useEffect(() => { glyph('x'); }, []);")).toEqual(['glyph@5']);
      expect(inCallback("load().then(() => glyph('x'));")).toEqual(['glyph@5']);
      expect(inCallback("const on = useCallback(() => glyph('x'), []);")).toEqual(['glyph@5']);
    });

    it('a callback that runs at once (map, filter, a helper called in place) is inside it', () => {
      expect(inCallback("const a = [1].map(() => glyph('x'));")).toEqual([]);
      expect(inCallback("const b = [1].filter((n) => glyph('x') !== String(n));")).toEqual([]);
    });
  });
});

describe('the readers the guard derives from a module’s text: what reads when it is CALLED (round-2 fix)', () => {
  const derive = (source: string): string[] =>
    [
      ...(deriveReaders(
        new Map([
          [GLYPHS_MODULE, GLYPHS_SOURCE],
          ['render/tui/m', `import { glyph, withGlyphForm } from './glyphs.js';\n${source}`],
        ]),
      ).get('render/tui/m') ?? []),
    ].sort();

  it('a function that reads at once is a reader: directly, in a callback of a synchronous method, in a helper it calls, in a function called in place', () => {
    expect(derive("export const a = () => glyph('x');")).toEqual(['a']);
    expect(derive("export const b = (xs: string[]) => xs.map(() => glyph('x'));")).toEqual(['b']);
    expect(
      derive("export const c = (xs: string[]) => xs.filter((x) => glyph('x') !== x);"),
    ).toEqual(['c']);
    expect(derive("export function d() { const rule = () => glyph('x'); return rule(); }")).toEqual(
      ['d'],
    );
    expect(derive("export const e = () => (() => glyph('x'))();")).toEqual(['e']);
    expect(
      derive("function inner() { return glyph('x'); }\nexport const f = () => inner();"),
    ).toEqual(['f']);
    // a helper that calls itself ends the walk instead of repeating it
    expect(
      derive(
        "export const g = () => { const walk = (n: number): string => (n > 0 ? walk(n - 1) : glyph('x')); return walk(3); };",
      ),
    ).toEqual(['g']);
  });

  it('a function that only BUILDS a closure that reads is not a reader: the read is that closure’s caller’s (a controller)', () => {
    expect(derive("export const a = () => ({ line: () => glyph('x') });")).toEqual([]);
    expect(
      derive("export const b = () => { const on = () => glyph('x'); return { on }; };"),
    ).toEqual([]);
    expect(
      derive(
        "export const c = (port: { bind(f: () => string): void }) => port.bind(() => glyph('x'));",
      ),
    ).toEqual([]);
    // a helper that is called only from a closure the function builds
    expect(
      derive(
        "export const d = () => { const rule = () => glyph('x'); return { on: () => rule() }; };",
      ),
    ).toEqual([]);
  });

  it('a read inside withGlyphForm is not a read, and a helper called only there is wrapped too', () => {
    expect(derive("export const a = (p: boolean) => withGlyphForm(p, () => glyph('x'));")).toEqual(
      [],
    );
    expect(
      derive(
        "export const b = (p: boolean) => { const rule = () => glyph('x'); return withGlyphForm(p, () => rule()); };",
      ),
    ).toEqual([]);
    // but a helper that is ALSO called outside it reads
    expect(
      derive(
        "export const c = (p: boolean) => { const rule = () => glyph('x'); return rule() + withGlyphForm(p, () => rule()); };",
      ),
    ).toEqual(['c']);
  });

  it('only an EXPORTED function is a reader of the module: a local helper is how it reads, not a name another module can import', () => {
    expect(
      derive("function helper() { return glyph('x'); }\nexport const a = () => helper();"),
    ).toEqual(['a']);
  });
});
