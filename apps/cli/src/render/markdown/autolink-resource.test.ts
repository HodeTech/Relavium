import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('invalid email autolink resource bounds', () => {
  it.each(['cold', 'stream'])(
    'rejects a long dotted candidate through the actual %s path',
    (mode) => {
      const fixture = fileURLToPath(new URL('./fixtures/autolink-resource.mjs', import.meta.url));
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
        // A child deadline can preempt synchronous regex backtracking; Vitest's
        // own in-process timer cannot. This bounds the real parser/render path,
        // not a microbenchmark ratio or a test-only copy of its predicate.
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(output).toBe(`autolink resource passed: ${mode}\n`);
    },
    // Each independently killable child has ten seconds, including TS loading.
    15_000,
  );
});
