import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (cause) {
    if (!specifier.endsWith('.js') || context.parentURL === undefined) throw cause;
    const candidate = new URL(specifier.slice(0, -3) + '.tsx', context.parentURL);
    try {
      await readFile(candidate);
    } catch {
      throw cause;
    }
    return { url: candidate.href, shortCircuit: true };
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return await nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return {
    format: 'module',
    shortCircuit: true,
    source: ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        verbatimModuleSyntax: true,
      },
    }).outputText,
  };
}
