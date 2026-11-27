/**
 * The scan of the catalog for `r` on a run's detail is bounded at 1,024 entries exactly (MVP-11 unit 7, round 2; `ENTRY_SCAN_MAX` of
 * `run-again.ts`): a catalog is read by index until an index names none, and the bound is only for a port that never says so. A bound that moved
 * by one finds an entry that is past the `/workflows` popup's reach, or misses the last one inside it.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDefinedModel } from '../../history/defined-model.js';
import { RUN_AGAIN_NOT_DEFINED, decideRunAgain } from './run-again.js';
import { runDetailRead } from './run-again.test-support.js';
import type { DefinedPort } from '../../history/defined-model.js';

/** The detail of a run of this directory that was recorded under `slug`. */
const detailOf = (slug: string) => runDetailRead({ directory: 'here', workflowSlug: slug });

/** A catalog that never ends: every index names an entry (slug `wf-<index>`), so only the scan's own bound stops the walk. */
function endlessPort(): { port: DefinedPort; asked: number[] } {
  const asked: number[] = [];
  const port: DefinedPort = {
    read: () => ({
      model: buildDefinedModel({ entries: [], pins: [] }),
      slugOf: (index: number) => {
        asked.push(index);
        return `wf-${String(index)}`;
      },
      pathOf: (index: number) => `wf-${String(index)}.yaml`,
    }),
  };
  return { port, asked };
}

describe('the catalog scan is bounded at 1,024 entries', () => {
  it('the last entry the scan reaches (index 1023) is found, and the one past it (1024) is not', () => {
    const { port } = endlessPort();
    expect(decideRunAgain(detailOf('wf-1023'), port)).toEqual({
      kind: 'run',
      slug: 'wf-1023',
      path: 'wf-1023.yaml',
    });
    expect(decideRunAgain(detailOf('wf-1024'), port)).toEqual({
      kind: 'refused',
      message: RUN_AGAIN_NOT_DEFINED,
    });
  });

  it('a slug that is not there asks the port 1,024 times, indexes 0 to 1023, and no more', () => {
    const { port, asked } = endlessPort();
    decideRunAgain(detailOf('nowhere'), port);
    expect(asked).toHaveLength(1_024);
    expect(asked[0]).toBe(0);
    expect(asked[1_023]).toBe(1_023);
  });

  it('the scan ends at the first index that names no entry (a short catalog is asked once past its end)', () => {
    const asked: number[] = [];
    const port: DefinedPort = {
      read: () => ({
        model: buildDefinedModel({ entries: [], pins: [] }),
        slugOf: (index: number) => {
          asked.push(index);
          return index < 3 ? `wf-${String(index)}` : undefined;
        },
        pathOf: (index: number) => `wf-${String(index)}.yaml`,
      }),
    };
    expect(decideRunAgain(detailOf('nowhere'), port)).toEqual({
      kind: 'refused',
      message: RUN_AGAIN_NOT_DEFINED,
    });
    expect(asked).toEqual([0, 1, 2, 3]);
  });

  it('a catalog read that throws is asked once, and the fault (it may carry a path) is not repeated', () => {
    const read = vi.fn((): never => {
      throw new Error('/secret/path could not be listed');
    });
    const decision = decideRunAgain(detailOf('nowhere'), { read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(decision)).not.toContain('secret');
  });
});
