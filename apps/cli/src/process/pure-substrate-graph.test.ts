import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  verbatimModuleSyntax: true,
};

/** Inspect emitted JS, so import/export type edges are erased by the real compiler. */
function runtimeSpecifiers(source: string, filename: string): string[] {
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions }).outputText;
  const parsed = ts.createSourceFile(
    filename.replace(/\.tsx?$/, '.js'),
    output,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
        found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

interface Closure {
  readonly files: Set<string>;
  readonly packages: Set<string>;
  readonly edges: string[];
}

interface ClosureOptions {
  readonly opaquePackages?: ReadonlySet<string>;
  readonly permittedPackages?: ReadonlySet<string>;
  readonly sourceOverrides?: ReadonlyMap<string, string>;
}

function runtimeClosure(roots: readonly string[], options: ClosureOptions = {}): Closure {
  const files = new Set<string>();
  const packages = new Set<string>();
  const edges: string[] = [];
  const pending = roots.map((root) => resolve(repository, root));
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    const source = options.sourceOverrides?.get(file) ?? readFileSync(file, 'utf8');
    for (const specifier of runtimeSpecifiers(source, file)) {
      edges.push(`${relative(repository, file)} -> ${specifier}`);
      if (!specifier.startsWith('.')) {
        packages.add(specifier);
        if (options.permittedPackages !== undefined && !options.permittedPackages.has(specifier))
          throw new Error(
            `forbidden runtime import: ${specifier} from ${relative(repository, file)}`,
          );
      }
      if (options.opaquePackages?.has(specifier) === true) continue;
      if (specifier.startsWith('node:')) continue;
      const resolved = ts.resolveModuleName(
        specifier,
        file,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      if (resolved === undefined)
        throw new Error(`unresolved runtime edge: ${specifier} from ${file}`);
      // Supported package exports resolve to declarations for tsc. Follow their actual paired JS.
      const target = resolved.resolvedFileName.replace(/\.d\.ts$/, '.js');
      pending.push(resolve(dirname(file), target));
    }
  }
  return { files, packages, edges };
}

describe('pure Step 6 substrate runtime import closure', () => {
  it('uses compiler-erased edges, including mixed imports, exports, dynamic imports and require', () => {
    expect(
      runtimeSpecifiers(
        `
      import type { Heavy } from 'heavy-types';
      export type { Heavy } from 'heavy-export-types';
      import { type Erased, kept } from 'mixed';
      export { type Erased, kept } from 'mixed-export';
      export * from 'value-reexport';
      void import('dynamic-value');
      const value = require('required-value');
    `,
        'witness.ts',
      ),
    ).toEqual(['mixed', 'mixed-export', 'value-reexport', 'dynamic-value', 'required-value']);
  });

  it('resolves every pure root transitively without loading service packages or the runtime classifier', () => {
    const graph = runtimeClosure([
      'apps/cli/src/process/cli-error.ts',
      'apps/cli/src/process/diagnostic-policy.ts',
      'apps/cli/src/process/options.ts',
      'apps/cli/src/process/exit-observations.ts',
      'apps/cli/src/process/invocation-registry.ts',
      'apps/cli/src/process/output-mode.ts',
      'apps/cli/src/process/source-label.ts',
      'apps/cli/src/commands/input.ts',
      'apps/cli/src/commands/descriptors.ts',
      'apps/cli/src/commands/discovery.ts',
    ]);
    expect([...graph.packages].sort(), graph.edges.join('\n')).toEqual([
      '@relavium/shared/fs-root-limits',
      '@relavium/shared/relavium-error',
      'node:path',
    ]);
    const filenames = [...graph.files].map((file) => relative(repository, file));
    expect(filenames.some((file) => file.endsWith('shared/dist/relavium-error.js'))).toBe(true);
    expect(filenames.some((file) => file.endsWith('shared/dist/fs-root-limits.js'))).toBe(true);
    expect(
      filenames.filter(
        (file) =>
          file.includes('/node_modules/') &&
          !file.endsWith('shared/dist/relavium-error.js') &&
          !file.endsWith('shared/dist/fs-root-limits.js'),
      ),
    ).toEqual([]);
    expect(
      filenames.filter((file) =>
        /(?:process\/errors|commands\/(?:dispatch|manifest|specs)|test-support|engine\/|db\/|render\/|config\/)/.test(
          file,
        ),
      ),
    ).toEqual([]);
    expect(
      filenames.every(
        (file) =>
          file.startsWith('apps/cli/src/') ||
          /packages\/shared\/dist\/(?:relavium-error|fs-root-limits)\.js$/.test(file),
      ),
    ).toBe(true);
  });
});

describe('lightweight Commander adapter runtime import closure', () => {
  const roots = ['apps/cli/src/program.ts', 'apps/cli/src/commands/specs.ts'];
  const permittedPackages = new Set([
    'commander',
    '@relavium/shared/fs-root-limits',
    '@relavium/shared/relavium-error',
    'node:path',
  ]);
  const opaquePackages = new Set(['commander']);

  function adapterClosure(sourceOverrides?: ReadonlyMap<string, string>): Closure {
    return runtimeClosure(roots, {
      permittedPackages,
      opaquePackages,
      ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
    });
  }

  function expectLightweight(graph: Closure): void {
    expect([...graph.packages].sort(), graph.edges.join('\n')).toEqual([
      '@relavium/shared/fs-root-limits',
      '@relavium/shared/relavium-error',
      'commander',
    ]);
    const filenames = [...graph.files].map((file) => relative(repository, file));
    expect(filenames).toContain('apps/cli/src/program.ts');
    expect(filenames).toContain('apps/cli/src/commands/specs.ts');
    expect(filenames).toContain('apps/cli/src/commands/descriptors.ts');
    expect(
      filenames.filter((file) =>
        /(?:process\/errors|commands\/(?:dispatch|manifest)|test-support|engine\/|db\/|render\/|config\/)/.test(
          file,
        ),
      ),
    ).toEqual([]);
    expect(
      filenames.every(
        (file) =>
          file.startsWith('apps/cli/src/') ||
          /packages\/shared\/dist\/(?:relavium-error|fs-root-limits)\.js$/.test(file),
      ),
    ).toBe(true);
  }

  it('follows local and supported shared values, stopping only at the reviewed Commander framework boundary', () => {
    // This source guard deliberately does not certify Commander's installed transitive graph,
    // packed/native reachability, or Step 7 bootstrap behavior.
    expectLightweight(adapterClosure());
  });

  it('rejects a compiler-emitted heavy value edge while erasing the same type-only fixture edge', () => {
    const filename = resolve(repository, 'apps/cli/src/commands/specs.ts');
    const original = readFileSync(filename, 'utf8');
    const typeOnly = new Map([
      [filename, `import type { WorkflowEngine } from '@relavium/core';\n${original}`],
    ]);
    expectLightweight(adapterClosure(typeOnly));
    const value = new Map([
      [
        filename,
        `import { WorkflowEngine } from '@relavium/core';\nvoid WorkflowEngine;\n${original}`,
      ],
    ]);
    expect(() => adapterClosure(value)).toThrowError(
      'forbidden runtime import: @relavium/core from apps/cli/src/commands/specs.ts',
    );
  });
});
