/** Offline production-helper controls for bounded completed evidence and concurrent owners. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearTimeout } from 'node:timers';
import {
  allocateEvidence,
  finishEvidence,
  captureEvidenceFinalization,
  warnEvidenceFailure,
} from './evidence-retention.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--retention-child') {
  const allocation = allocateEvidence(process.argv[3], process.argv[4]);
  process.send({ state: 'ready', owned: allocation.owned });
  process.once('message', () => {
    finishEvidence(allocation, 'success');
    process.disconnect();
  });
}

export async function checkRetentionGuards(owned, environment) {
  const root = join(owned, 'retention-guards');
  const repository = join(root, 'repository');
  const temporary = join(root, 'temporary');
  mkdirSync(repository, { recursive: true });
  mkdirSync(temporary);
  const results = [];
  const record = (name) => results.push({ name, passed: true });
  for (const primaryFailed of [false, true]) {
    let calls = 0;
    const result = captureEvidenceFinalization(
      () => {
        calls++;
      },
      primaryFailed,
      () => assert.fail('successful finalization must not warn'),
    );
    assert.equal(calls, 1);
    assert.deepEqual(result, { failed: false });
  }
  record('successful finalization is called once with or without a prior failure');
  const secondary = new Error('synthetic finalization failure');
  for (const error of [secondary, undefined, null]) {
    const result = captureEvidenceFinalization(
      () => {
        throw error;
      },
      false,
      () => assert.fail('no prior failure to retain'),
    );
    assert.equal(result.failed, true);
    assert.strictEqual(result.error, error);
  }
  record('finalization-only Error and primitive failures remain observable');
  for (const warningFails of [false, true]) {
    const primary = new Error('synthetic primary check failure');
    let warnings = 0;
    let caught;
    try {
      try {
        throw primary;
      } finally {
        const result = captureEvidenceFinalization(
          () => {
            throw secondary;
          },
          true,
          () => {
            warnings++;
            if (warningFails) throw new Error('synthetic closed diagnostic sink');
          },
        );
        assert.deepEqual(result, { failed: false });
      }
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught, primary);
    assert.equal(warnings, 1);
  }
  record('primary failure survives both failed finalization and a closed warning sink');

  function completed() {
    return readdirSync(temporary).filter((name) => {
      try {
        const owner = JSON.parse(readFileSync(join(temporary, name, 'OWNER.json'), 'utf8'));
        const state = JSON.parse(readFileSync(join(temporary, name, 'completion.json'), 'utf8'));
        return (
          owner.repository === repository &&
          ['success', 'failure'].includes(state.state) &&
          Object.keys(state).length === 2
        );
      } catch {
        return false;
      }
    });
  }
  let current;
  for (let index = 0; index < 8; index += 1) {
    current = allocateEvidence(repository, temporary);
    finishEvidence(current, index % 2 ? 'success' : 'failure');
    assert.ok(completed().length <= 3);
    assert.ok(existsSync(current.owned));
  }
  assert.equal(completed().length, 3);
  record('eight completed success/failure invocations retain at most three');
  const active = allocateEvidence(repository, temporary);
  const interrupted = join(temporary, `${active.prefix}dead00`);
  mkdirSync(interrupted);
  const foreign = join(temporary, `${active.prefix}for000`);
  mkdirSync(foreign);
  const owner = JSON.parse(readFileSync(join(active.owned, 'OWNER.json'), 'utf8'));
  writeFileSync(join(foreign, 'OWNER.json'), JSON.stringify({ ...owner, repository: root }));
  writeFileSync(
    join(foreign, 'completion.json'),
    JSON.stringify({ state: 'success', completedAt: 0 }),
  );
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'sentinel'), 'untouched');
  const redirected = join(temporary, `${active.prefix}lnk000`);
  symlinkSync(external, redirected, 'junction');
  const recordLink = join(temporary, `${active.prefix}rec000`);
  mkdirSync(recordLink);
  writeFileSync(join(external, 'OWNER.json'), JSON.stringify(owner));
  symlinkSync(join(external, 'OWNER.json'), join(recordLink, 'OWNER.json'), 'file');
  writeFileSync(
    join(recordLink, 'completion.json'),
    JSON.stringify({ state: 'success', completedAt: 0 }),
  );
  const malformed = join(temporary, `${active.prefix}bad000`);
  mkdirSync(malformed);
  writeFileSync(join(malformed, 'OWNER.json'), JSON.stringify(owner));
  writeFileSync(
    join(malformed, 'completion.json'),
    JSON.stringify({ state: 'success', completedAt: 0, forged: true }),
  );
  for (const name of completed()) {
    const file = join(temporary, name, 'completion.json');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (name !== `${active.prefix}rec000`)
      writeFileSync(file, JSON.stringify({ ...value, completedAt: Date.now() + 100000 }));
  }
  current = allocateEvidence(repository, temporary);
  finishEvidence(current, 'success');
  assert.ok(existsSync(current.owned));
  record('current evidence survives future-dated completed peers');
  for (const path of [active.owned, interrupted, foreign, redirected, recordLink, malformed])
    assert.ok(existsSync(path));
  assert.equal(readFileSync(join(external, 'sentinel'), 'utf8'), 'untouched');
  record('active interrupted foreign redirected and malformed peers survive pruning');
  const bad = allocateEvidence(repository, temporary);
  const before = readFileSync(join(bad.owned, 'OWNER.json'));
  writeFileSync(join(bad.owned, 'OWNER.json'), JSON.stringify({ ...owner, repository: root }));
  assert.throws(() => finishEvidence(bad, 'success'));
  assert.equal(existsSync(join(bad.owned, 'completion.json')), false);
  writeFileSync(join(bad.owned, 'OWNER.json'), before);
  finishEvidence(bad, 'failure');
  record('foreign current owner is refused before completion');
  const nested = join(active.owned, `${active.prefix}nest00`);
  mkdirSync(nested);
  writeFileSync(join(nested, 'OWNER.json'), JSON.stringify(owner));
  assert.throws(() => finishEvidence({ ...active, owned: nested }, 'success'));
  assert.equal(existsSync(join(nested, 'completion.json')), false);
  record('non-direct-child allocation is refused before completion');

  const workers = [];
  let primaryFailed = false;
  let finalization = { failed: false };
  try {
    for (let index = 0; index < 10; index += 1) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), '--retention-child', repository, temporary],
        { cwd: owned, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      const ready = new Promise((resolve) => {
        child.once('message', (value) => resolve(value));
        child.once('error', () => resolve({ state: 'error' }));
        child.once('close', () => resolve({ state: 'closed-before-ready' }));
      });
      const closed = new Promise((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal })),
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
      workers.push({ child, ready, closed, timer, index, output: () => ({ stdout, stderr }) });
    }
    const ready = await Promise.all(workers.map((worker) => worker.ready));
    for (const value of ready) assert.equal(value.state, 'ready');
    for (const worker of workers) worker.child.send('finish');
    const ended = await Promise.all(workers.map((worker) => worker.closed));
    for (const result of ended) {
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
    }
    record('ten concurrent invocations independently acquire owners and finish');
    // The synthetic future-dated peers retain priority; completed() excludes hostile record-link paths.
    const valid = completed().filter((name) => name !== `${active.prefix}rec000`);
    assert.ok(valid.length <= 3);
    record('completed concurrency still has a three-invocation bound');
    for (const path of [active.owned, interrupted, foreign, redirected, recordLink, malformed])
      assert.ok(existsSync(path));
    assert.equal(readFileSync(join(external, 'sentinel'), 'utf8'), 'untouched');
    record('concurrent pruning preserves every active foreign and redirected sentinel');
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    for (const worker of workers) {
      clearTimeout(worker.timer);
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill('SIGKILL');
    }
    const ended = await Promise.all(workers.map((worker) => worker.closed));
    finalization = captureEvidenceFinalization(
      [
        ...workers.map(
          (worker, index) => () =>
            writeFileSync(
              join(root, `worker-${index}.json`),
              `${JSON.stringify({ pid: worker.child.pid ?? null, ...ended[index], ...worker.output() }, null, 2)}\n`,
            ),
        ),
        () => writeFileSync(join(root, 'results.json'), `${JSON.stringify(results, null, 2)}\n`),
      ],
      primaryFailed,
      () =>
        warnEvidenceFailure(
          'Replay retention evidence failed; primary readiness or worker failure retained.\n',
        ),
    );
  }
  if (finalization.failed) throw finalization.error;
  return results;
}
