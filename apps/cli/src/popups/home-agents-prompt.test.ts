/**
 * Review round 3: the head of an agent's system prompt on the `/agents` detail (unit 8 fix wave 2, O2-11): the model's own cut mark is
 * taken off before the scrub and put back as the one ellipsis that ends the LAST row; a head cut inside a word ends on the whole word before it;
 * a prompt that was not cut gets no mark; every row keeps to the text column; at most four rows.
 */
import { describe, expect, it } from 'vitest';

import { displayWidth } from '../render/tui/viewport.js';
import { AGENTS_STEP } from './home-agents-popup.js';
import { ENTER, fakeAgents, homeRig, readyAgent, settleWork } from './home-popups.test-support.js';
import { POPUP_TEXT_COLUMNS } from './popup-text.js';

/** The rows of the prompt's head on the detail of the one agent `prompt` belongs to. */
async function promptRowsOf(prompt: string): Promise<readonly string[]> {
  const rig = homeRig();
  const fakes = fakeAgents([readyAgent('commit-reviewer', { system_prompt: prompt })]);
  expect(rig.open('agents', { agents: fakes.port }).opened).toBe(true);
  await settleWork();
  rig.settle();
  rig.press('', ENTER);
  expect(rig.step()).toBe(AGENTS_STEP.detail);
  const content = rig.content();
  if (content.kind !== 'report') throw new Error('a report');
  const at = content.lines.findIndex((line) => line.startsWith('System prompt'));
  expect(at).toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (const line of content.lines.slice(at + 1)) {
    if (line.trim() === '' || line.startsWith('Conversations')) break;
    rows.push(line);
  }
  return rows;
}

describe('the head of the system prompt on the detail', () => {
  it('a prompt that was not cut says no more than it says: no mark', async () => {
    const rows = await promptRowsOf('You review the commits of this repository.');
    expect(rows.map((row) => row.trim())).toEqual(['You review the commits of this repository.']);
  });

  it('a head cut inside a word ends on the whole word before it, with the mark once, which ends the last row', async () => {
    // 60 four-character words: the model’s head is 240 characters, so it ends inside the last (`ab…`); four rows hold all of it.
    const rows = await promptRowsOf('abc '.repeat(70));
    expect(rows.length).toBeLessThanOrEqual(4);
    const last = rows.at(-1) ?? '';
    expect(last.endsWith(' abc…'), JSON.stringify(last)).toBe(true);
    expect(rows.join('').match(/…/gu)).toHaveLength(1);
    expect(rows.join(' ')).not.toMatch(/\bab…/u);
  });

  it('every row keeps to the text column and the rows are at most four, in the order the prompt says them, the mark on the last', async () => {
    const prompt = Array.from({ length: 120 }, (_, at) => `word${String(at)}`).join(' ');
    const rows = await promptRowsOf(prompt);
    expect(rows.length).toBe(4);
    for (const row of rows)
      expect(displayWidth(row), JSON.stringify(row)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
    const numbers =
      rows
        .join(' ')
        .match(/word(\d+)/gu)
        ?.map((word) => Number(word.slice(4))) ?? [];
    expect(numbers[0]).toBe(0);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    expect(new Set(numbers).size, 'no row is said twice').toBe(numbers.length);
    expect(rows.at(-1)?.endsWith('…')).toBe(true);
    expect(rows.slice(0, -1).some((row) => row.includes('…'))).toBe(false);
  });

  it('a head that needs more than four rows is cut to four: one mark, at the end of the last, never doubled', async () => {
    // Eleven-character words: five a row, so the 240-character head takes five rows and the page keeps four.
    const rows = await promptRowsOf('abcdefghij '.repeat(60));
    expect(rows).toHaveLength(4);
    expect(rows.join('').match(/…/gu)).toHaveLength(1);
    expect(rows.at(-1)?.endsWith('abcdefghij…')).toBe(true);
    expect(rows.join('')).not.toContain('……');
  });
});

describe('the title row of the detail (review round 3, O3-10)', () => {
  it('is indented as the field rows under it are, whether or not the agent has a title', async () => {
    for (const title of [undefined, 'Reviews the commits']) {
      const rig = homeRig();
      const fakes = fakeAgents([
        readyAgent('commit-reviewer', title === undefined ? {} : { name: title }),
      ]);
      expect(rig.open('agents', { agents: fakes.port }).opened).toBe(true);
      await settleWork();
      rig.settle();
      rig.press('', ENTER);
      const content = rig.content();
      if (content.kind !== 'report') throw new Error('a report');
      const [first, , model] = content.lines;
      expect(first, 'the title row').toMatch(/^ {2}commit-reviewer/u);
      expect(first?.startsWith('   '), 'two columns, as the fields').toBe(false);
      const indent = (line: string | undefined): number => (line ?? '').search(/\S/u);
      expect(indent(first), 'the same column as the first field').toBe(indent(model));
    }
  });
});
