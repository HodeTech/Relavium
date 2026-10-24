/**
 * Candidate finalizer (ADR-0111, Steps 9a.1 and 9a.2a). It runs inside the CLI's prepack after the
 * sole candidate tsup build and before pnpm packs. It accounts for every emitted output, validates
 * every consumed upstream TypeScript map and every final map — decoding their mappings strictly and
 * keeping every position inside its generated and original text (source-map.mjs) — rewrites final
 * map sources to repository-relative original TypeScript, removes only tsup's exact terminal map-link
 * trailers, stages the maps and the build metadata owner-only outside the package, re-checks the
 * finite closure and the public file/mode inventory, and only then hashes. Nothing writes JS
 * afterwards.
 *
 * Refusals name a fixed code and at most a fixed label or a repository-relative path that has passed
 * validation, never map or source contents and never a host path: a metafile string that escapes
 * the repository or is not a plain path is left out. A successful bundle is no evidence by itself: a
 * missing upstream map makes the bundler silently map engine frames to compiled JS, so every source
 * set is checked explicitly.
 */
import { Buffer } from 'node:buffer';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, isAbsolute, join, posix } from 'node:path';
import { TextDecoder, isDeepStrictEqual } from 'node:util';
import { checkBundleClosure } from '../bundle-closure/closure.mjs';
import { MODE_EVIDENCE, emittedInventory } from '../bundle-closure/inventory.mjs';
import { flatFiles, readOrdinaryFile, sha256 } from './files.mjs';
import { within } from './paths.mjs';
import {
  SourceMapError,
  assertGeneratedRange,
  assertOriginalRange,
  decodeMappings,
  lineLengths,
} from './source-map.mjs';

/**
 * Names the private staging directory of a trusted candidate build. Only the package producer sets
 * it; its presence alone selects candidate maps in the CLI build and the finalizer in prepack.
 */
export const CANDIDATE_STAGING_ENV = 'RELAVIUM_CLI_CANDIDATE_STAGING';

/** The inlined engine packages, in their dependency build order. */
export const ENGINE_PACKAGES = Object.freeze(['shared', 'llm', 'core', 'db', 'mcp']);
const LIMITS = Object.freeze({
  metafileBytes: 4 * 1024 * 1024,
  jsBytes: 8 * 1024 * 1024,
  upstreamMapBytes: 4 * 1024 * 1024,
  finalMapBytes: 16 * 1024 * 1024,
  outputs: 256,
  sourcesPerMap: 4096,
  namesPerMap: 1_000_000,
});
const SOURCE_TAIL = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.tsx?$/u;
const MAPPINGS = /^[A-Za-z0-9+/,;]*$/u;
const PLAIN_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u;

export class CandidateFinalizationError extends Error {
  /** @param {string} code @param {string} [subject] a fixed label or a validated repository-relative path */
  constructor(code, subject) {
    super(
      `CLI candidate finalization refused: ${code}` +
        (subject === undefined ? '' : ` (${subject})`),
    );
    this.name = 'CandidateFinalizationError';
    this.code = code;
  }
}

/** @param {string} code @param {string} [subject] @returns {never} */
function refuse(code, subject) {
  throw new CandidateFinalizationError(code, subject);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The map-link trailer tsc and tsup write for an external map beside its JS file. */
export const mapTrailer = (/** @type {string} */ jsName) => `//# sourceMappingURL=${jsName}.map`;

/** @param {string} root @param {string} path repository-relative POSIX path */
function onDisk(root, path) {
  return join(root, ...path.split('/'));
}

/** @param {string} path @param {number} limit @param {string} subject */
function readBytes(path, limit, subject) {
  try {
    return readOrdinaryFile(path, limit);
  } catch {
    refuse('UNREADABLE_FILE', subject);
  }
}

/** @param {Uint8Array} bytes @param {string} subject */
function parseJson(bytes, subject) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    refuse('MALFORMED_JSON', subject);
  }
}

/** @param {string} path @param {number} limit @param {string} subject */
function readJson(path, limit, subject) {
  return parseJson(readBytes(path, limit, subject), subject);
}

/** @param {string} path @param {string} subject */
function readText(path, subject) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      readOrdinaryFile(path, LIMITS.jsBytes),
    );
  } catch {
    refuse('UNREADABLE_FILE', subject);
  }
}

/**
 * Resolve one map source against its map's repository-relative directory and admit only original
 * TypeScript inside `allowedRoots`. URLs, absolute or escaping paths and anything but a `.ts`/`.tsx`
 * source refuse — a JS source means the bundler fell back to compiled output.
 * @param {string} repository
 * @param {string} mapDirectory repository-relative POSIX directory of the map file
 * @param {unknown} source
 * @param {readonly string[]} allowedRoots repository-relative POSIX source roots
 * @param {string} subject
 */
function originalSource(repository, mapDirectory, source, allowedRoots, subject) {
  if (
    typeof source !== 'string' ||
    source.length === 0 ||
    source.length > 1024 ||
    /[\\%?#]/u.test(source) ||
    [...source].some((character) => (character.codePointAt(0) ?? 0) < 32) ||
    source.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)
  ) {
    refuse('MAP_SOURCE_PATH', subject);
  }
  const resolved = posix.normalize(posix.join(mapDirectory, source));
  const root = allowedRoots.find((candidate) => resolved.startsWith(`${candidate}/`));
  if (
    root === undefined ||
    resolved.endsWith('.d.ts') ||
    !SOURCE_TAIL.test(resolved.slice(root.length + 1))
  ) {
    refuse('MAP_SOURCE_NOT_ORIGINAL', subject);
  }
  let info;
  try {
    info = lstatSync(onDisk(repository, resolved));
  } catch {
    refuse('MAP_SOURCE_MISSING', subject);
  }
  if (!info.isFile()) refuse('MAP_SOURCE_MISSING', subject);
  return resolved;
}

/**
 * Decode a map's mappings strictly and require every generated position inside the text it was
 * generated for and every original position inside its source: a well-formed charset alone admits
 * truncated values, out-of-range indices and positions past a file's end, which the bundler would
 * otherwise drop or chain silently.
 * @param {string} repository
 * @param {{mappings: string, sources: unknown[], names: unknown[]}} map
 * @param {string} generated the generated text
 * @param {readonly string[]} sources repository-relative original sources, by index
 * @param {Map<string, number[]>} texts source line lengths, shared by every map of one run
 * @param {'UPSTREAM_MAP' | 'MAP'} kind @param {string} subject
 */
function checkMappings(repository, map, generated, sources, texts, kind, subject) {
  /** @param {() => void} check @param {string} code */
  const strictly = (check, code) => {
    try {
      check();
    } catch (error) {
      if (error instanceof SourceMapError) refuse(code, subject);
      throw error;
    }
  };
  let lines = [];
  strictly(() => {
    lines = decodeMappings(map.mappings, { sources: map.sources.length, names: map.names.length });
  }, `${kind}_MAPPINGS`);
  const originals = sources.map((source) => {
    let lengths = texts.get(source);
    if (lengths === undefined) {
      lengths = lineLengths(readText(onDisk(repository, source), source));
      texts.set(source, lengths);
    }
    return lengths;
  });
  strictly(() => {
    assertGeneratedRange(lines, lineLengths(generated));
    assertOriginalRange(lines, originals);
  }, `${kind}_RANGE`);
}

/**
 * Validate one consumed upstream (tsc) map. The JS must end with its exact trailer and the map must
 * name only this package's original TypeScript, without embedded sources or a source root. Its
 * mappings may be empty only for a module whose types all erase, which tsc emits as exactly
 * `export {};`.
 * @param {string} repository
 * @param {string} packageName
 * @param {string} jsPath repository-relative POSIX path of the consumed compiled JS
 * @param {Map<string, number[]>} texts source line lengths, shared by every map of one run
 */
function upstreamSources(repository, packageName, jsPath, texts) {
  const name = posix.basename(jsPath);
  const js = readText(onDisk(repository, jsPath), jsPath);
  if (!js.endsWith(mapTrailer(name)) || js.split('sourceMappingURL').length !== 2) {
    refuse('UPSTREAM_MAP_LINK', jsPath);
  }
  const mapPath = `${jsPath}.map`;
  let exists = false;
  try {
    exists = lstatSync(onDisk(repository, mapPath)).isFile();
  } catch {
    exists = false;
  }
  if (!exists) refuse('UPSTREAM_MAP_MISSING', jsPath);
  const map = readJson(onDisk(repository, mapPath), LIMITS.upstreamMapBytes, mapPath);
  if (
    !isRecord(map) ||
    !isDeepStrictEqual(Object.keys(map).sort(), [
      'file',
      'mappings',
      'names',
      'sourceRoot',
      'sources',
      'version',
    ]) ||
    map.version !== 3 ||
    map.file !== name ||
    map.sourceRoot !== '' ||
    typeof map.mappings !== 'string' ||
    !MAPPINGS.test(map.mappings) ||
    !Array.isArray(map.names) ||
    map.names.some((item) => typeof item !== 'string') ||
    !Array.isArray(map.sources) ||
    map.sources.length === 0 ||
    map.sources.length > LIMITS.sourcesPerMap
  ) {
    refuse('UPSTREAM_MAP_SHAPE', mapPath);
  }
  if (map.mappings === '' && js !== `export {};\n${mapTrailer(name)}`) {
    refuse('UPSTREAM_MAP_UNMAPPED', mapPath);
  }
  const directory = posix.dirname(jsPath);
  const sources = map.sources.map((source) =>
    originalSource(repository, directory, source, [`packages/${packageName}/src`], mapPath),
  );
  checkMappings(repository, map, js, sources, texts, 'UPSTREAM_MAP', mapPath);
  return sources;
}

/**
 * A metafile input (relative to apps/cli) as a refusal subject: its repository-relative path when
 * that is a plain path inside the repository, otherwise nothing.
 * @param {string} input
 */
function inputSubject(input) {
  if (input.startsWith('/')) return undefined;
  const path = posix.normalize(posix.join('apps/cli', input));
  return path.length <= 200 && PLAIN_PATH.test(path) ? path : undefined;
}

/**
 * Original TypeScript sources behind one metafile input: the CLI's own source directly, an engine
 * package's compiled JS through its tsc map. Any other input kind refuses.
 * @param {string} repository @param {string} input metafile input relative to apps/cli
 * @param {Map<string, string[]>} cache
 * @param {Map<string, number[]>} texts source line lengths, shared by every map of one run
 */
function inputSources(repository, input, cache, texts) {
  const cached = cache.get(input);
  if (cached) return cached;
  let sources;
  const engine = /^\.\.\/\.\.\/packages\/([a-z]+)\/dist\/(.+\.js)$/u.exec(input);
  if (input.startsWith('src/') && SOURCE_TAIL.test(input.slice(4)) && !input.endsWith('.d.ts')) {
    sources = [
      originalSource(repository, 'apps/cli', input, ['apps/cli/src'], `apps/cli/${input}`),
    ];
  } else if (
    engine &&
    ENGINE_PACKAGES.includes(engine[1]) &&
    /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/u.test(engine[2])
  ) {
    sources = upstreamSources(
      repository,
      engine[1],
      `packages/${engine[1]}/dist/${engine[2]}`,
      texts,
    );
  } else {
    refuse('UNSUPPORTED_INPUT', inputSubject(input));
  }
  cache.set(input, sources);
  return sources;
}

/**
 * Validate one final map against the original sources of the inputs that contributed bytes to its
 * runtime output, and return it with repository-relative sources. Mappings and names are kept.
 * @param {string} repository @param {string} jsName @param {unknown} map @param {Set<string>} expected
 * @param {string} code the runtime output without its map-link trailer
 * @param {Map<string, number[]>} texts source line lengths, shared by every map of one run
 */
function finalMap(repository, jsName, map, expected, code, texts) {
  const subject = `apps/cli/dist/${jsName}.map`;
  const keys = isRecord(map) ? Object.keys(map) : [];
  if (
    !isRecord(map) ||
    !['mappings', 'names', 'sources', 'version'].every((key) => keys.includes(key)) ||
    keys.some(
      (key) => !['file', 'mappings', 'names', 'sourceRoot', 'sources', 'version'].includes(key),
    )
  ) {
    // sourcesContent, an index map's sections or any unreviewed field refuses.
    refuse(isRecord(map) && 'sourcesContent' in map ? 'EMBEDDED_SOURCES' : 'MAP_SHAPE', subject);
  }
  if (
    map.version !== 3 ||
    (map.file !== undefined && map.file !== jsName) ||
    (map.sourceRoot !== undefined && map.sourceRoot !== '') ||
    typeof map.mappings !== 'string' ||
    !MAPPINGS.test(map.mappings) ||
    !Array.isArray(map.names) ||
    map.names.length > LIMITS.namesPerMap ||
    map.names.some((item) => typeof item !== 'string') ||
    !Array.isArray(map.sources) ||
    map.sources.length > LIMITS.sourcesPerMap ||
    // A code-splitting facade that only re-exports other chunks has no contributing input and an
    // empty map; any output with contributing inputs must map them.
    (expected.size === 0
      ? map.sources.length !== 0 || map.mappings !== '' || map.names.length !== 0
      : map.mappings.length === 0)
  ) {
    refuse('MAP_SHAPE', subject);
  }
  const sources = map.sources.map((source) =>
    originalSource(
      repository,
      'apps/cli/dist',
      source,
      ['apps/cli/src', ...ENGINE_PACKAGES.map((name) => `packages/${name}/src`)],
      subject,
    ),
  );
  if (new Set(sources).size !== sources.length) refuse('MAP_SOURCE_DUPLICATE', subject);
  if (!isDeepStrictEqual([...sources].sort(), [...expected].sort())) {
    refuse('MAP_SOURCE_COVERAGE', subject);
  }
  checkMappings(repository, map, code, sources, texts, 'MAP', subject);
  return { ...map, sources };
}

/**
 * A private staging directory must be absolute and canonical (no link in its path and the letter case
 * the filesystem stores, `realpathSync.native`), empty, an ordinary directory outside the candidate
 * repository and, where POSIX modes are observable, owner-only and owned by this process. The
 * repository is compared by its native real path too, so no alias of either side (a link or, on a
 * case-insensitive filesystem, another letter case) lets staging sit inside the candidate.
 * @param {string} staging @param {string} repository
 */
export function assertPrivateStaging(staging, repository) {
  if (typeof staging !== 'string' || !isAbsolute(staging)) refuse('STAGING_PATH');
  let info;
  let real;
  let root;
  try {
    info = lstatSync(staging);
    real = realpathSync.native(staging);
    root = realpathSync.native(repository);
  } catch {
    refuse('STAGING_PATH');
  }
  if (
    !info.isDirectory() ||
    real !== staging ||
    within(root, real) ||
    within(real, root) ||
    within(repository, staging)
  ) {
    refuse('STAGING_PATH');
  }
  if (readdirSync(staging).length !== 0) refuse('STAGING_NOT_EMPTY');
  if (
    MODE_EVIDENCE === 'posix' &&
    ((info.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()))
  ) {
    refuse('STAGING_NOT_PRIVATE');
  }
}

/** Create a new file with an exact mode (independent of the umask) and flush its bytes. */
function writeNew(path, bytes, mode) {
  const descriptor = openSync(path, 'wx', mode);
  try {
    if (MODE_EVIDENCE === 'posix') fchmodSync(descriptor, mode);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Write bytes to a new owner-only staging file; an existing file refuses. */
export function writePrivateFile(path, bytes) {
  writeNew(path, bytes, 0o600);
}

/** Replace one runtime output in place without moving any executable line or column. */
function replaceOutput(path, bytes, mode) {
  const temporary = `${path}.finalizing`;
  writeNew(temporary, bytes, mode);
  renameSync(temporary, path);
}

/**
 * Finalize the candidate CLI build in `<repository>/apps/cli` into `staging`.
 * @param {{repository: string, staging: string}} options absolute candidate root and private staging
 * @returns {{outputs: {path: string, bytes: number, sha256: string}[], maps: {path: string, bytes: number, sha256: string}[], upstreamMaps: number}}
 * @throws {CandidateFinalizationError} for any unaccounted, unchained or malformed output.
 */
export function finalizeCandidate({ repository, staging }) {
  assertPrivateStaging(staging, repository);
  const cli = join(repository, 'apps', 'cli');
  const dist = join(cli, 'dist');
  const metafileBytes = readBytes(
    join(dist, 'metafile-esm.json'),
    LIMITS.metafileBytes,
    'metafile',
  );
  const metafile = parseJson(metafileBytes, 'metafile');
  if (!isRecord(metafile) || !isRecord(metafile.outputs) || !isRecord(metafile.inputs)) {
    refuse('METAFILE_SHAPE');
  }

  // 1. Every emitted file is a paired JS output and map, or the metafile. Nothing else.
  const runtime = Object.keys(metafile.outputs).filter((path) => !path.endsWith('.map'));
  if (runtime.length === 0 || runtime.length > LIMITS.outputs) refuse('OUTPUT_INVENTORY');
  const expectedEntries = ['metafile-esm.json'];
  for (const path of runtime) {
    if (!/^dist\/[A-Za-z0-9_-]+\.js$/u.test(path)) refuse('OUTPUT_INVENTORY');
    if (!Object.hasOwn(metafile.outputs, `${path}.map`)) refuse('MAP_PAIRING', `apps/cli/${path}`);
    expectedEntries.push(basename(path), `${basename(path)}.map`);
  }
  if (Object.keys(metafile.outputs).length !== runtime.length * 2) refuse('MAP_PAIRING');
  const entries = readdirSync(dist, { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile()) ||
    !isDeepStrictEqual(entries.map((entry) => entry.name).sort(), expectedEntries.sort())
  ) {
    refuse('OUTPUT_INVENTORY');
  }

  // 2. Validate every consumed upstream map and every final map, and strip each exact trailer.
  //    No file is written until every output has been accepted.
  const cache = new Map();
  const texts = new Map();
  for (const input of Object.keys(metafile.inputs)) inputSources(repository, input, cache, texts);
  const prepared = runtime.map((path) => {
    const jsName = basename(path);
    const output = metafile.outputs[path];
    if (!isRecord(output) || !isRecord(output.inputs) || !Number.isSafeInteger(output.bytes)) {
      refuse('METAFILE_SHAPE', `apps/cli/${path}`);
    }
    const js = readText(join(dist, jsName), `apps/cli/${path}`);
    const trailer = mapTrailer(jsName);
    if (!js.endsWith(trailer) || js.split('sourceMappingURL').length !== 2) {
      refuse('FINAL_MAP_LINK', `apps/cli/${path}`);
    }
    const code = Buffer.from(js.slice(0, -trailer.length), 'utf8');
    // tsup appends the trailer after esbuild records the output size, so only the trailer may differ.
    if (code.length !== output.bytes) refuse('TRAILER_BYTES', `apps/cli/${path}`);
    const expected = new Set();
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (!isRecord(contribution) || !Number.isSafeInteger(contribution.bytesInOutput)) {
        refuse('METAFILE_SHAPE', `apps/cli/${path}`);
      }
      if (contribution.bytesInOutput === 0) continue;
      const sources = cache.get(input);
      if (!sources) refuse('UNSUPPORTED_INPUT', inputSubject(input));
      for (const source of sources) expected.add(source);
    }
    const map = finalMap(
      repository,
      jsName,
      readJson(join(dist, `${jsName}.map`), LIMITS.finalMapBytes, `apps/cli/${path}.map`),
      expected,
      js.slice(0, -trailer.length),
      texts,
    );
    const mode = lstatSync(join(dist, jsName)).mode & 0o777;
    return { path, jsName, code, map: Buffer.from(JSON.stringify(map), 'utf8'), mode };
  });

  // 3. Stage maps and build metadata owner-only outside the package, then finalize the JS.
  mkdirSync(join(staging, 'maps'), { mode: 0o700 });
  // The creation mode passes through the umask; the staged directory keeps the exact owner-only mode.
  if (MODE_EVIDENCE === 'posix') chmodSync(join(staging, 'maps'), 0o700);
  for (const item of prepared)
    writePrivateFile(join(staging, 'maps', `${item.jsName}.map`), item.map);
  writePrivateFile(join(staging, 'metafile-esm.json'), metafileBytes);
  for (const item of prepared) replaceOutput(join(dist, item.jsName), item.code, item.mode);
  for (const item of prepared) unlinkSync(join(dist, `${item.jsName}.map`));
  unlinkSync(join(dist, 'metafile-esm.json'));

  // 4. Re-check the finite closure and the public inventory on the finalized files, then hash.
  const manifest = readJson(join(cli, 'package.json'), 128 * 1024, 'apps/cli/package.json');
  checkBundleClosure({
    metafile,
    manifest,
    files: emittedInventory(cli),
    modeEvidence: MODE_EVIDENCE,
    maps: 'staged',
  });
  if (
    !isDeepStrictEqual(
      [...flatFiles(join(cli, 'drizzle'), 'package/drizzle')],
      [...flatFiles(join(repository, 'packages', 'db', 'drizzle'), 'package/drizzle')],
    )
  ) {
    refuse('MIGRATION_COPY');
  }
  const outputs = prepared.map((item) => {
    const bytes = readOrdinaryFile(join(dist, item.jsName), LIMITS.jsBytes);
    if (!bytes.equals(item.code)) refuse('OUTPUT_CHANGED', `apps/cli/${item.path}`);
    return { path: item.path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const maps = prepared.map((item) => ({
    path: `${item.path}.map`,
    bytes: item.map.length,
    sha256: sha256(item.map),
  }));
  const upstreamMaps = [...cache.keys()].filter((input) => !input.startsWith('src/')).length;
  const record = { version: 1, outputs, maps, upstreamMaps };
  writePrivateFile(
    join(staging, 'finalized.json'),
    Buffer.from(JSON.stringify(record, null, 2) + '\n'),
  );
  return record;
}
