/** Bound completed replay evidence; unexpected retirement claims are preserved for inspection. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const kind = 'relavium-budget-replay-evidence-v1';
function directory(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'replay evidence directory redirected');
  if (process.getuid !== undefined) assert.equal(stat.uid, process.getuid());
  return { dev: stat.dev, ino: stat.ino };
}
function readRecord(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'replay evidence record redirected');
  if (process.getuid !== undefined) assert.equal(stat.uid, process.getuid());
  return JSON.parse(readFileSync(path, 'utf8'));
}
function owner(repository, parentPid) {
  return { kind, repository, parentPid };
}
function ownedRecord(path, repository) {
  directory(path);
  const record = readRecord(join(path, 'OWNER.json'));
  assert.ok(Number.isSafeInteger(record.parentPid) && record.parentPid > 0);
  assert.deepEqual(record, owner(repository, record.parentPid));
  return record;
}

function completedRecord(path, repository) {
  const identity = directory(path);
  const ownership = ownedRecord(path, repository);
  const completion = readRecord(join(path, 'completion.json'));
  assert.ok(['success', 'failure'].includes(completion.state));
  assert.ok(Number.isSafeInteger(completion.completedAt) && completion.completedAt >= 0);
  assert.deepEqual(
    Object.keys(completion).sort((a, b) => a.localeCompare(b)),
    ['completedAt', 'state'],
  );
  assert.deepEqual(directory(path), identity);
  return { identity, ownership, completion };
}

function retireEvidence(entry, allocation) {
  // A private name outside the completed-invocation namespace cannot be pruned by another finisher.
  const claim = mkdtempSync(join(allocation.namespace, 'relavium-budget-replay-retirement-'));
  const path = join(claim, 'evidence');
  try {
    renameSync(entry.path, path);
  } catch (error) {
    rmSync(claim, { recursive: true });
    // Another finisher may have claimed the same old completed invocation first.
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    assert.deepEqual(completedRecord(path, allocation.repository), entry.snapshot);
  } catch {
    // Never delete or restore over an unexpected object. Its private claim remains inspectable.
    throw new Error('Replay evidence retirement changed; claimed contents preserved.');
  }
  rmSync(claim, { recursive: true });
}
export function allocateEvidence(repository, temporary) {
  const source = realpathSync(repository);
  const namespace = realpathSync(temporary);
  // Each invocation atomically acquires its own directory; there is no shared directory/OWNER
  // initialisation window. An interrupted invocation remains uncompleted, never a deletion target.
  const prefix = `relavium-budget-replay-${createHash('sha256').update(source).digest('hex').slice(0, 20)}-`;
  const owned = mkdtempSync(join(namespace, prefix));
  directory(owned);
  writeFileSync(join(owned, 'OWNER.json'), `${JSON.stringify(owner(source, process.pid))}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { namespace, prefix, owned, repository: source };
}
export function finishEvidence(allocation, state) {
  assert.ok(state === 'success' || state === 'failure');
  assert.equal(realpathSync(allocation.namespace), allocation.namespace);
  const expectedPrefix = `relavium-budget-replay-${createHash('sha256').update(allocation.repository).digest('hex').slice(0, 20)}-`;
  assert.equal(allocation.prefix, expectedPrefix);
  assert.equal(dirname(allocation.owned), allocation.namespace);
  assert.ok(basename(allocation.owned).startsWith(allocation.prefix));
  assert.match(basename(allocation.owned).slice(allocation.prefix.length), /^[a-zA-Z0-9]{6}$/);
  assert.deepEqual(
    ownedRecord(allocation.owned, allocation.repository),
    owner(allocation.repository, process.pid),
  );
  writeFileSync(
    join(allocation.owned, 'completion.json'),
    `${JSON.stringify({ state, completedAt: Date.now() })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const completed = [];
  for (const name of readdirSync(allocation.namespace)) {
    if (
      !name.startsWith(allocation.prefix) ||
      !/^[a-zA-Z0-9]{6}$/.test(name.slice(allocation.prefix.length))
    )
      continue;
    const path = join(allocation.namespace, name);
    try {
      const snapshot = completedRecord(path, allocation.repository);
      completed.push({ path, time: snapshot.completion.completedAt, snapshot });
    } catch {
      // No completion means active/interrupted; malformed, foreign and redirected paths are not owned.
    }
  }
  completed.sort((a, b) => b.time - a.time || b.path.localeCompare(a.path));
  const others = completed.filter((entry) => entry.path !== allocation.owned);
  for (const entry of others.slice(2)) retireEvidence(entry, allocation);
}

/** Fixed diagnostics use a synchronous descriptor write; a closed pipe cannot emit a later error. */
export function warnEvidenceFailure(message) {
  try {
    writeSync(2, message);
  } catch {
    // Diagnostics are secondary to the failure already retained by the caller.
  }
}

/**
 * Capture a synchronous evidence-finalization failure without replacing an existing check failure.
 * All writers are attempted, preserving the first evidence-only failure when the check succeeded.
 * @param {(() => void) | Array<() => void>} finalize
 * @param {boolean} primaryFailed
 * @param {() => void} warn
 * @returns {{ failed: false } | { failed: true, error: unknown }}
 */
export function captureEvidenceFinalization(finalize, primaryFailed, warn) {
  let result = { failed: false };
  for (const writer of Array.isArray(finalize) ? finalize : [finalize]) {
    try {
      writer();
    } catch (error) {
      if (!primaryFailed && !result.failed) {
        result = { failed: true, error };
      } else {
        try {
          warn();
        } catch {
          // A synchronous diagnostic failure must not replace the already retained failure either.
        }
      }
    }
  }
  return result;
}
