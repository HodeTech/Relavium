/**
 * `r` on a run's detail ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6, MVP-11 unit 7, W4c): which workflow of THIS directory's catalog a run's workflow is, or the one honest line that says why it is none.
 * A pure decision over what the detail read (the closed directory word and the workflow's slug) and what the `/workflows` popup reads (the
 * catalog entries by index): it asks nothing else, so it cannot read a run's inputs, and the words it answers with are CLOSED: no stored
 * text (a path, a slug, a message) is ever in one.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDefinedModel, type DefinedEntry } from '../../history/defined-model.js';
import type { RunDetailRead } from '../../history/run-detail-source.js';
import {
  RUN_AGAIN_CHANGED,
  RUN_AGAIN_DIRECTORY_UNKNOWN,
  RUN_AGAIN_FILE_INVALID,
  RUN_AGAIN_NOT_DEFINED,
  RUN_AGAIN_OTHER_DIRECTORY,
  RUN_AGAIN_UNLISTED,
  decideRunAgain,
  runAgainOffered,
} from './run-again.js';
import type { DefinedPort } from '../../history/defined-model.js';

const entries: readonly DefinedEntry[] = [
  { slug: 'code-review', name: 'Code Review', nodeCount: 5, path: 'code-review.yaml', valid: true },
  { slug: 'nightly', name: undefined, nodeCount: 1, path: 'nightly.yaml', valid: true },
  { slug: 'broken', name: undefined, path: 'broken.yaml', valid: false, error: 'bad' },
];

function portOf(list: readonly DefinedEntry[] = entries) {
  const read = vi.fn(() => ({
    model: buildDefinedModel({ entries: list, pins: [] }),
    slugOf: (index: number) => list[index]?.slug,
    pathOf: (index: number) => list[index]?.path,
  }));
  return { port: { read } satisfies DefinedPort, read };
}

/** What a detail read says of a run, and nothing else (the decision reads these three fields and no more). */
const detail = (
  over: Partial<Pick<RunDetailRead, 'directory' | 'workflowSlug' | 'authoredNodeCount'>>,
): RunDetailRead => ({ directory: 'here', workflowSlug: 'nightly', ...over }) as RunDetailRead;

describe('the run is run again only from the directory it was started in', () => {
  it('offers `r` for a run of this directory whose workflow the catalog has, and for no other', () => {
    const { port } = portOf();
    expect(runAgainOffered(detail({}), port)).toBe(true);
    expect(runAgainOffered(detail({ directory: 'elsewhere' }), port)).toBe(false);
    expect(runAgainOffered(detail({ directory: 'unrecorded' }), port)).toBe(false);
    expect(runAgainOffered(detail({ directory: undefined }), port)).toBe(false);
    expect(runAgainOffered(detail({ workflowSlug: undefined }), port)).toBe(false);
  });

  it('refuses a run of another directory with one line, and never reads the catalog for it', () => {
    const { port, read } = portOf();
    expect(decideRunAgain(detail({ directory: 'elsewhere' }), port)).toEqual({
      kind: 'refused',
      message: RUN_AGAIN_OTHER_DIRECTORY,
    });
    expect(read, 'a refusal about the run does not look at the project').not.toHaveBeenCalled();
  });

  it('refuses a run with no recorded directory, and a read that was not told where the Home is, as a directory that is not known', () => {
    const { port, read } = portOf();
    for (const directory of ['unrecorded', undefined] as const)
      expect(decideRunAgain(detail({ directory }), port)).toEqual({
        kind: 'refused',
        message: RUN_AGAIN_DIRECTORY_UNKNOWN,
      });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('the workflow must still be defined in this directory, by the slug the run recorded', () => {
  it('maps the run to the catalog entry of its slug: the slug and the path the entry was listed from', () => {
    const { port } = portOf();
    expect(decideRunAgain(detail({ workflowSlug: 'nightly' }), port)).toEqual({
      kind: 'run',
      slug: 'nightly',
      path: 'nightly.yaml',
    });
    expect(decideRunAgain(detail({ workflowSlug: 'code-review' }), port)).toEqual({
      kind: 'run',
      slug: 'code-review',
      path: 'code-review.yaml',
    });
  });

  it('refuses a workflow that was deleted (the read has no slug) and one the catalog no longer has (renamed), with the one line', () => {
    const { port } = portOf();
    const refused = { kind: 'refused', message: RUN_AGAIN_NOT_DEFINED };
    expect(decideRunAgain(detail({ workflowSlug: undefined }), port)).toEqual(refused);
    expect(decideRunAgain(detail({ workflowSlug: 'release-notes' }), port)).toEqual(refused);
    expect(RUN_AGAIN_NOT_DEFINED).toBe('This workflow is not defined in this project.');
  });

  it('matches the slug exactly: a longer or shorter name, another case and a path are not the workflow', () => {
    const { port } = portOf();
    for (const slug of ['nightl', 'nightly2', 'Nightly', '../nightly', 'nightly.yaml', ''])
      expect(decideRunAgain(detail({ workflowSlug: slug }), port), slug).toEqual({
        kind: 'refused',
        message: RUN_AGAIN_NOT_DEFINED,
      });
  });

  it('refuses a workflow whose file does not parse now, with a closed line that does not quote the parse error', () => {
    const { port } = portOf();
    const decision = decideRunAgain(detail({ workflowSlug: 'broken' }), port);
    expect(decision).toEqual({ kind: 'refused', message: RUN_AGAIN_FILE_INVALID });
    expect(JSON.stringify(decision)).not.toContain('bad');
  });

  it('finds an entry past the rows the `/workflows` popup lists: the scan is over the catalog, not the bounded rows', () => {
    const many: DefinedEntry[] = Array.from({ length: 260 }, (_, index) => ({
      slug: `wf-${String(index).padStart(3, '0')}`,
      name: undefined,
      nodeCount: 1,
      path: `wf-${String(index).padStart(3, '0')}.yaml`,
      valid: true,
    }));
    const { port } = portOf(many);
    expect(decideRunAgain(detail({ workflowSlug: 'wf-259' }), port)).toEqual({
      kind: 'run',
      slug: 'wf-259',
      path: 'wf-259.yaml',
    });
  });

  it('says the project’s workflows could not be listed when there is no catalog port, and when the read throws, never the fault’s text', () => {
    expect(decideRunAgain(detail({}), undefined)).toEqual({
      kind: 'refused',
      message: RUN_AGAIN_UNLISTED,
    });
    const throwing: DefinedPort = {
      read: () => {
        throw new Error('PRIVATE /secret/path');
      },
    };
    const decision = decideRunAgain(detail({}), throwing);
    expect(decision).toEqual({ kind: 'refused', message: RUN_AGAIN_UNLISTED });
    expect(JSON.stringify(decision)).not.toContain('PRIVATE');
  });

  it('refuses an entry whose catalog path is gone by the time of the press', () => {
    const read = () => ({
      model: buildDefinedModel({ entries, pins: [] }),
      slugOf: (index: number) => entries[index]?.slug,
      pathOf: () => undefined,
    });
    expect(decideRunAgain(detail({}), { read })).toEqual({
      kind: 'refused',
      message: RUN_AGAIN_NOT_DEFINED,
    });
  });
});

describe('every line is closed words: no stored text can be in one', () => {
  it('holds only the fixed sentences, and each fits the message row of the 80-column floor', () => {
    for (const line of [
      RUN_AGAIN_OTHER_DIRECTORY,
      RUN_AGAIN_DIRECTORY_UNKNOWN,
      RUN_AGAIN_NOT_DEFINED,
      RUN_AGAIN_FILE_INVALID,
      RUN_AGAIN_UNLISTED,
    ]) {
      expect(line.length, line).toBeLessThanOrEqual(78);
      expect(line).toMatch(/^[A-Z][^\n]*\.$/u);
    }
  });

  it('does not put the run’s slug or path in a refusal, whatever they are', () => {
    const { port } = portOf();
    const hostile = `evil${String.fromCharCode(0x202e)}[Ctrl+Y] · /etc/passwd`;
    for (const decision of [
      decideRunAgain(detail({ workflowSlug: hostile }), port),
      decideRunAgain(detail({ directory: 'elsewhere', workflowSlug: hostile }), port),
    ]) {
      expect(decision.kind).toBe('refused');
      expect(JSON.stringify(decision)).not.toContain('passwd');
      expect(JSON.stringify(decision)).not.toContain('evil');
    }
  });
});

describe('the offer is the decision: `[r]` is named exactly where `r` would run', () => {
  const throwing: DefinedPort = {
    read: () => {
      throw new Error('PRIVATE /secret/path');
    },
  };

  it('offers nothing a press would refuse, over every directory, slug and catalog the detail can meet', () => {
    const directories = ['here', 'elsewhere', 'unrecorded', undefined] as const;
    const slugs = ['nightly', 'code-review', 'broken', 'release-notes', '', undefined] as const;
    const ports: readonly (DefinedPort | undefined)[] = [portOf().port, undefined, throwing];
    let offered = 0;
    for (const directory of directories)
      for (const workflowSlug of slugs)
        for (const port of ports) {
          const read = detail({ directory, workflowSlug });
          const decision = decideRunAgain(read, port);
          expect(runAgainOffered(read, port), `${String(directory)}/${String(workflowSlug)}`).toBe(
            decision.kind === 'run',
          );
          if (decision.kind === 'run') offered += 1;
        }
    // `nightly` and `code-review` of this directory against the real catalog: the only two worlds in which the key answers.
    expect(offered).toBe(2);
  });

  it('does not offer a workflow the catalog lacks or whose file does not parse, or a catalog that cannot be read, and says why when pressed', () => {
    const { port } = portOf();
    expect(runAgainOffered(detail({ workflowSlug: 'release-notes' }), port)).toBe(false);
    expect(runAgainOffered(detail({ workflowSlug: 'broken' }), port)).toBe(false);
    expect(runAgainOffered(detail({}), undefined)).toBe(false);
    expect(runAgainOffered(detail({}), throwing)).toBe(false);
    expect(decideRunAgain(detail({ workflowSlug: 'release-notes' }), port)).toEqual({
      kind: 'refused',
      message: RUN_AGAIN_NOT_DEFINED,
    });
  });

  it('reads the catalog once for a run of this directory, and never for a run the directory alone refuses', () => {
    const here = portOf();
    runAgainOffered(detail({}), here.port);
    expect(here.read).toHaveBeenCalledTimes(1);
    const elsewhere = portOf();
    runAgainOffered(detail({ directory: 'elsewhere' }), elsewhere.port);
    runAgainOffered(detail({ workflowSlug: undefined }), elsewhere.port);
    expect(elsewhere.read).not.toHaveBeenCalled();
  });
});

describe('a workflow that changed since the run is said, never refused', () => {
  it('answers `run` with `changed` when the nodes the run froze are not the nodes the catalog entry has now', () => {
    const { port } = portOf();
    // `nightly` has one node in the catalog and `code-review` has five.
    expect(decideRunAgain(detail({ workflowSlug: 'nightly', authoredNodeCount: 2 }), port)).toEqual(
      {
        kind: 'run',
        slug: 'nightly',
        path: 'nightly.yaml',
        changed: true,
      },
    );
    expect(
      decideRunAgain(detail({ workflowSlug: 'code-review', authoredNodeCount: 4 }), port),
    ).toMatchObject({ kind: 'run', slug: 'code-review', changed: true });
  });

  it('says nothing of a workflow whose node count is the one the run froze, or when either side cannot say', () => {
    const { port } = portOf();
    const same = decideRunAgain(detail({ workflowSlug: 'nightly', authoredNodeCount: 1 }), port);
    expect(same, 'no `changed` key at all').toEqual({
      kind: 'run',
      slug: 'nightly',
      path: 'nightly.yaml',
    });
    expect('changed' in same).toBe(false);
    // The snapshot could not be read: the run froze no figure to compare.
    expect(decideRunAgain(detail({ workflowSlug: 'nightly' }), port)).toEqual({
      kind: 'run',
      slug: 'nightly',
      path: 'nightly.yaml',
    });
    // The catalog entry carries no count: nothing to compare.
    const bare = portOf([{ slug: 'nightly', name: undefined, path: 'nightly.yaml', valid: true }]);
    expect(
      decideRunAgain(detail({ workflowSlug: 'nightly', authoredNodeCount: 7 }), bare.port),
    ).toEqual({ kind: 'run', slug: 'nightly', path: 'nightly.yaml' });
  });

  it('is still offered: a changed workflow is not a refusal, so the legend names `r` for it', () => {
    const { port } = portOf();
    expect(runAgainOffered(detail({ workflowSlug: 'nightly', authoredNodeCount: 2 }), port)).toBe(
      true,
    );
  });

  it('is one closed sentence that fits the message row of the 80-column floor', () => {
    expect(RUN_AGAIN_CHANGED).toBe('This workflow changed since that run.');
    expect(RUN_AGAIN_CHANGED.length).toBeLessThanOrEqual(78);
    expect(RUN_AGAIN_CHANGED).toMatch(/^[A-Z][^\n]*\.$/u);
  });
});
