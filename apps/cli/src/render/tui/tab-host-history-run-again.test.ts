/**
 * `r` on a run's detail, in the History tab's pure model ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6, MVP-11 unit 7, W4c): the key asks the host to run the run's workflow again through the `/workflows` popup's own request (`kind: 'run'` with the
 * catalog's slug and path), or says on the tab's own message row why it cannot; it is named in the legend only where it is available; and it
 * is a key of the DETAIL alone: no list row, no loading or missing detail and no node page answers it. The model holds no port call but the
 * catalog's read, so the run's stored inputs can never be asked for on this path. The controller's side (the form, the single start, the
 * held key) is `home-history-run-again.test.ts`'s.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HistoryQuery, HistoryRead } from '../../history/history-source.js';
import type { RunDetailLoad, RunDetailRead } from '../../history/run-detail-source.js';
import type { ChatKey } from './chat-input.js';
import {
  RUN_AGAIN_CHANGED,
  RUN_AGAIN_DIRECTORY_UNKNOWN,
  RUN_AGAIN_FILE_INVALID,
  RUN_AGAIN_NOT_DEFINED,
  RUN_AGAIN_OTHER_DIRECTORY,
  RUN_AGAIN_UNLISTED,
} from './run-again.js';
import {
  NEWER_RUN,
  RUN,
  definedPortOver,
  historyListOfRun,
  runDetailRead,
} from './run-again.test-support.js';
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
import type { DefinedPort } from '../../history/defined-model.js';
import { displayWidth } from './viewport.js';

const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };
const DOWN: ChatKey = { downArrow: true };

const detailRead = runDetailRead;
const definedPort = definedPortOver;

interface Options {
  readonly detail?: RunDetailLoad;
  readonly defined?: DefinedPort | undefined;
  /** What the History port answers a read with (default: the list holding the one run). */
  readonly list?: (query: HistoryQuery) => HistoryRead;
}

/** The History tab on `RUN`'s detail, over a port that counts every read it is asked for. */
function rig(options: Options = {}) {
  const fake = definedPort();
  const defined = 'defined' in options ? options.defined : fake.port;
  const read = vi.fn(
    (query: HistoryQuery): HistoryRead => options.list?.(query) ?? historyListOfRun(),
  );
  const cost = vi.fn(() => ({ kind: 'text' as const, text: '$0.01' }));
  const loadDetail = vi.fn(() => Promise.resolve<RunDetailLoad>({ kind: 'missing' }));
  const loadNode = vi.fn(() => ({ kind: 'unavailable' as const }));
  const isRunPinned = vi.fn(() => false);
  const history: HistoryPort = { read, cost, loadDetail, loadNode, isRunPinned };
  const context = (): TabHostContext => ({
    history,
    ...(defined === undefined ? {} : { defined }),
    now: 10_000,
  });
  let state: TabHostState = enterTab(freshTabMemory('history'), 'history', context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  const onDetail = (load: RunDetailLoad = { kind: 'ready', detail: detailRead() }): void => {
    state = enterHistoryAtDetail(freshTabMemory('history'), context(), RUN);
    // The catalog is handed in with the load: it decides, once, whether the legend offers `[r]` (the controller does the same).
    state = withHistoryLoad(state, RUN, load, defined);
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
    /** The queries the History port was asked to read, in order. */
    queries: (): readonly HistoryQuery[] => read.mock.calls.map(([query]) => query),
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

describe('r on a run’s detail asks the host to run its workflow again, through the `/workflows` popup’s own request', () => {
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
    expect(RUN_AGAIN_NOT_DEFINED).toBe('This workflow is not defined in this project.');
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
  const OFFERED = '←/→ tab · Enter open · [n] first failed · [p] pin · [r] run again · Esc back';
  const NOT_OFFERED = '←/→ tab · ↑/↓ scroll · Enter open · [n] first failed · [p] pin · Esc back';

  it('names it for a run of this directory whose workflow the catalog has, last before the way out, with `Enter open` kept', () => {
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
  it('says the run is not changed where `r` is available, and names the way into a node without repeating `[r]` from the legend', () => {
    const r = rig();
    r.onDetail();
    expect(HISTORY_DETAIL_HINT_AGAIN).toBe('This run is not changed. Enter opens a node.');
    expect(HISTORY_DETAIL_HINT_AGAIN).not.toContain('[r]');
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
    const reads = r.definedReads.mock.calls.length; // the load read the catalog once, to decide the legend
    const step = r.press('r');
    expect(step.kind).toBe('state');
    expect(r.state.history?.detail?.node, 'still the node page').toBeDefined();
    expect(r.definedReads.mock.calls.length, 'the press read no catalog').toBe(reads);
    r.press('', ESC);
    expect(r.press('r').kind, 'back on the detail it answers again').toBe('run');
  });

  it('is not a chord, and not a chunk: `Ctrl+R`, `Alt+R` and a pasted `rr` ask for nothing', () => {
    const r = rig();
    r.onDetail();
    const reads = r.definedReads.mock.calls.length; // the load read the catalog once, to decide the legend
    expect(r.press('r', { ctrl: true }).kind).toBe('state');
    expect(r.press('r', { meta: true }).kind).toBe('state');
    expect(r.press('rr').kind).toBe('state');
    expect(r.press('rn').kind).toBe('state');
    expect(r.definedReads.mock.calls.length, 'none of them read the catalog').toBe(reads);
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

describe('the legend keeps `Enter open` beside `[r] run again`, and gives up the one key with the least to say (round 2)', () => {
  const FAILED_OFFERED =
    '←/→ tab · Enter open · [n] first failed · [p] pin · [r] run again · Esc back';
  const COMPLETED_OFFERED =
    '←/→ tab · ↑/↓ scroll · Enter open · [p] pin · [r] run again · Esc back';
  const WHOLE = '←/→ tab · ↑/↓ scroll · Enter open · [n] first failed · [p] pin · Esc back';
  /** Every item, which 100 columns hold (89 of 98): nothing gives way there, and the chord does not fit beside it. */
  const EVERY_ITEM =
    '←/→ tab · ↑/↓ scroll · Enter open · [n] first failed · [p] pin · [r] run again · Esc back';
  /** Where `r` is not offered the legend is 73 columns, and 100 columns leave room for the chord beside it (review round 1, D-2). */
  const WHOLE_WIDE =
    '←/→ tab · ↑/↓ scroll · Enter open · [n] first failed · [p] pin · [Ctrl+C] close · Esc back';
  const FLOOR = usableColumns(80);

  const cases = [
    {
      name: 'a failed run of this directory with `r` offered',
      detail: () => detailRead(),
      legend: FAILED_OFFERED,
      wide: EVERY_ITEM,
      gives: '↑/↓ scroll',
    },
    {
      name: 'a completed run of this directory with `r` offered',
      detail: () =>
        detailRead({ directory: 'here', workflowSlug: 'nightly', nodeStatus: 'completed' }),
      legend: COMPLETED_OFFERED,
      wide: EVERY_ITEM,
      gives: '[n] first failed',
    },
    {
      name: 'a failed run with `r` not offered (another directory)',
      detail: () => detailRead({ directory: 'elsewhere', workflowSlug: 'nightly' }),
      legend: WHOLE,
      wide: WHOLE_WIDE,
      gives: undefined,
    },
    {
      name: 'a completed run with `r` not offered (another directory)',
      detail: () =>
        detailRead({ directory: 'elsewhere', workflowSlug: 'nightly', nodeStatus: 'completed' }),
      legend: WHOLE,
      wide: WHOLE_WIDE,
      gives: undefined,
    },
  ] as const;

  // 78 is the usable width of the 80-column floor (`FLOOR`, below): a terminal narrower than the floor draws no tab host at all. At 80 one item
  // gives way; at 100 and 120 (98 and 100 usable) every item is named, since the width holds them (review round 1, D-2).
  for (const columns of [80, 100, 120]) {
    for (const one of cases) {
      it(`${one.name}, at ${String(columns)} columns: the whole of it on the legend row, the way out last`, () => {
        const r = rig();
        r.onDetail({ kind: 'ready', detail: one.detail() });
        const lines = tabHostLines(r.state, { columns, terminalRows: 24 });
        const drawn = lines.at(-1);
        expect(drawn?.kind).toBe('legend');
        expect(drawn?.text, 'not one item was cut with an ellipsis').not.toContain('…');
        expect(drawn?.text).toBe(columns === 80 ? one.legend : one.wide);
        expect(displayWidth(drawn?.text ?? ''), 'fits the width').toBeLessThanOrEqual(
          columns === 80 ? FLOOR : usableColumns(columns),
        );
        expect(drawn?.text).toMatch(/Esc back$/u);
        if (one.gives !== undefined && columns === 80) expect(drawn?.text).not.toContain(one.gives);
      });
    }
  }

  it('measures what the comment says: 89 columns with every item, 76 without the scroll, 70 without `[n]`, 73 where `r` is not offered', () => {
    expect(FLOOR).toBe(78);
    const widths = [FAILED_OFFERED, COMPLETED_OFFERED, WHOLE].map((text) => displayWidth(text));
    // The two offered legends and the one without `r` are what the detail draws; the fourth number is what both would be with every item.
    expect(widths).toEqual([76, 70, 73]);
    expect(
      displayWidth(
        '←/→ tab · ↑/↓ scroll · Enter open · [n] first failed · [p] pin · [r] run again · Esc back',
      ),
      'every item does not fit the floor',
    ).toBe(89);
  });

  it('says on a failed run that the scroll keys still work, and on a completed one that `n` still answers', () => {
    const failed = rig();
    failed.onDetail();
    const before = failed.state.history?.detail?.cursor ?? 0;
    failed.press('', DOWN);
    expect(failed.state.history?.detail?.cursor, 'the arrows scroll though unlisted').toBe(
      before + 1,
    );
    const completed = rig();
    completed.onDetail({
      kind: 'ready',
      detail: detailRead({ directory: 'here', workflowSlug: 'nightly', nodeStatus: 'completed' }),
    });
    completed.press('n');
    expect(completed.message(), 'an unlisted key is still never silent').toBe(
      'No node of this run ended failed.',
    );
  });

  it('keeps `Enter open` working where it is named: it opens the node the cursor is on', () => {
    const r = rig();
    r.onDetail();
    r.openNodePage();
    expect(r.state.history?.detail?.node).toBeDefined();
  });

  it('the line under the legend is the hint where `r` is offered, and a message a key leaves takes its row only until the next key', () => {
    const r = rig();
    r.onDetail();
    expect(r.text()).toContain(HISTORY_DETAIL_HINT_AGAIN);
    expect(r.text(), 'the legend carries `[r]`, so the line under it does not').not.toContain(
      '[r] opens',
    );
    r.press('p'); // no pin store: its sentence replaces the hint
    expect(r.text()).not.toContain(HISTORY_DETAIL_HINT_AGAIN);
    r.press('', DOWN);
    expect(r.text(), 'the next key brings the hint back').toContain(HISTORY_DETAIL_HINT_AGAIN);
  });
});

describe('what the legend offers is what `r` does: never a promise the press refuses', () => {
  const directories = ['here', 'elsewhere', 'unrecorded', undefined] as const;
  const slugs = ['nightly', 'code-review', 'broken', 'release-notes', undefined] as const;

  it('over every directory, slug and catalog the detail can meet, `[r] run again` is named exactly where `r` makes a request', () => {
    let offered = 0;
    for (const directory of directories)
      for (const workflowSlug of slugs)
        for (const catalog of ['listed', 'none', 'throws'] as const) {
          const defined: DefinedPort | undefined =
            catalog === 'listed'
              ? definedPort().port
              : catalog === 'none'
                ? undefined
                : {
                    read: () => {
                      throw new Error('PRIVATE /secret/path');
                    },
                  };
          const r = rig({ defined });
          // The same catalog is what the load is handed and what `r` reads.
          r.onDetail({ kind: 'ready', detail: detailRead({ directory, workflowSlug }) });
          const named = r.legend().includes('[r] run again');
          const step = r.press('r');
          const label = `${String(directory)}/${String(workflowSlug)}/${catalog}`;
          expect(named, label).toBe(step.kind === 'run');
          if (named) offered += 1;
        }
    expect(offered, 'only nightly and code-review of this directory against a listed catalog').toBe(
      2,
    );
  });

  it('does not offer a workflow the catalog lacks, and the refusal says the truth for an ad-hoc file that was never in the project', () => {
    const r = rig();
    r.onDetail({
      kind: 'ready',
      detail: detailRead({ directory: 'here', workflowSlug: 'adhoc-script' }),
    });
    expect(r.legend()).not.toContain('run again');
    r.press('r');
    expect(r.message()).toBe('This workflow is not defined in this project.');
    expect(r.message(), 'no claim that it ever was').not.toContain('any more');
  });

  it('does not offer a workflow whose file does not parse, and a load given no catalog offers nothing', () => {
    const broken = rig();
    broken.onDetail({
      kind: 'ready',
      detail: detailRead({ directory: 'here', workflowSlug: 'broken' }),
    });
    expect(broken.legend()).not.toContain('run again');
    const none = rig({ defined: undefined });
    none.onDetail();
    expect(none.legend()).not.toContain('run again');
    expect(none.text()).toContain(HISTORY_DETAIL_HINT);
  });

  it('reads the catalog once as the detail lands, and not on a render or a scroll', () => {
    const r = rig();
    const before = r.definedReads.mock.calls.length;
    r.onDetail();
    expect(r.definedReads.mock.calls.length, 'the load read it once').toBe(before + 1);
    r.legend();
    r.text();
    r.press('', DOWN);
    expect(r.definedReads.mock.calls.length, 'drawing and scrolling read nothing').toBe(before + 1);
  });
});

describe('a workflow that changed since the run: the form still opens, and the detail says so first', () => {
  it('asks for the run and leaves `This workflow changed since that run.` on the detail’s message row', () => {
    const r = rig();
    // The catalog's `nightly` has one node; the run froze three.
    r.onDetail({
      kind: 'ready',
      detail: detailRead({ directory: 'here', workflowSlug: 'nightly', authoredNodeCount: 3 }),
    });
    const step = r.press('r');
    expect(step).toMatchObject({ kind: 'run', slug: 'nightly', path: 'nightly.yaml' });
    expect(r.message()).toBe(RUN_AGAIN_CHANGED);
    expect(r.text()).toContain(RUN_AGAIN_CHANGED);
    r.press('', DOWN);
    expect(r.message(), 'the next key drops it, as every sentence a key leaves').toBeUndefined();
  });

  it('says nothing when the workflow has the nodes the run froze, or the run froze no figure', () => {
    for (const authoredNodeCount of [1, undefined]) {
      const r = rig();
      r.onDetail({
        kind: 'ready',
        detail: detailRead({ directory: 'here', workflowSlug: 'nightly', authoredNodeCount }),
      });
      expect(r.press('r').kind).toBe('run');
      expect(r.message(), String(authoredNodeCount)).toBeUndefined();
    }
  });

  it('is still named on the legend: a changed workflow is not a refusal', () => {
    const r = rig();
    r.onDetail({
      kind: 'ready',
      detail: detailRead({ directory: 'here', workflowSlug: 'nightly', authoredNodeCount: 3 }),
    });
    expect(r.legend()).toContain('[r] run again');
  });
});

describe('Esc from a detail reads the list again, so a run that ended before its view opened is in it (round 2, observation F5)', () => {
  /** A History list that grows: the run `r` started is in it once `list.started` is set, and a read fails once `list.fails` is. */
  const list = { started: false, fails: false, page: 0 };
  const source = (query: HistoryQuery): HistoryRead => {
    void query;
    if (list.fails) throw new Error('PRIVATE /secret/path');
    return historyListOfRun(list.started ? [NEWER_RUN] : [], list.page);
  };
  const fresh = (): void => {
    list.started = false;
    list.fails = false;
    list.page = 0;
  };
  const ids = (r: ReturnType<typeof rig>): readonly string[] =>
    (r.state.history?.read?.rows ?? []).flatMap((entry) =>
      entry.kind === 'run' ? [entry.row.id] : [],
    );

  it('puts the new run in the list the person lands on, with the cursor still on the run they came from', () => {
    fresh();
    const r = rig({ list: source });
    r.onDetail();
    expect(ids(r), 'the list read as the detail opened has the one run').toEqual([RUN]);
    list.started = true; // `r` + `Ctrl+Y` started a run that ended at once: the detail stays, and the list behind it is old
    r.press('', ESC);
    expect(r.state.history?.detail, 'back on the list').toBeUndefined();
    expect(ids(r), 'the list read again has the run that started meanwhile').toEqual([
      NEWER_RUN,
      RUN,
    ]);
    const selected = r.state.history?.read?.rows[r.state.history.cursor];
    expect(
      selected?.kind === 'run' ? selected.row.id : undefined,
      'the cursor follows the run',
    ).toBe(RUN);
    expect(r.text()).toContain(NEWER_RUN.slice(0, 8));
  });

  it('reads FRESH, once, and only for the first page: the source keeps the pages it fetched, and a later page is not what a new run changes', () => {
    fresh();
    const first = rig({ list: source });
    first.onDetail();
    const before = first.queries().length;
    first.press('', ESC);
    expect(first.queries().length, 'one read').toBe(before + 1);
    expect(first.queries().at(-1)).toMatchObject({ scope: 'project', page: 0, fresh: true });
    list.page = 2;
    const later = rig({ list: source });
    later.onDetail();
    const reads = later.queries().length;
    later.press('', ESC);
    expect(later.queries().length, 'a later page is left as it was').toBe(reads);
    fresh();
  });

  it('reads nothing for a detail that is missing or unreadable, and nothing for the node page’s own Esc', () => {
    fresh();
    for (const load of [{ kind: 'missing' }, { kind: 'unreadable' }] as const) {
      const r = rig({ list: source });
      r.onDetail(load);
      const reads = r.queries().length;
      r.press('', ESC);
      expect(r.queries().length, load.kind).toBe(reads);
    }
    const r = rig({ list: source });
    r.onDetail();
    r.openNodePage();
    const reads = r.queries().length;
    r.press('', ESC);
    expect(r.state.history?.detail?.node, 'the node page closed').toBeUndefined();
    expect(r.state.history?.detail, 'and the detail stays').toBeDefined();
    expect(r.queries().length, 'the node page’s Esc is one level, not the way to the list').toBe(
      reads,
    );
  });

  it('keeps the list as it was and says so when the read fails', () => {
    fresh();
    const r = rig({ list: source });
    r.onDetail();
    list.fails = true;
    r.press('', ESC);
    list.fails = false;
    expect(r.state.history?.detail).toBeUndefined();
    expect(ids(r)).toEqual([RUN]);
    expect(r.state.history?.message).toBe('The history could not be read again.');
    expect(r.text()).not.toContain('PRIVATE');
  });

  it('is the same for Backspace, the detail’s other way back', () => {
    fresh();
    const r = rig({ list: source });
    r.onDetail();
    list.started = true;
    r.press('', { backspace: true });
    expect(ids(r)).toEqual([NEWER_RUN, RUN]);
    fresh();
  });
});
