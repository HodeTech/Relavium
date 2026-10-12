import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);

describe.each(['whole-buffer', 'filesystem-store'])('%s native Content-Type admission', (mode) => {
  it.each([
    'compatible',
    'compatible-parameters',
    'conflicting',
    'compatible-conflicting',
    'conflicting-compatible',
    'identical',
    'parameters-conflicting',
    'conflicting-parameters',
    'mixed-header-case',
  ])(
    '%s retains original field multiplicity before body consumption',
    async (fixture) => {
      const result = await execute(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          new URL('./fixtures/media-temporary-register.ts', import.meta.url).href,
          fileURLToPath(new URL('./fixtures/media-native-headers-worker.ts', import.meta.url)),
          mode,
          fixture,
        ],
        { timeout: 10_000, maxBuffer: 64 * 1024 },
      );
      const report: unknown = JSON.parse(result.stdout);
      expect(report).toMatchObject({ mode, fixture, joined: true });
      expect(report, 'MEDIA_NATIVE_HEADER_MULTIPLICITY').toMatchObject({
        admissionFailure: null,
      });
      expect(report, 'MEDIA_NATIVE_HEADER_CLOSE_JOIN').toMatchObject({ closeFailure: null });
    },
    15_000,
  );
});
