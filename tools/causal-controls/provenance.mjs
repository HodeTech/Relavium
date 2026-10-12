/** Small shared provenance authority; family names and owned roots remain finite. */
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { digest } from '../usage-coverage-controls/source-graph.mjs';

export function selectControls(mutations, requested) {
  assert.ok(
    requested.length === 0 || (requested.length === 2 && requested[0] === '--mechanism'),
    'Usage: check.mjs [--mechanism declared-id]',
  );
  assert.ok(
    mutations.length > 0 && new Set(mutations.map((entry) => entry.id)).size === mutations.length,
    'Empty/duplicate mechanisms',
  );
  for (const entry of mutations) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(entry.before.length > 0 && entry.before !== entry.after, 'Empty/ineffective anchor');
    assert.ok(
      Number.isSafeInteger(entry.expectedTests) && entry.expectedTests > 0,
      'Empty declared inventory',
    );
  }
  const selected = requested.length
    ? mutations.filter((entry) => entry.id === requested[1])
    : mutations;
  assert.ok(selected.length, 'Unknown mechanism');
  return selected;
}

export function ownedTools(repository, roots) {
  const files = [];
  function walk(path) {
    const physical = join(repository, path);
    const info = lstatSync(physical);
    assert.ok(
      !info.isSymbolicLink() && realpathSync(physical) === resolve(physical),
      `Owned tooling must be physical: ${path}`,
    );
    if (info.isDirectory()) {
      for (const name of readdirSync(physical).sort()) walk(join(path, name));
    } else {
      assert.ok(info.isFile(), `Owned tooling must be a file: ${path}`);
      const bytes = readFileSync(physical);
      files.push({ path: path.split(sep).join('/'), bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  for (const root of roots) walk(root);
  assert.ok(
    roots.every((root) => files.some((file) => file.path.startsWith(root + '/'))),
    'Missing owned tool root',
  );
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function captureOwnedTools(repository, graph, roots) {
  const files = ownedTools(repository, roots);
  for (const file of files) {
    const bytes = readFileSync(join(repository, file.path));
    assert.equal(digest(bytes), file.sha256, 'Tool changed during capture');
    mkdirSync(dirname(join(graph, file.path)), { recursive: true });
    writeFileSync(join(graph, file.path), bytes, { flag: 'wx' });
  }
  verifyOwnedTools(repository, roots, files);
  return files;
}
export function verifyOwnedTools(repository, roots, files) {
  assert.deepEqual(
    ownedTools(repository, roots),
    files,
    'Developer tooling membership/bytes changed',
  );
}
export function mergeFiles(source, tools) {
  const files = [...source, ...tools];
  assert.equal(
    new Set(files.map((entry) => entry.path)).size,
    files.length,
    'Duplicate manifest paths',
  );
  return files;
}
export function assertEvaluations(records, manifest, targetPath, graph, native = undefined) {
  const target = manifest.files.find((entry) => entry.path === targetPath);
  assert.ok(target, 'Target absent from manifest');
  assert.ok(
    records.some(
      (entry) =>
        entry.relativePath === targetPath &&
        entry.rawSha256 === target.sha256 &&
        entry.stage === 'module-body-entry' &&
        entry.threadId === 0,
    ),
    'Copied target source has no body evaluation witness',
  );
  for (const entry of records) {
    const file = manifest.files.find((file) => file.path === entry.relativePath);
    assert.ok(file, 'Evaluation outside captured source');
    assert.equal(entry.rawSha256, file.sha256, 'Evaluation source hash differs');
    assert.equal(
      entry.physicalPath,
      realpathSync(join(graph, file.path)),
      'Evaluation borrowed developer/dist source',
    );
  }
  if (native === undefined) return;
  const { program, parent, dependencyRecords, dependencies } = native;
  const parentPids = new Set(
    records
      .filter(
        (entry) =>
          entry.relativePath === parent &&
          entry.stage === 'module-body-entry' &&
          entry.threadId === 0,
      )
      .map((entry) => entry.pid),
  );
  const children = records.filter(
    (entry) =>
      entry.relativePath === program && entry.stage === 'module-body-entry' && entry.threadId === 0,
  );
  assert.ok(parentPids.size > 0 && children.length > 0, 'Native child body receipt missing');
  const external = new Map(dependencies.files.map((entry) => [entry.path, entry]));
  for (const receipt of dependencyRecords) {
    const pin = external.get(receipt.path);
    assert.ok(pin, 'Native dependency outside pinned manifest');
    assert.equal(receipt.stage, 'dependency-load-verification');
    assert.equal(receipt.sha256, pin.sha256, 'Native dependency hash differs');
    assert.equal(receipt.bytes, pin.bytes, 'Native dependency size differs');
  }
  for (const child of children) {
    assert.ok(parentPids.has(child.ppid) && child.pid !== child.ppid, 'Native child PID unlinked');
    assert.ok(
      records.some(
        (entry) =>
          entry.pid === child.pid &&
          entry.relativePath === targetPath &&
          entry.stage === 'module-body-entry' &&
          entry.threadId === 0,
      ),
      'Native child target body receipt missing',
    );
    assert.ok(
      dependencyRecords.some((entry) => entry.pid === child.pid),
      'Native child dependency receipt missing',
    );
  }
}
/** @returns {Record<string, string | undefined>} */
export function phaseEnvironment(kind, runtime, scratch) {
  if (kind === 'filesystem')
    return { ...process.env, CI: 'true', NO_COLOR: '1', RELAVIUM_USAGE_RUNTIME: runtime };
  assert.equal(kind, 'secrets');
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG'])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CI: 'true',
    NO_COLOR: '1',
    RELAVIUM_USAGE_RUNTIME: runtime,
  };
}

export function exactReplacement(original, control) {
  const text = original.toString('utf8');
  assert.equal(text.split(control.before).length, 2, `${control.id}: exact source anchor drift`);
  return text.replace(control.before, control.after);
}
export function assertInventories(fixed, mutated, restored) {
  assert.deepEqual(mutated.inventory, fixed.inventory, 'Mutated workload changed');
  assert.deepEqual(restored.inventory, fixed.inventory, 'Restored workload changed');
}
