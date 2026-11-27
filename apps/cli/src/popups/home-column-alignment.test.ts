/**
 * The columns of the Home's `/agents` and `/workflows` lists line up by what they take on the screen, not by how many code points they have (review
 * round 1 of MVP-11 unit 8, D-7): a CJK name is two cells a character, so a list of one such name and some Latin ones padded by code points leaves the
 * dates, the nodes and the standings in different columns. The one `padTo` is `render/tui/viewport.ts`'s, which counts display columns.
 */
import { describe, expect, it } from 'vitest';

import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { displayWidth, padTo } from '../render/tui/viewport.js';
import type { PopupContent } from './frame-model.js';
import {
  detailControls,
  homeWorkflowsSpec,
  workflowDetailContent,
} from './home-workflows-popup.js';
import { openFrame, withContent } from './popup-reducer.js';
import type { HomeWorkflowRun } from './home-port.js';
import { definedRead, detailOf } from './home-popups.test-support.js';
import {
  fakeAgents,
  fakeWorkflows,
  homeRig,
  readyAgent,
  settleWork,
  workflowEntry,
} from './home-popups.test-support.js';

/** Ten characters, twenty columns: a name a Japanese project could give its reviewer. */
const WIDE = 'コミットレビュー担当';

const rowsOf = (content: PopupContent | undefined) => {
  if (content?.kind !== 'list') throw new Error(`a list, not ${content?.kind ?? 'nothing'}`);
  return content.rows.filter((row) => row.section !== true);
};

describe('padTo counts display columns', () => {
  it('pads a wide name by the cells it takes, never cuts, and leaves a text that is as wide or wider as it is', () => {
    expect(displayWidth(WIDE)).toBe(20);
    expect(padTo('abc', 6)).toBe('abc   ');
    expect(padTo(WIDE, 24)).toBe(`${WIDE}    `);
    expect(displayWidth(padTo(WIDE, 24))).toBe(24);
    expect(padTo(WIDE, 12)).toBe(WIDE);
    expect(padTo('', 3)).toBe('   ');
  });
});

describe('a list that holds a wide name', () => {
  it('/agents: every slug and every title is padded to the same number of columns', async () => {
    const fakes = fakeAgents([
      readyAgent(WIDE, { name: 'レビュー担当者' }),
      readyAgent('reviewer', { name: 'Reviewer' }),
      readyAgent('qa', { name: 'QA' }),
    ]);
    const rig = homeRig();
    rig.open('agents', { agents: fakes.port });
    await settleWork();
    rig.settle();
    const rows = rowsOf(rig.content());
    expect(rows).toHaveLength(3);
    const slugs = new Set(rows.map((row) => displayWidth(row.label)));
    expect([...slugs], 'one slug column').toEqual([20]);
    const titles = new Set(rows.map((row) => displayWidth(row.detail ?? '')));
    expect([...titles], 'one title column, as wide as the widest title').toEqual([14]);
  });

  it('/workflows: every slug is padded to the same number of columns, and so is every node count', async () => {
    const fakes = fakeWorkflows([
      workflowEntry(WIDE),
      workflowEntry('backup-db'),
      workflowEntry('qa', { nodeCount: 12 }),
    ]);
    const rig = homeRig();
    rig.open('workflows', { workflows: fakes.port });
    await settleWork();
    rig.settle();
    const rows = rowsOf(rig.content());
    expect(rows).toHaveLength(3);
    expect([...new Set(rows.map((row) => displayWidth(row.label)))], 'one slug column').toEqual([
      20,
    ]);
    expect(
      new Set(rows.map((row) => displayWidth(row.detail ?? ''))).size,
      'one nodes column',
    ).toBe(1);
  });
});

describe('the last runs of a detail stand in columns (review round 2, P2-4)', () => {
  const NOW = Date.parse('2026-11-27T12:00:00Z');
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();
  const RUNS: readonly HomeWorkflowRun[] = [
    { runId: '41ae651d-aaaa', status: 'paused', at: ago(5 * 60_000) },
    { runId: '092e6161-bbbb', status: 'completed', at: ago(48 * 3_600_000) },
    { runId: 'fa7f8a61-cccc', status: 'failed', at: ago(96 * 3_600_000) },
    { runId: '7c0d19e2-dddd', status: 'running', at: ago(60_000) },
  ];

  function detailBox(color: boolean): readonly string[] {
    const read = definedRead([workflowEntry('release-notes')]);
    const row = read.model.rows[0];
    if (row === undefined) throw new Error('no row');
    const content = workflowDetailContent({ row, detail: detailOf(), runs: RUNS }, NOW);
    const landed = withContent(
      openFrame(homeWorkflowsSpec('home'), 1),
      1,
      content,
      detailControls(row),
      false,
    );
    const variant: Variant = { renderer: 'alt', color, size: { cols: 100, rows: 30 } };
    return popupBoxOf({ ...landed, stepIndex: 1 }, variant).rows;
  }

  it.each([false, true])(
    'the id of every run starts in one column, whatever the word before it is (colour %s: the plain form and the glyph form)',
    (color) => {
      const rows = detailBox(color).filter((row) => /[0-9a-f]{8}\s*$/u.test(row.trimEnd()));
      expect(rows).toHaveLength(4);
      const columns = rows.map((row) => displayWidth(row.slice(0, row.search(/[0-9a-f]{8}\s*$/u))));
      expect(new Set(columns).size, rows.join('\n')).toBe(1);
    },
  );

  it('the age column starts in one column too, where the runs have an age', () => {
    const rows = detailBox(true).filter((row) => /(done|failed) +\d+[dhm] ago/u.test(row));
    expect(rows).toHaveLength(2);
    const starts = rows.map((row) => displayWidth(row.slice(0, row.search(/\d+[dhm] ago/u))));
    expect(new Set(starts).size, rows.join('\n')).toBe(1);
  });
});
