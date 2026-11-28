import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CLI_SRC } from './source-literal.js';
import type { Golden } from './golden.js';
import { PRODUCERS } from './producers.js';
import { RECORDERS, recordAll, serialize } from './record-all.js';

/**
 * **The golden snapshot of every key legend and hint** ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §3, "One builder, golden first"; MVP-11 Step 3).
 *
 * `legend.golden.json` holds, for every producer in `producers.ts`, the exact strings it emits in every state that changes them (the
 * recorders are in `recorders/`). Step 3 changes the wording in a commit of its own, regenerated with `UPDATE_LEGEND_GOLDEN=1`, so
 * that the diff of the golden IS the reviewable change; this test is what makes that diff the only place a wording can move. A
 * difference is reported as the producer, the state, what the golden says and what the producer says now.
 *
 * Regenerate (only the wording commit of Step 3, or a deliberate new producer):
 *
 *     UPDATE_LEGEND_GOLDEN=1 pnpm --filter relavium exec vitest run src/render/tui/legend-golden/legend-golden.test.ts
 */

const GOLDEN_PATH = fileURLToPath(new URL('./legend.golden.json', import.meta.url));
const REGENERATE = process.env['UPDATE_LEGEND_GOLDEN'] === '1';

/** Some recorders mount real views over real stores; a loaded machine needs the room. */
const TIMEOUT_MS = 180_000;

/**
 * One recording for the whole file: recording every producer takes about twelve seconds, and the golden check and the determinism check both
 * need a recording. The golden check reads this one; the determinism check compares THIS one with a fresh one (the only second recording the
 * file makes), so the property it pins, that two recordings in a process agree, is the same as when each test recorded for itself.
 */
let recording: Promise<Golden> | undefined;
const recordedOnce = (): Promise<Golden> => (recording ??= recordAll());

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readGolden(): Golden {
  if (!existsSync(GOLDEN_PATH)) return {};
  const parsed: unknown = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  if (!isRecord(parsed)) throw new Error('legend.golden.json is not an object of producers');
  const golden: Record<string, Record<string, string>> = {};
  for (const [id, states] of Object.entries(parsed)) {
    if (!isRecord(states)) throw new Error(`legend.golden.json: ${id} is not an object of states`);
    const rows: Record<string, string> = {};
    for (const [state, row] of Object.entries(states)) {
      if (typeof row !== 'string')
        throw new Error(`legend.golden.json: ${id} › ${state} is not a string`);
      rows[state] = row;
    }
    golden[id] = rows;
  }
  return golden;
}

/** What differs, one block per difference, readable without a diff tool: the producer, the state, before and after. */
function describeDifferences(before: Golden, after: Golden): string[] {
  const out: string[] = [];
  const show = (text: string | undefined): string =>
    text === undefined ? '(not recorded)' : JSON.stringify(text);
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[id];
    const now = after[id];
    if (was === undefined) {
      out.push(
        `[${id}] a producer the golden does not have (${String(Object.keys(now ?? {}).length)} states)`,
      );
      continue;
    }
    if (now === undefined) {
      out.push(
        `[${id}] a producer in the golden that is no longer recorded (${String(Object.keys(was).length)} states)`,
      );
      continue;
    }
    for (const state of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (was[state] === now[state]) continue;
      out.push(
        `[${id}] ${state}\n    before: ${show(was[state])}\n    after:  ${show(now[state])}`,
      );
    }
  }
  return out;
}

describe('the registry of producers', () => {
  it('has a unique id per producer, a recorder for each, and no recorder without a producer', () => {
    const ids = PRODUCERS.map((producer) => producer.id);
    expect(
      ids.filter((id, index) => ids.indexOf(id) !== index),
      'duplicate ids',
    ).toEqual([]);
    expect(
      ids.filter((id) => RECORDERS[id] === undefined),
      'producers without a recorder',
    ).toEqual([]);
    expect(
      Object.keys(RECORDERS).filter((id) => !ids.includes(id)),
      'recorders without a producer',
    ).toEqual([]);
  });

  it('names a file that exists and says what it records', () => {
    for (const producer of PRODUCERS) {
      expect(existsSync(`${CLI_SRC}${producer.file}`), `${producer.id}: ${producer.file}`).toBe(
        true,
      );
      expect(producer.describe.trim().length, `${producer.id} has no description`).toBeGreaterThan(
        10,
      );
      expect(producer.id, 'ids are kebab-case').toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u);
    }
  });
});

describe('the legend golden', () => {
  it(
    REGENERATE
      ? 'regenerates legend.golden.json (UPDATE_LEGEND_GOLDEN=1)'
      : 'says today what legend.golden.json says, state by state',
    async () => {
      const actual = await recordedOnce();
      if (REGENERATE) {
        writeFileSync(GOLDEN_PATH, serialize(actual));
        return;
      }
      const differences = describeDifferences(readGolden(), actual);
      if (differences.length > 0) {
        throw new Error(
          `${String(differences.length)} legend(s) differ from legend.golden.json. A wording change is a deliberate commit: regenerate with UPDATE_LEGEND_GOLDEN=1 and review the diff of the file.\n\n${differences.join('\n')}`,
        );
      }
      expect(differences).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'records the same strings twice (no clock, no order, no machine in them)',
    async () => {
      const first = await recordedOnce();
      const second = await recordAll();
      expect(describeDifferences(first, second)).toEqual([]);
      expect(serialize(first)).toBe(serialize(second));
    },
    TIMEOUT_MS,
  );

  /**
   * A mounted view that never got its frame measured says so instead of drawing (`Review unavailable`, `Terminal too small`): the
   * recording of such a view is a recording of its refusal, and a recorder that mounted its host wrong would record that refusal for
   * every state and still match its own golden. A refusal sentence may only be recorded in a state whose label says why.
   */
  it('records a refusal only in a state that is named for it, never for an ordinary state of a view', () => {
    const REFUSAL =
      /^(?:Terminal too small|Checkpoint: terminal too small|Prompt does not fit|Review unavailable|Question unavailable|Checkpoint unavailable|Enlarge the terminal)/u;
    const NAMED_FOR_IT =
      /small|below|room|fit|floor|too-small|TOO_SMALL|\bsize=(?:[0-6]\d|7\d)x|unavailable|identity|too large|not measured/iu;
    const blind: string[] = [];
    for (const [id, states] of Object.entries(readGolden())) {
      for (const [state, row] of Object.entries(states)) {
        if (REFUSAL.test(row) && !NAMED_FOR_IT.test(state))
          blind.push(`${id} › ${state}: ${row.slice(0, 80)}`);
      }
    }
    expect(blind).toEqual([]);
  });

  it('draws the ordinary card, not its refusal, in the states a person actually sees', () => {
    const golden = readGolden();
    const row = (id: string, state: string): string | undefined => golden[id]?.[state];
    expect(row('approval-host', 'card: a change colour=off [1]')).toBe(
      '[Ctrl+Y] Allow · [Ctrl+G] Allow all file writes this session',
    );
    expect(row('approval-host', 'card: a command colour=off [1]')).toBe(
      '[Ctrl+Y] Allow once · [Ctrl+G] Allow this session · [Ctrl+O] Allow + remember',
    );
    // The full view is the inspection popup now: its legend sits one column in, like every popup legend in this file.
    expect(row('approval-host', 'full view colour=off [4]')).toBe(
      ' [Ctrl+N] Deny · [b] back to the card · [Ctrl+C] stops the turn · Esc back',
    );
    expect(row('question-card-view', 'size=80x24 colour=off [2]')).toBe(
      'Esc / [Ctrl+C] stops the turn',
    );
    expect(row('checkpoint-card-view', 'size=80x24 colour=off [1]')).toBe(
      '[Ctrl+Y] Continue · [Ctrl+N] Stop here',
    );
    expect(row('home-view-hint', 'idle, nothing to continue colour=off [1]')).toBe(
      '[/] commands · type a message to chat · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(row('chat-idle-hint', 'armed=false emptyDraft=false')).toBe(
      'Enter send · [Ctrl+J] newline · [Ctrl+C] clear the draft',
    );
  });

  it('holds no absolute path, no home directory and no timestamp', () => {
    const text = serialize(readGolden());
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\|\/private\/tmp|\/var\/folders/u);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  });
});
