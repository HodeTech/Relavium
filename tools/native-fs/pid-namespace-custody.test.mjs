/** Probe-protocol controls only; synthetic native/proc data is never platform evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const [phase, sameNamespace, admitted] of [
  ['live', false, true],
  ['live', true, false],
  ['dead', true, true],
]) {
  test(`namespace probe ${phase}: same identity=${sameNamespace} admitted=${admitted}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'relavium-namespace-protocol-'));
    try {
      const preload = join(scratch, 'protocol.cjs');
      writeFileSync(
        preload,
        `const fs = require('node:fs');
const modules = require('node:module');
const read = fs.readFileSync;
const exists = fs.existsSync;
const link = fs.readlinkSync;
fs.readFileSync = (path, ...args) => String(path) === '/fixture/producer-ready.json'
  ? JSON.stringify({ pid: 134, namespace: ${JSON.stringify(sameNamespace ? 'pid:[7]' : 'pid:[8]')} })
  : read(path, ...args);
fs.existsSync = (path) => String(path) === '/fixture/work/target' ? false : exists(path);
fs.readlinkSync = (path, ...args) => String(path) === '/proc/self/ns/pid' ? 'pid:[7]' : link(path, ...args);
modules.syncBuiltinESMExports();
process.kill = (pid, signal) => {
  if (pid !== 134 || signal !== 0) throw new Error('Unexpected probe signal');
  throw Object.assign(new Error('Absent in consumer namespace'), { code: 'ESRCH' });
};
const load = modules._load;
modules._load = function(request, ...args) {
  if (request !== '/addon.node') return load.call(this, request, ...args);
  return {
    createWriteCancellation: () => ({}),
    recoverMetadataStaging: async (home) => {
      if (home !== '/fixture/home') throw new Error('Unexpected probe home');
      process.stdout.write('recovery-reached\\n');
      return process.argv[3] === 'live' ? { removed: 0, retained: 1 } : { removed: 1, retained: 0 };
    },
  };
};
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--require',
          preload,
          fileURLToPath(new URL('./pid-namespace-custody.mjs', import.meta.url)),
          '--consumer',
          phase,
        ],
        { encoding: 'utf8', timeout: 10000, maxBuffer: 16384, shell: false },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, admitted ? 0 : 1, result.stderr);
      assert.equal(result.stdout, admitted ? 'recovery-reached\n' : '');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

// Argument controls run the actual orchestrator with a throwing process witness,
// so no test can reach Docker or mistake fake recovery for native evidence.
for (const [label, image, binary, unsafeScript, admitted] of [
  ['ordinary inputs', 'relavium-native-fs-x64-gnu-10001-10001', '/tmp/addon.node', false, true],
  ['option-shaped image', '--privileged', '/tmp/addon.node', false, false],
  ['foreign image family', 'unreviewed-image', '/tmp/addon.node', false, false],
  ['image suffix syntax', 'relavium-native-fs:latest', '/tmp/addon.node', false, false],
  [
    'source field injection',
    'relavium-native-fs-x64-gnu-10001-10001',
    '/tmp/addon.node,src=/other.node',
    false,
    false,
  ],
  ['source quote', 'relavium-native-fs-x64-gnu-10001-10001', '/tmp/addon".node', false, false],
  ['source newline', 'relavium-native-fs-x64-gnu-10001-10001', '/tmp/addon\n.node', false, false],
  [
    'source carriage return',
    'relavium-native-fs-x64-gnu-10001-10001',
    '/tmp/addon\r.node',
    false,
    false,
  ],
  ['source NUL', 'relavium-native-fs-x64-gnu-10001-10001', '/tmp/addon\0.node', false, false],
  [
    'script source delimiter',
    'relavium-native-fs-x64-gnu-10001-10001',
    '/tmp/addon.node',
    true,
    false,
  ],
]) {
  test(`namespace argument admission: ${label}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'relavium-namespace-arguments-'));
    try {
      const preload = join(scratch, 'process-witness.cjs');
      writeFileSync(
        preload,
        `const child = require('node:child_process');
const modules = require('node:module');
process.getuid = () => 10001;
process.getgid = () => 10001;
process.argv[3] = ${JSON.stringify(binary)};
child.spawnSync = () => {
  process.stdout.write('docker-reached\\n');
  throw new Error('DOCKER_ARGUMENT_WITNESS');
};
modules.syncBuiltinESMExports();
`,
      );
      let script = fileURLToPath(new URL('./pid-namespace-custody.mjs', import.meta.url));
      if (unsafeScript) {
        const directory = join(scratch, 'comma,checkout');
        mkdirSync(directory);
        const copied = join(directory, 'pid-namespace-custody.mjs');
        copyFileSync(script, copied);
        script = copied;
      }
      const result = spawnSync(
        process.execPath,
        ['--require', preload, script, image, '/unused-by-preload.node'],
        { encoding: 'utf8', timeout: 10000, maxBuffer: 16384, shell: false },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, admitted ? 'docker-reached\n' : '');
      assert.match(
        result.stderr,
        admitted ? /DOCKER_ARGUMENT_WITNESS/u : /NATIVE_PID_NAMESPACE_ARGUMENTS/u,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
