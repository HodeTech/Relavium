/**
 * Symbolication of actual packed CLI and engine frames (ADR-0111; packaging.md "Candidate
 * finalization — Step 9" item 5; Step 9a.2a). After the archive inspection and the private manifest,
 * the producer runs the finalized `dist` — byte-equal to the tarball, re-hashed per frame — under the
 * tooling-only preload (frame-capture.mjs) while it imports a canary workflow, and maps the captured
 * frames through the staged final maps. Each anchor below must be reached by a synchronous frame that
 * lands exactly on a mapping segment and resolves to the call site that the matching source
 * revision's syntax tree gives: the candidate copy for a dirty local build, the checkout's Git objects
 * at the recorded commit otherwise, both bound to the manifest's per-source digests. Each frame file is
 * re-hashed after the run. A refusal names a fixed code; no frame, path, position or source text is
 * ever printed.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPrivateManifest } from './manifest.mjs';
import { readOrdinaryFile, sha256 } from './files.mjs';
import { isolatedEnvironment, isolatedGitEnvironment, runCommand } from './process.mjs';
import { SourceMapError, decodeMappings, segmentAt } from './source-map.mjs';

export class SymbolicationError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`PACKED_CLI_SYMBOLICATION_${code}`);
    this.name = 'SymbolicationError';
    this.code = code;
  }
}

/** @param {string} code @returns {never} */
function refuse(code) {
  throw new SymbolicationError(code);
}

/**
 * The named call sites the canary import passes through: three in the CLI and two in the inlined
 * `@relavium/core`. Each is the one call to `call` inside the function `within`; its expected line and
 * column come from the source revision, never from this table.
 */
export const ANCHORS = Object.freeze([
  { source: 'packages/core/src/yaml-decode.ts', within: 'decodeHardenedYaml', call: 'parseYaml' },
  { source: 'packages/core/src/parser.ts', within: 'parseWorkflow', call: 'decodeHardenedYaml' },
  {
    source: 'apps/cli/src/authoring/authoring.ts',
    within: 'parseAsWorkflow',
    call: 'parseWorkflow',
  },
  {
    source: 'apps/cli/src/authoring/authoring.ts',
    within: 'detectAndParse',
    call: 'parseAsWorkflow',
  },
  { source: 'apps/cli/src/commands/import.ts', within: 'importCommand', call: 'detectAndParse' },
]);

const PRELOAD = fileURLToPath(new URL('./frame-capture.mjs', import.meta.url));
const FRAME_LIMIT = 64;

/** A workflow the CLI accepts, whose id carries the canary the preload watches for. */
function canaryDocument(canary) {
  return [
    "schema_version: '1.0'",
    'workflow:',
    `  id: ${canary}`,
    '  name: Symbolication canary',
    '  nodes:',
    '    - { id: start, type: input }',
    '    - { id: out, type: output }',
    '  edges:',
    '    - { from: start, to: out }',
    '',
  ].join('\n');
}

/**
 * @typedef {{file: string | null, line: number, column: number, async: boolean}} Frame
 */

/**
 * Run the finalized CLI's `import` of a canary workflow under the preload, with its home, project and
 * temporary files in `work` (owner-only, outside the candidate), and return the one captured stack.
 * The project's own `.relavium/` exists before the run, so the CLI's upward search for a project stops
 * there and never adopts an ancestor's — a developer's real one on Windows, where the temporary
 * directory lies below the home; the run must have imported the canary into it.
 * @param {{candidate: string, work: string, run?: typeof runCommand}} options
 * @returns {Promise<Frame[]>}
 */
export async function captureFrames({ candidate, work, run = runCommand }) {
  const canary = `frames-canary-${randomBytes(6).toString('hex')}`;
  const home = join(work, 'home');
  const project = join(work, 'project');
  const catalog = join(project, '.relavium');
  for (const directory of [home, project, catalog]) mkdirSync(directory, { mode: 0o700 });
  const document = join(work, `${canary}.relavium.yaml`);
  writeFileSync(document, canaryDocument(canary), { mode: 0o600, flag: 'wx' });
  const log = join(work, 'frames.json');
  try {
    await run(
      process.execPath,
      [
        '--import',
        pathToFileURL(PRELOAD).href,
        join(candidate, 'apps', 'cli', 'dist', 'index.js'),
        'import',
        document,
        '--cwd',
        project,
      ],
      {
        cwd: work,
        env: {
          ...isolatedEnvironment(home),
          RELAVIUM_FRAME_CAPTURE_LOG: log,
          RELAVIUM_FRAME_CAPTURE_PACKAGE: join(candidate, 'apps', 'cli', 'package.json'),
          RELAVIUM_FRAME_CAPTURE_CANARY: canary,
        },
        timeoutMs: 120_000,
      },
    );
  } catch {
    // The child's own output is never printed: it can quote the candidate.
    refuse('CAPTURE_FAILED');
  }
  let imported = false;
  try {
    imported = lstatSync(join(catalog, 'workflows', `${canary}.relavium.yaml`)).isFile();
  } catch {
    imported = false;
  }
  if (!imported) refuse('CAPTURE_PROJECT');
  let record;
  try {
    record = JSON.parse(readOrdinaryFile(log, 1024 * 1024).toString('utf8'));
  } catch {
    refuse('CAPTURE_FAILED');
  }
  if (record?.version !== 1 || !Array.isArray(record.captures)) refuse('CAPTURE_SHAPE');
  if (record.captures.length !== 1) refuse('CAPTURE_COUNT');
  const [frames] = record.captures;
  if (
    !Array.isArray(frames) ||
    frames.length === 0 ||
    frames.length > FRAME_LIMIT ||
    !frames.every(
      (frame) =>
        frame !== null &&
        typeof frame === 'object' &&
        (frame.file === null || typeof frame.file === 'string') &&
        typeof frame.async === 'boolean' &&
        (frame.file === null ||
          (Number.isSafeInteger(frame.line) &&
            frame.line > 0 &&
            Number.isSafeInteger(frame.column) &&
            frame.column > 0)),
    )
  ) {
    refuse('CAPTURE_SHAPE');
  }
  return frames;
}

/**
 * The text of each path at the matching source revision, bound to the manifest's digest: the
 * candidate copy for a dirty local build, otherwise the blob at the recorded commit, read from the
 * original checkout's object store by Git without home, global or system configuration, without
 * filters or text conversion (`cat-file blob`) and without replace refs.
 * @param {{candidate: string, checkout: string, manifest: import('./manifest.mjs').PrivateManifest,
 *   paths: readonly string[], run?: typeof runCommand}} options
 * @returns {Promise<Map<string, string>>}
 */
export async function readSourceRevision({
  candidate,
  checkout,
  manifest,
  paths,
  run = runCommand,
}) {
  const texts = new Map();
  for (const path of paths) {
    const digest = manifest.sources[path];
    if (digest === undefined) refuse('SOURCE_REVISION');
    let bytes;
    try {
      bytes = manifest.source.dirty
        ? readOrdinaryFile(join(candidate, ...path.split('/')), 8 * 1024 * 1024)
        : Buffer.from(
            (
              await run(
                'git',
                ['--no-replace-objects', 'cat-file', 'blob', `${manifest.source.commit}:${path}`],
                { cwd: checkout, env: isolatedGitEnvironment(), timeoutMs: 60_000 },
              )
            ).stdout,
            'utf8',
          );
    } catch {
      refuse('SOURCE_REVISION');
    }
    if (sha256(bytes) !== digest) refuse('SOURCE_REVISION');
    texts.set(path, bytes.toString('utf8'));
  }
  return texts;
}

/**
 * The 1-based line and UTF-16 column of an anchor's call site in `text`: the start of the callee's
 * name in the one call to `call` inside the one function named `within`.
 * @param {typeof import('typescript')} ts @param {string} text
 * @param {{source: string, within: string, call: string}} anchor
 */
export function anchorPosition(ts, text, anchor) {
  const file = ts.createSourceFile(
    anchor.source,
    text,
    ts.ScriptTarget.Latest,
    true,
    anchor.source.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const owners = [];
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body !== undefined &&
      node.name !== undefined &&
      node.name.getText(file) === anchor.within
    ) {
      owners.push(node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === anchor.within &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      owners.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (owners.length !== 1) refuse('ANCHOR_SOURCE');
  const callees = [];
  const find = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === anchor.call) callees.push(callee);
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === anchor.call) {
        callees.push(callee.name);
      }
    }
    ts.forEachChild(node, find);
  };
  find(owners[0]);
  if (callees.length !== 1) refuse('ANCHOR_SOURCE');
  const { line, character } = file.getLineAndCharacterOfPosition(callees[0].getStart(file));
  return { line: line + 1, column: character + 1 };
}

/**
 * Map the captured frames and require every anchor, against the manifest sealed into `staging`. Each
 * frame inside the finalized `dist` must be the very file the manifest and the tarball record; its
 * map must be the staged bytes the manifest records and decode strictly; only an exact segment counts.
 * @param {{candidate: string, staging: string, checkout: string, work: string,
 *   archive: {files: {path: string, sha256: string}[]}, run?: typeof runCommand,
 *   capture?: typeof captureFrames, revision?: typeof readSourceRevision,
 *   anchors?: readonly {source: string, within: string, call: string}[]}} options
 * @returns {Promise<{anchors: number}>}
 */
export async function symbolicateCandidate({
  candidate,
  staging,
  checkout,
  work,
  archive,
  run = runCommand,
  capture = captureFrames,
  revision = readSourceRevision,
  anchors = ANCHORS,
}) {
  // The maintainer's coverage ruling: at least two `@relavium/core` and three CLI call sites.
  const within = (root) => anchors.filter((anchor) => anchor.source.startsWith(root)).length;
  if (within('packages/core/src/') < 2 || within('apps/cli/src/') < 3) refuse('ANCHORS');
  const manifest = readPrivateManifest(staging);
  const frames = await capture({ candidate, work, run });
  const paths = [...new Set(anchors.map((anchor) => anchor.source))];
  const texts = await revision({ candidate, checkout, manifest, paths, run });
  let ts;
  try {
    ts = createRequire(join(candidate, 'apps', 'cli', 'package.json'))('typescript');
  } catch {
    refuse('TOOLCHAIN');
  }
  const outputs = new Map(manifest.outputs.map((output) => [output.path, output]));
  const packed = new Map(archive.files.map((file) => [file.path, file.sha256]));
  const dist = realpathSync.native(join(candidate, 'apps', 'cli', 'dist'));
  const decoded = new Map();
  const mapsOf = (output) => {
    let entry = decoded.get(output.path);
    if (entry !== undefined) return entry;
    const bytes = readOrdinaryFile(
      join(staging, 'maps', `${basename(output.path)}.map`),
      16 * 1024 * 1024,
    );
    if (sha256(bytes) !== output.map.sha256) refuse('MAP_DIGEST');
    try {
      const map = JSON.parse(bytes.toString('utf8'));
      entry = {
        sources: map.sources,
        lines: decodeMappings(map.mappings, {
          sources: map.sources.length,
          names: map.names.length,
        }),
      };
    } catch (error) {
      if (error instanceof SourceMapError || error instanceof SyntaxError) refuse('MAP_DECODE');
      throw error;
    }
    decoded.set(output.path, entry);
    return entry;
  };
  const reached = [];
  for (const frame of frames) {
    if (frame.async || frame.file === null || !frame.file.startsWith('file:')) continue;
    let path;
    try {
      path = realpathSync.native(fileURLToPath(frame.file));
    } catch {
      refuse('FRAME_FILE');
    }
    // Frames outside the finalized dist (the preload, yaml, commander) carry no anchor.
    if (dirname(path) !== dist) continue;
    const key = `dist/${basename(path)}`;
    const output = outputs.get(key);
    if (output === undefined) refuse('FRAME_FILE');
    const digest = sha256(readOrdinaryFile(path, 16 * 1024 * 1024));
    if (digest !== output.sha256 || packed.get(`package/${key}`) !== digest) refuse('FRAME_FILE');
    const { sources, lines } = mapsOf(output);
    const segment = segmentAt(lines, frame.line - 1, frame.column - 1);
    if (segment?.source === undefined) continue;
    reached.push({
      source: sources[segment.source],
      line: (segment.originalLine ?? 0) + 1,
      column: (segment.originalColumn ?? 0) + 1,
    });
  }
  for (const anchor of anchors) {
    const expected = anchorPosition(ts, texts.get(anchor.source), anchor);
    if (
      !reached.some(
        (frame) =>
          frame.source === anchor.source &&
          frame.line === expected.line &&
          frame.column === expected.column,
      )
    ) {
      refuse('ANCHOR_UNMAPPED');
    }
  }
  return { anchors: anchors.length };
}
