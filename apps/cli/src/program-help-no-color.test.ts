import { describe, expect, it } from 'vitest';

import { resolveGlobalOptions } from './process/options.js';
import { run } from './run.js';
import { captureIo } from './test-support.js';

/**
 * The shell `--help` says what the colour resolver does with `NO_COLOR` (MVP-11 step 1, defect N6). The help used to say "any value ⇒
 * off" while `process/options.ts` ignores an empty value, as no-color.org says. The sentence is the resolver's contract, so it is
 * pinned beside the resolver's own behaviour. It lives in its own file, not in `run.test.ts`, whose test count a causal control pins.
 */
describe('the --help colour precedence line', () => {
  it('says a non-empty NO_COLOR switches colour off, and the resolver does exactly that', async () => {
    const { io, out } = captureIo();
    expect(await run(['node', 'relavium', '--help'], io)).toBe(0);
    expect(out()).toContain('NO_COLOR (non-empty ⇒ off)');
    expect(out()).not.toContain('NO_COLOR (any value');
    expect(resolveGlobalOptions({}, '/w', { NO_COLOR: '1' }).color).toBe(false);
    expect(resolveGlobalOptions({}, '/w', { NO_COLOR: '0' }).color).toBe(false); // even "0" is non-empty
    expect(resolveGlobalOptions({}, '/w', { NO_COLOR: '' }).color).toBe(true); // an empty value is ignored
  });
});
