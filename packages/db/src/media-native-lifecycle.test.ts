import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const execute = promisify(execFile);

it.each([
  ['deinline-eio', 'de-inline EIO cleans the real temporary before joining actual native close'],
  [
    'direct-store-eio',
    'raw store EIO cleans the real temporary before joining actual native close',
  ],
  ['abandon', 'direct native return and subsequent helper close join the same real retirement'],
  ['lazy', 'exact public native registration precedes the lazy first pull'],
  ['injected-foreign', 'injected dependencies remain foreign until explicit trusted adoption'],
  ['adopted-eof', 'an adopted finite view joins real native close before EOF and publication'],
  ['eof', 'a native EOF joins real close acknowledgement before CAS publication'],
  ['whole-buffer', 'the whole-buffer twin joins real native EOF close acknowledgement'],
])(
  '%s: %s',
  async (mode) => {
    const result = await execute(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        new URL('./fixtures/media-temporary-register.ts', import.meta.url).href,
        fileURLToPath(new URL('./fixtures/media-native-lifecycle-worker.ts', import.meta.url)),
        mode,
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({ mode, joined: true });
    expect(
      report,
      mode === 'adopted-eof'
        ? 'FS_CAUSAL_MEDIA_ADOPTED_EOF_JOIN'
        : mode === 'injected-foreign'
          ? 'MEDIA_NATIVE_INJECTED_FOREIGN'
          : mode === 'lazy'
            ? 'MEDIA_NATIVE_CONSTRUCTOR_REGISTERED'
            : 'FS_CAUSAL_MEDIA_NATIVE_CLOSE_JOIN',
    ).toMatchObject({ witnessFailure: null });
  },
  15_000,
);
