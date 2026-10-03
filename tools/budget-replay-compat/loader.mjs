import { createRequire } from 'node:module';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyDependencyFile } from './dependency-runtime.mjs';

const root = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const mode = process.env.COMPAT_SOURCE;
if (mode !== 'producer' && mode !== 'frozen')
  throw new Error('COMPAT_SOURCE must be producer or frozen');
const sourceRoot = resolvePath(root, mode);
const require = createRequire(resolvePath(root, 'package.json'));
const ts = require('typescript');
const manifestRaw = JSON.parse(
  readFileSync(
    resolvePath(
      root,
      mode === 'producer' ? 'producer-source-manifest.json' : 'frozen/source-manifest.json',
    ),
    'utf8',
  ),
);
const manifest = new Map(
  (Array.isArray(manifestRaw) ? manifestRaw : manifestRaw.files).map((f) => [
    resolvePath(sourceRoot, f.path),
    f,
  ]),
);
const trace = resolvePath(root, 'logs', `${process.env.COMPAT_LABEL}.resolution.jsonl`);
const aliases = Object.fromEntries(
  ['shared', 'llm', 'core', 'db'].map((p) => [
    `@relavium/${p}`,
    resolvePath(sourceRoot, `packages/${p}/src/index.ts`),
  ]),
);
const log = (value) => appendFileSync(trace, `${JSON.stringify(value)}\n`);
log({
  phase: 'loader-start',
  root,
  sourceRoot,
  mode,
  nodeVersion: process.version,
  typescriptVersion: ts.version,
});

export async function resolve(specifier, context, nextResolve) {
  let result;
  const parentPath = context.parentURL?.startsWith('file:')
    ? fileURLToPath(context.parentURL)
    : undefined;
  if (Object.hasOwn(aliases, specifier)) {
    result = { url: pathToFileURL(aliases[specifier]).href, shortCircuit: true };
  } else if (parentPath?.startsWith(`${sourceRoot}${sep}`) && specifier.startsWith('.')) {
    const original = fileURLToPath(new URL(specifier, context.parentURL));
    const candidate = original.endsWith('.js') ? `${original.slice(0, -3)}.ts` : original;
    if (!existsSync(candidate)) throw new Error(`Frozen relative source is absent: ${candidate}`);
    result = { url: pathToFileURL(candidate).href, shortCircuit: true };
  } else {
    result = await nextResolve(specifier, context);
  }
  if (result.url.startsWith('file:')) {
    const path = realpathSync(fileURLToPath(result.url));
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error(`Workspace or external source/dist forbidden: ${path}`);
    }
    if (path.startsWith(`${root}${sep}${mode === 'producer' ? 'frozen' : 'producer'}${sep}`)) {
      throw new Error(`Mixed producer/predecessor source forbidden: ${path}`);
    }
    // Project sources have their own immutable/captured manifest. EVERY other loaded file must be a
    // captured worker tool or copied dependency; an arbitrary file inside the owned tree is not enough.
    if (!manifest.has(path)) verifyDependencyFile(path);
  }
  log({ phase: 'resolve', specifier, parentURL: context.parentURL, resolved: result.url });
  return result;
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(pathToFileURL(`${sourceRoot}/`).href) && url.endsWith('.ts')) {
    const path = fileURLToPath(url);
    const bytes = readFileSync(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const expected = manifest.get(path);
    if (
      !expected ||
      expected.sha256 !== sha256 ||
      (expected.bytes ?? expected.size) !== bytes.length
    )
      throw new Error(`Source integrity failed: ${path}`);
    const output = ts.transpileModule(bytes.toString('utf8'), {
      fileName: path,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
      reportDiagnostics: true,
    });
    const errors = (output.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length) throw new Error(`Source transpile failed: ${path}`);
    log({
      phase: 'load-source',
      mode,
      path: relative(sourceRoot, path),
      bytes: bytes.length,
      sha256,
    });
    return { format: 'module', source: output.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
