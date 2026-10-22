/**
 * Finite emitted ESM graph guard (ADR-0111). No filesystem reads or process state:
 * the CLI supplies an inventory, and controls can remove/change any independent
 * witness. This checks emitted files, not a tarball. A finalized candidate's maps are
 * checked here only for pairing; the candidate finalizer owns their content and custody.
 */
import { Buffer } from 'node:buffer';
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

export class BundleClosureError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'BundleClosureError';
    this.code = code;
  }
}

function refuse(code, detail) {
  throw new BundleClosureError(code, detail);
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse('METADATA_SHAPE', `${label} must be an object`);
  }
  return value;
}

function strings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    refuse('METADATA_SHAPE', `${label} must be a string array`);
  }
  return value;
}

function bytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse('METADATA_SHAPE', `${label} must be nonnegative integral bytes`);
  }
}

function sourcePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\\\s:?#%]/u.test(value) ||
    [...value].some((character) => character.codePointAt(0) < 32) ||
    value.startsWith('/') ||
    posix.normalize(value) !== value
  ) {
    refuse('INPUT_PATH', `${label} is not a canonical relative source path`);
  }
}

function outputPath(value, directory) {
  if (
    typeof value !== 'string' ||
    !value.startsWith(`${directory}/`) ||
    !/^[a-zA-Z0-9_-]+\.js$/u.test(value.slice(directory.length + 1))
  ) {
    refuse('OUTPUT_PATH', `expected a flat ${directory}/*.js output: ${value}`);
  }
}

/** Exact builtin identity matters: fs/not-a-builtin must not disappear as "fs". */
function externalPackage(specifier) {
  if (isBuiltin(specifier)) return undefined;
  if (
    typeof specifier !== 'string' ||
    !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]+)*$/u.test(
      specifier,
    ) ||
    specifier.split('/').some((part) => part === '.' || part === '..')
  ) {
    refuse('EXTERNAL_PATH', `unsupported external specifier: ${specifier}`);
  }
  const parts = specifier.split('/');
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (isBuiltin(packageName)) {
    refuse('EXTERNAL_PATH', `unknown builtin subpath: ${specifier}`);
  }
  if (packageName.startsWith('@relavium/')) {
    refuse('PRIVATE_EXTERNAL', `engine package must be inlined: ${specifier}`);
  }
  return packageName;
}

function imports(value, label) {
  if (!Array.isArray(value)) refuse('METADATA_SHAPE', `${label}.imports must be an array`);
  for (const edge of value) {
    record(edge, `${label} import`);
    if (
      typeof edge.path !== 'string' ||
      !['import-statement', 'dynamic-import'].includes(edge.kind) ||
      (edge.external !== undefined && typeof edge.external !== 'boolean') ||
      (edge.original !== undefined && typeof edge.original !== 'string')
    ) {
      refuse('LOADER_KIND', `${label} has unsupported import metadata`);
    }
  }
  return value;
}

// Only syntax with an independently enumerable specifier is supported. Refuse
// acquisition/aliasing of loader or code-generation capabilities, not just calls
// spelled `require(...)`: imported createRequire is routinely minified/renamed.
const LOADER_NAMES = new Set([
  'require',
  '__require',
  'createRequire',
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'AsyncGeneratorFunction',
  'getBuiltinModule',
  '_load',
  '_compile',
  'dlopen',
  'Worker',
  'importScripts',
]);
const MODULE_SAFE_EXPORTS = new Set([
  'builtinModules',
  'isBuiltin',
  'syncBuiltinESMExports',
  'findSourceMap',
  'SourceMap',
]);

function actualImports(contents, path) {
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length > 0) refuse('JS_SYNTAX', `cannot parse emitted JS: ${path}`);
  const edges = [];
  function edge(specifier, kind) {
    if (!specifier || !ts.isStringLiteral(specifier)) {
      refuse('NONLITERAL_IMPORT', `${path} has a nonliteral runtime import`);
    }
    edges.push({ path: specifier.text, kind });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        edge(node.moduleSpecifier, 'import-statement');
        const specifier = node.moduleSpecifier.text;
        if (['vm', 'node:vm', 'worker_threads', 'node:worker_threads'].includes(specifier)) {
          refuse('UNKNOWN_LOADER', `${path} imports a code-generation capability`);
        }
        if (specifier === 'module' || specifier === 'node:module') {
          const bindings = ts.isImportDeclaration(node)
            ? node.importClause?.namedBindings
            : node.exportClause;
          if (
            !bindings ||
            !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ||
            (ts.isImportDeclaration(node) && node.importClause?.name) ||
            bindings.elements.some(
              (item) => !MODULE_SAFE_EXPORTS.has((item.propertyName ?? item.name).text),
            )
          ) {
            refuse('UNKNOWN_LOADER', `${path} imports an unreviewed module loader capability`);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1) {
        refuse('UNKNOWN_LOADER', `${path} uses unsupported import options`);
      }
      edge(node.arguments[0], 'dynamic-import');
      // import('node:module') exposes every loader even when renamed/destructured.
      if (
        [
          'module',
          'node:module',
          'vm',
          'node:vm',
          'worker_threads',
          'node:worker_threads',
        ].includes(node.arguments[0].text)
      ) {
        refuse('UNKNOWN_LOADER', `${path} dynamically acquires a module loader capability`);
      }
    }
    if (
      (ts.isIdentifier(node) && LOADER_NAMES.has(node.text)) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        LOADER_NAMES.has(node.argumentExpression.text))
    ) {
      refuse('UNKNOWN_LOADER', `${path} contains an unreviewed runtime loader`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return edges;
}

/**
 * Separate external maps from runtime outputs. An ordinary build is map-free. A finalized
 * candidate pairs every runtime output with exactly one map, staged outside the package, whose
 * metadata entry carries no graph information of its own.
 */
function runtimeOutputs(outputs, directory, maps) {
  const runtime = {};
  const staged = new Set();
  for (const [path, output] of Object.entries(outputs)) {
    if (!path.endsWith('.map')) {
      runtime[path] = output;
      continue;
    }
    if (maps !== 'staged') refuse('MAP_OUTPUT', `ordinary build emitted a source map: ${path}`);
    outputPath(path.slice(0, -'.map'.length), directory);
    const entry = record(output, `map output ${path}`);
    bytes(entry.bytes, `map output ${path}.bytes`);
    if (
      !isDeepStrictEqual(Object.keys(entry).sort(), ['bytes', 'exports', 'imports', 'inputs']) ||
      Object.keys(record(entry.inputs, `map output ${path}.inputs`)).length > 0 ||
      strings(entry.exports, `map output ${path}.exports`).length > 0 ||
      imports(entry.imports, `map output ${path}`).length > 0
    ) {
      refuse('MAP_OUTPUT', `staged map metadata carries graph information: ${path}`);
    }
    staged.add(path);
  }
  if (maps === 'staged') {
    for (const path of Object.keys(runtime)) {
      if (!staged.has(`${path}.map`)) {
        refuse('MAP_PAIRING', `runtime output has no staged map: ${path}`);
      }
    }
    for (const path of staged) {
      if (!Object.hasOwn(runtime, path.slice(0, -'.map'.length))) {
        refuse('MAP_PAIRING', `staged map has no runtime output: ${path}`);
      }
    }
  }
  return runtime;
}

/**
 * @param {{metafile: unknown, manifest: unknown,
 * files: Record<string, {contents: string, mode?: number, kind?: string}>,
 * outputDirectory?: string, entryPoint?: string,
 * modeEvidence?: "posix" | "not-observable-windows",
 * maps?: "none" | "staged"}} options `staged` admits a finalized candidate's paired map
 * metadata; the map files themselves must already be outside the inventoried package.
 * @returns {{outputs: string[], dependencies: string[], inputs: string[], modeEvidence: string}}
 * @throws {BundleClosureError} when an emitted graph invariant fails.
 */
export function checkBundleClosure({
  metafile,
  manifest,
  files,
  outputDirectory = 'dist',
  entryPoint = 'src/index.ts',
  modeEvidence = 'posix',
  maps = 'none',
}) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(outputDirectory)) {
    refuse('OUTPUT_PATH', 'outputDirectory must be one plain directory name');
  }
  if (!['posix', 'not-observable-windows'].includes(modeEvidence)) {
    refuse('MODE_EVIDENCE', 'mode evidence must name its observable platform scope');
  }
  if (!['none', 'staged'].includes(maps)) {
    refuse('MAP_MODE', 'map mode must be none or staged');
  }
  sourcePath(entryPoint, 'entryPoint');
  const meta = record(metafile, 'metafile');
  const inputs = record(meta.inputs, 'metafile.inputs');
  const outputs = runtimeOutputs(record(meta.outputs, 'metafile.outputs'), outputDirectory, maps);
  const dependencies = record(record(manifest, 'manifest').dependencies, 'manifest.dependencies');
  record(files, 'files');
  const declared = new Set(Object.keys(dependencies));
  for (const name of declared) {
    if (externalPackage(name) !== name || typeof dependencies[name] !== 'string') {
      refuse('DEPENDENCY_DECLARATION', `invalid runtime dependency declaration: ${name}`);
    }
  }
  function assertExternal(specifier) {
    const name = externalPackage(specifier);
    if (name !== undefined && !declared.has(name)) {
      refuse('UNDECLARED_EXTERNAL', `runtime dependency is not declared: ${specifier}`);
    }
    return name;
  }
  for (const [path, input] of Object.entries(inputs)) {
    sourcePath(path, 'metafile input');
    record(input, `input ${path}`);
    bytes(input.bytes, `input ${path}.bytes`);
    if (input.format !== 'esm') refuse('INPUT_FORMAT', `expected an ESM input: ${path}`);
    // No third-party implementation may silently become a second bundled copy.
    if (path.split('/').includes('node_modules')) {
      refuse('BUNDLED_DEPENDENCY', `third-party input must remain external: ${path}`);
    }
    for (const imported of imports(input.imports, `input ${path}`)) {
      if (imported.external === true) assertExternal(imported.path);
      else if (!Object.hasOwn(inputs, imported.path)) {
        refuse('MISSING_INPUT', `input ${path} references absent input ${imported.path}`);
      }
    }
  }
  if (!Object.hasOwn(inputs, entryPoint)) refuse('ENTRY_POINT', 'entry input is absent');
  const outputNames = Object.keys(outputs);
  if (!outputNames.includes(`${outputDirectory}/index.js`)) {
    refuse('ENTRY_POINT', 'index.js output is absent');
  }
  const inputOwners = new Map();
  const importedPackages = new Set();
  const graph = new Map();
  let roots = 0;
  for (const [path, output] of Object.entries(outputs)) {
    outputPath(path, outputDirectory);
    record(output, `output ${path}`);
    bytes(output.bytes, `output ${path}.bytes`);
    strings(output.exports, `output ${path}.exports`);
    const contributions = record(output.inputs, `output ${path}.inputs`);
    const isEntry = path === `${outputDirectory}/index.js`;
    if (output.entryPoint !== undefined) {
      sourcePath(output.entryPoint, `output ${path}.entryPoint`);
      if (!Object.hasOwn(inputs, output.entryPoint)) {
        refuse('ENTRY_POINT', `output ${path} names absent entry input`);
      }
      if (output.entryPoint === entryPoint) roots += 1;
    }
    if (isEntry && output.entryPoint !== entryPoint) {
      refuse('ENTRY_POINT', 'index.js is not emitted from the configured entry');
    }
    for (const [input, contribution] of Object.entries(contributions)) {
      if (!Object.hasOwn(inputs, input))
        refuse('MISSING_INPUT', `${path} names absent input ${input}`);
      record(contribution, `${path} input ${input}`);
      bytes(contribution.bytesInOutput, `${path} input ${input}.bytesInOutput`);
      if (contribution.bytesInOutput > 0) {
        if (inputOwners.has(input)) {
          refuse('DUPLICATE_INPUT', `${input} is independently inlined in more than one output`);
        }
        inputOwners.set(input, path);
      }
    }
    if (!Object.hasOwn(files, path)) refuse('MISSING_OUTPUT', `emitted output is absent: ${path}`);
    const file = record(files[path], `file ${path}`);
    if (file.kind !== undefined && file.kind !== 'file') {
      refuse('OUTPUT_KIND', `runtime output is not an ordinary file: ${path}`);
    }
    if (typeof file.contents !== 'string') refuse('OUTPUT_KIND', `cannot read JS output: ${path}`);
    if (modeEvidence === 'posix') {
      if (file.mode !== (isEntry ? 0o755 : 0o644))
        refuse('OUTPUT_MODE', `unexpected or missing POSIX mode: ${path}`);
    } else if (file.mode !== undefined) {
      refuse('MODE_EVIDENCE', 'Windows graph evidence cannot assert unobservable POSIX modes');
    }
    // Neither an ordinary build nor a finalized candidate may link a map from runtime code.
    if (/sourceMappingURL\s*=/u.test(file.contents)) {
      refuse('MAP_LINK', `runtime output links a source map: ${path}`);
    }
    if (Buffer.byteLength(file.contents, 'utf8') !== output.bytes) {
      refuse('OUTPUT_BYTES', `output byte inventory disagrees: ${path}`);
    }
    if (
      isEntry ? !file.contents.startsWith('#!/usr/bin/env node\n') : file.contents.startsWith('#!')
    ) {
      refuse('HASHBANG', `only index.js may carry its expected hashbang: ${path}`);
    }
    const neighbours = new Set();
    function normalizeEdge(imported, metadata) {
      let target;
      if (metadata && imported.external !== true) {
        outputPath(imported.path, outputDirectory);
        target = imported.path;
      } else if (imported.path.startsWith('./')) {
        const name = imported.path.slice(2);
        target = `${outputDirectory}/${name}`;
        outputPath(target, outputDirectory);
        if (metadata) refuse('EXTERNAL_CHUNK', `${path} declares a relative chunk external`);
      } else {
        const name = assertExternal(imported.path);
        if (name !== undefined) importedPackages.add(name);
        return `${imported.kind}:external:${imported.path}`;
      }
      if (!Object.hasOwn(outputs, target)) {
        refuse('MISSING_CHUNK', `${path} loads absent chunk ${target}`);
      }
      neighbours.add(target);
      return `${imported.kind}:chunk:${target}`;
    }
    const declaredEdges = new Set(
      imports(output.imports, `output ${path}`).map((item) => normalizeEdge(item, true)),
    );
    const actualEdges = new Set(
      actualImports(file.contents, path).map((item) => normalizeEdge(item, false)),
    );
    if (
      declaredEdges.size !== actualEdges.size ||
      [...declaredEdges].some((item) => !actualEdges.has(item))
    ) {
      refuse('IMPORT_DRIFT', `actual JS imports disagree with metadata: ${path}`);
    }
    graph.set(path, neighbours);
  }
  if (roots !== 1) refuse('ENTRY_POINT', 'expected one configured entry output');
  for (const path of Object.keys(files)) {
    if (/\.(?:js|mjs|cjs)$/iu.test(path) && !Object.hasOwn(outputs, path)) {
      refuse('EXTRA_OUTPUT', `JS file is absent from build metadata: ${path}`);
    }
  }
  const reached = new Set();
  const pending = [`${outputDirectory}/index.js`];
  while (pending.length > 0) {
    const path = pending.pop();
    if (reached.has(path)) continue;
    reached.add(path);
    pending.push(...graph.get(path));
  }
  if (reached.size !== outputNames.length) {
    refuse('UNREFERENCED_OUTPUT', 'build inventory contains unreachable runtime chunks');
  }
  for (const name of declared) {
    if (!importedPackages.has(name))
      refuse('DEAD_DEPENDENCY', `declared dependency is not loaded: ${name}`);
  }
  return {
    modeEvidence,
    outputs: outputNames.sort(),
    dependencies: [...importedPackages].sort(),
    inputs: Object.keys(inputs).sort(),
  };
}
