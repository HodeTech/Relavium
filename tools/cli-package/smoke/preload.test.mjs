import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { explicitEnvironment, invoke, ndjson } from './process.mjs';

test('package preload refuses and witnesses HTTP/2 default, named and CommonJS entry points', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-http2-denial-'));
  const log = join(root, 'calls.ndjson');
  try {
    const result = await invoke(
      [
        '--import',
        new URL('./preload.mjs', import.meta.url).href,
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        import http2, { connect, createServer, createSecureServer } from 'node:http2';
        import { createRequire } from 'node:module';
        const common = createRequire(import.meta.url)('node:http2');
        for (const methods of [http2, { connect, createServer, createSecureServer }, common]) {
          for (const name of ['connect', 'createServer', 'createSecureServer']) {
            assert.throws(() => {
              const resource = methods[name]('http://127.0.0.1:1');
              resource?.on?.('error', () => {});
              resource?.destroy?.();
              resource?.close?.();
            }, { message: 'Package smoke refuses http2.' + name });
          }
        }
      `,
      ],
      {
        cwd: root,
        env: explicitEnvironment(root, root, { RELAVIUM_PACKAGE_SMOKE_LOG: log }),
        timeout: 5000,
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(
      ndjson(readFileSync(log, 'utf8')),
      Array.from({ length: 3 }, () =>
        ['connect', 'createServer', 'createSecureServer'].map((name) => ({
          operation: `http2.${name}`,
          denied: true,
        })),
      ).flat(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
