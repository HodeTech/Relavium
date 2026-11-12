/** Bounded, isolated cross-PID-namespace custody proof using a real native addon. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const fixture = '/fixture';
const home = join(fixture, 'home');
const target = join(fixture, 'work', 'target');
const ready = join(fixture, 'producer-ready.json');
const mode = process.argv[2];
if (mode === '--producer') {
  const addon = createRequire(import.meta.url)('/addon.node');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(fixture, 'work'), { mode: 0o700 });
  const token = addon.createWriteCancellation();
  const prepared = await addon.prepareNewMetadata(target, process.umask()).catch((error) => {
    throw new Error('NATIVE_NAMESPACE_PREPARE', { cause: error });
  });
  // Keep both native handles and their claim live until the process is killed.
  const stage = await addon
    .stageNewMetadata(
      prepared,
      home,
      Buffer.from('private payload'),
      'a'.repeat(32),
      process.umask(),
      token,
    )
    .catch((error) => {
      throw new Error('NATIVE_NAMESPACE_STAGE', { cause: error });
    });
  assert.ok(stage);
  globalThis.__relaviumCustodyFixture = { stage, prepared, token };
  writeFileSync(ready, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  process.stdout.write('NATIVE_PID_NAMESPACE_READY\n');
  await new Promise(() => setInterval(() => {}, 1000));
} else if (mode === '--consumer') {
  const addon = createRequire(import.meta.url)('/addon.node');
  const { pid } = JSON.parse(readFileSync(ready, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 1);
  if (process.argv[3] === 'live') {
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error?.code === 'ESRCH',
    );
  }
  const result = await addon.recoverMetadataStaging(home, addon.createWriteCancellation());
  assert.deepEqual(
    result,
    process.argv[3] === 'live' ? { removed: 0, retained: 1 } : { removed: 1, retained: 0 },
  );
  assert.equal(existsSync(target), false);
} else {
  if (process.argv.length !== 4 || !process.getuid || !process.getgid)
    throw new Error('NATIVE_PID_NAMESPACE_ARGUMENTS');
  const image = process.argv[2];
  const binary = resolve(process.argv[3]);
  const prefix = `relavium-custody-${randomBytes(12).toString('hex')}`;
  const volume = `${prefix}-fixture`;
  const common = [
    '--network=none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--mount',
    `type=volume,src=${volume},dst=/fixture`,
    '--mount',
    `type=bind,src=${binary},dst=/addon.node,readonly`,
    '--mount',
    `type=bind,src=${script},dst=/native-stage-probe.mjs,readonly`,
  ];
  const docker = (args, timeout = 10000) =>
    spawnSync('docker', args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 16384,
      shell: false,
    });
  const success = (result) => !result.error && result.status === 0;
  const created = docker(['volume', 'create', volume]);
  if (!success(created)) throw new Error('NATIVE_PID_NAMESPACE_VOLUME');
  const containers = [];
  let unknownContainer = false;
  let producer;
  let joined;
  let primary;
  const createContainer = (name, command) => {
    // A timed-out create could have succeeded. Preserve the volume until
    // ownership and teardown can be established, rather than guessing.
    unknownContainer = true;
    const result = docker(['create', '--name', name, ...common, image, ...command]);
    if (!success(result)) throw new Error('NATIVE_PID_NAMESPACE_CREATE');
    containers.push(name);
    unknownContainer = false;
  };
  try {
    const producerName = `${prefix}-producer`;
    createContainer(producerName, ['sh', '-c', 'node /native-stage-probe.mjs --producer & wait']);
    producer = spawn('docker', ['start', '--attach', producerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let output = '';
    let overflow = false;
    const collect = (chunk) => {
      const text = chunk.toString();
      if (output.length + text.length > 16384) overflow = true;
      output = (output + text).slice(0, 16384);
    };
    producer.stdout.on('data', collect);
    producer.stderr.on('data', collect);
    joined = new Promise((done) => {
      producer.once('close', () => done(true));
      producer.once('error', () => done(true));
    });
    const deadline = Date.now() + 30000;
    while (
      !output.includes('NATIVE_PID_NAMESPACE_READY\n') &&
      !overflow &&
      Date.now() < deadline &&
      producer.exitCode === null
    )
      await delay(50);
    if (!output.includes('NATIVE_PID_NAMESPACE_READY\n') || overflow)
      throw new Error(`NATIVE_PID_NAMESPACE_PRODUCER: ${output.slice(0, 2048)}`);
    const runConsumer = (state) => {
      const name = `${prefix}-${state}`;
      createContainer(name, ['node', '/native-stage-probe.mjs', '--consumer', state]);
      const result = docker(['start', '--attach', name], 30000);
      if (!success(result))
        throw new Error(
          `NATIVE_PID_NAMESPACE_CONSUMER_${state}: ${(result.stderr ?? '').slice(0, 2048)}`,
        );
    };
    runConsumer('live');
    if (!success(docker(['kill', producerName]))) throw new Error('NATIVE_PID_NAMESPACE_KILL');
    if (!(await Promise.race([joined, delay(10000, false, { ref: false })])))
      throw new Error('NATIVE_PID_NAMESPACE_JOIN');
    if (!success(docker(['wait', producerName]))) throw new Error('NATIVE_PID_NAMESPACE_WAIT');
    runConsumer('dead');
  } catch (error) {
    primary = error;
  }
  // Every successful create has a unique owned name. Inspect, kill if still
  // running (including a timed-out consumer), wait, then remove. Any unknown
  // state retains the volume and its evidence.
  const cleanupErrors = [];
  for (const name of containers.reverse()) {
    const state = docker(['inspect', '--format', '{{.State.Running}}', name]);
    if (!success(state) || !['true', 'false'].includes(state.stdout.trim())) {
      cleanupErrors.push(new Error('NATIVE_PID_NAMESPACE_INSPECT'));
      continue;
    }
    if (state.stdout.trim() === 'true' && !success(docker(['kill', name]))) {
      cleanupErrors.push(new Error('NATIVE_PID_NAMESPACE_KILL_CLEANUP'));
      continue;
    }
    if (!success(docker(['wait', name])) || !success(docker(['rm', name])))
      cleanupErrors.push(new Error('NATIVE_PID_NAMESPACE_JOIN_CLEANUP'));
  }
  if (joined && !(await Promise.race([joined, delay(10000, false, { ref: false })])))
    cleanupErrors.push(new Error('NATIVE_PID_NAMESPACE_UNJOINED'));
  if (unknownContainer) cleanupErrors.push(new Error('NATIVE_PID_NAMESPACE_CREATE_UNCERTAIN'));
  if (cleanupErrors.length === 0 && !success(docker(['volume', 'rm', volume])))
    cleanupErrors.push(new Error('NATIVE_PID_NAMESPACE_VOLUME_CLEANUP'));
  if (primary && cleanupErrors.length)
    throw new AggregateError([primary, ...cleanupErrors], 'NATIVE_PID_NAMESPACE_FAILED');
  if (primary) throw primary;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'NATIVE_PID_NAMESPACE_CLEANUP');
  console.log('native-pid-namespace-custody: passed');
}
