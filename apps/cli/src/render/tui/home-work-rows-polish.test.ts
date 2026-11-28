/**
 * The work page's rows, polished (MVP-11 unit 7, round 2: observation F10): the id of a row that cannot be read comes last like every other
 * row's; a session row does not repeat the built-in chat agent; the one qualifier every unverified run carries is shorter and keeps its
 * words; a cut is always the one ellipsis glyph and a stored `…` is always three dots, so the two are never mistaken for each other on one
 * screen; and without colour (where `||` is two columns and `x` and `!` are one) the names of the three Attention kinds start in one column.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_AGENT_ID } from '../../chat/default-agent.js';
import type { HomeRunRow, HomeSessionRow, HomeUnreadableRun } from '../../home/home-store.js';
import { parkedRunLabel, type ParkedRunRow } from './home-attention.js';
import { withGlyphForm } from './glyphs.js';
import {
  attentionLead,
  failedRunLabel,
  runLabel,
  sessionLabel,
  splitRowId,
  unreadableRunLabel,
} from './home-projection.js';
import { displayWidth } from './viewport.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const WIDE = 200;
const VERIFIED = { unverified: false, pendingInvocations: 0, unknownCalls: 0 } as const;
const UNVERIFIED = { unverified: true, pendingInvocations: 0, unknownCalls: 0 } as const;

const session = (over: Partial<HomeSessionRow> = {}): HomeSessionRow => ({
  sessionId: 's1',
  title: 'Refactor the billing module',
  agentSlug: 'coder',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-26T11:00:00.000Z',
  totalCostMicrocents: 12_000_000,
  usageCoverage: VERIFIED,
  ...over,
});
const run = (over: Partial<HomeRunRow> = {}): HomeRunRow => ({
  runId: '3f9a1c2e-7b64-4d0a-9c11-5a2e8f6d0b13',
  workflowSlug: 'release-notes',
  status: 'failed',
  createdAt: '2026-11-26T09:55:00.000Z',
  startedAt: '2026-11-26T09:55:00.000Z',
  completedAt: '2026-11-26T10:00:00.000Z',
  totalCostMicrocents: 4_000_000,
  usageCoverage: VERIFIED,
  ...over,
});
const parked: ParkedRunRow = {
  runId: '3f9a1c2e-7b64-4d0a-9c11-5a2e8f6d0b13',
  kind: 'approval',
  gates: 1,
  workflow: 'release-notes',
  parkedSince: '2026-11-26T10:00:00.000Z',
};
const broken: HomeUnreadableRun = {
  runId: '3f9a1c2e-7b64-4d0a-9c11-5a2e8f6d0b13',
  workflowSlug: 'release-notes',
  reason: 'corrupt-row',
};

describe('an unreadable run’s row ends with its id, like every other row', () => {
  it('`⚠ workflow · cannot be read · id`, and without a name `⚠ cannot be read · id`', () => {
    expect(unreadableRunLabel(broken, WIDE)).toBe('⚠ release-notes · cannot be read · 3f9a1c2e');
    const unnamed: HomeUnreadableRun = { runId: broken.runId, reason: broken.reason };
    expect(unreadableRunLabel(unnamed, WIDE)).toBe('⚠ cannot be read · 3f9a1c2e');
  });

  it('a narrow row gives up the workflow’s tail, then the id; `cannot be read` is never given up', () => {
    const long = { ...broken, workflowSlug: 'nightly-release-pipeline-for-the-eu-region' };
    // the name's tail goes first, down to its floor of 12 columns...
    expect(unreadableRunLabel(long, 55)).toBe('⚠ nightly-release-pipeline… · cannot be read · 3f9a1c2e');
    expect(unreadableRunLabel(long, 42)).toBe('⚠ nightly-rel… · cannot be read · 3f9a1c2e');
    // ...then the id (and the name has its room back); `cannot be read` stays
    expect(unreadableRunLabel(long, 41)).toBe('⚠ nightly-release-pipel… · cannot be read');
    expect(unreadableRunLabel(long, 33)).toBe('⚠ nightly-relea… · cannot be read');
    for (let columns = 16; columns <= 90; columns += 1) {
      const label = unreadableRunLabel(long, columns);
      expect(displayWidth(label), String(columns)).toBeLessThanOrEqual(columns);
      expect(label, String(columns)).toContain('cannot be read');
    }
  }); // prettier-ignore

  it('every kind of run row ends with the first eight characters of its id (`splitRowId` finds it)', () => {
    const rows = [
      parkedRunLabel(parked, WIDE, NOW),
      failedRunLabel(run(), NOW, WIDE),
      runLabel(run({ status: 'completed' }), NOW, WIDE),
      unreadableRunLabel(broken, WIDE),
    ];
    for (const row of rows) {
      expect(splitRowId(row, '3f9a1c2e').id, row).toBe('3f9a1c2e');
      expect(row.endsWith(' · 3f9a1c2e'), row).toBe(true);
    }
  });

  it('`splitRowId` splits only before a WHOLE id at the very end: a cut or a dropped id is all lead', () => {
    expect(splitRowId('a · b · 3f9a1c2e', '3f9a1c2e')).toEqual({ lead: 'a · b · ', id: '3f9a1c2e' });
    expect(splitRowId('a · b · 3f9a1c2', '3f9a1c2e')).toEqual({ lead: 'a · b · 3f9a1c2', id: undefined });
    expect(splitRowId('a · b', '3f9a1c2e')).toEqual({ lead: 'a · b', id: undefined });
    expect(splitRowId('a · b', undefined)).toEqual({ lead: 'a · b', id: undefined });
    expect(splitRowId('a · b', '')).toEqual({ lead: 'a · b', id: undefined });
    // an id that is not the LAST thing on the row is not split off (the old unreadable row led with it)
    expect(splitRowId('3f9a1c2e · b · c', '3f9a1c2e')).toEqual({ lead: '3f9a1c2e · b · c', id: undefined });
    expect(splitRowId('a · 3f9a1c2e · c', '3f9a1c2e')).toEqual({ lead: 'a · 3f9a1c2e · c', id: undefined });
  }); // prettier-ignore
});

describe('a session row does not repeat the built-in chat agent', () => {
  it('a titled session of the built-in agent is `title · age · cost`', () => {
    expect(sessionLabel(session({ agentSlug: DEFAULT_CHAT_AGENT_ID }), NOW, WIDE)).toBe(
      'Refactor the billing module · 1h ago · $0.1200',
    );
  });

  it('a titled session of another agent still names it', () => {
    expect(sessionLabel(session(), NOW, WIDE)).toBe('Refactor the billing module · coder · 1h ago · $0.1200');
  }); // prettier-ignore

  it('an UNTITLED session shows its agent once, as its name, built-in or not: it is all the row has to be known by', () => {
    expect(sessionLabel(session({ title: undefined, agentSlug: DEFAULT_CHAT_AGENT_ID }), NOW, WIDE)).toBe(
      'relavium-chat · 1h ago · $0.1200',
    );
    expect(sessionLabel(session({ title: '   ', agentSlug: 'coder' }), NOW, WIDE)).toBe(
      'coder · 1h ago · $0.1200',
    );
  }); // prettier-ignore

  it('the agent is the id, not a look-alike: `relavium-chat-2` is another agent and is named', () => {
    expect(sessionLabel(session({ agentSlug: `${DEFAULT_CHAT_AGENT_ID}-2` }), NOW, WIDE)).toContain(
      `· ${DEFAULT_CHAT_AGENT_ID}-2 ·`,
    );
  });
});

describe('the qualifier an unverified run carries is shorter and keeps its words', () => {
  const cost = (over: Partial<HomeSessionRow>): string =>
    sessionLabel(session({ title: 'T', agentSlug: DEFAULT_CHAT_AGENT_ID, ...over }), NOW, WIDE);

  it('`$0.0002 known; usage unverified` (31 columns) is `$0.0002 usage unverified` (24): never a bare amount, never `free`', () => {
    const unverified = cost({ totalCostMicrocents: 20_000, usageCoverage: UNVERIFIED });
    expect(unverified).toBe('T · 1h ago · $0.0002 usage unverified');
    expect(unverified).not.toContain('known;');
    expect(unverified).not.toMatch(/\bfree\b/u);
    // a run whose usage was never recorded at all is the same: unverified
    const never: HomeSessionRow = {
      sessionId: 's1',
      title: 'T',
      agentSlug: DEFAULT_CHAT_AGENT_ID,
      modelId: undefined,
      status: 'ended',
      updatedAt: '2026-11-26T11:00:00.000Z',
      totalCostMicrocents: 20_000,
    };
    expect(sessionLabel(never, NOW, WIDE)).toContain('usage unverified');
    // a verified zero is the only `free`, and a verified sum is a bare amount
    expect(cost({ totalCostMicrocents: 0, usageCoverage: VERIFIED })).toContain('free');
    expect(cost({ totalCostMicrocents: 20_000, usageCoverage: VERIFIED })).toBe(
      'T · 1h ago · $0.0002',
    );
  });

  it('every other qualified cost keeps its words, as the report writes them', () => {
    expect(cost({ totalCostMicrocents: 20_000, usageCoverage: { ...VERIFIED, pendingInvocations: 2 } })).toContain(
      '$0.0002 known; 2 usage pending',
    );
    expect(cost({ totalCostMicrocents: 20_000, usageCoverage: { ...VERIFIED, unknownCalls: 1 } })).toContain(
      '$0.0002 known; usage unknown for 1 call',
    );
    expect(cost({ totalCostMicrocents: 20_000, usageCoverage: VERIFIED, unpricedCalls: 3 })).toContain(
      '$0.0002 known; price unknown for 3 calls',
    );
    // unverified AND something else: the sentence is the report's, whole
    expect(
      cost({ totalCostMicrocents: 20_000, usageCoverage: { ...UNVERIFIED, pendingInvocations: 1 } }),
    ).toContain('known; usage unverified; 1 usage pending');
  }); // prettier-ignore

  it('a run row (the Runs section and the Attention rows) says it too, before its id', () => {
    const coverage = { usageCoverage: UNVERIFIED, totalCostMicrocents: 20_000 };
    expect(runLabel(run({ ...coverage, status: 'completed' }), NOW, WIDE)).toBe(
      'release-notes · completed · 2h ago · $0.0002 usage unverified · 3f9a1c2e',
    );
  });
});

describe('a cut is `…` and a stored `…` is `...`: the two are never the same text on one screen', () => {
  it('a title that brought its own ellipsis is drawn with three dots (the scrub’s compatibility fold), whole', () => {
    const label = sessionLabel(
      session({ title: 'rec…', agentSlug: DEFAULT_CHAT_AGENT_ID }),
      NOW,
      WIDE,
    );
    expect(label.startsWith('rec... · ')).toBe(true);
    expect(label).not.toContain('…');
  });

  it('a name the row cuts ends in the single glyph, and a stored one beside it still has three dots', () => {
    const cut = runLabel(run({ workflowSlug: 'quarterly-compliance-report-generation-for-the-eu-region' }), NOW, WIDE);
    expect(cut).toContain('…');
    expect(cut.match(/…/gu)).toHaveLength(1);
    const stored = runLabel(run({ workflowSlug: 'rec…' }), NOW, WIDE);
    expect(stored).toContain('rec...');
    expect(stored).not.toContain('…');
  }); // prettier-ignore

  it('every stored field of every row is folded: no stored `…` reaches a row, whatever the row', () => {
    const dots = 'a…b';
    const rows = [
      sessionLabel(session({ title: dots, agentSlug: `x${dots}` }), NOW, WIDE),
      runLabel(run({ workflowSlug: dots }), NOW, WIDE),
      failedRunLabel(run({ workflowSlug: dots }), NOW, WIDE),
      unreadableRunLabel({ ...broken, workflowSlug: dots }, WIDE),
      parkedRunLabel({ ...parked, workflow: dots }, WIDE, NOW),
    ];
    for (const row of rows) {
      expect(row, row).toContain('a...b');
      expect(row, row).not.toContain('…');
    }
  });
});

describe('without colour the names of the three Attention kinds start in one column', () => {
  const rows = (): readonly string[] => [
    parkedRunLabel(parked, WIDE, NOW),
    failedRunLabel(run(), NOW, WIDE),
    unreadableRunLabel(broken, WIDE),
  ];
  const nameColumn = (row: string): number =>
    displayWidth(row.slice(0, row.indexOf('release-notes')));

  it('plain: `||` is two columns, `x` and `!` one, and the lead is padded so the names align', () => {
    const plain = withGlyphForm(true, rows);
    expect(plain.map(nameColumn)).toEqual([3, 3, 3]);
    expect(plain[0]?.startsWith('|| release-notes')).toBe(true);
    expect(plain[1]?.startsWith('x  release-notes')).toBe(true);
    expect(plain[2]?.startsWith('!  release-notes')).toBe(true);
  });

  it('with the glyphs (one column each) they align already, and nothing is padded', () => {
    const glyphs = rows();
    expect(glyphs.map(nameColumn)).toEqual([2, 2, 2]);
    expect(glyphs.some((row) => row.includes('  '))).toBe(false);
  });

  it('`attentionLead` is the one place that decides it: the same width for the three, in either form', () => {
    for (const plain of [true, false]) {
      const widths = withGlyphForm(plain, () =>
        (['paused', 'failed', 'warning'] as const).map((kind) => displayWidth(attentionLead(kind))),
      );
      expect(new Set(widths).size, `plain=${String(plain)}`).toBe(1);
    }
  });

  it('the pad never widens a row beyond its columns', () => {
    withGlyphForm(true, () => {
      for (let columns = 8; columns <= 60; columns += 1)
        for (const row of [
          parkedRunLabel(parked, columns, NOW),
          failedRunLabel(run(), NOW, columns),
          unreadableRunLabel(broken, columns),
        ])
          expect(displayWidth(row), `${String(columns)}: ${row}`).toBeLessThanOrEqual(columns);
    });
  });
});
