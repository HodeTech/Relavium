/** Probe-protocol controls only; synthetic native/proc data is never platform evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
