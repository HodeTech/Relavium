/**
 * `r` on a run's detail, in the History tab's pure model ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6, MVP-11 unit 7, W4c): the key asks the host to run the run's workflow again through the Defined tab's own request (`kind: 'run'` with the
 * catalog's slug and path), or says on the tab's own message row why it cannot; it is named in the legend only where it is available; and it
 * is a key of the DETAIL alone: no list row, no loading or missing detail and no node page answers it. The model holds no port call but the
 * catalog's read, so the run's stored inputs can never be asked for on this path. The controller's side (the form, the single start, the
 * held key) is `home-history-run-again.test.ts`'s.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HistoryRead } from '../../history/history-source.js';
import type { RunDetailLoad, RunDetailRead } from '../../history/run-detail-source.js';
import type { ChatKey } from './chat-input.js';
import {
  RUN_AGAIN_DIRECTORY_UNKNOWN,
  RUN_AGAIN_FILE_INVALID,
  RUN_AGAIN_NOT_DEFINED,
  RUN_AGAIN_OTHER_DIRECTORY,
  RUN_AGAIN_UNLISTED,
} from './run-again.js';
import { RUN, definedPortOver, historyListOfRun, runDetailRead } from './run-again.test-support.js';
import { usableColumns } from './sheet-frame.js';
import {
  enterHistoryAtDetail,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegendText,
  tabHostLines,
  withHistoryLoad,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
} from './tab-host.js';
import {
  HISTORY_DETAIL_HINT,
  HISTORY_DETAIL_HINT_AGAIN,
  HISTORY_KEYS,
  type HistoryPort,
} from './tab-host-history.js';
import type { DefinedPort } from './tab-host-workflows.js';
import { displayWidth } from './viewport.js';

const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };
const DOWN: ChatKey = { downArrow: true };

const detailRead = runDetailRead;
const definedPort = definedPortOver;

interface Options {
  readonly detail?: RunDetailLoad;
  readonly defined?: DefinedPort | undefined;
}

/** The History tab on `RUN`'s detail, over a port that counts every read it is asked for. */
function rig(options: Options = {}) {
  const fake = definedPort();
  const defined = 'defined' in options ? options.defined : fake.port;
  const read = vi.fn((): HistoryRead => historyListOfRun());
  const cost = vi.fn(() => ({ kind: 'text' as const, text: '$0.01' }));
  const loadDetail = vi.fn(() => Promise.resolve<RunDetailLoad>({ kind: 'missing' }));
  const loadNode = vi.fn(() => ({ kind: 'unavailable' as const }));
  const isRunPinned = vi.fn(() => false);
  const history: HistoryPort = { read, cost, loadDetail, loadNode, isRunPinned };
  const context = (): TabHostContext => ({
    port: undefined,
    history,
    ...(defined === undefined ? {} : { defined }),
    now: 10_000,
    canArm: true,
  });
  let state: TabHostState = enterTab(freshTabMemory('history'), 'history', context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  const onDetail = (load: RunDetailLoad = { kind: 'ready', detail: detailRead() }): void => {
    state = enterHistoryAtDetail(freshTabMemory('history'), context(), RUN);
    state = withHistoryLoad(state, RUN, load);
  };
  /** Every read the port was asked for, by name: what the model asked of the world. */
  const calls = () => ({
    read: read.mock.calls.length,
    cost: cost.mock.calls.length,
    loadDetail: loadDetail.mock.calls.length,
    loadNode: loadNode.mock.calls.length,
    isRunPinned: isRunPinned.mock.calls.length,
  });
  return {
    press,
    onDetail,
    calls,
    definedReads: fake.read,
    get state(): TabHostState {
      return state;
    },
    message: (): string | undefined => state.history?.detail?.message,
    /** The node page over the detail, opened as a person opens it: `n` puts the cursor on the failed node's row, `Enter` opens it. */
    openNodePage: (): void => {
      press('n');
      press('', ENTER);
    },
    text: (): string =>
      tabHostLines(state, { columns: 80, terminalRows: 24 })
        .map((line) => line.text)
        .join('\n'),
    legend: (): string => tabHostLegendText(state),
  };
}

describe('r on a run’s detail asks the host to run its workflow again, through the Defined tab’s own request', () => {
  it('answers a `run` step with the catalog’s slug and the path it was listed from, and keeps the detail as it is', () => {
    const r = rig();
    r.onDetail();
    const before = r.state.history?.detail?.cursor;
    const step = r.press('r');
    expect(step).toMatchObject({ kind: 'run', slug: 'nightly', path: 'nightly.yaml' });
    expect(r.state.history?.detail?.phase, 'the detail stays open behind the form').toBe('ready');
    expect(r.state.history?.detail?.cursor).toBe(before);
    expect(r.message(), 'nothing is said: the form is the answer').toBeUndefined();
  });

  it('is the same key with Caps Lock on', () => {
    const r = rig();
    r.onDetail();
    expect(r.press('R')).toMatchObject({ kind: 'run', slug: 'nightly' });
  });

  it('drops the sentence the key before it left, as every key of the detail does', () => {
    const r = rig();
    r.onDetail({ kind: 'ready', detail: detailRead({ directory: 'elsewhere' }) });
    r.press('r');
    expect(r.message(), 'the refusal is on the row').toBe(RUN_AGAIN_OTHER_DIRECTORY);
    r.press('', DOWN);
    expect(r.message(), 'the next key dropped it').toBeUndefined();
  });

  it('drops the sentence a refused `r` left when the next `r` is a request', () => {
    const r = rig();
    r.onDetail();
    r.press('p'); // the pin store says its word on the row (no pin port: the unavailable sentence)
    expect(r.message()).toBeDefined();
    expect(r.press('r').kind).toBe('run');
    expect(r.message(), 'the request left no sentence behind').toBeUndefined();
  });

  it('asks the catalog and nothing else of the world: not the history, the cost, the detail, a node or the pin store (the stored inputs are never read)', () => {
    const r = rig();
    r.onDetail();
    const before = r.calls();
    const reads = r.definedReads.mock.calls.length;
    r.press('r');
    expect(r.calls(), 'no read of the run was made by the key').toEqual(before);
    expect(r.definedReads.mock.calls.length, 'the catalog was read once, by the key').toBe(
      reads + 1,
    );
  });
});

describe('r that cannot run says why on the tab’s own message row, in one closed line', () => {
  const refuses = (load: RunDetailRead, defined: DefinedPort | undefined, line: string): void => {
    const r = rig(defined === undefined ? { defined: undefined } : { defined });
    r.onDetail({ kind: 'ready', detail: load });
    const step = r.press('r');
    expect(step.kind, 'a refusal is a state, never a request').toBe('state');
    expect(r.message()).toBe(line);
    expect(r.text(), 'the line is drawn on the tab').toContain(line);
    expect(r.state.history?.message, 'not the list’s row').toBeUndefined();
  };

  it('a run of another directory', () => {
    refuses(
      detailRead({ directory: 'elsewhere', workflowSlug: 'nightly' }),
      definedPort().port,
      RUN_AGAIN_OTHER_DIRECTORY,
    );
  });

  it('a run that recorded no directory, and a detail that was never told where the Home is', () => {
    refuses(
      detailRead({ directory: 'unrecorded', workflowSlug: 'nightly' }),
      definedPort().port,
      RUN_AGAIN_DIRECTORY_UNKNOWN,
    );
    refuses(
      detailRead({ directory: undefined, workflowSlug: 'nightly' }),
      definedPort().port,
      RUN_AGAIN_DIRECTORY_UNKNOWN,
    );
  });

  it('a workflow that is deleted, or renamed (the catalog has no entry of the recorded slug)', () => {
    refuses(
      detailRead({ directory: 'here', workflowSlug: undefined }),
      definedPort().port,
      RUN_AGAIN_NOT_DEFINED,
    );
    refuses(
      detailRead({ directory: 'here', workflowSlug: 'release-notes' }),
      definedPort().port,
      RUN_AGAIN_NOT_DEFINED,
    );
    expect(RUN_AGAIN_NOT_DEFINED).toBe('This workflow is not defined in this project any more.');
  });

  it('a workflow whose file does not parse now, without the parse error', () => {
    refuses(
      detailRead({ directory: 'here', workflowSlug: 'broken' }),
      definedPort().port,
      RUN_AGAIN_FILE_INVALID,
    );
    const r = rig();
    r.onDetail({
      kind: 'ready',
      detail: detailRead({ directory: 'here', workflowSlug: 'broken' }),
    });
    r.press('r');
    expect(r.text()).not.toContain('PARSE-ERROR-TEXT');
  });

  it('a Home with no catalog to look in, and a catalog that cannot be read', () => {
    refuses(detailRead(), undefined, RUN_AGAIN_UNLISTED);
    refuses(
      detailRead(),
      {
        read: () => {
          throw new Error('PRIVATE /secret/path');
        },
      },
      RUN_AGAIN_UNLISTED,
    );
  });

  it('puts no stored text in any refusal: the run’s slug and the project’s path are not on the screen', () => {
    const r = rig();
    r.onDetail({
      kind: 'ready',
      detail: detailRead({ directory: 'here', workflowSlug: 'hostile-slug-from-the-log' }),
    });
    r.press('r');
    expect(r.message()).toBe(RUN_AGAIN_NOT_DEFINED);
    expect(r.message()).not.toContain('hostile-slug');
  });
});

describe('the legend names `[r] run again` only where `r` is available, and the way out stays whole at 80 columns', () => {
  const OFFERED = '←/→ tab · ↑/↓ scroll · [n] first failed · [p] pin · [r] run again · Esc back';
  const NOT_OFFERED = '←/→ tab · ↑/↓ scroll · Enter open · [n] first failed · [p] pin · Esc back';

  it('names it for a run of this directory whose workflow the detail could name, last before the way out', () => {
    const r = rig();
    r.onDetail();
    expect(r.legend()).toBe(OFFERED);
    expect(HISTORY_KEYS.run).toEqual({ keys: 'r', verb: 'run again' });
    expect(displayWidth(r.legend()), 'fits the floor').toBeLessThanOrEqual(usableColumns(80));
  });

  it('does not name it for a run of another directory, one with no recorded directory, a deleted workflow, or a detail that was not told where the Home is', () => {
    for (const over of [
      { directory: 'elsewhere', workflowSlug: 'nightly' },
      { directory: 'unrecorded', workflowSlug: 'nightly' },
      { directory: 'here', workflowSlug: undefined },
      { directory: undefined, workflowSlug: 'nightly' },
    ] as const) {
      const r = rig();
      r.onDetail({ kind: 'ready', detail: detailRead(over) });
      expect(r.legend(), JSON.stringify(over)).toBe(NOT_OFFERED);
    }
  });

  it('does not name it on a detail that is missing or unreadable, or on the node page over a detail', () => {
    for (const load of [{ kind: 'missing' }, { kind: 'unreadable' }] as const) {
      const r = rig();
      r.onDetail(load);
      expect(r.legend(), load.kind).not.toContain('run again');
    }
    const loading = rig();
    loading.press('', ENTER); // the list's Enter: the detail is asked for and the tab waits
    expect(loading.state.history?.detail?.phase).toBe('loading');
    expect(loading.legend(), 'loading').not.toContain('run again');
    const opened = rig();
    opened.onDetail();
    opened.openNodePage();
    expect(opened.state.history?.detail?.node, 'the node page is open').toBeDefined();
    expect(opened.legend()).not.toContain('run again');
  });

  it('names no key the detail does not answer: the list’s legend never names it', () => {
    const r = rig();
    expect(r.legend()).not.toContain('run again');
    expect(r.text()).not.toContain('run again');
  });

  it('keeps `Esc back` last and never clips the legend, offered or not', () => {
    for (const detail of [detailRead(), detailRead({ directory: 'elsewhere' })]) {
      const r = rig();
      r.onDetail({ kind: 'ready', detail });
      const lines = tabHostLines(r.state, { columns: 80, terminalRows: 24 });
      expect(lines.at(-1)?.kind).toBe('legend');
      expect(lines.at(-1)?.text).toMatch(/Esc back$/u);
      expect(lines.at(-1)?.text).not.toContain('…');
    }
  });
});

describe('the line under the detail says the truth: this run is not changed, and what the keys do', () => {
  it('says a new run is started through the form where `r` is available, and names the way into a node', () => {
    const r = rig();
    r.onDetail();
    expect(HISTORY_DETAIL_HINT_AGAIN).toBe(
      'This run is not changed. Enter opens a node; [r] opens the run form.',
    );
    expect(r.text()).toContain(HISTORY_DETAIL_HINT_AGAIN);
    expect(r.text()).not.toContain('No run is changed here');
  });

  it('says `p` only marks the run where `r` is not available', () => {
    const r = rig();
    r.onDetail({ kind: 'ready', detail: detailRead({ directory: 'elsewhere' }) });
    expect(HISTORY_DETAIL_HINT).toBe('This run is not changed; [p] only marks it.');
    expect(r.text()).toContain(HISTORY_DETAIL_HINT);
    expect(r.text()).not.toContain('No run is changed here');
  });

  it('fits the 80-column floor whole', () => {
    expect(displayWidth(HISTORY_DETAIL_HINT_AGAIN)).toBeLessThanOrEqual(usableColumns(80));
    expect(displayWidth(HISTORY_DETAIL_HINT)).toBeLessThanOrEqual(usableColumns(80));
  });
});

describe('r is a key of the ready detail alone', () => {
  it('does nothing on a detail that is loading, missing or unreadable', () => {
    for (const load of [undefined, { kind: 'missing' }, { kind: 'unreadable' }] as const) {
      const r = rig();
      if (load === undefined) {
        r.press('', ENTER); // the list's Enter: the detail is asked for and waits
        expect(r.state.history?.detail?.phase).toBe('loading');
      } else r.onDetail(load);
      const before = r.state;
      const step = r.press('r');
      expect(step.kind, String(load?.kind ?? 'loading')).toBe('state');
      expect(r.state, 'not one field of the tab changed').toBe(before);
      expect(r.definedReads, 'the catalog was not read for it').not.toHaveBeenCalled();
    }
  });

  it('does nothing on a History list row: the row’s keys are unchanged, and the catalog is not read', () => {
    const r = rig();
    const step = r.press('r');
    expect(step.kind).toBe('state');
    expect(r.state.history?.detail).toBeUndefined();
    expect(r.state.history?.message, 'no sentence either').toBeUndefined();
    expect(r.definedReads).not.toHaveBeenCalled();
  });

  it('does nothing on the node page over the detail', () => {
    const r = rig();
    r.onDetail();
    r.openNodePage();
    expect(r.state.history?.detail?.node).toBeDefined();
    const step = r.press('r');
    expect(step.kind).toBe('state');
    expect(r.state.history?.detail?.node, 'still the node page').toBeDefined();
    expect(r.definedReads).not.toHaveBeenCalled();
    r.press('', ESC);
    expect(r.press('r').kind, 'back on the detail it answers again').toBe('run');
  });

  it('is not a chord, and not a chunk: `Ctrl+R`, `Alt+R` and a pasted `rr` ask for nothing', () => {
    const r = rig();
    r.onDetail();
    expect(r.press('r', { ctrl: true }).kind).toBe('state');
    expect(r.press('r', { meta: true }).kind).toBe('state');
    expect(r.press('rr').kind).toBe('state');
    expect(r.press('rn').kind).toBe('state');
    expect(r.definedReads).not.toHaveBeenCalled();
  });

  it('does not change what the other keys of the detail do', () => {
    const r = rig();
    r.onDetail();
    expect(r.press('n').kind).toBe('state');
    expect(
      r.state.history?.detail?.cursor,
      '`n` still goes to the first failed node',
    ).toBeGreaterThan(0);
    expect(r.press('p').kind).toBe('state');
    expect(r.press('', ENTER).kind).toBe('state');
  });
});
