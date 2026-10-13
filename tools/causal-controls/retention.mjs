/** Bounded metadata-only evidence with primary-failure-preserving cleanup. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { digest, json } from '../usage-coverage-controls/source-graph.mjs';
import { maxProcessOutputUnits } from './process.mjs';
const maxFiles = 2000,
  maxBytes = 64 * 1024 * 1024,
  maxReceiptPathBytes = 1024;
// UTF-8 takes at most three bytes per UTF-16 code unit. The process cap remains
// exactly 8,388,608 decoded code units.
const maxStdioBytes = 8 + 3 * maxProcessOutputUnits;
const receiptName = /^(\d+)(?:-(\d+))?(?:\.(loader-preparation|dependencies))?\.jsonl$/;
const phaseManifestName =
  /^([a-z0-9]+(?:-[a-z0-9]+)*)\/(fixed|mutated|restored)\/source-manifest\.json$/;
const manifestArchiveName = 'source-manifests.json.gz';
const manifestIndexName = 'source-manifest-index.json';
const sha256Name = /^[a-f0-9]{64}$/;

function portableManifestPath(path) {
  assert.ok(typeof path === 'string' && Buffer.byteLength(path) <= maxReceiptPathBytes);
  assert.match(path, phaseManifestName, 'Invalid phase manifest path');
  return path;
}

function physicalFile(path, bound) {
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path);
  assert.ok(info.size <= bound, 'Retained input bound');
  return info.size;
}

function exactKeys(value, keys) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function verifyRuntimeManifestJoins(root, decoded) {
  for (const control of boundedDirectoryEntries(root)) {
    assert.ok(!control.isSymbolicLink(), 'Phase manifest control directory redirected');
    if (!control.isDirectory()) continue;
    for (const phase of boundedDirectoryEntries(join(root, control.name))) {
      if (!['fixed', 'mutated', 'restored'].includes(phase.name)) continue;
      assert.ok(
        phase.isDirectory() && !phase.isSymbolicLink(),
        'Phase manifest directory redirected',
      );
      const runtimePath = join(root, control.name, phase.name, 'runtime.json');
      if (lstatSync(runtimePath, { throwIfNoEntry: false }))
        assert.ok(
          decoded.has(`${control.name}/${phase.name}/source-manifest.json`),
          'Phase runtime manifest missing',
        );
    }
  }
}

/** Check phase membership without claiming the external cohort's declaration order. */
function verifyManifestPhasePrefix(root, decoded, summary) {
  const mechanisms = summary.mechanisms === undefined ? [] : summary.mechanisms;
  assert.ok(Array.isArray(mechanisms) && mechanisms.length <= maxFiles);
  const completed = new Set();
  const phases = ['fixed', 'mutated', 'restored'];
  for (const mechanism of mechanisms) {
    assert.ok(
      typeof mechanism.id === 'string' &&
        phaseManifestName.test(`${mechanism.id}/fixed/source-manifest.json`),
    );
    assert.ok(!completed.has(mechanism.id), 'Phase manifest duplicate completed control');
    completed.add(mechanism.id);
  }
  function requireRuntime(control, phase, diagnostic) {
    const directory = join(root, control, phase);
    const info = lstatSync(directory, { throwIfNoEntry: false });
    assert.ok(info?.isDirectory() && !info.isSymbolicLink(), `${diagnostic} directory missing`);
    const runtime = join(directory, 'runtime.json');
    assert.ok(lstatSync(runtime, { throwIfNoEntry: false }), `${diagnostic} missing`);
    physicalFile(runtime, maxBytes);
  }
  for (const control of completed)
    for (const phase of phases) {
      assert.ok(
        decoded.has(`${control}/${phase}/source-manifest.json`),
        'Completed phase manifest missing',
      );
      requireRuntime(control, phase, 'Completed phase runtime');
    }
  const unfinished = new Map();
  for (const source of decoded.keys()) {
    const match = phaseManifestName.exec(source);
    assert.ok(match, 'Invalid phase manifest path');
    const [, control, phase] = match;
    if (completed.has(control)) continue;
    if (!unfinished.has(control)) unfinished.set(control, new Set());
    unfinished.get(control).add(phase);
  }
  assert.ok(
    summary.complete !== true || unfinished.size === 0,
    'Phase manifest unreported tail in complete capture',
  );
  assert.ok(unfinished.size <= 1, 'Phase manifest unfinished control count');
  for (const [control, present] of unfinished) {
    const prefix = phases.slice(0, present.size);
    assert.ok(
      prefix.every((phase) => present.has(phase)),
      'Phase manifest prefix gap or missing fixed phase',
    );
    // A failed restored phase can leave all three manifests before the coordinator
    // records the mechanism. Only the last attempted phase may precede runtime creation.
    for (const phase of prefix.slice(0, -1))
      requireRuntime(control, phase, 'Phase manifest predecessor runtime');
  }
}

/** One byte-exact, independently bounded envelope replaces two per-phase log files. */
export function encodePhaseStdio(stdout, stderr) {
  assert.ok(
    typeof stdout === 'string' &&
      typeof stderr === 'string' &&
      stdout.length + stderr.length <= maxProcessOutputUnits,
    'Process output bound',
  );
  const out = Buffer.from(stdout, 'utf8'),
    err = Buffer.from(stderr, 'utf8');
  assert.ok(out.length + err.length + 8 <= maxStdioBytes, 'Stdio envelope bound');
  const bytes = Buffer.allocUnsafe(8 + out.length + err.length);
  bytes.writeUInt32BE(out.length, 0);
  bytes.writeUInt32BE(err.length, 4);
  out.copy(bytes, 8);
  err.copy(bytes, 8 + out.length);
  return {
    bytes,
    index: {
      version: 1,
      stdout: { bytes: out.length, sha256: digest(out) },
      stderr: { bytes: err.length, sha256: digest(err) },
    },
  };
}

/** Reconstruct both original log byte streams and refuse malformed or expanded envelopes. */
export function decodePhaseStdio(bytes, index) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.length <= maxStdioBytes);
  assert.equal(index?.version, 1);
  for (const stream of ['stdout', 'stderr']) {
    assert.ok(Number.isSafeInteger(index[stream]?.bytes) && index[stream].bytes >= 0);
    assert.match(index[stream]?.sha256, /^[a-f0-9]{64}$/);
  }
  const outLength = bytes.readUInt32BE(0),
    errLength = bytes.readUInt32BE(4);
  assert.equal(outLength, index.stdout.bytes, 'Stdio stdout length differs');
  assert.equal(errLength, index.stderr.bytes, 'Stdio stderr length differs');
  assert.equal(bytes.length, 8 + outLength + errLength, 'Stdio envelope length differs');
  const out = bytes.subarray(8, 8 + outLength),
    err = bytes.subarray(8 + outLength);
  assert.equal(digest(out), index.stdout.sha256, 'Stdio stdout digest differs');
  assert.equal(digest(err), index.stderr.sha256, 'Stdio stderr digest differs');
  const stdout = out.toString('utf8'),
    stderr = err.toString('utf8');
  assert.ok(
    stdout.length + stderr.length <= maxProcessOutputUnits &&
      Buffer.from(stdout, 'utf8').equals(out) &&
      Buffer.from(stderr, 'utf8').equals(err),
    'Stdio decoded process bound',
  );
  return { stdout, stderr };
}

function* boundedDirectoryEntries(path) {
  const directory = opendirSync(path);
  let count = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      assert.ok(++count <= maxFiles, 'Retained stdio directory bound');
      yield entry;
    }
  } finally {
    directory.closeSync();
  }
}

/** Standalone verifier for all retained phase stdout/stderr bytes. */
export function verifyRetainedStdio(destination) {
  const root = realpathSync(destination);
  const reconstructed = [];
  let retainedFiles = 0,
    retainedBytes = 0;
  function countRetained(path, bound) {
    const info = lstatSync(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path);
    assert.ok(info.size <= bound, 'Retained stdio input bound');
    retainedFiles++;
    retainedBytes += info.size;
    assert.ok(retainedFiles <= maxFiles && retainedBytes <= maxBytes, 'Retained stdio total bound');
  }
  for (const control of boundedDirectoryEntries(root)) {
    assert.ok(!control.isSymbolicLink(), 'Retained control path redirected');
    if (!control.isDirectory()) continue;
    const controlPath = join(root, control.name);
    for (const phase of boundedDirectoryEntries(controlPath)) {
      if (!['fixed', 'mutated', 'restored'].includes(phase.name)) continue;
      assert.ok(phase.isDirectory() && !phase.isSymbolicLink(), 'Retained phase path redirected');
      const phasePath = join(controlPath, phase.name);
      const names = new Set([...boundedDirectoryEntries(phasePath)].map((entry) => entry.name));
      const hasProcess = names.has('process.json'),
        hasStdio = names.has('stdio.bin');
      assert.equal(hasProcess, hasStdio, 'Retained process/stdio pair incomplete');
      if (!hasProcess) continue; // A failed pre-spawn phase has neither completed artifact.
      const processPath = join(phasePath, 'process.json'),
        stdioPath = join(phasePath, 'stdio.bin');
      countRetained(processPath, maxStdioBytes);
      countRetained(stdioPath, maxStdioBytes);
      const report = JSON.parse(readFileSync(processPath, 'utf8'));
      const streams = decodePhaseStdio(readFileSync(stdioPath), report.stdio);
      reconstructed.push({ control: control.name, phase: phase.name, ...streams });
    }
  }
  const summaryPath = join(root, 'summary.json');
  countRetained(summaryPath, maxBytes);
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  if (summary.mechanisms !== undefined) {
    assert.ok(Array.isArray(summary.mechanisms) && summary.mechanisms.length <= maxFiles);
    const phases = new Set(reconstructed.map(({ control, phase }) => `${control}/${phase}`));
    for (const mechanism of summary.mechanisms) {
      assert.ok(typeof mechanism.id === 'string' && mechanism.id.length <= 1024);
      for (const phase of ['fixed', 'mutated', 'restored'])
        assert.ok(phases.has(`${mechanism.id}/${phase}`), 'Completed phase stdio missing');
    }
  }
  return reconstructed;
}
function receiptIdentity(name, kind) {
  const match = receiptName.exec(name);
  assert.ok(match, 'Unknown evaluation receipt');
  const [, pid, thread, suffix] = match;
  assert.ok(
    kind === 'dependencies'
      ? suffix === 'dependencies' && thread === undefined
      : (suffix === undefined || suffix === 'loader-preparation') && thread !== undefined,
    'Evaluation receipt filename/kind disagreement',
  );
  const numericPid = Number(pid),
    numericThread = thread === undefined ? undefined : Number(thread);
  assert.ok(Number.isSafeInteger(numericPid) && numericPid > 0, 'Invalid receipt PID');
  assert.ok(
    numericThread === undefined || (Number.isSafeInteger(numericThread) && numericThread >= 0),
    'Invalid receipt thread',
  );
  return { pid: numericPid, thread: numericThread, suffix };
}

export function exportMetadata({ directory, scratch, repository, evidenceKind, summary }) {
  assert.ok(['filesystem', 'secrets'].includes(evidenceKind), 'Unknown evidence family');
  if (directory === undefined) return;
  let ancestor = resolve(directory);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const base = resolve(realpathSync(ancestor), relative(ancestor, resolve(directory)));
  const destination = join(base, evidenceKind);
  for (const root of [repository, scratch]) {
    const delta = relative(realpathSync(root), destination);
    assert.ok(
      delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta),
      'Evidence must be outside repository and scratch',
    );
  }
  assert.ok(!existsSync(destination), 'Evidence destination already exists');
  const entries = [];
  let bytes = 0;
  let rawReceiptBytes = 0;
  let rawReceiptFiles = 0;
  let indexBytes = 1024; // fixed JSON keys, punctuation and counters
  const aggregates = [];
  const segments = [];
  const manifests = [];
  const manifestPaths = new Set();
  let rawManifestBytes = 0;
  let manifestIndexBytes = 1024;
  function indexEntry(entry) {
    indexBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    assert.ok(indexBytes <= maxBytes, 'Evaluation index bound');
  }
  function add(path, content) {
    entries.push({ path, content });
    bytes += content.length;
    assert.ok(entries.length + 1 <= maxFiles && bytes <= maxBytes, 'Metadata export bound');
  }
  function collectEvaluations(dir, rel) {
    const groups = new Map([
      ['source', []],
      ['dependencies', []],
    ]);
    const handle = opendirSync(dir);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        const source = join(dir, entry.name);
        assert.ok(
          !lstatSync(source).isSymbolicLink() && entry.isFile(),
          'Evaluation receipt must be physical',
        );
        const kind = entry.name.endsWith('.dependencies.jsonl') ? 'dependencies' : 'source';
        receiptIdentity(entry.name, kind);
        assert.ok(++rawReceiptFiles <= maxFiles, 'Raw evaluation receipt file bound');
        const size = lstatSync(source).size;
        assert.ok(size <= maxBytes - rawReceiptBytes, 'Raw evaluation receipt bound');
        const content = readFileSync(source);
        assert.equal(content.length, size, 'Evaluation receipt changed during export');
        assert.ok(content.length > 0 && content.at(-1) === 10, 'Incomplete evaluation receipt');
        rawReceiptBytes += content.length;
        groups.get(kind).push({ name: entry.name, content });
      }
    } finally {
      handle.closeSync();
    }
    for (const [kind, files] of groups) {
      if (files.length === 0) continue;
      files.sort((a, b) => a.name.localeCompare(b.name));
      let offset = 0;
      const retained = join(rel, `${kind}-evaluations.jsonl.gz`);
      for (const file of files) {
        const segment = {
          source: join(rel, file.name),
          retained,
          offset,
          bytes: file.content.length,
          sha256: digest(file.content),
          lines: file.content.toString('utf8').split('\n').length - 1,
        };
        assert.ok(
          Buffer.byteLength(segment.source) <= maxReceiptPathBytes &&
            Buffer.byteLength(segment.retained) <= maxReceiptPathBytes,
          'Evaluation receipt path bound',
        );
        indexEntry(segment);
        segments.push(segment);
        offset += file.content.length;
      }
      const raw = Buffer.concat(
        files.map((file) => file.content),
        offset,
      );
      const compressed = gzipSync(raw, { level: 9, mtime: 0 });
      const aggregate = {
        retained,
        bytes: raw.length,
        sha256: digest(raw),
        compressedBytes: compressed.length,
        compressedSha256: digest(compressed),
      };
      indexEntry(aggregate);
      aggregates.push(aggregate);
      add(retained, compressed);
    }
  }
  function collect(dir, rel = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['graph', 'cache', 'home'].includes(entry.name)) continue;
      const source = join(dir, entry.name),
        path = join(rel, entry.name);
      assert.ok(!lstatSync(source).isSymbolicLink(), 'Metadata must not be symlinked');
      if (
        entry.isDirectory() &&
        entry.name === 'evaluation' &&
        /(?:^|[/\\])(?:fixed|mutated|restored)$/.test(rel)
      )
        collectEvaluations(source, path);
      else if (entry.isDirectory()) collect(source, path);
      else if (
        entry.isFile() &&
        (/\.(json|jsonl|log)$/.test(entry.name) ||
          (entry.name === 'stdio.bin' && /(?:^|[/\\])(?:fixed|mutated|restored)$/.test(rel)))
      ) {
        const size = lstatSync(source).size;
        const portable = path.split(sep).join('/');
        const manifest = entry.name === 'source-manifest.json' && phaseManifestName.test(portable);
        if (manifest) {
          portableManifestPath(portable);
          assert.ok(!manifestPaths.has(portable), 'Duplicate phase manifest');
          manifestPaths.add(portable);
          assert.ok(manifests.length < maxFiles, 'Raw phase manifest file bound');
          assert.ok(size > 0 && size <= maxBytes - rawManifestBytes, 'Raw phase manifest bound');
          manifestIndexBytes += Buffer.byteLength(portable) + 180;
          assert.ok(manifestIndexBytes <= maxBytes, 'Phase manifest index bound');
        } else assert.ok(size <= maxBytes - bytes, 'Metadata export bound');
        const content = readFileSync(source);
        assert.equal(content.length, size, 'Metadata changed during export');
        if (manifest) {
          rawManifestBytes += size;
          manifests.push({ source: path.split(sep).join('/'), content });
        } else add(path, content);
      }
    }
  }
  collect(scratch);
  if (manifests.length > 0) {
    manifests.sort((a, b) => a.source.localeCompare(b.source));
    let offset = 0;
    const sourceSegments = manifests.map(({ source, content }) => {
      const segment = { source, offset, bytes: content.length, sha256: digest(content) };
      offset += content.length;
      return segment;
    });
    assert.equal(offset, rawManifestBytes);
    const raw = Buffer.concat(
      manifests.map(({ content }) => content),
      rawManifestBytes,
    );
    const compressed = gzipSync(raw, { level: 9, mtime: 0 });
    assert.ok(compressed.length <= maxBytes, 'Phase manifest archive bound');
    const archive = {
      retained: manifestArchiveName,
      bytes: raw.length,
      sha256: digest(raw),
      compressedBytes: compressed.length,
      compressedSha256: digest(compressed),
    };
    const index = Buffer.from(
      `${JSON.stringify({ version: 1, rawBytes: raw.length, archive, segments: sourceSegments })}\n`,
    );
    assert.ok(index.length <= maxBytes, 'Phase manifest index bound');
    add(manifestArchiveName, compressed);
    add(manifestIndexName, index);
  }
  if (aggregates.length > 0)
    add(
      'evaluation-index.json',
      Buffer.from(`${JSON.stringify({ version: 1, rawReceiptBytes, aggregates, segments })}\n`),
    );
  const metadata = Buffer.from(
    JSON.stringify({ version: 1, files: entries.length, bytes, report: summary }, null, 2) + '\n',
  );
  assert.ok(bytes + metadata.length <= maxBytes, 'Metadata export bound');
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination);
  for (const entry of entries) {
    mkdirSync(dirname(join(destination, entry.path)), { recursive: true });
    writeFileSync(join(destination, entry.path), entry.content, { flag: 'wx' });
  }
  writeFileSync(join(destination, 'export.json'), metadata, { flag: 'wx' });
  if (aggregates.length > 0) verifyRetainedEvaluations(destination);
  verifyRetainedSourceManifests(destination);
  verifyRetainedStdio(destination);
}
/** Verify every original per-PID receipt without unbounded gzip expansion. */
export function verifyRetainedEvaluations(destination) {
  const root = realpathSync(destination);
  const indexPath = join(root, 'evaluation-index.json');
  const indexInfo = lstatSync(indexPath);
  assert.ok(indexInfo.isFile() && !indexInfo.isSymbolicLink() && indexInfo.size <= maxBytes);
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.equal(index.version, 1);
  assert.ok(Array.isArray(index.aggregates) && Array.isArray(index.segments));
  assert.ok(
    index.aggregates.length > 0 &&
      index.aggregates.length <= maxFiles &&
      index.segments.length > 0 &&
      index.segments.length <= maxFiles,
    'Evaluation index count bound',
  );
  assert.ok(
    Number.isSafeInteger(index.rawReceiptBytes) &&
      index.rawReceiptBytes > 0 &&
      index.rawReceiptBytes <= maxBytes,
  );
  let rawTotal = 0;
  let retainedReceiptBytes = indexInfo.size;
  const decoded = new Map();
  for (const aggregate of index.aggregates) {
    assert.ok(
      Number.isSafeInteger(aggregate.bytes) && aggregate.bytes > 0 && aggregate.bytes <= maxBytes,
      'Invalid evaluation expansion bound',
    );
    assert.ok(
      typeof aggregate.retained === 'string' &&
        Buffer.byteLength(aggregate.retained) <= maxReceiptPathBytes,
      'Evaluation archive path bound',
    );
    assert.match(
      aggregate.retained,
      /(?:^|[/\\])evaluation[/\\](?:source|dependencies)-evaluations\.jsonl\.gz$/,
    );
    const path = resolve(root, aggregate.retained);
    const delta = relative(root, path);
    assert.ok(
      delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta),
      'Evaluation path escape',
    );
    const info = lstatSync(path);
    assert.ok(
      info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path,
      'Evaluation archive redirected',
    );
    assert.ok(rawTotal + aggregate.bytes <= maxBytes, 'Raw evaluation receipt bound');
    assert.equal(info.size, aggregate.compressedBytes);
    assert.ok(info.size <= maxBytes, 'Evaluation archive bound');
    retainedReceiptBytes += info.size;
    assert.ok(retainedReceiptBytes <= maxBytes, 'Retained evaluation receipt bound');
    const compressed = readFileSync(path);
    assert.equal(digest(compressed), aggregate.compressedSha256);
    const raw = gunzipSync(compressed, { maxOutputLength: aggregate.bytes });
    assert.equal(raw.length, aggregate.bytes);
    assert.equal(digest(raw), aggregate.sha256);
    assert.ok(!decoded.has(aggregate.retained), 'Duplicate evaluation archive');
    decoded.set(aggregate.retained, raw);
    rawTotal += raw.length;
  }
  let segmentTotal = 0;
  const seen = new Set();
  const cursor = new Map([...decoded.keys()].map((path) => [path, 0]));
  for (const segment of index.segments) {
    assert.ok(
      typeof segment.source === 'string' &&
        typeof segment.retained === 'string' &&
        Buffer.byteLength(segment.source) <= maxReceiptPathBytes &&
        Buffer.byteLength(segment.retained) <= maxReceiptPathBytes,
      'Evaluation receipt path bound',
    );
    assert.ok(!seen.has(segment.source), 'Duplicate evaluation receipt');
    seen.add(segment.source);
    assert.equal(
      dirname(segment.source),
      dirname(segment.retained),
      'Evaluation source path mismatch',
    );
    const kind =
      segment.retained.endsWith('/dependencies-evaluations.jsonl.gz') ||
      segment.retained.endsWith('\\dependencies-evaluations.jsonl.gz')
        ? 'dependencies'
        : 'source';
    const name = segment.source.split(/[/\\]/).at(-1);
    const identity = receiptIdentity(name, kind);
    const raw = decoded.get(segment.retained);
    assert.ok(raw, 'Evaluation archive missing');
    assert.ok(
      Number.isSafeInteger(segment.offset) &&
        segment.offset >= 0 &&
        Number.isSafeInteger(segment.bytes) &&
        segment.bytes > 0 &&
        segment.offset + segment.bytes <= raw.length,
      'Evaluation receipt offset outside archive',
    );
    assert.equal(segment.offset, cursor.get(segment.retained), 'Evaluation receipt gap/overlap');
    assert.equal(
      digest(raw.subarray(segment.offset, segment.offset + segment.bytes)),
      segment.sha256,
    );
    const original = raw.subarray(segment.offset, segment.offset + segment.bytes);
    assert.equal(original.at(-1), 10, 'Incomplete evaluation receipt');
    const lines = original.toString('utf8').split('\n').slice(0, -1);
    assert.equal(lines.length, segment.lines, 'Evaluation receipt line count differs');
    for (const line of lines) {
      const record = JSON.parse(line);
      assert.equal(record.pid, identity.pid, 'Evaluation receipt PID differs');
      if (kind === 'dependencies') assert.equal(record.stage, 'dependency-load-verification');
      else {
        assert.equal(record.threadId, identity.thread, 'Evaluation receipt thread differs');
        assert.equal(
          record.stage,
          identity.suffix === 'loader-preparation'
            ? 'loader-helper-body-entry'
            : 'module-body-entry',
        );
      }
    }
    cursor.set(segment.retained, segment.offset + segment.bytes);
    segmentTotal += segment.bytes;
  }
  for (const [path, bytes] of cursor) assert.equal(bytes, decoded.get(path).length);
  assert.equal(segmentTotal, rawTotal);
  assert.equal(segmentTotal, index.rawReceiptBytes);
  return index;
}
/** Reconstruct every original phase source manifest, including incomplete prefixes. */
export function verifyRetainedSourceManifests(destination) {
  const rootInfo = lstatSync(destination);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Evidence root redirected');
  const root = realpathSync(destination);
  const summaryPath = join(root, 'summary.json');
  physicalFile(summaryPath, maxBytes);
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const archivePath = join(root, manifestArchiveName);
  const indexPath = join(root, manifestIndexName);
  const archiveInfo = lstatSync(archivePath, { throwIfNoEntry: false });
  const indexInfo = lstatSync(indexPath, { throwIfNoEntry: false });
  assert.equal(
    Boolean(archiveInfo),
    Boolean(indexInfo),
    'Phase manifest archive/index pair incomplete',
  );
  if (!indexInfo) {
    const decoded = new Map();
    verifyManifestPhasePrefix(root, decoded, summary);
    verifyRuntimeManifestJoins(root, decoded);
    return decoded;
  }
  physicalFile(indexPath, maxBytes);
  physicalFile(archivePath, maxBytes);
  assert.ok(indexInfo.size + archiveInfo.size <= maxBytes, 'Retained phase manifest pair bound');
  const indexContent = readFileSync(indexPath);
  assert.equal(indexContent.length, indexInfo.size);
  const indexText = indexContent.toString('utf8');
  assert.ok(Buffer.from(indexText, 'utf8').equals(indexContent), 'Phase manifest index UTF-8');
  const index = JSON.parse(indexText);
  exactKeys(index, ['version', 'rawBytes', 'archive', 'segments']);
  assert.equal(index.version, 1);
  assert.ok(
    Number.isSafeInteger(index.rawBytes) && index.rawBytes > 0 && index.rawBytes <= maxBytes,
    'Phase manifest raw bound',
  );
  assert.ok(
    Array.isArray(index.segments) && index.segments.length > 0 && index.segments.length <= maxFiles,
    'Phase manifest count bound',
  );
  const archive = index.archive;
  exactKeys(archive, ['retained', 'bytes', 'sha256', 'compressedBytes', 'compressedSha256']);
  assert.equal(archive.retained, manifestArchiveName);
  assert.equal(archive.bytes, index.rawBytes);
  assert.ok(
    Number.isSafeInteger(archive.compressedBytes) &&
      archive.compressedBytes > 0 &&
      archive.compressedBytes <= maxBytes,
    'Phase manifest archive bound',
  );
  assert.match(archive.sha256, sha256Name);
  assert.match(archive.compressedSha256, sha256Name);
  assert.equal(archiveInfo.size, archive.compressedBytes);
  const compressed = readFileSync(archivePath);
  assert.equal(compressed.length, archiveInfo.size);
  assert.equal(digest(compressed), archive.compressedSha256);
  assert.ok(
    compressed.length >= 18 &&
      compressed[0] === 0x1f &&
      compressed[1] === 0x8b &&
      compressed[2] === 8 &&
      compressed[3] === 0,
    'Phase manifest gzip header',
  );
  const singleMember = inflateRawSync(compressed.subarray(10), {
    info: true,
    maxOutputLength: index.rawBytes,
  });
  assert.equal(
    10 + singleMember.engine.bytesWritten + 8,
    compressed.length,
    'Phase manifest gzip trailing data/member',
  );
  const raw = gunzipSync(compressed, { maxOutputLength: index.rawBytes });
  assert.equal(raw.length, index.rawBytes);
  assert.ok(singleMember.buffer.equals(raw), 'Phase manifest deflate/gzip disagreement');
  assert.equal(digest(raw), archive.sha256);
  const decoded = new Map();
  let offset = 0;
  for (const segment of index.segments) {
    exactKeys(segment, ['source', 'offset', 'bytes', 'sha256']);
    const source = portableManifestPath(segment.source);
    assert.ok(!decoded.has(source), 'Duplicate phase manifest');
    assert.ok(
      Number.isSafeInteger(segment.offset) &&
        Number.isSafeInteger(segment.bytes) &&
        segment.bytes > 0 &&
        segment.offset === offset &&
        segment.bytes <= raw.length - offset,
      'Phase manifest gap/overlap/out-of-order',
    );
    assert.match(segment.sha256, sha256Name);
    const original = raw.subarray(offset, offset + segment.bytes);
    assert.equal(digest(original), segment.sha256);
    offset += segment.bytes;
    const sourceText = original.toString('utf8');
    assert.ok(Buffer.from(sourceText, 'utf8').equals(original), 'Phase manifest UTF-8');
    const manifest = JSON.parse(sourceText);
    exactKeys(manifest, ['sourceRoot', 'files']);
    assert.ok(typeof manifest.sourceRoot === 'string' && isAbsolute(manifest.sourceRoot));
    assert.ok(Array.isArray(manifest.files) && manifest.files.length <= maxFiles);
    const sourceFiles = new Set();
    for (const file of manifest.files) {
      exactKeys(file, ['path', 'bytes', 'sha256']);
      assert.ok(
        typeof file.path === 'string' &&
          file.path.length > 0 &&
          Buffer.byteLength(file.path) <= maxReceiptPathBytes &&
          !isAbsolute(file.path) &&
          !file.path.includes('\\') &&
          file.path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
          !sourceFiles.has(file.path),
        'Phase source path bound',
      );
      sourceFiles.add(file.path);
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0);
      assert.match(file.sha256, sha256Name);
    }
    const phaseDirectory = join(root, dirname(source));
    const controlDirectory = dirname(phaseDirectory);
    const controlInfo = lstatSync(controlDirectory, { throwIfNoEntry: false });
    if (controlInfo)
      assert.ok(
        controlInfo.isDirectory() &&
          !controlInfo.isSymbolicLink() &&
          realpathSync(controlDirectory) === controlDirectory,
        'Phase manifest control directory redirected',
      );
    const phaseInfo = lstatSync(phaseDirectory, { throwIfNoEntry: false });
    if (phaseInfo) {
      assert.ok(
        phaseInfo.isDirectory() &&
          !phaseInfo.isSymbolicLink() &&
          realpathSync(phaseDirectory) === phaseDirectory,
        'Phase manifest directory redirected',
      );
      const runtimePath = join(phaseDirectory, 'runtime.json');
      const runtimeInfo = lstatSync(runtimePath, { throwIfNoEntry: false });
      if (runtimeInfo) {
        physicalFile(runtimePath, maxBytes);
        const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
        assert.equal(runtime.manifestSha256, segment.sha256, 'Phase runtime manifest differs');
      }
    }
    decoded.set(source, Buffer.from(original));
  }
  assert.equal(offset, raw.length, 'Unused phase manifest archive bytes');
  verifyRuntimeManifestJoins(root, decoded);
  verifyManifestPhasePrefix(root, decoded, summary);
  return decoded;
}
export function finish({ scratch, summary, primaryFailure, directory, repository, evidenceKind }) {
  try {
    json(join(scratch, 'summary.json'), summary);
  } catch (error) {
    primaryFailure ??= error;
  }
  try {
    exportMetadata({ scratch, summary, directory, repository, evidenceKind });
  } catch (error) {
    primaryFailure ??= error;
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    primaryFailure ??= error;
  }
  return primaryFailure;
}
