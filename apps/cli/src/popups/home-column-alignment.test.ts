/**
 * The columns of the Home's `/agents` and `/workflows` lists line up by what they take on the screen, not by how many code points they have (review
 * round 1 of MVP-11 unit 8, D-7): a CJK name is two cells a character, so a list of one such name and some Latin ones padded by code points leaves the
 * dates, the nodes and the standings in different columns. The one `padTo` is `render/tui/viewport.ts`'s, which counts display columns.
 */
import { describe, expect, it } from 'vitest';

import { displayWidth, padTo } from '../render/tui/viewport.js';
import type { PopupContent } from './frame-model.js';
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
