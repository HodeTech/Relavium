import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['whole', 'split'])(
  'makes progress through escaped literal tick runs in the actual %s path',
  (mode) => {
    const fixture = fileURLToPath(new URL('./fixtures/opaque-run-progress.mjs', import.meta.url));
    const loader = fileURLToPath(
      new URL('../../engine/fixtures/ts-resolve-hook.mjs', import.meta.url),
    );
    const output = execFileSync(
      process.execPath,
      [
        '--max-old-space-size=256',
        '--no-warnings',
        '--experimental-strip-types',
        '--loader',
        loader,
        fixture,
        mode,
      ],
      // An in-process Vitest timeout cannot preempt a synchronous no-progress loop.
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(output).toBe(`opaque run progress passed: ${mode}\n`);
  },
  15_000,
);
