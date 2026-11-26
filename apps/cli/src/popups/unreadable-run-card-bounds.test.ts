/**
 * The exact bounds of what a stored value may take on the card of an unreadable run (MVP-11 unit 7, round 2; `unreadable-run-card.ts`): an id and a
 * workflow take 64 columns, a status 24, and a cut shows its ellipsis only when something was cut; a value is read to 256 code points before it is
 * scrubbed, so a megabyte of name costs what a short one does. `unreadable-run-card.test.ts` bounds the read loosely (at most 512 units) and checks
 * widths against the popup's, so a bound that moved by one column or one code point passed.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeUnreadableRun } from '../home/home-store.js';
import { unreadableRunLines } from './unreadable-run-card.js';

/** The length, in UTF-16 units, of every text the card handed to the scrub (`flowLine`), in order. */
const scrubbedLengths = vi.hoisted((): number[] => []);
vi.mock('../render/tui/flow-text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render/tui/flow-text.js')>();
  return {
    ...actual,
    flowLine: (text: string): string => {
      scrubbedLengths.push(text.length);
      return actual.flowLine(text);
    },
  };
});

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const run = (over: Partial<HomeUnreadableRun>): HomeUnreadableRun => ({
  runId: 'r'.repeat(10),
  workflowSlug: 'release-notes',
  status: 'failed',
  reason: 'corrupt-row',
  ...over,
});
/** A run the store knows only by its id (what a summary read that found nothing else leaves). */
const bare = (runId: string): HomeUnreadableRun => ({ runId, reason: 'corrupt-row' });

/** What one fact of the card draws for its value: the lines of the fact (its label, then the wrapped value), joined, with the spaces taken out. */
function valueOf(lines: readonly string[], label: string): string {
  const at = lines.findIndex((line) => line.trim().startsWith(label));
  const out: string[] = [];
  for (let index = at; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (index > at && (line.trim() === '' || /^ {2}\S/u.test(line))) break;
    out.push(index === at ? line.trim().slice(label.length) : line);
  }
  return out.join('').replace(/\s+/gu, '');
}

describe('a value on the card takes at most its column bound, and shows an ellipsis only when it was cut', () => {
  it.each([
    [64, false],
    [65, true],
    [200, true],
  ] as const)('the id and the workflow at %i columns: cut %s, to exactly 64', (length, cut) => {
    const lines = unreadableRunLines(
      run({ runId: 'r'.repeat(length), workflowSlug: 'w'.repeat(length) }),
      NOW,
    );
    for (const [label, letter] of [
      ['Run id', 'r'],
      ['Workflow', 'w'],
    ] as const) {
      const value = valueOf(lines, label);
      expect(value.length, label).toBe(64);
      expect(value.endsWith('…'), label).toBe(cut);
      expect(value.split(letter).length - 1, label).toBe(cut ? 63 : 64);
    }
  });

  it.each([
    [24, false],
    [25, true],
    [60, true],
  ] as const)('the status at %i columns: cut %s, to exactly 24', (length, cut) => {
    // the store's status is a closed word of the engine; the bound is for a row a hand edited, which no typed value can be
    const edited = Object.assign(run({}), { status: 's'.repeat(length) });
    const value = valueOf(unreadableRunLines(edited, NOW), 'Status');
    expect(value.length).toBe(24);
    expect(value.endsWith('…')).toBe(cut);
  });
});

describe('a stored value is read to 256 code points before it is scrubbed', () => {
  /** The lengths the scrub saw for a card whose id is `value` (and nothing else a stored value). */
  const scrubbed = (value: string): number[] => {
    scrubbedLengths.length = 0;
    unreadableRunLines(bare(value), NOW);
    return [...scrubbedLengths];
  };

  it('a long ordinary value: exactly 256 units reach the scrub (the id twice: the title and the fact)', () => {
    expect(scrubbed('a'.repeat(5_000))).toEqual([256, 256]);
  });

  it('a long value of two-unit code points: 256 of them, 512 units, never half of them', () => {
    expect(scrubbed(String.fromCodePoint(0x1f600).repeat(5_000))).toEqual([512, 512]);
  });

  it('a value of exactly 256 and of 255 code points is read whole', () => {
    expect(scrubbed('b'.repeat(256))).toEqual([256, 256]);
    expect(scrubbed('b'.repeat(255))).toEqual([255, 255]);
  });
});
