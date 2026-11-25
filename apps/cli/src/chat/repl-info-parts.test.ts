/**
 * `costNotice` and `catalogNotice` are the plain text of their structured parts (MVP-11 step 4b: the `/cost` and `/workflows` popups draw the
 * same parts). Two things are pinned: the string the non-interactive path prints did not move by a byte (the expected text below was captured from
 * the notices BEFORE they were split, over the fixtures of `repl-info.test.ts`), and the popup's words are the parts' words, so the two cannot name
 * different facts.
 */
import { LEGACY_COST_SENTINEL, type SessionCostRow } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../workflows/catalog.js';
import {
  catalogNotice,
  catalogParts,
  costLineText,
  costNotice,
  costParts,
  NO_PROJECT_NOTICE,
} from './repl-info.js';

const row = (over: Partial<SessionCostRow> & { model: string }): SessionCostRow => ({
  modelCatalogId: undefined,
  inputTokens: 100,
  outputTokens: 200,
  conservativeMicrocents: 0,
  costMicrocents: 0,
  callCount: 1,
  unpricedCalls: 0,
  isLegacy: false,
  ...over,
});
const entry = (slug: string, valid = true): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  path: `${slug}.relavium.yaml`,
  valid,
});
const COMPLETE = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };

interface Fixture {
  readonly args: Parameters<typeof costNotice>;
  /** The notice exactly as it was written before the split. */
  readonly was: string;
}

const COST: Readonly<Record<string, Fixture>> = {
  empty: { args: [0, []], was: 'Session cost: $0.0000 known; usage unverified' },
  totalOnly: { args: [5_000_000, []], was: 'Session cost: $0.0500 known; usage unverified' },
  held: {
    args: [
      0,
      [row({ model: 'claude-haiku-4-5', callCount: 0, conservativeMicrocents: 900 })],
      { coverage: COMPLETE },
    ],
    was: 'Session cost: $0.0000\n  $0.0000    0%  claude-haiku-4-5  (no completed call)  — ~$0.000009 estimated, possibly billed',
  },
  both: {
    args: [
      10_000,
      [
        row({
          model: 'claude-opus-4-8',
          costMicrocents: 10_000,
          callCount: 2,
          conservativeMicrocents: 450,
        }),
      ],
      { coverage: COMPLETE },
    ],
    was: 'Session cost: $0.0001\n  $0.0001  100%  claude-opus-4-8  (2 calls, 300 tok)  — ~$0.0000045 estimated, possibly billed',
  },
  two: {
    args: [
      10_000,
      [
        row({ model: 'claude-opus-4-8', costMicrocents: 7500, callCount: 3 }),
        row({ model: 'claude-sonnet-4-6', costMicrocents: 2500, callCount: 1 }),
      ],
      { coverage: COMPLETE },
    ],
    was: 'Session cost: $0.0001\n  $0.0001   75%  claude-opus-4-8  (3 calls, 300 tok)\n  $0.0000   25%  claude-sonnet-4-6  (1 call, 300 tok)',
  },
  unpriced: {
    args: [
      0,
      [row({ model: 'gpt-5.4-pro', callCount: 2, unpricedCalls: 2 })],
      { coverage: COMPLETE },
    ],
    was: 'Session cost: $0.0000 known; price unknown for 2 calls\n  $0.0000 known; price unknown for 2 calls    0%  gpt-5.4-pro  (2 calls, 300 tok)  — price unknown for 2 of 2 calls',
  },
  partlyUnpriced: {
    args: [
      500,
      [row({ model: 'gpt-5.4-pro', costMicrocents: 500, callCount: 5, unpricedCalls: 2 })],
    ],
    was: 'Session cost: $0.0000 known; usage unverified; price unknown for 2 calls\n  $0.0000 known; usage unverified; price unknown for 2 calls  100%  gpt-5.4-pro  (5 calls, 300 tok)  — price unknown for 2 of 5 calls',
  },
  legacy: {
    args: [
      4200,
      [
        row({
          model: LEGACY_COST_SENTINEL,
          isLegacy: true,
          costMicrocents: 4200,
          callCount: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
      ],
      { coverage: COMPLETE },
    ],
    was: 'Session cost: $0.0000\n  $0.0000  100%  before per-model attribution — breakdown unavailable (this spend predates it)',
  },
  legacyBeside: {
    args: [
      10_000,
      [
        row({ model: 'claude-opus-4-8', costMicrocents: 6000, callCount: 3 }),
        row({
          model: LEGACY_COST_SENTINEL,
          isLegacy: true,
          costMicrocents: 4000,
          callCount: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
      ],
      { coverage: COMPLETE },
    ],
    was: 'Session cost: $0.0001\n  $0.0001   60%  claude-opus-4-8  (3 calls, 300 tok)\n  $0.0000   40%  before per-model attribution — breakdown unavailable (this spend predates it)',
  },
  sentinelNamed: {
    args: [
      3000,
      [row({ model: LEGACY_COST_SENTINEL, isLegacy: false, costMicrocents: 3000, callCount: 4 })],
      { coverage: COMPLETE },
    ],
    was: 'Session cost: $0.0000\n  $0.0000  100%  (pre-2.6.C)  (4 calls, 300 tok)',
  },
  escape: {
    args: [100, [row({ model: `evil\u001b[31m`, costMicrocents: 100 })]],
    was: 'Session cost: $0.0000 known; usage unverified\n  $0.0000 known; usage unverified  100%  evil  (1 call, 300 tok)',
  },
  released: {
    args: [500, [], { released: 1_200 }],
    was: 'Session cost: $0.0000 known; usage unverified\nReleased ~$0.000012 of estimated-but-unconfirmed spend back to the cap.',
  },
  releasedZero: {
    args: [500, [], { released: 0 }],
    was: 'Session cost: $0.0000 known; usage unverified',
  },
  broken: {
    args: [500, [], { durabilityBroken: true }],
    was: 'Session cost: $0.0000 known; usage unverified\nwarning: a conservative commitment could not be written durably — the cap still holds in this session, but a resume would not see it. Use /cost --release to clear it deliberately.',
  },
  usageOnly: {
    args: [
      500,
      [row({ model: 'a-model', costMicrocents: 500 })],
      {
        coverage: COMPLETE,
        models: [
          { model: 'a-model', coverage: COMPLETE },
          {
            model: 'usage-only-model',
            coverage: { unverified: false, pendingInvocations: 1, unknownCalls: 2 },
          },
        ],
      },
    ],
    was: 'Session cost: $0.0000\n  usage-only-model — $0.0000 known; 1 usage pending; usage unknown for 2 calls\n  $0.0000  100%  a-model  (1 call, 300 tok)',
  },
  everything: {
    args: [
      10_000,
      [
        row({
          model: 'claude-opus-4-8',
          costMicrocents: 6000,
          callCount: 3,
          unpricedCalls: 1,
          conservativeMicrocents: 450,
        }),
        row({ model: 'zz', callCount: 0, conservativeMicrocents: 70 }),
        row({
          model: LEGACY_COST_SENTINEL,
          isLegacy: true,
          costMicrocents: 4000,
          callCount: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
      ],
      {
        coverage: { unverified: true, pendingInvocations: 1, unknownCalls: 2 },
        durabilityBroken: true,
        released: 3_000,
        models: [
          { model: 'claude-opus-4-8', coverage: COMPLETE },
          { model: 'only-usage', coverage: COMPLETE },
        ],
      },
    ],
    was: 'Session cost: $0.0001 known; usage unverified; 1 usage pending; usage unknown for 2 calls; price unknown for 1 call\nReleased ~$0.00003 of estimated-but-unconfirmed spend back to the cap.\nwarning: a conservative commitment could not be written durably — the cap still holds in this session, but a resume would not see it. Use /cost --release to clear it deliberately.\n  only-usage — $0.0000\n  $0.0001 known; price unknown for 1 call   60%  claude-opus-4-8  (3 calls, 300 tok)  — price unknown for 1 of 3 calls  — ~$0.0000045 estimated, possibly billed\n  $0.0000 known; usage unverified; 1 usage pending; usage unknown for 2 calls    0%  zz  (no completed call)  — ~$0.0000007 estimated, possibly billed\n  $0.0000 known; usage unverified; 1 usage pending; usage unknown for 2 calls   40%  before per-model attribution — breakdown unavailable (this spend predates it)',
  },
};

describe('costNotice is exactly what it was before the split', () => {
  it.each(Object.entries(COST))('%s', (_name, fixture) => {
    expect(costNotice(...fixture.args)).toBe(fixture.was);
  });
});

describe('the parts of the notice', () => {
  it.each(Object.entries(COST))(
    '%s: the notice is the total, then the notes, then the rows, one per line, a model id sanitised',
    (_name, fixture) => {
      const parts = costParts(...fixture.args);
      const lines = [
        parts.total,
        ...[...parts.notes, ...parts.rows].map((line) =>
          costLineText(line, (model) =>
            // the notice's own sanitiser: control characters out
            // eslint-disable-next-line no-control-regex -- the point of the fixture
            model.replaceAll(/\u001b\[[0-9;]*m/gu, ''),
          ),
        ),
      ];
      expect(lines.join('\n')).toBe(fixture.was);
    },
  );

  it('keeps a model id raw in its own field: a surface decides how to draw it, and no other field carries one', () => {
    const parts = costParts(100, [row({ model: 'ZQX\u001b[31mQXZ', costMicrocents: 100 })]);
    expect(parts.rows[0]?.model).toBe('ZQX\u001b[31mQXZ');
    expect(parts.rows[0]?.head).not.toContain('ZQX');
    expect(parts.rows[0]?.tail).not.toContain('ZQX');
    expect(parts.total).not.toContain('\u001b');
    // A usage-only model is a note with the same field.
    const only = costParts(0, [], { models: [{ model: 'only\u001b[31m', coverage: COMPLETE }] });
    expect(only.notes[0]?.model).toBe('only\u001b[31m');
  });

  it('a legacy row, a released note and the durability warning carry no model', () => {
    const legacy = costParts(
      4200,
      [row({ model: LEGACY_COST_SENTINEL, isLegacy: true, costMicrocents: 4200 })],
      { released: 100, durabilityBroken: true },
    );
    expect(legacy.rows[0]?.model).toBeUndefined();
    expect(legacy.notes.map((note) => note.model)).toEqual([undefined, undefined]);
  });
});

describe('catalogNotice is exactly what it was before the split', () => {
  it.each([
    [
      'both kinds, an invalid entry kept',
      [entry('deploy'), entry('broken', false)],
      [entry('coder')],
      'Workflows (2):\n  deploy\n  broken (invalid)\nAgents (1):\n  coder',
    ],
    ['one kind empty', [entry('deploy')], [], 'Workflows (1):\n  deploy\nAgents: none'],
    ['an empty project', [], [], 'No workflows or agents found in this project.'],
    ['an escape in a slug', [entry('evil\u001b[31m')], [], 'Workflows (1):\n  evil\nAgents: none'],
  ])('%s', (_name, workflows, agents, was) => {
    expect(catalogNotice(workflows, agents)).toBe(was);
  });

  it('says the catalog as parts: an empty project, or two sections with their headings and their entries, a slug raw', () => {
    expect(catalogParts([], [])).toEqual({ kind: 'empty' });
    const parts = catalogParts([entry('a\u001b[31mb'), entry('c', false)], []);
    expect(parts).toEqual({
      kind: 'sections',
      sections: [
        {
          heading: 'Workflows (2):',
          entries: [
            { slug: 'a\u001b[31mb', valid: true },
            { slug: 'c', valid: false },
          ],
        },
        { heading: 'Agents: none', entries: [] },
      ],
    });
  });

  it('the no-project line is one constant, path-free', () => {
    expect(NO_PROJECT_NOTICE).toBe('No .relavium/ project found from the current directory.');
  });
});
