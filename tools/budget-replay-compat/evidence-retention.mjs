/** Bound completed replay evidence; active, foreign and redirected trees are never pruned. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const kind = 'relavium-budget-replay-evidence-v1';
function directory(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'replay evidence directory redirected');
  if (process.getuid !== undefined) assert.equal(stat.uid, process.getuid());
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
      ownedRecord(path, allocation.repository);
      const completion = readRecord(join(path, 'completion.json'));
      assert.ok(['success', 'failure'].includes(completion.state));
      assert.ok(Number.isSafeInteger(completion.completedAt) && completion.completedAt >= 0);
      assert.deepEqual(Object.keys(completion).sort(), ['completedAt', 'state']);
      completed.push({ path, time: completion.completedAt });
    } catch {
      // No completion means active/interrupted; malformed, foreign and redirected paths are not owned.
    }
  }
  completed.sort((a, b) => b.time - a.time || b.path.localeCompare(a.path));
  const others = completed.filter((entry) => entry.path !== allocation.owned);
  for (const entry of others.slice(2)) rmSync(entry.path, { recursive: true, force: true });
}

/**
 * Capture a synchronous evidence-finalization failure without replacing an existing check failure.
 * @param {() => void} finalize
 * @param {boolean} primaryFailed
 * @param {() => void} warn
 * @returns {{ failed: false } | { failed: true, error: unknown }}
 */
export function captureEvidenceFinalization(finalize, primaryFailed, warn) {
  try {
    finalize();
    return { failed: false };
  } catch (error) {
    if (!primaryFailed) return { failed: true, error };
    try {
      warn();
    } catch {
      // A closed diagnostic sink must not replace the original check failure either.
    }
    return { failed: false };
  }
}
