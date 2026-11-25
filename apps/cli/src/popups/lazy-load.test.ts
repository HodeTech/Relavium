/**
 * The popups' code is loaded when the person first opens one, and not before ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, MVP-11 §4.4): `doctor-port.ts` and `report-port.ts` are the eager halves and bring the lazy halves in with a dynamic `import()`. One static
 * value import of a lazy module anywhere in the closure of the Home or a chat pulls the popups into the first paint, and every behavioural test stays
 * green, so this reads the sources: the STATIC value-import closure of each host entry holds none of the lazy modules (a type-only import and a
 * dynamic `import()` do not count).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../', import.meta.url));

const ENTRIES = [
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
  'agent-popup',
  'help-popup',
  'workflows-popup',
  'popup-text',
  'popup-work',
  'popup-copy',
  'chord-refusal',
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

/** The files `file` imports as values at its top level: an import with a runtime effect, and a re-export. */
function staticImports(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier))
        specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
  }
  return specifiers
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => {
      const base = relative(SRC, resolve(SRC, dirname(file), specifier.replace(/\.js$/u, '')))
        .split(sep)
        .join('/');
      return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((path) => FILES.has(path));
    })
    .filter((path): path is string => path !== undefined);
}

/** Every file reached from `entry` through static value imports, itself included. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...staticImports(file));
  }
  return seen;
}

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
    const reached = closure('render/tui/home-controller.ts');
    expect(reached.has('popups/doctor-port.ts')).toBe(true);
    expect(reached.has('popups/report-port.ts')).toBe(true);
  });

  it.each(ENTRIES)('%s reaches no lazy module through a static value import', (entry) => {
    const reached = closure(entry);
    expect(reached.size).toBeGreaterThan(1);
    expect(LAZY.filter((lazy) => reached.has(lazy))).toEqual([]);
  });
});
