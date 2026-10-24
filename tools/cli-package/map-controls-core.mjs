/**
 * Product map controls (ADR-0111; packaging.md "Product map controls and the package-test receipt —
 * Step 9a.2b"; the 2026-10-24 preflight rulings), run by map-controls.mjs. One real package-test
 * production runs at the checked-out commit. Inside its seal, after the baseline receipt and while the
 * private staging still exists, every named negative control corrupts one product copy — the
 * producer's own owned candidate tree, or a re-recorded copy of its private staging — and requires that
 * control's exact refusal; each corrupted file is restored and checked by digest (dist itself is
 * replaced by the next build), and a restoration
 * production must then seal again. Staging copies stay under the staging, which the producer removes
 * first on success, failure and interrupt; a refused control build's `dist`, which holds the bundler's
 * maps, is removed at once. The developer's checkout is read, never written (Git may refresh its own
 * index's stat cache). The summary carries control ids, expected and observed codes and prepack's fixed
 * lines with their repository-relative subjects — never an absolute path, frame, position, map byte or
 * raw child output.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { originFromEnvironment } from './binding.mjs';
import { sourceIdentity } from './candidate.mjs';
import { CANDIDATE_STAGING_ENV } from './finalize.mjs';
import { readOrdinaryFile, sha256 } from './files.mjs';
import { readPrivateManifest, sealPrivateManifest, verifySealedDist } from './manifest.mjs';
import { emitFreshPackage } from './pipeline.mjs';
import { producePackage } from './produce.mjs';
import { productionFailure } from './production-failure.mjs';
import { sealPackage } from './seal.mjs';
import {
  assertGeneratedRange,
  assertOriginalRange,
  decodeMappings,
  lineLengths,
} from './source-map.mjs';
import { ANCHORS, symbolicateCandidate } from './symbolicate.mjs';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MIB = 1024 * 1024;

/** Base64 VLQ of one signed value, as a source map writer encodes it. */
function vlq(value) {
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let out = '';
  do {
    let digit = rest % 32;
    rest = Math.floor(rest / 32);
    if (rest > 0) digit += 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

/**
 * Encode decoded segments (as `decodeMappings` returns them) back into `mappings`.
 * @param {import('./source-map.mjs').Segment[][]} lines
 */
export function encodeMappings(lines) {
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let name = 0;
  return lines
    .map((segments) => {
      let column = 0;
      return segments
        .map((segment) => {
          let out = vlq(segment.generatedColumn - column);
          column = segment.generatedColumn;
          if (segment.source !== undefined) {
            out +=
              vlq(segment.source - source) +
              vlq(segment.originalLine - originalLine) +
              vlq(segment.originalColumn - originalColumn);
            source = segment.source;
            originalLine = segment.originalLine;
            originalColumn = segment.originalColumn;
            if (segment.name !== undefined) {
              out += vlq(segment.name - name);
              name = segment.name;
            }
          }
          return out;
        })
        .join(',');
    })
    .join(';');
}

/**
 * A map shifted while staying valid: every original column after a line's start moves one to the left,
 * so every position stays inside its text and only symbolication can tell.
 * @param {string} mappings @param {{sources: number, names: number}} counts
 */
export function shiftOriginalColumns(mappings, counts) {
  const lines = decodeMappings(mappings, counts);
  let moved = 0;
  for (const segments of lines) {
    for (const segment of segments) {
      if (segment.originalColumn !== undefined && segment.originalColumn > 0) {
        segment.originalColumn -= 1;
        moved += 1;
      }
    }
  }
  assert.ok(moved > 0, 'PACKED_CLI_MAP_CONTROL_NOTHING_SHIFTED');
  return encodeMappings(lines);
}

/** Sources rotated by one: with two or more distinct sources, no source keeps its index. */
export function rotateSources(sources) {
  assert.ok(
    sources.length >= 2 && new Set(sources).size === sources.length,
    'PACKED_CLI_MAP_CONTROL_SOURCES',
  );
  return [...sources.slice(1), sources[0]];
}

/** The JS one line down: a line break after the hashbang line, or at the start. */
export function shiftLines(text) {
  if (!text.startsWith('#!')) return `\n${text}`;
  const end = text.indexOf('\n');
  assert.ok(end > 0, 'PACKED_CLI_MAP_CONTROL_HASHBANG');
  return `${text.slice(0, end + 1)}\n${text.slice(end + 1)}`;
}

/** The JS one column right: a space before every line but a hashbang line. */
export function shiftColumns(text) {
  return text
    .split('\n')
    .map((line, index) => (index === 0 && line.startsWith('#!') ? line : ` ${line}`))
    .join('\n');
}

/** `mappings` cut right after the first continuation digit, so the value it starts never ends. */
export function cutInsideValue(mappings) {
  for (let index = 0; index < mappings.length; index += 1) {
    if (BASE64.indexOf(mappings[index]) >= 32) return mappings.slice(0, index + 1);
  }
  assert.fail('PACKED_CLI_MAP_CONTROL_NO_CONTINUATION');
}

/** An owner-only directory, created fresh. */
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** The refusal of `action`: its code, its prepack diagnostics and how many times stdout says each marker. */
async function refusal(action) {
  try {
    await action();
  } catch (error) {
    const lines = productionFailure(error);
    const stdout = typeof error?.result?.stdout === 'string' ? error.result.stdout : '';
    return {
      code: /: ([A-Z0-9_]+)$/u.exec(lines.at(-1))?.[1] ?? 'UNEXPECTED',
      diagnostics: lines.slice(0, -1),
      builds: (stdout.match(/\bESM Build start\b/gu) ?? []).length,
      finalized: (stdout.match(/^✓ CLI candidate finalized: /gmu) ?? []).length,
    };
  }
  return { code: 'ACCEPTED', diagnostics: [], builds: 0, finalized: 0 };
}

/** A file's bytes and mode, to restore it exactly. */
function snapshot(path) {
  const bytes = readOrdinaryFile(path, 16 * MIB);
  return { path, bytes, sha256: sha256(bytes), mode: lstatSync(path).mode & 0o777 };
}

/** Put a snapshot back and prove it is byte for byte the original. */
function restore(saved) {
  rmSync(saved.path, { force: true });
  writeFileSync(saved.path, saved.bytes, { mode: saved.mode, flag: 'wx' });
  chmodSync(saved.path, saved.mode);
  assert.equal(
    sha256(readOrdinaryFile(saved.path, 16 * MIB)),
    saved.sha256,
    'PACKED_CLI_MAP_CONTROL_RESTORE',
  );
}

/** SHA-256 of every file in a directory, by name; a directory listed as such. */
function inventory(directory, skip = new Set()) {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true, recursive: true })
      .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
      .filter((path) => ![...skip].some((name) => path.startsWith(join(directory, name))))
      .sort()
      .map((path) => [
        path.slice(directory.length),
        lstatSync(path).isFile() ? sha256(readOrdinaryFile(path, 32 * MIB)) : 'directory',
      ]),
  );
}

/**
 * Run every control inside the baseline seal, recording into `state` as it goes, so a run that stops
 * early still reports what ran. `context` holds the seal's own inputs, its receipt, the baseline
 * artifact directory and the emitter's isolated environment and pnpm.
 * @param {{results: {id: string, expected: string, observed: string}[], chunks: number}} state
 */
async function runControls(context, state) {
  const { candidate, staging, checkout, source, dirty, receipt, artifact, env, pnpm } = context;
  const record = (id, expected, observed) => state.results.push({ id, expected, observed });
  const controls = privateDirectory(join(staging, 'controls'));
  let count = 0;
  const scratch = (id) =>
    privateDirectory(join(controls, `${String((count += 1)).padStart(2, '0')}-${id}`));
  const cli = join(candidate, 'apps', 'cli');
  const tarball = join(artifact, receipt.tarball);
  const sealed = readPrivateManifest(staging);
  // The dist's digests, or null once a broken refusal let a build replace or remove it.
  const distDigests = () => {
    try {
      return inventory(join(cli, 'dist'));
    } catch {
      return null;
    }
  };

  // The chunks the anchors' sources lie in, by their staged maps; the anchor sources' upstream map.
  const anchorSources = new Set(ANCHORS.map((anchor) => anchor.source));
  const mapsOf = (name) =>
    JSON.parse(readOrdinaryFile(join(staging, 'maps', name), 16 * MIB).toString('utf8'));
  const chunks = readdirSync(join(staging, 'maps'))
    .filter((name) => mapsOf(name).sources.some((path) => anchorSources.has(path)))
    .map((name) => name.slice(0, -'.map'.length))
    .sort();
  assert.ok(chunks.length > 0, 'PACKED_CLI_MAP_CONTROL_NO_ANCHOR_CHUNK');
  state.chunks = chunks.length;
  const plain = sealed.outputs
    .map((output) => basename(output.path))
    .filter((name) => !chunks.includes(name))
    .sort();

  const sealedRecord = JSON.parse(
    readOrdinaryFile(join(staging, 'finalized.json'), MIB).toString('utf8'),
  );
  const sealedDigests = new Map(
    [...sealedRecord.outputs, ...sealedRecord.maps].map((entry) => [entry.path, entry.sha256]),
  );

  /**
   * A copy of the sealed staging re-recorded for the candidate as it now is, then symbolicated. The
   * copy must differ from the sealed record in exactly the `changed` outputs and maps, so a control
   * corrupts the chunk it names and nothing else.
   */
  const resealed = async (id, { forceDirty = dirty, changeMap, changed = [] } = {}) => {
    const root = scratch(id);
    const copy = privateDirectory(join(root, 'staging'));
    privateDirectory(join(copy, 'maps'));
    const finalized = JSON.parse(
      readOrdinaryFile(join(staging, 'finalized.json'), MIB).toString('utf8'),
    );
    finalized.maps = finalized.maps.map((entry) => {
      const name = basename(entry.path);
      let bytes = readOrdinaryFile(join(staging, 'maps', name), 16 * MIB);
      if (changeMap !== undefined && name === `${changeMap.chunk}.map`) {
        bytes = Buffer.from(JSON.stringify(changeMap.change(JSON.parse(bytes.toString('utf8')))));
      }
      writeFileSync(join(copy, 'maps', name), bytes, { mode: 0o600, flag: 'wx' });
      return { path: entry.path, bytes: bytes.length, sha256: sha256(bytes) };
    });
    finalized.outputs = finalized.outputs.map((entry) => {
      const bytes = readOrdinaryFile(join(cli, ...entry.path.split('/')), 8 * MIB);
      return { path: entry.path, bytes: bytes.length, sha256: sha256(bytes) };
    });
    assert.deepEqual(
      [...finalized.outputs, ...finalized.maps]
        .filter((entry) => sealedDigests.get(entry.path) !== entry.sha256)
        .map((entry) => entry.path)
        .sort(),
      [...changed].sort(),
      'PACKED_CLI_MAP_CONTROL_TARGET',
    );
    writeFileSync(join(copy, 'finalized.json'), JSON.stringify(finalized), {
      mode: 0o600,
      flag: 'wx',
    });
    const digests = new Map(
      finalized.outputs.map((output) => [`package/${output.path}`, output.sha256]),
    );
    const archive = {
      sha256: receipt.tarballSha256,
      package: receipt.package,
      files: receipt.files.map((file) =>
        digests.has(file.path) ? { ...file, sha256: digests.get(file.path) } : file,
      ),
    };
    await sealPrivateManifest({
      candidate,
      staging: copy,
      checkout,
      source,
      dirty: forceDirty,
      archive,
    });
    const work = privateDirectory(join(root, 'work'));
    return refusal(() =>
      symbolicateCandidate({ candidate, staging: copy, checkout, work, archive }),
    );
  };

  /** One pack of the candidate as it now is, into a fresh staging and artifact directory. */
  const pack = async (id, stagingOverride) => {
    const root = scratch(id);
    const destination = privateDirectory(join(root, 'artifact'));
    const fresh = stagingOverride ?? privateDirectory(join(root, 'staging'));
    const observed = await refusal(() =>
      pnpm(['pack', '--pack-destination', destination], {
        cwd: cli,
        env: { ...env, [CANDIDATE_STAGING_ENV]: fresh },
      }),
    );
    // A refused build left the bundler's own maps in dist: none outlives the control. A refusal before
    // any build (a second prepack into a sealed staging) leaves the sealed dist as it is.
    if (observed.code !== 'ACCEPTED' && observed.builds > 0) {
      rmSync(join(cli, 'dist'), { recursive: true, force: true });
    }
    return { observed, destination, staging: fresh, root };
  };

  /** Seal a fresh pack's tarball with fresh work, as the producer would. */
  const seal = (packed) =>
    refusal(() =>
      sealPackage(packed.destination, {
        repository: candidate,
        staging: packed.staging,
        source,
        dirty,
        checkout,
        work: privateDirectory(join(packed.root, 'work')),
      }),
    );

  // Post-receipt rebuild refusals that need the sealed state come first.
  {
    // A second prepack into the sealed staging refuses before any build, changing nothing.
    const before = { dist: distDigests(), staging: inventory(staging, new Set(['controls'])) };
    const second = await pack('second-prepack', staging);
    const unchanged =
      JSON.stringify(distDigests()) === JSON.stringify(before.dist) &&
      JSON.stringify(inventory(staging, new Set(['controls']))) ===
        JSON.stringify(before.staging) &&
      readdirSync(second.destination).length === 0 &&
      second.observed.builds === 0;
    record(
      'second-prepack',
      'STAGING_NOT_EMPTY',
      unchanged &&
        second.observed.diagnostics.length === 1 &&
        second.observed.diagnostics[0] === '✗ CLI candidate finalization refused: STAGING_NOT_EMPTY'
        ? 'STAGING_NOT_EMPTY'
        : `MARKERS_${second.observed.code}`,
    );
  }
  {
    // A re-seal into the artifact directory, or of the sealed staging beside a copied tarball, refuses
    // before any capture runs.
    const receiptDigest = sha256(
      readOrdinaryFile(join(artifact, 'package-test-receipt.json'), MIB),
    );
    const root = scratch('re-seal');
    const works = [privateDirectory(join(root, 'work-1')), privateDirectory(join(root, 'work-2'))];
    // The receipt half alone: a copy of the sealed staging without its manifest.
    const unsealed = privateDirectory(join(root, 'unsealed'));
    cpSync(join(staging, 'maps'), join(unsealed, 'maps'), { recursive: true });
    for (const name of ['finalized.json', 'metafile-esm.json']) {
      cpSync(join(staging, name), join(unsealed, name));
    }
    const again = await refusal(() =>
      sealPackage(artifact, {
        repository: candidate,
        staging: unsealed,
        source,
        dirty,
        checkout,
        work: works[0],
      }),
    );
    // The staging half alone: the tarball copied without its receipt, beside the sealed staging.
    const copied = privateDirectory(join(root, 'artifact'));
    cpSync(tarball, join(copied, receipt.tarball));
    const beside = await refusal(() =>
      sealPackage(copied, {
        repository: candidate,
        staging,
        source,
        dirty,
        checkout,
        work: works[1],
      }),
    );
    const quiet =
      works.every((work) => readdirSync(work).length === 0) &&
      !existsSync(join(unsealed, 'manifest.json')) &&
      !existsSync(join(copied, 'package-test-receipt.json')) &&
      sha256(readOrdinaryFile(join(artifact, 'package-test-receipt.json'), MIB)) === receiptDigest;
    record(
      're-seal-receipt',
      'PACKED_CLI_ALREADY_SEALED',
      quiet ? again.code : `MARKERS_${again.code}`,
    );
    record(
      're-seal-staging',
      'PACKED_CLI_ALREADY_SEALED',
      quiet ? beside.code : `MARKERS_${beside.code}`,
    );
  }

  // The re-recording technique alone refuses nothing: the unchanged copy reaches every anchor.
  record('re-recorded-baseline', 'ACCEPTED', (await resealed('re-recorded-baseline')).code);

  // Wrong JS by line and by column, a wrong map and permuted sources, on every anchor-bearing chunk.
  for (const [index, chunk] of chunks.entries()) {
    const path = join(cli, 'dist', chunk);
    for (const [kind, change] of [
      ['js-line', shiftLines],
      ['js-column', shiftColumns],
    ]) {
      const saved = snapshot(path);
      try {
        const text = saved.bytes.toString('utf8');
        const changedText = change(text);
        // One more line for a line shift, the same lines for a column shift.
        assert.ok(
          changedText !== text &&
            changedText.split('\n').length - text.split('\n').length ===
              (kind === 'js-line' ? 1 : 0),
          'PACKED_CLI_MAP_CONTROL_KIND',
        );
        writeFileSync(path, changedText);
        record(
          `${kind}-${index + 1}`,
          'PACKED_CLI_SYMBOLICATION_ANCHOR_UNMAPPED',
          (await resealed(kind, { changed: [`dist/${chunk}`] })).code,
        );
      } finally {
        restore(saved);
      }
    }
    record(
      `map-line-${index + 1}`,
      'PACKED_CLI_SYMBOLICATION_ANCHOR_UNMAPPED',
      (
        await resealed('map-line', {
          changeMap: { chunk, change: (map) => ({ ...map, mappings: `;${map.mappings}` }) },
          changed: [`dist/${chunk}.map`],
        })
      ).code,
    );
    record(
      `sources-rotated-${index + 1}`,
      'PACKED_CLI_SYMBOLICATION_ANCHOR_UNMAPPED',
      (
        await resealed('sources-rotated', {
          changeMap: { chunk, change: (map) => ({ ...map, sources: rotateSources(map.sources) }) },
          changed: [`dist/${chunk}.map`],
        })
      ).code,
    );
  }

  // A wrong source revision: clean, the Git object refuses the copy; dirty, the anchor positions move.
  {
    const saved = snapshot(join(candidate, ...ANCHORS[1].source.split('/')));
    try {
      writeFileSync(saved.path, `// shifted\n${saved.bytes.toString('utf8')}`);
      record(
        'source-clean',
        'PACKED_CLI_SYMBOLICATION_SOURCE_REVISION',
        (await resealed('source-clean', { forceDirty: false })).code,
      );
      record(
        'source-dirty',
        'PACKED_CLI_SYMBOLICATION_ANCHOR_UNMAPPED',
        (await resealed('source-dirty', { forceDirty: true })).code,
      );
    } finally {
      restore(saved);
    }
  }

  // A rebuilt dist that differs from the manifest: the sealed state verifies; a changed chunk whose map
  // names no anchor source, and a real rebuild from a changed source, refuse.
  record(
    'sealed-dist',
    'ACCEPTED',
    (await refusal(() => verifySealedDist({ candidate, manifest: sealed, tarball }))).code,
  );
  if (plain.length === 0)
    record('dist-plain-chunk', 'PACKED_CLI_MANIFEST_DIST_DRIFT', 'NO_PLAIN_CHUNK');
  else {
    const saved = snapshot(join(cli, 'dist', plain[0]));
    try {
      writeFileSync(saved.path, Buffer.concat([saved.bytes, Buffer.from(' ')]));
      record(
        'dist-plain-chunk',
        'PACKED_CLI_MANIFEST_DIST_DRIFT',
        (await refusal(() => verifySealedDist({ candidate, manifest: sealed, tarball }))).code,
      );
    } finally {
      restore(saved);
    }
  }
  const entry = snapshot(join(cli, 'src', 'index.ts'));
  try {
    writeFileSync(
      entry.path,
      `${entry.bytes.toString('utf8')}\nglobalThis.relaviumMapControls = 1;\n`,
    );
    const rebuilt = await pack('rebuild');
    const changed = sealed.outputs.some((output) => {
      try {
        return (
          sha256(readOrdinaryFile(join(cli, ...output.path.split('/')), 8 * MIB)) !== output.sha256
        );
      } catch {
        return true;
      }
    });
    const verified = await refusal(() =>
      verifySealedDist({ candidate, manifest: sealed, tarball }),
    );
    record(
      'dist-rebuilt',
      'PACKED_CLI_MANIFEST_DIST_DRIFT',
      rebuilt.observed.code === 'ACCEPTED' && changed
        ? verified.code
        : `MARKERS_${rebuilt.observed.code}`,
    );
  } finally {
    restore(entry);
  }

  // Upstream maps: a missing, a malformed and a value-truncated map refuse in the finalizer after the
  // bundler silently succeeded; a byte-truncated map fails the build; a shifted but valid map is
  // accepted there and refused by symbolication.
  const upstream = ANCHORS[0].source
    .replace(/^packages\/core\/src\//u, 'packages/core/dist/')
    .replace(/\.ts$/u, '.js');
  const upstreamMap = join(candidate, ...`${upstream}.map`.split('/'));
  const saved = snapshot(upstreamMap);
  const original = JSON.parse(saved.bytes.toString('utf8'));
  const refusedLine = (code, subject) =>
    `✗ CLI candidate finalization refused: ${code} (${subject})`;
  for (const [id, corrupt, expected] of [
    ['upstream-missing', () => rmSync(upstreamMap), refusedLine('UPSTREAM_MAP_MISSING', upstream)],
    [
      'upstream-shape',
      () => writeFileSync(upstreamMap, JSON.stringify({ ...original, sourcesContent: [null] })),
      refusedLine('UPSTREAM_MAP_SHAPE', `${upstream}.map`),
    ],
    [
      'upstream-index',
      () =>
        writeFileSync(
          upstreamMap,
          JSON.stringify({ ...original, mappings: `A${vlq(original.sources.length)}AA` }),
        ),
      refusedLine('UPSTREAM_MAP_MAPPINGS', `${upstream}.map`),
    ],
    [
      // A map that is no longer JSON fails the bundler's own build, before the finalizer reads it.
      'upstream-cut-bytes',
      () => writeFileSync(upstreamMap, saved.bytes.subarray(0, Math.floor(saved.bytes.length / 2))),
      '✗ CLI build failed',
    ],
    [
      'upstream-cut-value',
      () =>
        writeFileSync(
          upstreamMap,
          JSON.stringify({ ...original, mappings: cutInsideValue(original.mappings) }),
        ),
      refusedLine('UPSTREAM_MAP_MAPPINGS', `${upstream}.map`),
    ],
  ]) {
    try {
      corrupt();
      const packed = await pack(id);
      // The bundler silently succeeded once, nothing was finalized, staged or packed, and the one
      // prepack diagnostic is the expected fixed line.
      const markers = [
        packed.observed.builds,
        packed.observed.finalized,
        readdirSync(packed.staging).length,
        readdirSync(packed.destination).length,
        packed.observed.diagnostics.length,
      ];
      const line = packed.observed.diagnostics.at(-1);
      record(
        id,
        expected,
        markers.join() === '1,0,0,0,1' && line === expected
          ? expected
          : `MARKERS(${markers.join()}) ${line ?? packed.observed.code}`,
      );
    } finally {
      restore(saved);
    }
  }
  try {
    const mappings = shiftOriginalColumns(original.mappings, {
      sources: original.sources.length,
      names: original.names.length,
    });
    // The shift is strictly valid: the finalizer's own checks admit it.
    const lines = decodeMappings(mappings, {
      sources: original.sources.length,
      names: original.names.length,
    });
    assertGeneratedRange(
      lines,
      lineLengths(
        readOrdinaryFile(join(candidate, ...upstream.split('/')), 16 * MIB).toString('utf8'),
      ),
    );
    assertOriginalRange(
      lines,
      original.sources.map((path) =>
        lineLengths(
          readOrdinaryFile(join(dirname(upstreamMap), ...path.split('/')), 16 * MIB).toString(
            'utf8',
          ),
        ),
      ),
    );
    writeFileSync(upstreamMap, JSON.stringify({ ...original, mappings }));
    const packed = await pack('upstream-shifted');
    const accepted = packed.observed.code === 'ACCEPTED';
    record(
      'upstream-shifted',
      'PACKED_CLI_SYMBOLICATION_ANCHOR_UNMAPPED',
      accepted ? (await seal(packed)).code : `MARKERS_${packed.observed.code}`,
    );
  } finally {
    restore(saved);
  }

  // The seal's own check: a dist the run changed after the inspection refuses before the receipt.
  {
    const packed = await pack('seal-verify');
    let observed = `MARKERS_${packed.observed.code}`;
    if (packed.observed.code === 'ACCEPTED' && plain.length > 0) {
      const refused = await refusal(() =>
        sealPackage(packed.destination, {
          repository: candidate,
          staging: packed.staging,
          source,
          dirty,
          checkout,
          work: privateDirectory(join(packed.root, 'work')),
          ports: {
            symbolicate: async (options) => {
              await symbolicateCandidate(options);
              const path = join(cli, 'dist', plain[0]);
              writeFileSync(
                path,
                Buffer.concat([readOrdinaryFile(path, 8 * MIB), Buffer.from(' ')]),
              );
            },
          },
        }),
      );
      observed = existsSync(join(packed.destination, 'package-test-receipt.json'))
        ? 'MARKERS_RECEIPT_WRITTEN'
        : refused.code;
    }
    record('seal-verify', 'PACKED_CLI_MANIFEST_DIST_DRIFT', observed);
  }

  // Restoration: every corrupted file is back, so a fresh pack seals again.
  const restored = await pack('restoration');
  record(
    'restoration',
    'ACCEPTED',
    restored.observed.code === 'ACCEPTED'
      ? (await seal(restored)).code
      : `MARKERS_${restored.observed.code}`,
  );
}

/**
 * Run the controls through one real production of `repository` and return their results with the
 * source identity. The developer checkout must be the same before and after.
 * @param {{repository: string, environment: Record<string, string | undefined>,
 *   temporary?: string}} options
 */
export async function runMapControls({ repository, environment, temporary = tmpdir() }) {
  // A half-configured CI environment refuses before anything is built.
  try {
    originFromEnvironment(environment);
  } catch {
    assert.fail('PACKED_CLI_MAP_CONTROL_ORIGIN');
  }
  const before = await sourceIdentity(repository);
  const root = realpathSync.native(mkdtempSync(join(temporary, 'relavium-map-controls-')));
  chmodSync(root, 0o700);
  const ran = { results: [], chunks: 0 };
  let emitted;
  try {
    const produced = await producePackage({
      repository,
      destination: join(root, 'artifact'),
      environment,
      temporary,
      ports: {
        emit: (options) => {
          emitted = { env: options.env, pnpm: options.pnpm };
          return emitFreshPackage(options);
        },
        seal: async (artifact, inputs) => {
          const receipt = await sealPackage(artifact, inputs);
          try {
            await runControls(
              {
                candidate: inputs.repository,
                staging: inputs.staging,
                checkout: inputs.checkout,
                source: inputs.source,
                dirty: inputs.dirty,
                receipt,
                artifact,
                ...emitted,
              },
              ran,
            );
          } catch (error) {
            // A harness self-check or an unexpected error stops the controls; the summary still names
            // it, with only its fixed code, and every control that did not run is reported missing.
            const line = productionFailure(error).at(-1);
            ran.results.push({
              id: 'aborted',
              expected: 'none',
              observed: line.slice(line.lastIndexOf(': ') + 2),
            });
          }
          return receipt;
        },
      },
    });
    const after = await sourceIdentity(repository);
    assert.deepEqual(
      [after.source, after.status, after.unchecked],
      [before.source, before.status, before.unchecked],
      'PACKED_CLI_MAP_CONTROL_CHECKOUT_CHANGED',
    );
    return { source: produced.receipt.source, dirty: produced.identity.dirty, ...ran };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The controls every run records once, besides four for each anchor-bearing chunk. */
export const FIXED_CONTROLS = Object.freeze([
  'second-prepack',
  're-seal-receipt',
  're-seal-staging',
  're-recorded-baseline',
  'source-clean',
  'source-dirty',
  'sealed-dist',
  'dist-plain-chunk',
  'dist-rebuilt',
  'upstream-missing',
  'upstream-shape',
  'upstream-index',
  'upstream-cut-bytes',
  'upstream-cut-value',
  'upstream-shifted',
  'seal-verify',
  'restoration',
]);
const PER_CHUNK = Object.freeze(['js-line', 'js-column', 'map-line', 'sources-rotated']);

/**
 * The verdict on a run: at least one anchor-bearing chunk, every expected control recorded exactly
 * once, and each with its expected outcome.
 * @param {{results: {id: string, expected: string, observed: string}[], chunks: number}} outcome
 */
export function verdict({ results, chunks }) {
  const expected = [
    ...FIXED_CONTROLS,
    ...Array.from({ length: chunks }, (_, index) =>
      PER_CHUNK.map((kind) => `${kind}-${index + 1}`),
    ).flat(),
  ];
  const ids = results.map((result) => result.id);
  const missing = expected.filter((id) => !ids.includes(id));
  const unexpected = ids.filter((id, index) => !expected.includes(id) || ids.indexOf(id) !== index);
  const failed = results
    .filter((result) => result.observed !== result.expected)
    .map((result) => result.id);
  return {
    expected: expected.length,
    missing,
    unexpected,
    failed,
    passed: chunks >= 1 && missing.length === 0 && unexpected.length === 0 && failed.length === 0,
  };
}

/**
 * Print a run's summary and return the process exit code: 0 only when the verdict passes.
 * @param {{source: string, dirty: boolean, results: {id: string, expected: string,
 *   observed: string}[], chunks: number}} outcome
 * @param {{seconds: number, write?: (line: string) => void, warn?: (line: string) => void}} options
 */
export function report(outcome, { seconds, write = console.log, warn = console.error }) {
  const judged = verdict(outcome);
  write(
    JSON.stringify({
      scope: 'product copies of one real package-test production',
      source: outcome.source,
      dirty: outcome.dirty,
      chunks: outcome.chunks,
      controls: outcome.results.length,
      expected: judged.expected,
      failed: judged.failed,
      missing: judged.missing,
      unexpected: judged.unexpected,
      results: outcome.results,
      seconds,
    }),
  );
  if (judged.passed) return 0;
  const named = [
    ...judged.failed,
    ...judged.missing.map((id) => `${id} (missing)`),
    ...judged.unexpected.map((id) => `${id} (unexpected)`),
  ];
  warn(
    `✗ CLI product map controls failed: ${named.length > 0 ? named.join(', ') : 'no anchor-bearing chunk'}`,
  );
  return 1;
}
