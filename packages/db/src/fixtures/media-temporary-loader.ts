import { existsSync, readFileSync } from 'node:fs';
import type { LoadHook, ResolveHook } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

// Native regression children execute this checkout's sources, never stale workspace dist.
const root = fileURLToPath(new URL('../../../../', import.meta.url));

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
  const workspace = /^@relavium\/(shared|db|core|llm|mcp)$/.exec(specifier)?.[1];
  if (workspace !== undefined)
    return {
      url: pathToFileURL(`${root}packages/${workspace}/src/index.ts`).href,
      shortCircuit: true,
    };
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(source)) return { url: source.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
};

export const load: LoadHook = (url, context, nextLoad) => {
  if (
    url.startsWith('file:') &&
    url.endsWith('.ts') &&
    fileURLToPath(url).startsWith(root) &&
    !url.includes('/node_modules/')
  ) {
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
  }
  return nextLoad(url, context);
};
