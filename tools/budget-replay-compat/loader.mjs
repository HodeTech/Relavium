import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyDependencyResolution, verifyDependencyFile } from './dependency-runtime.mjs';

const root = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const mode = process.env.COMPAT_SOURCE;
if (mode !== 'producer' && mode !== 'frozen')
  throw new Error('COMPAT_SOURCE must be producer or frozen');
const sourceRoot = resolvePath(root, mode);
const require = createRequire(resolvePath(root, 'package.json'));
const ts = require('typescript');
const manifestPath = resolvePath(
  root,
  mode === 'producer' ? 'producer-source-manifest.json' : 'frozen/source-manifest.json',
);
const manifestBytes = readFileSync(manifestPath);
const manifestRaw = JSON.parse(manifestBytes.toString('utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evaluation = JSON.parse(readFileSync(resolvePath(root, 'evaluation-context.json'), 'utf8'));
const supplement =
  mode === 'frozen' && existsSync(resolvePath(root, 'session-source-supplement.json'))
    ? JSON.parse(readFileSync(resolvePath(root, 'session-source-supplement.json'), 'utf8')).files
    : [];
if (
  supplement.length > 0 &&
  (supplement.length !== 1 ||
    supplement[0].path !== 'packages/db/src/session-store.ts' ||
    supplement[0].gitBlob !== '9b4c5a1b5235dc44b110e41d7cc71cad5d071162' ||
    supplement[0].bytes !== 36496 ||
    supplement[0].sha256 !== '8a42221ccf48f1361ba964796bf4638d745eeb286b53d66ef83a68bf4682d25b')
)
  throw new Error('Session source supplement differs from its exact Git allowlist');
const manifest = new Map(
  [...(Array.isArray(manifestRaw) ? manifestRaw : manifestRaw.files), ...supplement].map((f) => [
    resolvePath(sourceRoot, f.path),
    f,
  ]),
);
const trace = resolvePath(root, 'logs', `${process.env.COMPAT_LABEL}.resolution.jsonl`);
const aliases = Object.fromEntries(
  [
    ['@relavium/shared', 'packages/shared/src/index.ts'],
    ['@relavium/shared/relavium-error', 'packages/shared/src/relavium-error.ts'],
    ['@relavium/shared/fs-root-limits', 'packages/shared/src/fs-root-limits.ts'],
    ['@relavium/shared/terminal-safe', 'packages/shared/src/terminal-safe.ts'],
    ['@relavium/llm', 'packages/llm/src/index.ts'],
    ['@relavium/llm/adapters', 'packages/llm/src/adapters/index.ts'],
    ['@relavium/llm/scrub-secrets', 'packages/llm/src/scrub-secrets.ts'],
    ['@relavium/core', 'packages/core/src/index.ts'],
    ['@relavium/core/tool-dispatch-error', 'packages/core/src/tools/dispatch-error.ts'],
    ['@relavium/db', 'packages/db/src/index.ts'],
    ['@relavium/mcp', 'packages/mcp/src/index.ts'],
  ].map(([name, path]) => [name, resolvePath(sourceRoot, path)]),
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
  if (specifier.startsWith('@relavium/') && !Object.hasOwn(aliases, specifier))
    throw new Error(`Unowned Relavium subpath forbidden: ${specifier}`);
  if (Object.hasOwn(aliases, specifier)) {
    if (!manifest.has(aliases[specifier]))
      throw new Error(`Source alias absent from ${mode} manifest: ${specifier}`);
    result = { url: pathToFileURL(aliases[specifier]).href, shortCircuit: true };
  } else if (parentPath?.startsWith(`${sourceRoot}${sep}`) && specifier.startsWith('.')) {
    const original = fileURLToPath(new URL(specifier, context.parentURL));
    const candidate = original.endsWith('.js')
      ? [`${original.slice(0, -3)}.ts`, `${original.slice(0, -3)}.tsx`, original].find((path) =>
          existsSync(path),
        )
      : original;
    if (!candidate || !existsSync(candidate))
      throw new Error(`Frozen relative source is absent: ${candidate}`);
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
    if (!manifest.has(path)) verifyDependencyResolution(parentPath, specifier, path);
  }
  log({ phase: 'resolve', specifier, parentURL: context.parentURL, resolved: result.url });
  return result;
}

function instrument(source, path, bytes, manifestFile, sourceMode) {
  const rawSha256 = digest(bytes);
  let identifier = `__compatEvaluation_${rawSha256.slice(0, 16)}`;
  while (source.includes(identifier)) identifier += '_';
  const supplementManifestPath =
    mode === 'frozen' && supplement.length > 0
      ? resolvePath(root, 'session-source-supplement.json')
      : undefined;
  const metadata = {
    directory: evaluation.directory,
    executionPhase: evaluation.phase,
    mutationId: evaluation.mutationId,
    sourceMode,
    physicalPath: path,
    relativePath: relative(sourceMode === 'worker-tool' ? root : sourceRoot, path),
    bytes: bytes.length,
    rawSha256,
    manifestPath: manifestFile,
    manifestSha256: digest(readFileSync(manifestFile)),
    ...(supplementManifestPath
      ? {
          supplementManifestPath,
          supplementManifestSha256: digest(readFileSync(supplementManifestPath)),
        }
      : {}),
    currentSourceRoot: evaluation.currentSourceRoot,
    outerSourceManifestSha256: evaluation.outerSourceManifestSha256,
    ...(sourceMode === 'producer'
      ? { capturedFrom: resolvePath(evaluation.currentSourceRoot, relative(sourceRoot, path)) }
      : {}),
  };
  const prefix = `import { recordEvaluation as ${identifier} } from ${JSON.stringify(pathToFileURL(resolvePath(root, 'evaluation.mjs')).href)}; ${identifier}(${JSON.stringify(metadata)});\n`;
  // Shift existing inline mappings by the single inserted module-body line. The raw source and
  // sourcesContent stay unchanged, so semantic failures still point to captured product bytes.
  source = source.replace(
    /(\/\/# sourceMappingURL=data:application\/json;base64,)([^\s]+)/,
    (_match, beginning, encoded) => {
      const map = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      map.mappings = `;${map.mappings}`;
      return `${beginning}${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    },
  );
  if (source.startsWith('#!')) {
    const end = source.indexOf('\n');
    return `${source.slice(0, end + 1)}${prefix}${source.slice(end + 1)}`;
  }
  return prefix + source;
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    const path = realpathSync(fileURLToPath(url));
    if (manifest.has(path) && /\.tsx?$/.test(path)) {
      const bytes = readFileSync(path);
      const sha256 = digest(bytes);
      const expected = manifest.get(path);
      if (expected.sha256 !== sha256 || (expected.bytes ?? expected.size) !== bytes.length)
        throw new Error(`Source integrity failed: ${path}`);
      const output = ts.transpileModule(bytes.toString('utf8'), {
        fileName: path,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
          inlineSourceMap: true,
          inlineSources: true,
          jsx: ts.JsxEmit.ReactJSX,
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
      return {
        format: 'module',
        source: instrument(output.outputText, path, bytes, manifestPath, mode),
        shortCircuit: true,
      };
    }
    // Only explicitly captured worker tools receive worker-body witnesses; external dependency
    // preparation remains distinct from product/module evaluation.
    if (
      path.startsWith(`${root}${sep}`) &&
      !path.slice(root.length + 1).includes(sep) &&
      path.endsWith('.mjs') &&
      !['evaluation.mjs', 'dependency-runtime.mjs', 'register.mjs'].includes(
        path.slice(root.length + 1),
      )
    ) {
      verifyDependencyFile(path);
      const bytes = readFileSync(path);
      return {
        format: 'module',
        source: instrument(
          bytes.toString('utf8'),
          path,
          bytes,
          resolvePath(root, 'dependency-runtime.json'),
          'worker-tool',
        ),
        shortCircuit: true,
      };
    }
  }
  return nextLoad(url, context);
}
