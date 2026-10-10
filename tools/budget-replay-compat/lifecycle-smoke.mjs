/** Actual production caller controls; all children, faults and namespace interventions are offline. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { runReplayStage } from './worker-stage.mjs';
import { allocateEvidence, finishEvidence } from './evidence-retention.mjs';
import { checkRetentionGuards } from './evidence-retention-smoke.mjs';

async function overrideBuiltins(changes, work) {
  const originals = changes.map(([target, key, replacement]) => {
    const original = target[key];
    target[key] = replacement;
    return [target, key, original];
  });
  syncBuiltinESMExports();
  try {
    return await work();
  } finally {
    for (const [target, key, original] of originals) target[key] = original;
    syncBuiltinESMExports();
  }
}

async function diagnosticChild() {
  const primaryMode = process.argv[3];
  let primary = new Error('synthetic primary');
  if (primaryMode === 'undefined') primary = undefined;
  if (primaryMode === 'null') primary = null;
  process.send({ state: 'ready' });
  await new Promise((resolve) => process.once('message', resolve));
  const write = fs.writeFileSync;
  let caught = false;
  let value;
  await overrideBuiltins(
    [
      [
        fs,
        'writeFileSync',
        (path, ...args) => {
          if (typeof path === 'string' && basename(path) === 'OWNER') throw primary;
          if (typeof path === 'string' && basename(path) === 'completion.json')
            throw new Error('synthetic secondary');
          return write(path, ...args);
        },
      ],
    ],
    async () => {
      try {
        await import('./check.mjs');
      } catch (error) {
        caught = true;
        value = error;
      }
    },
  );
  assert.ok(caught);
  assert.strictEqual(value, primary);
  process.send({ state: 'retained', mode: primaryMode }, () => process.disconnect());
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--diagnostic-child')
  diagnosticChild().catch(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });

function stageFixture(root, name, code) {
  const owned = join(root, name);
  fs.mkdirSync(join(owned, 'logs'), { recursive: true });
  fs.writeFileSync(join(owned, 'register.mjs'), '');
  fs.writeFileSync(join(owned, 'worker.mjs'), `process.exit(${code});\n`);
  return owned;
}

async function stageWriteControls(root, environment) {
  const rows = [];
  const write = fs.writeFileSync;
  for (const code of [17, 0]) {
    for (const suffix of ['process.json', 'stdout.log', 'stderr.log']) {
      const owned = stageFixture(root, `stage-${code}-${suffix}`, code);
      const secondary = new Error('synthetic stage evidence failure');
      const processes = [];
      let caught;
      await overrideBuiltins(
        [
          [
            fs,
            'writeFileSync',
            (path, ...args) => {
              if (path === join(owned, `logs/control.${suffix}`)) throw secondary;
              return write(path, ...args);
            },
          ],
        ],
        async () => {
          try {
            await runReplayStage({
              owned,
              stage: 'control',
              source: 'producer',
              script: 'worker.mjs',
              environment,
              processes,
            });
          } catch (error) {
            caught = error;
          }
        },
      );
      assert.equal(processes.length, 1);
      const worker = processes[0];
      assert.ok(worker.pid > 0 && worker.workerClosed);
      assert.equal(worker.code, code);
      if (code === 0) assert.strictEqual(caught, secondary);
      else {
        assert.equal(caught?.code, 'ERR_ASSERTION');
        assert.equal(caught.actual, 17);
      }
      for (const other of ['process.json', 'stdout.log', 'stderr.log'])
        if (other !== suffix) assert.ok(fs.existsSync(join(owned, `logs/control.${other}`)));
      rows.push({
        code,
        suffix,
        pid: worker.pid,
        actualClosedWorkerFailurePreserved: code !== 0,
        evidenceOnlyFailureObservable: code === 0,
      });
    }
  }
  return rows;
}

async function spawnErrorControl(root, environment) {
  const owned = stageFixture(root, 'spawn-error', 0);
  const spawn = cp.spawn;
  const write = fs.writeFileSync;
  let closed = false;
  let evidenceAfterClose = false;
  const processes = [];
  let caught;
  await overrideBuiltins(
    [
      [
        cp,
        'spawn',
        (command, args, options) => {
          const child = spawn(command, args, { ...options, cwd: join(owned, 'missing') });
          child.once('close', () => {
            closed = true;
          });
          return child;
        },
      ],
      [
        fs,
        'writeFileSync',
        (path, ...args) => {
          if (path === join(owned, 'logs/control.process.json')) evidenceAfterClose = closed;
          return write(path, ...args);
        },
      ],
    ],
    async () => {
      try {
        await runReplayStage({
          owned,
          stage: 'control',
          source: 'producer',
          script: 'worker.mjs',
          environment,
          processes,
        });
      } catch (error) {
        caught = error;
      }
    },
  );
  assert.equal(caught?.code, 'ENOENT');
  assert.ok(closed && evidenceAfterClose);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].pid, null);
  assert.ok(processes[0].spawnFailed && processes[0].workerClosed);
  return { failedSpawnHasNoPid: true, evidenceAfterActualClose: true };
}

async function retentionWriteControl(root, environment) {
  const owned = join(root, 'retention-caller');
  fs.mkdirSync(owned);
  const fail = join(root, 'failed-retention-worker.mjs');
  fs.writeFileSync(fail, 'process.exit(17);\n');
  const spawn = cp.spawn;
  const write = fs.writeFileSync;
  const closed = [];
  const secondary = new Error('synthetic retention evidence failure');
  let caught;
  await overrideBuiltins(
    [
      [
        cp,
        'spawn',
        (command, args, options) => {
          const child = spawn(command, [fail], options);
          child.once('close', (code, signal) => closed.push({ pid: child.pid, code, signal }));
          return child;
        },
      ],
      [
        fs,
        'writeFileSync',
        (path, ...args) => {
          if (path === join(owned, 'retention-guards/worker-0.json')) throw secondary;
          return write(path, ...args);
        },
      ],
    ],
    async () => {
      try {
        await checkRetentionGuards(owned, environment);
      } catch (error) {
        caught = error;
      }
    },
  );
  assert.equal(caught?.code, 'ERR_ASSERTION');
  assert.notStrictEqual(caught, secondary);
  assert.equal(closed.length, 10);
  assert.ok(closed.every((child) => child.pid > 0 && child.code === 17 && child.signal === null));
  for (let index = 1; index < 10; index++)
    assert.ok(fs.existsSync(join(owned, `retention-guards/worker-${index}.json`)));
  assert.ok(fs.existsSync(join(owned, 'retention-guards/results.json')));
  return { readinessFailurePreserved: true, closed, laterEvidenceAttempted: true };
}

async function closedDiagnosticControl(root, environment, mode) {
  const child = cp.spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--diagnostic-child', mode],
    {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  let stderr = '';
  let retained = false;
  child.stdout.resume();
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.on('message', (value) => {
    if (value.state === 'ready') {
      child.stderr.once('close', () => child.send('go'));
      child.stderr.destroy();
    }
    if (value.state === 'retained') retained = value.mode === mode;
  });
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  let ended;
  try {
    ended = await closed;
  } finally {
    clearTimeout(timer);
  }
  assert.equal(spawnError, undefined);
  assert.equal(ended.code, 0, stderr);
  assert.equal(ended.signal, null);
  assert.ok(retained);
  return { mode, pid: child.pid, closedPipe: true, actualCheckPrimaryRetained: true, ...ended };
}

async function retirementIntervention(root, mode) {
  const fixture = join(root, `retirement-${mode}`);
  const repository = join(fixture, 'repository');
  const temporary = join(fixture, 'temporary');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(temporary);
  const prior = [];
  for (let index = 0; index < 3; index++) {
    const allocation = allocateEvidence(repository, temporary);
    finishEvidence(allocation, 'success');
    fs.writeFileSync(
      join(allocation.owned, 'completion.json'),
      JSON.stringify({ state: 'success', completedAt: index }),
    );
    prior.push(allocation);
  }
  const candidate = prior[0];
  const current = allocateEvidence(repository, temporary);
  const owner = fs.readFileSync(join(candidate.owned, 'OWNER.json'));
  const completion = fs.readFileSync(join(candidate.owned, 'completion.json'));
  const inode = fs.lstatSync(candidate.owned).ino;
  const read = fs.readFileSync;
  const readdir = fs.readdirSync;
  let validated = false;
  let intervened = false;
  let caught;
  await overrideBuiltins(
    [
      [
        fs,
        'readdirSync',
        (path, ...args) => {
          const names = readdir(path, ...args);
          if (path !== temporary) return names;
          return [
            basename(candidate.owned),
            ...names.filter(
              (name) => ![basename(candidate.owned), basename(current.owned)].includes(name),
            ),
            basename(current.owned),
          ];
        },
      ],
      [
        fs,
        'readFileSync',
        (path, ...args) => {
          const value = read(path, ...args);
          if (path === join(candidate.owned, 'completion.json')) validated = true;
          if (path === join(current.owned, 'completion.json')) {
            assert.ok(validated);
            if (mode === 'foreign-owner') {
              fs.writeFileSync(
                join(candidate.owned, 'OWNER.json'),
                JSON.stringify({ ...JSON.parse(owner.toString('utf8')), repository: fixture }),
              );
            } else {
              fs.renameSync(candidate.owned, join(fixture, 'saved-completed'));
              fs.mkdirSync(candidate.owned);
              fs.writeFileSync(join(candidate.owned, 'OWNER.json'), owner);
              if (mode === 'completed-replacement')
                fs.writeFileSync(join(candidate.owned, 'completion.json'), completion);
              assert.notEqual(fs.lstatSync(candidate.owned).ino, inode);
            }
            fs.writeFileSync(join(candidate.owned, 'sentinel'), 'preserve unexpected claim');
            intervened = true;
          }
          return value;
        },
      ],
    ],
    async () => {
      try {
        finishEvidence(current, 'success');
      } catch (error) {
        caught = error;
      }
    },
  );
  assert.ok(validated && intervened);
  assert.equal(caught?.message, 'Replay evidence retirement changed; claimed contents preserved.');
  const claims = fs
    .readdirSync(temporary)
    .filter((name) => name.startsWith('relavium-budget-replay-retirement-'));
  assert.equal(claims.length, 1);
  const claimed = join(temporary, claims[0], 'evidence');
  assert.equal(fs.readFileSync(join(claimed, 'sentinel'), 'utf8'), 'preserve unexpected claim');
  if (mode !== 'foreign-owner') assert.ok(fs.existsSync(join(fixture, 'saved-completed')));
  return { mode, validatedBeforeIntervention: true, unexpectedClaimPreserved: true };
}

export async function checkLifecycleGuards(owned, environment) {
  const root = join(owned, 'lifecycle-guards');
  fs.mkdirSync(root);
  const results = {
    stageWrites: await stageWriteControls(root, environment),
    spawnError: await spawnErrorControl(root, environment),
    retentionWrites: await retentionWriteControl(root, environment),
    diagnosticPipes: [],
    retirementClaims: [],
  };
  for (const mode of ['Error', 'undefined', 'null'])
    results.diagnosticPipes.push(await closedDiagnosticControl(root, environment, mode));
  for (const mode of ['foreign-owner', 'active-replacement', 'completed-replacement'])
    results.retirementClaims.push(await retirementIntervention(root, mode));
  fs.writeFileSync(join(root, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  return results;
}
