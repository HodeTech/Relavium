/**
 * The popups' code is loaded when the person first opens one, and not before ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, MVP-11 §4.4): `doctor-port.ts`, `report-port.ts` and `settings-port.ts` are the eager halves and bring the lazy halves in with a dynamic
 * `import()`. One static
 * value import of a lazy module anywhere in the closure of the Home or a chat pulls the popups into the first paint, and every behavioural test stays
 * green, so this reads the sources: the STATIC value-import closure of each host entry holds none of the lazy modules. Only an `import type { … }`
 * declaration, an `export type { … } from` and a dynamic `import()` do not count: `verbatimModuleSyntax` keeps `import { type X } from './m.js'` as a
 * side-effect import that loads the module, and `staticSpecifiers` is pinned to that below. The entries are every host's (the Home, the chat, both
 * Ink hosts, the controller) and the program and the binary's own entry, which reach every command.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../', import.meta.url));

const ENTRIES = [
  'index.ts',
  'program.ts',
  'home/drive-home.tsx',
  'commands/chat.ts',
  'popups/popup-route.ts',
  'popups/popup-host.ts',
  'render/tui/chat-ink.tsx',
  'render/tui/home-app.tsx',
  'render/tui/home-controller.ts',
] as const;

const LAZY = [
  'doctor-session',
  'doctor-popup',
  'report-session',
  'cost-session',
  'cost-popup',
  'export-session',
  'export-popup',
  'agent-popup',
  'help-popup',
  'workflows-popup',
  'popup-text',
  'popup-work',
  'popup-copy',
  'chord-refusal',
  'settings-session',
  'effort-popup',
  'models-session',
  'models-popup',
  'mode-popup',
  'permissions-session',
  'permissions-popup',
  'unreadable-run-card',
  // The startup-default write of `/mode` (MVP-11 unit 8, OD-25): loaded by `await import` from the chat and the Home, only when a write is asked.
  'mode-confirm',
  'mode-home',
  // The Home's management popups (MVP-11 unit 8): `home-port.ts` is the eager half; the session and the three popups' words load on first use.
  'home-session',
  'home-text',
  'home-help-popup',
  'home-agents-popup',
  'home-agents-session',
  'home-workflows-popup',
  'home-workflows-session',
].map((name) => `popups/${name}.ts`);

/** Every source file of the CLI (tests and their support excluded), by its path under `src`. */
function sources(directory: string, found: Set<string> = new Set()): Set<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/u.test(entry) && !/\.test(?:-support)?\.tsx?$/u.test(entry))
      found.add(relative(SRC, path).split(sep).join('/'));
  }
  return found;
}

const FILES = sources(SRC);

/**
 * The module specifiers a source loads at its top level: an import with a runtime effect, and a re-export. **Only an `import type { … }`
 * DECLARATION is erased.** The repo sets `verbatimModuleSyntax`, so `import { type X } from './m.js'` is kept as `import {} from './m.js'` and
 * loads the module (a real build put the doctor's words in a shared chunk through one such line), and so is `export { type X } from './m.js'`.
 */
function staticSpecifiers(text: string): string[] {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly !== true && ts.isStringLiteral(node.moduleSpecifier))
        specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
  }
  return specifiers;
}

/** The source files a closure is read from: the CLI's own, or a few written in a test. */
interface SourceTree {
  readonly has: (file: string) => boolean;
  readonly read: (file: string) => string;
}
const REAL: SourceTree = {
  has: (file) => FILES.has(file),
  read: (file) => readFileSync(join(SRC, file), 'utf8'),
};
const tree = (files: Readonly<Record<string, string>>): SourceTree => ({
  has: (file) => Object.hasOwn(files, file),
  read: (file) => files[file] ?? '',
});

/** The files `file` imports as values at its top level (see {@link staticSpecifiers}), by their path under `src`. */
function staticImports(file: string, from: SourceTree): string[] {
  return staticSpecifiers(from.read(file))
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => {
      const base = relative(SRC, resolve(SRC, dirname(file), specifier.replace(/\.js$/u, '')))
        .split(sep)
        .join('/');
      return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((path) => from.has(path));
    })
    .filter((path): path is string => path !== undefined);
}

/** Every file reached from `entry` through static value imports, itself included. */
function closure(entry: string, from: SourceTree = REAL): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...staticImports(file, from));
  }
  return seen;
}

describe('what counts as a load (verbatimModuleSyntax keeps every import that is not an `import type` declaration)', () => {
  it.each([
    ["import { x } from './m.js';", ['./m.js']],
    ["import x from './m.js';", ['./m.js']],
    ["import * as m from './m.js';", ['./m.js']],
    ["import './m.js';", ['./m.js']],
    ["import { type X } from './m.js';", ['./m.js']],
    ["import { type X, type Y } from './m.js';", ['./m.js']],
    ["import x, { type X } from './m.js';", ['./m.js']],
    ["export { x } from './m.js';", ['./m.js']],
    ["export * from './m.js';", ['./m.js']],
    ["export { type X } from './m.js';", ['./m.js']],
    ["import type { X } from './m.js';", []],
    ["import type X from './m.js';", []],
    ["import type * as m from './m.js';", []],
    ["export type { X } from './m.js';", []],
    ["export type * from './m.js';", []],
    ["const m = () => import('./m.js');", []],
    ['export { x };', []],
  ] as const)('%s loads %j', (text, loaded) => {
    expect(staticSpecifiers(text)).toEqual(loaded);
  });
});

describe('a lazy module hidden in an entry’s closure is found', () => {
  const LAZY_FILE = 'popups/doctor-session.ts';
  it.each([
    ['a value import', "import { openDoctorPopup } from '../popups/doctor-session.js';"],
    [
      'an import whose names are all `type` modifiers (kept by verbatimModuleSyntax)',
      "import { type X } from '../popups/doctor-session.js';",
    ],
    ['a re-export', "export { openDoctorPopup } from '../popups/doctor-session.js';"],
    [
      'a type-only re-export with `type` modifiers',
      "export { type X } from '../popups/doctor-session.js';",
    ],
    ['a side-effect import', "import '../popups/doctor-session.js';"],
  ])('%s, one hop down from the entry', (_name, line) => {
    const files = {
      'entry/main.ts': "import { middle } from './middle.js';",
      'entry/middle.ts': line,
      [LAZY_FILE]: 'export const x = 1;',
    };
    expect(closure('entry/main.ts', tree(files)).has(LAZY_FILE)).toBe(true);
  });

  it.each([
    ['an `import type` declaration', "import type { X } from '../popups/doctor-session.js';"],
    ['an `export type` re-export', "export type { X } from '../popups/doctor-session.js';"],
    ['a dynamic import', "export const load = () => import('../popups/doctor-session.js');"],
  ])('%s is not a load', (_name, line) => {
    const files = {
      'entry/main.ts': "import { middle } from './middle.js';",
      'entry/middle.ts': line,
      [LAZY_FILE]: 'export const x = 1;',
    };
    expect(closure('entry/main.ts', tree(files)).has(LAZY_FILE)).toBe(false);
  });
});

describe('the popups load on first use', () => {
  it('every entry and every lazy module is a source file (a renamed file cannot make the check pass by missing it)', () => {
    for (const file of [...ENTRIES, ...LAZY]) expect(FILES.has(file), file).toBe(true);
  });

  it('the eager halves bring the lazy halves in with a dynamic import, and the host entries reach the eager halves', () => {
    expect(readFileSync(join(SRC, 'popups/doctor-port.ts'), 'utf8')).toContain(
      "import('./doctor-session.js')",
    );
    expect(readFileSync(join(SRC, 'popups/report-port.ts'), 'utf8')).toContain(
      "import('./report-session.js')",
    );
    expect(readFileSync(join(SRC, 'popups/settings-port.ts'), 'utf8')).toContain(
      "import('./settings-session.js')",
    );
    expect(readFileSync(join(SRC, 'popups/unreadable-run-port.ts'), 'utf8')).toContain(
      "import('./unreadable-run-card.js')",
    );
    expect(readFileSync(join(SRC, 'popups/home-port.ts'), 'utf8')).toContain(
      "import('./home-session.js')",
    );
    const reached = closure('render/tui/home-controller.ts');
    expect(reached.has('popups/doctor-port.ts')).toBe(true);
    expect(reached.has('popups/report-port.ts')).toBe(true);
    expect(reached.has('popups/settings-port.ts')).toBe(true);
    expect(closure('home/drive-home.tsx').has('popups/unreadable-run-port.ts')).toBe(true);
    expect(closure('home/drive-home.tsx').has('popups/home-port.ts')).toBe(true);
  });

  it.each(ENTRIES)('%s reaches no lazy module through a static value import', (entry) => {
    const reached = closure(entry);
    expect(reached.size).toBeGreaterThan(1);
    expect(LAZY.filter((lazy) => reached.has(lazy))).toEqual([]);
  });
});
