import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const execute = promisify(execFile);

it.each(['foreign', 'registered'])(
  '%s iterator return observes the original rejection without leaking host diagnostics',
  async (ownership) => {
    const result = await execute(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--import',
        new URL('./fixtures/media-temporary-register.ts', import.meta.url).href,
        fileURLToPath(new URL('./fixtures/media-return-diagnostics-worker.ts', import.meta.url)),
        ownership,
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ownership, cases: 13, joined: true });
    expect(report, 'MEDIA_RETURN_DIAGNOSTICS_OBSERVED').toMatchObject({
      unhandledRejections: 0,
      originalUnhandledRejections: 0,
    });
    expect(report, 'MEDIA_RETURN_DIAGNOSTICS_PROTOCOL').toMatchObject({
      acknowledgementsCorrect: true,
      cachedOnce: true,
      pendingContract: true,
      primaryFailuresPreserved: true,
      unpublished: true,
      diagnosticsPrivate: true,
    });
    expect(result.stderr).toBe('');
  },
  15_000,
);
