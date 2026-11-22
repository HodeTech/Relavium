import type { RunLeaseSummary, RunSummaryRecord } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import {
  STALLED_REASON,
  classifyActiveRuns,
  isStalled,
  type ActiveRow,
  type ClassifyActiveInput,
} from './active-model.js';

const HERE = '/work/project';
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const TTL = 60_000;

const BASE_FIELDS = {
  workflowId: 'wf-id',
  status: 'running',
  executionMode: 'local',
  triggerType: 'manual',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: '2026-11-22T11:00:00.000Z',
  updatedAt: '2026-11-22T11:00:00.000Z',
} as const;

function run(id: string, overrides: Partial<RunSummaryRecord> = {}): RunSummaryRecord {
  return { ...BASE_FIELDS, id, projectRoot: HERE, ...overrides };
}

/** A run that never recorded a project root. */
function unrootedRun(id: string, overrides: Partial<RunSummaryRecord> = {}): RunSummaryRecord {
  return { ...BASE_FIELDS, id, ...overrides };
}

const liveLease: RunLeaseSummary = { ownerId: 'owner', generation: 1, expiresAt: NOW + TTL };

function classify(
  runs: readonly RunSummaryRecord[],
  overrides: Partial<ClassifyActiveInput> = {},
): ActiveRow[] {
  return classifyActiveRuns({
    runs,
    leases: new Map(runs.map((r) => [r.id, liveLease])),
    currentProjectRoot: HERE,
    outboxHeldRunIds: new Set(),
    nowMs: NOW,
    leaseTtlMs: TTL,
    ...overrides,
  });
}

function only(rows: readonly ActiveRow[]): ActiveRow {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('unreachable');
  return row;
}

describe('the active classes', () => {
  it('hosted: the leg this Home executes is actionable and reopens its view', () => {
    const row = only(classify([run('r1')], { hostedRunId: 'r1' }));
    expect(row).toMatchObject({
      class: 'hosted',
      actionable: true,
      enter: 'reopen-view',
      stalled: false,
    });
    expect(row.reason).toBeUndefined();
  });

  it('other-running: another process`s pending or running run is read-only, with a reason', () => {
    for (const status of ['pending', 'running'] as const) {
      const row = only(classify([run('r2', { status })]));
      expect(row).toMatchObject({
        class: 'other-running',
        actionable: false,
        enter: 'inspect',
        reason: 'running in another process',
      });
    }
  });

  it('other-paused-here: a run paused at a gate in THIS project opens the gate card', () => {
    const row = only(
      classify([run('r3', { status: 'paused' })], {
        pendingGateCounts: new Map([['r3', 2]]),
      }),
    );
    expect(row).toMatchObject({
      class: 'other-paused-here',
      actionable: true,
      enter: 'open-gate-card',
    });
    expect(row.reason).toBeUndefined();
  });

  it('other-paused-elsewhere: a paused run from another project is read-only and says why', () => {
    const row = only(
      classify([run('r4', { status: 'paused', projectRoot: '/work/other' })], {
        pendingGateCounts: new Map([['r4', 1]]),
      }),
    );
    expect(row).toMatchObject({
      class: 'other-paused-elsewhere',
      actionable: false,
      reason: 'another project',
    });
  });

  it('other-paused-elsewhere: a run that never recorded a project is not this project`s', () => {
    const row = only(
      classify([unrootedRun('r5', { status: 'paused' })], {
        pendingGateCounts: new Map([['r5', 1]]),
      }),
    );
    expect(row).toMatchObject({
      class: 'other-paused-elsewhere',
      actionable: false,
      reason: 'project not recorded',
    });
  });

  it('held: a run whose terminal is in the outbox is read-only, even when it is also paused here', () => {
    const row = only(
      classify([run('r6', { status: 'paused' })], {
        outboxHeldRunIds: new Set(['r6']),
        pendingGateCounts: new Map([['r6', 1]]),
      }),
    );
    expect(row).toMatchObject({
      class: 'held',
      actionable: false,
      reason: 'terminal held in the outbox',
    });
  });

  it('held also wins over another project`s pause and over a running run', () => {
    const rows = classify(
      [run('r7', { status: 'paused', projectRoot: '/work/other' }), run('r8')],
      { outboxHeldRunIds: new Set(['r7', 'r8']) },
    );
    expect(rows.map((row) => row.class)).toEqual(['held', 'held']);
  });

  it('a media park (paused here with no gate) is read-only with its own reason, never a gate card', () => {
    const row = only(
      classify([run('r9', { status: 'paused' })], { pendingGateCounts: new Map([['r9', 0]]) }),
    );
    expect(row).toMatchObject({
      class: 'other-paused-media',
      actionable: false,
      enter: 'inspect',
      reason: 'waiting for a media job',
    });
  });

  it('paused-gate-unknown: without the gate facts a paused run here is NOT actionable (no guessing)', () => {
    const row = only(classify([run('r10', { status: 'paused' })]));
    expect(row).toMatchObject({
      class: 'paused-gate-unknown',
      actionable: false,
      reason: 'gate state not read',
    });
    // A map that lacks THIS run is the same as no map.
    expect(
      only(classify([run('r10', { status: 'paused' })], { pendingGateCounts: new Map([['x', 1]]) }))
        .class,
    ).toBe('paused-gate-unknown');
  });

  it('keeps hosted over held (the view is where the held remedy shows) and drops finished runs, held or not', () => {
    const hostedAndHeld = classify([run('h')], {
      hostedRunId: 'h',
      outboxHeldRunIds: new Set(['h']),
    });
    expect(only(hostedAndHeld).class).toBe('hosted');
    const finished = classify(
      [
        run('c', { status: 'completed' }),
        run('f', { status: 'failed' }),
        run('x', { status: 'cancelled' }),
      ],
      { outboxHeldRunIds: new Set(['c', 'f', 'x']), hostedRunId: 'c' },
    );
    expect(finished).toEqual([]);
  });

  it('puts every run in exactly one class', () => {
    const runs = [
      run('a'),
      run('b', { status: 'pending' }),
      run('c', { status: 'paused' }),
      run('d', { status: 'paused', projectRoot: '/work/other' }),
      run('e'),
      run('f', { status: 'paused' }),
    ];
    const rows = classify(runs, {
      hostedRunId: 'a',
      outboxHeldRunIds: new Set(['e']),
      pendingGateCounts: new Map([['c', 1]]),
    });
    expect(rows.map((row) => row.runId).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(Object.fromEntries(rows.map((row) => [row.runId, row.class]))).toEqual({
      a: 'hosted',
      b: 'other-running',
      c: 'other-paused-here',
      d: 'other-paused-elsewhere',
      e: 'held',
      f: 'paused-gate-unknown',
    });
  });
});

describe('stalled', () => {
  const at = (expiresAt: number) => new Map([['r', { ownerId: 'o', generation: 1, expiresAt }]]);
  const stalledOf = (
    leases: Map<string, RunLeaseSummary>,
    overrides: Partial<RunSummaryRecord> = {},
  ) => only(classify([run('r', overrides)], { leases }));

  it('is a running run with NO lease', () => {
    const row = stalledOf(new Map());
    expect(row).toMatchObject({ stalled: true, stalledReason: STALLED_REASON });
    expect(STALLED_REASON).toBe('settled by the next start');
  });

  it('is a lease expired by MORE than one TTL, and not a lease expired by exactly one TTL', () => {
    expect(stalledOf(at(NOW - TTL - 1)).stalled).toBe(true);
    expect(stalledOf(at(NOW - TTL)).stalled).toBe(false);
    expect(stalledOf(at(NOW - TTL + 1)).stalled).toBe(false);
    const old = new Date(NOW - 10 * TTL).toISOString();
    const stalledAt = (expiresAt: number) =>
      isStalled({
        lease: { ownerId: 'o', generation: 1, expiresAt },
        createdAt: old,
        nowMs: NOW,
        leaseTtlMs: TTL,
      });
    expect(stalledAt(NOW - TTL - 1)).toBe(true);
    expect(stalledAt(NOW - TTL)).toBe(false);
  });

  it('is not a live lease, a recently expired one, or an unexpired one', () => {
    expect(stalledOf(at(NOW + 1)).stalled).toBe(false);
    expect(stalledOf(at(NOW - 1)).stalled).toBe(false);
  });

  describe('a run younger than one lease TTL is not treated as crashed (ADR-0079, 2026-11-06)', () => {
    const createdAgo = (ageMs: number) => ({ createdAt: new Date(NOW - ageMs).toISOString() });
    const none = new Map<string, RunLeaseSummary>();

    it('a fresh run with no lease is not stalled: its owner may not have taken the lease yet', () => {
      const row = stalledOf(none, createdAgo(1_000));
      expect(row.stalled).toBe(false);
      expect(row.stalledReason).toBeUndefined();
    });

    it('an old run with no lease is stalled', () => {
      expect(stalledOf(none, createdAgo(10 * TTL)).stalled).toBe(true);
    });

    it('an old run with an expired lease is stalled, and a fresh one with the same lease is not', () => {
      const expired = at(NOW - TTL - 1);
      expect(stalledOf(expired, createdAgo(10 * TTL)).stalled).toBe(true);
      expect(stalledOf(expired, createdAgo(TTL - 1)).stalled).toBe(false);
    });

    it('an old run with a live lease is not stalled', () => {
      expect(stalledOf(at(NOW + 1), createdAgo(10 * TTL)).stalled).toBe(false);
    });

    it('the age boundary is exactly one TTL: younger is left alone, one TTL old is not', () => {
      expect(stalledOf(none, createdAgo(TTL - 1)).stalled).toBe(false);
      expect(stalledOf(none, createdAgo(TTL)).stalled).toBe(true);
      expect(stalledOf(none, createdAgo(TTL + 1)).stalled).toBe(true);
    });

    it('a start lying a TTL or more in the future (a clock that moved back) is not young, as in reconcile', () => {
      expect(stalledOf(none, createdAgo(-(TTL - 1))).stalled).toBe(false);
      expect(stalledOf(none, createdAgo(-TTL)).stalled).toBe(true);
    });

    it('a creation time that cannot be read is not young', () => {
      expect(stalledOf(none, { createdAt: 'not a time' }).stalled).toBe(true);
    });
  });

  it('applies only to a running run another process owns', () => {
    const noLeases = new Map<string, RunLeaseSummary>();
    expect(stalledOf(noLeases, { status: 'pending' }).stalled).toBe(false);
    expect(stalledOf(noLeases, { status: 'paused' }).stalled).toBe(false);
    const hosted = only(classify([run('r')], { leases: noLeases, hostedRunId: 'r' }));
    expect(hosted.stalled).toBe(false);
    const held = only(classify([run('r')], { leases: noLeases, outboxHeldRunIds: new Set(['r']) }));
    expect(held.stalled).toBe(false);
    expect(held.stalledReason).toBeUndefined();
  });
});

describe('ordering', () => {
  it('lists hosted, then paused in this project, then running, then the rest', () => {
    const runs = [
      run('held', { createdAt: '2026-11-22T11:50:00.000Z' }),
      run('elsewhere', {
        status: 'paused',
        projectRoot: '/work/other',
        createdAt: '2026-11-22T11:55:00.000Z',
      }),
      run('running', { createdAt: '2026-11-22T11:00:00.000Z' }),
      run('paused-here', { status: 'paused', createdAt: '2026-11-22T10:00:00.000Z' }),
      run('hosted', { createdAt: '2026-11-22T09:00:00.000Z' }),
    ];
    const rows = classify(runs, {
      hostedRunId: 'hosted',
      outboxHeldRunIds: new Set(['held']),
      pendingGateCounts: new Map([['paused-here', 1]]),
    });
    expect(rows.map((row) => row.runId)).toEqual([
      'hosted',
      'paused-here',
      'running',
      'elsewhere',
      'held',
    ]);
  });

  it('groups every paused-here variant together, ahead of running', () => {
    const rows = classify(
      [
        run('running', { createdAt: '2026-11-22T11:59:00.000Z' }),
        run('unknown', { status: 'paused', createdAt: '2026-11-22T08:00:00.000Z' }),
        run('media', { status: 'paused', createdAt: '2026-11-22T09:00:00.000Z' }),
        run('gate', { status: 'paused', createdAt: '2026-11-22T10:00:00.000Z' }),
      ],
      {
        pendingGateCounts: new Map([
          ['media', 0],
          ['gate', 2],
        ]),
      },
    );
    expect(rows.map((row) => row.runId)).toEqual(['gate', 'media', 'unknown', 'running']);
  });

  it('is newest first within a group by creation time, then id descending', () => {
    const rows = classify([
      run('a', { createdAt: '2026-11-22T10:00:00.000Z' }),
      run('c', { createdAt: '2026-11-22T11:00:00.000Z' }),
      run('b', { createdAt: '2026-11-22T11:00:00.000Z' }),
      run('d', { createdAt: '2026-11-22T09:00:00.000+00:00' }),
    ]);
    expect(rows.map((row) => row.runId)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('compares creation times as times, not as text', () => {
    // 10:00 at +02:00 is 08:00Z — OLDER than 09:00Z, though its text sorts later.
    const rows = classify([
      run('offset', { createdAt: '2026-11-22T10:00:00.000+02:00' }),
      run('utc', { createdAt: '2026-11-22T09:00:00.000Z' }),
    ]);
    expect(rows.map((row) => row.runId)).toEqual(['utc', 'offset']);
  });
});

describe('an unreadable creation time', () => {
  it('orders by the text, newest (largest) first, when either time cannot be read, then by id', () => {
    // `Date.parse` cannot read these; the fallback compares the stored text, descending, as the readable case does.
    const rows = classify([
      run('a', { createdAt: 'garbage-a' }),
      run('b', { createdAt: 'garbage-c' }),
      run('c', { createdAt: 'garbage-b' }),
    ]);
    expect(rows.map((row) => row.runId)).toEqual(['b', 'c', 'a']);
  });

  it('puts an unreadable time against a readable one by the same text rule, in either input order', () => {
    // 'zzz' sorts after '2026-…' as text, so descending text order puts the unreadable row first; as TIMES the
    // pair is undefined, so the row must not be ranked by a NaN comparison (which would leave input order).
    const unreadable = run('bad', { createdAt: 'zzz' });
    const readable = run('good', { createdAt: '2026-11-22T11:00:00.000Z' });
    expect(classify([readable, unreadable]).map((row) => row.runId)).toEqual(['bad', 'good']);
    expect(classify([unreadable, readable]).map((row) => row.runId)).toEqual(['bad', 'good']);
    const low = run('low', { createdAt: '!!!' }); // sorts BEFORE '2026-…' as text
    expect(classify([low, readable]).map((row) => row.runId)).toEqual(['good', 'low']);
    expect(classify([readable, low]).map((row) => row.runId)).toEqual(['good', 'low']);
  });

  it('breaks a tie between equal unreadable texts by id descending, and keeps the stored text on the row', () => {
    const rows = classify([
      run('m', { createdAt: 'same' }),
      run('z', { createdAt: 'same' }),
      run('a', { createdAt: 'same' }),
    ]);
    expect(rows.map((row) => row.runId)).toEqual(['z', 'm', 'a']);
    expect(rows[0]?.createdAt).toBe('same');
  });
});

describe('free-form values read back from the history file', () => {
  it('passes the project root through the one-line floor, without changing the class decision', () => {
    const forged = '/work/other\u001b]0;pwn\u0007\u202e\nevil';
    const row = only(classify([run('r', { status: 'paused', projectRoot: forged })]));
    // The decision compared the stored value (another project), the row shows the sanitized one.
    expect(row.class).toBe('other-paused-elsewhere');
    expect(row.projectRoot).toBe('/work/other evil');
  });

  it('passes the short id through the one-line floor and keeps the full id as the identity', () => {
    const id = 'ab\u001b[2Jcd\nef\u0007gh-tail';
    const row = only(classify([run(id)]));
    expect(row.shortId).toBe('abcd');
    expect(row.runId).toBe(id);
  });
});

describe('labels', () => {
  it('shows the slug when resolved, the workflow id otherwise, and sanitizes either', () => {
    const labelled = only(
      classify([run('r', { workflowId: 'wf-1' })], {
        workflowLabels: new Map([['wf-1', 'deploy\u001b[31m\nprod']]),
      }),
    );
    expect(labelled.label).toBe('deploy prod');
    expect(only(classify([run('r', { workflowId: 'wf\n2' })])).label).toBe('wf 2');
  });

  it('carries the status word and glyph so colour is never the only signal', () => {
    expect(only(classify([run('r', { status: 'running' })]))).toMatchObject({
      status: 'running',
      glyph: '◐',
      shortId: 'r',
    });
    expect(only(classify([run('r', { status: 'paused' })])).glyph).toBe('⏸');
  });
});
