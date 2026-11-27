import './force-color.js';

import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import { ChatView } from './chat-ink.js';
import { emptyEditor } from './chat-input.js';
import {
  initialSessionViewState,
  INLINE_TRANSCRIPT_BOUND,
  type SessionViewState,
} from './session-view-model.js';
import { mountInk, type InkMount } from './surface-matrix/mount.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * SE7-2 on the DRAWN rows (the scoped security sitting of unit 7): the pure model of the status line guarantees its fit (`status-line-last-resort.test.ts`),
 * and the view must not cut a row that fits. Before, the status row was `wrap="truncate-end"`, so a line wider than the terminal was cut by Ink inside
 * the cost: `$…`, `$12…`, `$1234.5…`, an amount without the word that qualifies it. These tests mount the REAL `ChatView` over a fake terminal
 * of every width from 20 to 200 columns, with a long model id and a qualified or a clean cost, and read what the terminal shows.
 */
const mounts: InkMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

const LONG_MODEL = 'claude-sonnet-4-6-extended-identifier-0123456789-abcdefghij';

/** Microcents of an amount: the store holds USD × 100,000,000. */
const usd = (amount: number): number => Math.round(amount * 100_000_000);

const VERIFIED = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };

const stateOf = (qualified: boolean): SessionViewState =>
  initialSessionViewState(
    {
      model: LONG_MODEL,
      transcript: [],
      cumulativeCostMicrocents: usd(1234.5679),
      ...(qualified ? {} : { usageCoverage: VERIFIED }),
    },
    INLINE_TRANSCRIPT_BOUND,
  );

interface Shape {
  readonly name: string;
  readonly qualified: boolean;
  readonly mode: 'ask' | 'accept-edits';
  readonly effort: 'high' | undefined;
}
const SHAPES: readonly Shape[] = [
  {
    name: 'qualified, accept-edits with an effort',
    qualified: true,
    mode: 'accept-edits',
    effort: 'high',
  },
  { name: 'qualified, default', qualified: true, mode: 'ask', effort: undefined },
  {
    name: 'unqualified, accept-edits with an effort',
    qualified: false,
    mode: 'accept-edits',
    effort: 'high',
  },
  { name: 'unqualified, default', qualified: false, mode: 'ask', effort: undefined },
];

const variant = (cols: number): Variant => ({
  renderer: 'inline',
  color: false,
  size: { cols, rows: 30 },
});

async function draw(shape: Shape, cols: number): Promise<string[]> {
  const mount = mountInk(
    <ChatView
      state={stateOf(shape.qualified)}
      columns={cols}
      color={false}
      tick={0}
      nowMs={0}
      editor={emptyEditor()}
      running={false}
      mode={shape.mode}
      reasoningEffort={shape.effort}
      reasoningVisible={false}
      provider="anthropic"
    />,
    variant(cols),
  );
  mounts.push(mount);
  await mount.settle();
  const rows = mount.frame();
  mounts.splice(mounts.indexOf(mount), 1);
  mount.unmount();
  return rows;
}

/** The row of the thin rule: EXACTLY the margin of the grid at `cols`, then the content column of rule glyphs (the margin is the grid's, not any indent). */
function ruleAt(rows: readonly string[], cols: number): number {
  const grid = chatGrid(cols);
  return rows.findIndex((row) =>
    new RegExp(`^ {${String(grid.margin)}}[-─]{${String(grid.content)}}$`, 'u').test(row),
  );
}

/**
 * The rows of the status line: those between the thin rule and the hint, the last row of the block. The block stands on the grid (unit 9), so the rule
 * is the row of rule glyphs after the margin, and the status line is fitted to what the terminal leaves right of that margin.
 */
function statusRows(rows: readonly string[], cols: number): string[] {
  const rule = ruleAt(rows, cols);
  expect(rule, rows.join('\n')).toBeGreaterThanOrEqual(0);
  return rows.slice(rule + 1, rows.length - 1);
}

const AMOUNT = /\$\s?\d[\d,]*(?:\.\d+)?/gu;
const WIDTHS = Array.from({ length: 181 }, (_unused, index) => 20 + index);

describe.each(SHAPES)('the drawn status rows, $name, from 20 to 200 columns (SE7-2)', (shape) => {
  it('never shows a number of a qualified cost without its qualifier, and never an amount cut by an ellipsis', async () => {
    for (const cols of WIDTHS) {
      const rows = statusRows(await draw(shape, cols), cols);
      for (const row of rows) {
        expect(row, `${String(cols)} columns`).not.toMatch(/\$[\d.,]*…/u);
        if (!shape.qualified) continue;
        for (const match of row.matchAll(AMOUNT)) {
          const after = row.slice((match.index ?? 0) + match[0].length);
          expect(after.startsWith(' known'), `${String(cols)} columns: ${row}`).toBe(true);
        }
      }
    }
  });

  it('never cuts the mode word or the effort', async () => {
    const expected =
      shape.effort === undefined ? [shape.mode] : [shape.mode, `effort ${shape.effort}`];
    for (const cols of WIDTHS) {
      // below the width of the words that are never cut a row may wrap between two of their words, never inside one
      const joined = statusRows(await draw(shape, cols), cols)
        .join(' ')
        .replace(/\s+/gu, ' ');
      for (const word of expected)
        expect(joined, `${String(cols)} columns`).toContain(
          word === shape.mode ? `${word} mode` : word,
        );
    }
  });

  it('is exactly one row from 80 columns up, with the prompt block five rows below the leading row', async () => {
    for (const cols of WIDTHS.filter((width) => width >= 80)) {
      const rows = await draw(shape, cols);
      const rule = ruleAt(rows, cols);
      expect(statusRows(rows, cols), `${String(cols)} columns`).toHaveLength(1);
      expect(rows.length - rule, 'the rule, the status line and the hint').toBe(3);
    }
  });
});
