import type { RunSummaryRecord } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { classifyActiveRuns } from './active-model.js';
import { buildDefinedModel, type DefinedOtherPin } from './defined-model.js';
import { buildHistoryRows, storedPlace } from './history-model.js';
import { MAX_PROJECT_ROOT_CHARS } from './run-detail-model.js';

/**
 * The directory a History, Active or Defined row carries is named by ONE rule ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §8): the project itself in words, never a lone `.` (observed on the History tab as `cost free · 34a41108-… · .`), a directory inside the project from the
 * project, one inside the home from `~`, and one outside both whole. It is shortened first, then scrubbed WHOLE (it is stored text that could carry a
 * secret) and bounded, and a `~` that only appeared because a control character in front of it was taken out keeps a `./`. The three models are
 * held to the same table, so a tab cannot go back to its own spelling.
 */
const ROOTS = { cwd: '/work/project', home: '/home/me' } as const;
const NOW = Date.parse('2026-11-25T12:00:00.000Z');
// A key-shaped string, built from parts so no literal credential sits in the source.
const KEY = `sk-${'A1b2C3d4E5'.repeat(3)}`;

const RUN_FIELDS = {
  workflowId: 'wf-id',
  status: 'running',
  executionMode: 'local',
  triggerType: 'manual',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: '2026-11-25T11:00:00.000Z',
  updatedAt: '2026-11-25T11:00:00.000Z',
} as const;

const runAt = (projectRoot: string): RunSummaryRecord => ({
  ...RUN_FIELDS,
  id: 'run-1',
  projectRoot,
});

/** The directory each of the three models says for a run (or a pin) recorded under `root`. */
const THREE_MODELS: readonly (readonly [
  name: string,
  say: (root: string, paths: typeof ROOTS | undefined) => string | undefined,
])[] = [
  [
    'the History tab',
    (root, paths) =>
      buildHistoryRows({
        runs: [runAt(root)],
        nowMs: NOW,
        pinnedRunIds: new Set(),
        ...(paths === undefined ? {} : { paths }),
      })[0]?.projectRoot,
  ],
  [
    'the Active tab',
    (root, paths) =>
      classifyActiveRuns({
        runs: [runAt(root)],
        leases: new Map(),
        currentProjectRoot: root,
        outboxHeldRunIds: new Set(),
        nowMs: NOW,
        leaseTtlMs: 60_000,
        ...(paths === undefined ? {} : { paths }),
      })[0]?.projectRoot,
  ],
  [
    'the Defined tab',
    (root, paths) => {
      const other: DefinedOtherPin = {
        kind: 'workflow',
        ref: 'nightly',
        rowid: 1,
        oversized: false,
        projectRoot: root,
      };
      return buildDefinedModel({
        entries: [],
        pins: [],
        otherPins: [other],
        ...(paths === undefined ? {} : { paths }),
      }).rows[0]?.projectRoot;
    },
  ],
];

const TABLE = [
  ['the project itself, in words and never a lone dot', '/work/project', '. (project root)'],
  [
    'a directory inside the project, from the project',
    '/work/project/packages/app',
    'packages/app',
  ],
  ['a directory inside the home, from ~', '/home/me/other', '~/other'],
  ['a directory outside both, whole', '/opt/shared/tools', '/opt/shared/tools'],
  [
    'a `~` that appears only when a control character in front of it goes',
    '/work/project/\u0007~/x',
    './~/x',
  ],
] as const;

describe.each(THREE_MODELS)('%s names a run’s directory', (_name, say) => {
  it.each(TABLE)('as a person does: %s', (_case, root, shown) => {
    expect(say(root, ROOTS)).toBe(shown);
  });

  it('as it was stored when it has no roots to shorten against', () => {
    expect(say('/work/project', undefined)).toBe('/work/project');
    expect(say('/home/me/other', undefined)).toBe('/home/me/other');
  });

  it('after shortening, with a secret in it masked whole and the row bounded', () => {
    const masked = say(`/home/me/${KEY}`, ROOTS) ?? '';
    expect(masked.startsWith('~/')).toBe(true);
    expect(masked).not.toContain('sk-A1b2');
    expect(say(`/home/me/${'p'.repeat(5000)}`, ROOTS)?.length).toBeLessThanOrEqual(
      MAX_PROJECT_ROOT_CHARS + 1,
    );
  });
});

describe('storedPlace', () => {
  it('cuts at the tail and marks the cut, as every stored text does, rather than at the front', () => {
    const shown = storedPlace(`/opt/${'a'.repeat(50)}`, ROOTS, 20);
    expect(shown).toBe(`/opt/${'a'.repeat(15)}…`);
  });
});
