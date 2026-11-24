import './force-no-color.js';

import type { ModelCatalogEntry } from '@relavium/llm';
import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ReplCommand } from '../../commands/repl-commands.js';
import { styleRuns } from './emphasis-test-kit.js';
import { HomeView } from './home-view.js';
import { MentionView } from './mention-view.js';
import { ModelPickerView } from './model-picker-view.js';
import type { ModelPickerState } from './model-picker.js';
import { filterPaletteEntries, type PaletteEntry } from './palette-entries.js';
import { PaletteView } from './palette-view.js';
import { ReverseSearchView } from './reverse-search-view.js';

/**
 * Text a user, a project, a model or a provider wrote is drawn inside the style pair of a bold or selected row, and must not carry an
 * SGR of its own into the frame: `emphasize` does not sanitise (its text is the caller's), so each VIEW that draws such a field inside a
 * pair passes it through `sanitizeInline` first (palette command name, mention name and filter, model name and filter, reverse-search query,
 * a strip row). The sheets' lines are cleaned upstream: the tab host's own view sanitises every line, and the permissions sheet shows a label
 * through `escaped()`. Each field below holds `ESC[31m … ESC[0m` and a pair of its own (`ESC[7m`), and the frame must hold only the
 * sequences the rule wrote: the colour and the reset the field tried to write are gone, and so is the inverse of its own.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
/** The field: words around a red colour, a reset and an inverse pair the author wrote. */
const HOSTILE = `ev${ESC}[31mil${ESC}[0m${ESC}[7mname${ESC}[27m`;
const CLEAN = 'evilname';
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');

function frameOf(element: ReactElement): string {
  const view = render(element);
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

/** The sequences of `frame` that are not the ones of the rule (`1`, `22`, `7`, `27`): a colour, a reset, or anything else. */
const foreign = (frame: string): string[] =>
  (frame.match(SGR) ?? []).filter(
    (code) => !['[1m', '[22m', '[7m', '[27m'].some((own) => code.endsWith(own)),
  );

describe('a field of untrusted text drawn inside the style pair of its row', () => {
  it('the palette’s command name (the selected row)', () => {
    const entries: readonly PaletteEntry[] = [
      {
        command: {
          name: HOSTILE,
          label: HOSTILE,
          description: HOSTILE,
          effect: 'read',
          availableIn: ['home'],
          run: () => undefined,
        } satisfies ReplCommand,
        description: HOSTILE,
        group: 'work',
        groupStart: false,
        enabled: true,
      },
    ];
    const frame = frameOf(
      <PaletteView
        list={{ entries, rows: filterPaletteEntries(entries, ''), layout: 'down' }}
        state={{ query: '', index: 0 }}
        color={false}
      />,
    );
    expect(foreign(frame)).toEqual([]);
    expect(frame).toContain(CLEAN);
  });

  it('the mention list’s candidate name and filter (the selected row and the bold echo)', () => {
    const frame = frameOf(
      <MentionView
        state={{
          dir: '',
          filter: HOSTILE,
          candidates: [{ name: HOSTILE, type: 'file', path: 'p' }],
          selected: 0,
          loading: false,
        }}
        color={false}
      />,
    );
    expect(foreign(frame)).toEqual([]);
    expect(frame.split(CLEAN).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('the model picker’s display name and filter', () => {
    const entry: ModelCatalogEntry = {
      modelId: 'm',
      provider: 'anthropic',
      displayName: HOSTILE,
      pricingSource: 'catalog',
      priceKnown: true,
      available: true,
      deprecated: false,
    };
    const state: ModelPickerState = {
      entries: [entry],
      filter: '',
      selected: 0,
      loading: false,
      currentDefault: undefined,
      refreshedAt: undefined,
      banner: undefined,
      hint: undefined,
      effortTiers: [],
      phase: 'model',
      effortStep: false,
      pending: undefined,
      effortSelected: 0,
      currentEffort: undefined,
    };
    const frame = frameOf(
      <ModelPickerView state={state} color={false} nowMs={0} scope="next-chat" />,
    );
    expect(foreign(frame)).toEqual([]);
    expect(frame).toContain(CLEAN);
    const filtered = frameOf(
      <ModelPickerView
        state={{ ...state, filter: HOSTILE }}
        color={false}
        nowMs={0}
        scope="next-chat"
      />,
    );
    expect(foreign(filtered)).toEqual([]);
  });

  it('the reverse search’s query', () => {
    const frame = frameOf(
      <ReverseSearchView
        state={{ query: HOSTILE, matchIndex: 0 }}
        entries={[`a line with ${HOSTILE}`]}
        color={false}
      />,
    );
    expect(foreign(frame)).toEqual([]);
    expect(frame).toContain(CLEAN);
  });

  it('a strip row of the Home (the focused one)', () => {
    const frame = frameOf(
      <HomeView
        snapshot={{
          attention: {
            gates: [],
            failedRuns: [
              {
                runId: 'run-1',
                workflowSlug: HOSTILE,
                status: 'failed',
                createdAt: '2026-11-24T00:00:00.000Z',
                startedAt: undefined,
                completedAt: undefined,
                totalCostMicrocents: 0,
                unpricedCalls: 0,
              },
            ],
          },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: false,
        }}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={100}
        rows={30}
        color={false}
        stripFocus={{ kind: 'run', id: 'run-1' }}
      />,
    );
    expect(foreign(frame)).toEqual([]);
    expect(frame).toContain(CLEAN);
  });

  it('and the helper itself leaves the text alone, which is why the callers above clean it first', () => {
    // `styleRuns` reads the bytes the way a terminal does: the field's own sequences WOULD be styles if they got through.
    const runs = styleRuns(`${ESC}[1m${HOSTILE}${ESC}[22m`);
    expect(runs.some((run) => run.styles.includes('colour'))).toBe(true);
  });
});
