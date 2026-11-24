/**
 * The Defined tab of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): its rows, its keys, and what `r` and `x` ask for. A pure model: no ink, no controller, no real project; the catalog
 * and the pins are values the test hands in through the one port the tab reads.
 *
 * "Inert" is proved at the step: a row that is not a catalog entry (a pin whose workflow left, a file that did not parse) produces
 * NO `run` and NO `export` step, so nothing downstream can be handed its label; and the slug of a request that is made is the
 * catalog entry's own, looked up by index.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildDefinedModel,
  type DefinedEntry,
  type DefinedPin,
} from '../../history/defined-model.js';
import { launchAmbiguous, launchChanged, launchMoved } from '../../home/run-launch.js';
import type { ChatKey } from './chat-input.js';
import { usableColumns } from './sheet-frame.js';
import {
  TAB_HOST_ROWS,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegend,
  tabHostLegendText,
  tabHostLines,
  tabHostMemory,
  withDefinedNote,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
} from './tab-host.js';
import {
  DEFINED_EMPTY,
  DEFINED_KEYS,
  DEFINED_NO_DETAIL,
  DEFINED_UNREADABLE,
  type DefinedPort,
} from './tab-host-workflows.js';
import { displayWidth } from './viewport.js';

const UP: ChatKey = { upArrow: true };
const DOWN: ChatKey = { downArrow: true };
const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };

const entry = (over: Partial<DefinedEntry> & { slug: string }): DefinedEntry => ({
  name: undefined,
  path: `.relavium/workflows/${over.slug}.relavium.yaml`,
  valid: true,
  ...over,
});

const pin = (ref: string, rowid: number, over: Partial<DefinedPin> = {}): DefinedPin => ({
  kind: 'workflow',
  ref,
  rowid,
  oversized: false,
  ...over,
});

const READY: readonly DefinedEntry[] = [
  entry({ slug: 'code-review', name: 'Code Review', nodeCount: 5 }),
  entry({ slug: 'nightly', name: undefined, nodeCount: 1 }),
  entry({ slug: 'broken-one', valid: false, error: 'a workflow must declare at least one node' }),
];

/** A port over a catalog and pins the test can change; it counts its reads. */
function portOver(entries: readonly DefinedEntry[], pins: readonly DefinedPin[] = []) {
  let current = { entries, pins };
  const reads = vi.fn();
  const port: DefinedPort = {
    read: () => {
      reads();
      const { entries: listed, pins: pinned } = current;
      return {
        model: buildDefinedModel({
          entries: listed,
          pins: pinned,
          lastRuns: new Map([['code-review', 'completed']]),
        }),
        slugOf: (index) => listed[index]?.slug,
        pathOf: (index) => listed[index]?.path,
      };
    },
  };
  return {
    port,
    reads,
    set: (next: { entries: readonly DefinedEntry[]; pins?: readonly DefinedPin[] }) => {
      current = { entries: next.entries, pins: next.pins ?? [] };
    },
  };
}

/** `state` with the Defined tab's cursor at `cursor`. */
function atCursor(state: TabHostState, cursor: number): TabHostState {
  if (state.defined === undefined) throw new Error('the Defined tab was not read');
  return { ...state, defined: { ...state.defined, cursor } };
}

/** The Defined tab entered over a port, with the keys going through the tab host's own fold. */
function rig(entries: readonly DefinedEntry[], pins: readonly DefinedPin[] = []) {
  const fake = portOver(entries, pins);
  const context = (): TabHostContext => ({
    port: undefined,
    defined: fake.port,
    now: 10_000,
    canArm: true,
  });
  let state: TabHostState = enterTab(freshTabMemory('defined'), 'defined', context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  return {
    ...fake,
    press,
    context,
    get state(): TabHostState {
      return state;
    },
    set state(next: TabHostState) {
      state = next;
    },
    cursor: (): number | undefined => state.defined?.cursor,
    lines: (columns = 80, rows = 24) =>
      tabHostLines(state, { columns, terminalRows: rows }).map((line) => line.text),
  };
}

describe('the rows say what they are, in a glyph and a word', () => {
  it('draws a ready workflow with its node count, its last run and its pin word, an invalid file flagged, and a pin that left marked', () => {
    const r = rig(READY, [pin('code-review', 7), pin('left-the-catalog', 8)]);
    const text = r.lines().join('\n');
    // Pinned rows first: the workflow pinned, then the pin the catalog no longer has, then the rest in the catalog's order.
    const drawn = r.lines().slice(2, 7);
    expect(drawn[0]).toMatch(
      /^› code-review {2}Code Review {2}5 nodes\s+✓ completed {2}★ pinned$/u,
    );
    expect(drawn[1]).toMatch(/^ {2}left-the-catalog {2}\? not in catalog\s+★ pinned$/u);
    expect(drawn[2]).toMatch(/^ {2}nightly {2}1 node\s+· unpinned$/u);
    expect(drawn[3]).toMatch(/^ {2}broken-one {2}✗ invalid\s+· unpinned$/u);
    // Every state is a word as well as a glyph; none is colour alone.
    for (const word of ['✓ completed', '★ pinned', '· unpinned', '✗ invalid', '? not in catalog'])
      expect(text, word).toContain(word);
  });

  it('shows the selected row’s file, and for a row that is not a workflow that runs, why it is neither run nor exported', () => {
    const r = rig(READY, [pin('left-the-catalog', 8)]);
    // The pin that left is first (pinned rows come first) and is selected.
    expect(r.lines().join('\n')).toContain('Cannot run or export: not in catalog');
    r.press('', DOWN);
    expect(r.lines().join('\n')).toContain('.relavium/workflows/code-review.relavium.yaml');
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.lines().join('\n')).toContain(
      'Cannot run or export: a workflow must declare at least one node',
    );
  });

  it('keeps what `p` does on screen at 80 columns for a pin of another project, however long that project’s path is: the path comes last', () => {
    const long = `/work/${'a-deep-directory/'.repeat(6)}project`;
    const port: DefinedPort = {
      read: () => ({
        model: buildDefinedModel({
          entries: [],
          pins: [],
          otherPins: [
            { kind: 'workflow', ref: 'elsewhere', rowid: 9, oversized: false, projectRoot: long },
          ],
        }),
        slugOf: () => undefined,
        pathOf: () => undefined,
      }),
    };
    const state = enterTab(freshTabMemory('defined'), 'defined', {
      port: undefined,
      defined: port,
      now: 0,
    });
    const lines = tabHostLines(state, { columns: 80, terminalRows: 24 }).map((l) => l.text);
    const line = lines.find((l) => l.startsWith('Pinned in another project')) ?? '';
    expect(line, 'the sentence about the pin is drawn').toContain('[p] removes the pin');
    expect(displayWidth(line)).toBeLessThanOrEqual(78);
    // The cut is real, and it falls on the project path (which comes last), never on what `p` does.
    expect(line.endsWith('…'), 'the line was cut').toBe(true);
    expect(line, 'the whole path did not fit').not.toContain(long);
    expect(line).toContain('/work/a-deep-directory/');
    // Without a project root the sentence has nothing to add.
    const bare = tabHostLines(
      enterTab(freshTabMemory('defined'), 'defined', {
        port: undefined,
        defined: {
          read: () => ({
            model: buildDefinedModel({
              entries: [],
              pins: [],
              otherPins: [
                { kind: 'workflow', ref: 'elsewhere', rowid: 9, oversized: false, projectRoot: '' },
              ],
            }),
            slugOf: () => undefined,
            pathOf: () => undefined,
          }),
        },
        now: 0,
      }),
      { columns: 80, terminalRows: 24 },
    ).map((l) => l.text);
    expect(bare).toContain('Pinned in another project; [p] removes the pin.');
  });

  it('says so when the project has no workflow, and when the tab cannot be listed', () => {
    expect(rig([]).lines().join('\n')).toContain(DEFINED_EMPTY);
    const unreadable = enterTab(freshTabMemory('defined'), 'defined', {
      port: undefined,
      defined: {
        read: () => {
          throw new Error('PRIVATE');
        },
      },
      now: 0,
    });
    const drawn = tabHostLines(unreadable, { columns: 80, terminalRows: 24 }).map((l) => l.text);
    expect(drawn.join('\n')).toContain(DEFINED_UNREADABLE);
    expect(drawn.join('\n')).not.toContain('PRIVATE');
    // No port at all is the same sentence, never a crash.
    const noPort = enterTab(freshTabMemory('defined'), 'defined', { port: undefined, now: 0 });
    expect(noPort.unreadable).toBe(true);
  });
});

describe('↑ and ↓ move the cursor and stop at the ends', () => {
  it('moves one row at a time and stays at the top and at the bottom', () => {
    const r = rig(READY);
    expect(r.cursor()).toBe(0);
    r.press('', UP);
    expect(r.cursor(), '↑ at the top stays').toBe(0);
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.cursor()).toBe(2);
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.cursor(), '↓ at the bottom stays').toBe(2);
    r.press('', UP);
    expect(r.cursor()).toBe(1);
  });

  it('a chord or a meta key moves nothing', () => {
    const r = rig(READY);
    r.press('', { downArrow: true, ctrl: true });
    r.press('', { downArrow: true, meta: true });
    expect(r.cursor()).toBe(0);
  });

  it('Enter says there is no workflow detail yet and names the keys that act, and asks the host for nothing', () => {
    const r = rig(READY);
    const step = r.press('', ENTER);
    expect(step.kind, 'a state, never a request').toBe('state');
    expect(r.state.defined?.message).toBe(DEFINED_NO_DETAIL);
    expect(r.lines().join('\n')).toContain(DEFINED_NO_DETAIL);
    // The sentence names exactly the keys the legend names.
    for (const key of ['r', 'x', 'p']) expect(DEFINED_NO_DETAIL).toContain(`[${key}] `);
    // The next key drops it, as every message of the tab.
    r.press('', DOWN);
    expect(r.state.defined?.message).toBeUndefined();
  });

  it('Enter on a tab with no row has nothing to say about, so it says nothing; the other keys are nothing too', () => {
    const empty = rig([]);
    expect(empty.press('', ENTER)).toEqual({ kind: 'state', state: empty.state });
    expect(empty.state.defined?.message).toBeUndefined();
    const r = rig(READY);
    for (const letter of ['a', 'd', 'z', ' ']) {
      expect(r.press(letter).kind, letter).toBe('state');
    }
    expect(r.state.defined?.cursor).toBe(0);
  });

  it('Esc closes the screen, as it does on every tab with no question to drop', () => {
    expect(rig(READY).press('', ESC).kind).toBe('close');
  });
});

describe('a refused launch names its files on the message row at 80 columns, however long the directories are', () => {
  const first = `.relavium/workflows/${'a-deep-directory/'.repeat(4)}first.relavium.yaml`;
  const second = `.relavium/workflows/${'another-directory/'.repeat(4)}second.relavium.yaml`;

  it.each([
    [
      'a file that moved',
      launchMoved('nightly', second),
      'Not started. Open the list again: nightly is now in second.relavium.yaml.',
    ],
    [
      'two files with one id',
      launchAmbiguous('nightly', first, second),
      'Not started. Rename one of first or second: both declare nightly.',
    ],
  ])(
    '%s: the whole sentence is on the row, and the directories are not',
    (_what, message, expected) => {
      const r = rig(READY);
      const noted = withDefinedNote(r.state, message);
      const row = tabHostLines(noted, { columns: 80, terminalRows: 24 })
        .map((line) => line.text)
        .find((line) => line.startsWith('Not started.'));
      expect(row, 'the message is drawn, whole').toBe(expected);
      expect(displayWidth(row ?? '')).toBeLessThanOrEqual(78);
    },
  );

  it.each([
    [
      'a file whose id changed',
      launchChanged('nightly', 'a-new-id'.repeat(9)),
      'Not started. Open the list again: ',
    ],
  ])(
    '%s: the row starts with what to do, and a clip takes the id, not the remedy',
    (_what, message, lead) => {
      const r = rig(READY);
      const noted = withDefinedNote(r.state, message);
      const row = tabHostLines(noted, { columns: 80, terminalRows: 24 })
        .map((line) => line.text)
        .find((line) => line.startsWith('Not started.'));
      expect(row, 'the message is drawn').toBeDefined();
      expect(row?.startsWith(lead), 'what to do comes first').toBe(true);
      expect(displayWidth(row ?? '')).toBeLessThanOrEqual(78);
      expect(row?.endsWith('…'), 'the sentence is longer than the row: the cut is real').toBe(true);
    },
  );
});

describe('r runs the row’s workflow through the launch flow', () => {
  it('asks for the slug of the catalog entry the row names, with the tab left where it was', () => {
    const r = rig(READY);
    r.press('', DOWN);
    const step = r.press('r');
    // The request carries the slug and the catalog path the row was listed from, so the launch can refuse a file that is another one by then.
    expect(step).toMatchObject({
      kind: 'run',
      slug: 'nightly',
      path: '.relavium/workflows/nightly.relavium.yaml',
    });
    expect(step.kind === 'run' ? step.state.defined?.cursor : undefined).toBe(1);
  });

  it('follows the entry, not the row’s place in the list: a pinned workflow moves up and still runs as itself', () => {
    const r = rig(READY, [pin('nightly', 3)]);
    // `nightly` is pinned, so it is the first row although it is the second entry of the catalog.
    expect(r.press('r')).toMatchObject({ kind: 'run', slug: 'nightly' });
  });

  it('a letter with Caps Lock on is the same key: R, X and P act as r, x and p', () => {
    const r = rig(READY);
    expect(r.press('R')).toMatchObject({ kind: 'run', slug: 'code-review' });
    expect(r.press('X')).toMatchObject({ kind: 'export', slug: 'code-review' });
    const pinned = vi.fn();
    const asked = foldTabHostKey(
      r.state,
      'P',
      {},
      {
        port: undefined,
        defined: r.port,
        pins: {
          pinWorkflow: (slug) => {
            pinned(slug);
            return 'pinned';
          },
          unpinWorkflow: () => true,
          pinRun: () => 'pinned',
          unpinRun: () => true,
          unpinRow: () => true,
        },
        now: 10_000,
        canArm: true,
      },
    );
    expect(asked.kind).toBe('state');
    expect(pinned, 'P pinned the row, as p does').toHaveBeenCalledWith('code-review');
  });

  it('a Ctrl+R or Meta+R is not an R: nothing is asked', () => {
    const r = rig(READY);
    expect(r.press('r', { ctrl: true }).kind).toBe('state');
    expect(r.press('r', { meta: true }).kind).toBe('state');
  });

  it('a file that did not parse refuses with its own note, and asks for nothing', () => {
    const r = rig(READY);
    r.press('', DOWN);
    r.press('', DOWN);
    const step = r.press('r');
    expect(step.kind).toBe('state');
    expect(r.lines().join('\n')).toContain(
      'Cannot run broken-one: a workflow must declare at least one node.',
    );
  });

  it('a pin whose workflow is not in the catalog refuses, and says it is not in the catalog', () => {
    const r = rig(READY, [pin('left-the-catalog', 8)]);
    const step = r.press('r');
    expect(step.kind).toBe('state');
    expect(r.lines().join('\n')).toContain(
      'Cannot run left-the-catalog: it is not in the catalog.',
    );
  });

  it('the next key drops the message', () => {
    const r = rig(READY, [pin('left-the-catalog', 8)]);
    r.press('r');
    expect(r.lines().join('\n')).toContain('Cannot run');
    r.press('', DOWN);
    expect(r.lines().join('\n')).not.toContain('Cannot run');
  });
});

describe('x opens the export card for the row', () => {
  it('asks for the slug of the catalog entry the row names', () => {
    const r = rig(READY);
    expect(r.press('x')).toMatchObject({ kind: 'export', slug: 'code-review' });
  });

  it('refuses a file that did not parse and a pin that left, and asks for nothing', () => {
    const r = rig(READY, [pin('left-the-catalog', 8)]);
    expect(r.press('x').kind).toBe('state');
    expect(r.lines().join('\n')).toContain(
      'Cannot export left-the-catalog: it is not in the catalog.',
    );
    r.press('', DOWN);
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.press('x').kind).toBe('state');
    expect(r.lines().join('\n')).toContain('Cannot export broken-one: ');
  });

  it('an empty list has nothing to export or run', () => {
    const r = rig([]);
    expect(r.press('x').kind).toBe('state');
    expect(r.press('r').kind).toBe('state');
  });
});

describe('a crafted slug is inert', () => {
  const CRAFTED = '../../x';

  it('a pin with a path for a ref is a line of text: neither key makes a request, and the path is never the slug of one', () => {
    const r = rig(READY, [pin(CRAFTED, 9)]);
    // It is the first row (pinned rows come first) and is shown as the label it is.
    expect(r.lines().join('\n')).toContain(`${CRAFTED}  ? not in catalog`);
    const requests: TabHostStep[] = [r.press('r'), r.press('x')];
    for (const step of requests) expect(step.kind, JSON.stringify(step)).toBe('state');
    // Whatever the other keys do, no step of the whole session is a request, so none carries the crafted text as a slug.
    for (const key of [DOWN, UP, ENTER]) requests.push(r.press('', key));
    expect(requests.filter((step) => step.kind !== 'state')).toEqual([]);
  });

  it('an entry that really carries such a slug is handed on as TEXT, to be compared with the catalog and never opened', () => {
    const r = rig([entry({ slug: CRAFTED, nodeCount: 2 })]);
    // The tab does not judge a catalog's slugs (the catalog and the launch flow do); it must not alter them either.
    expect(r.press('r')).toMatchObject({ kind: 'run', slug: CRAFTED });
  });

  it('an entry that has gone from the catalog between the read and the key is refused, not looked up under another index', () => {
    const r = rig(READY);
    const stale = r.state.defined;
    if (stale === undefined) throw new Error('the tab was not read');
    const shrunk: TabHostState = {
      ...r.state,
      defined: {
        ...stale,
        read: { ...stale.read, slugOf: () => undefined, pathOf: () => undefined },
      },
    };
    r.state = shrunk;
    expect(r.press('r').kind).toBe('state');
    expect(r.lines().join('\n')).toContain(
      'Cannot run code-review: it is not in the catalog any more.',
    );
  });

  it('a request needs the entry’s path as well as its slug: a read that knows the slug and not the file asks the launch for nothing', () => {
    const r = rig(READY);
    const stale = r.state.defined;
    if (stale === undefined) throw new Error('the tab was not read');
    r.state = {
      ...r.state,
      defined: { ...stale, read: { ...stale.read, pathOf: () => undefined } },
    };
    expect(r.press('r').kind).toBe('state');
    expect(r.lines().join('\n')).toContain(
      'Cannot run code-review: it is not in the catalog any more.',
    );
    // Export names no path: it needs the slug alone, as it always did.
    expect(r.press('x')).toMatchObject({ kind: 'export', slug: 'code-review' });
  });
});

describe('the legend names exactly the keys the tab answers to', () => {
  it('lists select, run, export and pin with the tab keys and Esc last, and each does what it says', () => {
    const r = rig(READY);
    const { items, exit } = tabHostLegend(r.state);
    expect([...items, exit].map((item) => ('keys' in item ? item.keys : item.text))).toEqual([
      '←/→',
      'Tab',
      '↑/↓',
      'r',
      'x',
      'p',
      'Esc',
    ]);
    expect(tabHostLegendText(r.state)).toBe(
      '←/→ tab · Tab cycle · ↑/↓ select · [r] run · [x] export · [p] pin · Esc close',
    );
    expect(DEFINED_KEYS.select.keys).toBe('↑/↓');
    expect(r.press('', DOWN).kind).toBe('state');
    expect(r.cursor()).toBe(1);
    expect(r.press('r').kind).toBe('run');
    expect(r.press('x').kind).toBe('export');
    // `p` is answered inside the tab host (through its pin port, which `tab-host-pin.test.ts` drives): here there is none.
    expect(r.press('p').kind).toBe('state');
    expect(r.state.defined?.message).toBe('Pinning is unavailable in this session.');
    expect(DEFINED_KEYS.pin.keys).toBe('p');
    expect(r.press('', ESC).kind).toBe('close');
  });

  it('names no row key when there is no row', () => {
    const { items, exit } = tabHostLegend(rig([]).state);
    expect([...items, exit].map((item) => ('keys' in item ? item.keys : item.text))).toEqual([
      '←/→',
      'Tab',
      'Ctrl+C',
      'Esc',
    ]);
  });
});

describe('what the tab remembers, and the notes it is given', () => {
  it('keeps the cursor across a trip to another tab, clamps it to the rows there are now, and reads the port again each time', () => {
    const r = rig(READY);
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.reads).toHaveBeenCalledTimes(1);
    r.press('', { rightArrow: true }); // to Active
    r.press('', { leftArrow: true }); // and back: read again
    expect(r.reads).toHaveBeenCalledTimes(2);
    expect(r.cursor()).toBe(2);
    // The catalog shrank while the person was away: the cursor lands on a row that exists.
    r.set({ entries: READY.slice(0, 1) });
    r.press('', { rightArrow: true });
    r.press('', { leftArrow: true });
    expect(r.cursor()).toBe(0);
    expect(tabHostMemory(r.state).positions.defined).toBe(0);
  });

  it('puts a sentence on the tab that the next key drops, and only on that tab', () => {
    const r = rig(READY);
    r.state = withDefinedNote(r.state, 'Started code-review as run r-1.');
    expect(r.lines().join('\n')).toContain('Started code-review as run r-1.');
    r.press('', DOWN);
    expect(r.lines().join('\n')).not.toContain('Started code-review');
    const elsewhere = enterTab(freshTabMemory('active'), 'active', { port: undefined, now: 0 });
    expect(withDefinedNote(elsewhere, 'x')).toBe(elsewhere);
  });
});

describe('the Defined tab fits the 23-row budget', () => {
  const many = Array.from({ length: 300 }, (_, index) =>
    entry({
      slug: `workflow-${String(index).padStart(3, '0')}`,
      name: `Workflow number ${String(index)}`,
      nodeCount: index,
    }),
  );

  const checks: readonly (readonly [string, number, number])[] = [
    ['80x24', 80, 24],
    ['120x40', 120, 40],
    ['80x30', 80, 30],
  ];

  it.each(checks)(
    'at %s, with 300 workflows and a message: at most 23 rows, none wider than the margin allows, the cursor in view, the strip first and the legend last',
    (_name, columns, terminalRows) => {
      const r = rig(many);
      for (const at of [0, 1, 7, 150, 199]) {
        r.state = atCursor(r.state, at);
        r.state = withDefinedNote(
          r.state,
          'Cannot run workflow-007: it is not in the catalog any more.',
        );
        const lines = r.lines(columns, terminalRows);
        expect(lines.length, `cursor ${String(at)}`).toBeLessThanOrEqual(TAB_HOST_ROWS);
        expect(lines[0]).toContain('› Defined');
        expect(lines.at(-1)).toContain('Esc close');
        for (const line of lines)
          expect(displayWidth(line), line).toBeLessThanOrEqual(usableColumns(columns));
        const selected = lines.slice(1).filter((line) => line.startsWith('› '));
        expect(selected.length, 'exactly one selected row is drawn').toBe(1);
        expect(selected[0]).toContain(`workflow-${String(at).padStart(3, '0')}`);
      }
    },
  );

  it('counts the rows past the model’s own bound, and marks the rows a window hides', () => {
    const r = rig(many);
    const first = r.lines().join('\n');
    expect(first).toContain('… 100 more not listed');
    expect(first).toContain('▼ ');
    expect(first).not.toContain('▲ ');
    r.state = atCursor(r.state, 100);
    const middle = r.lines().join('\n');
    expect(middle).toContain('▲ ');
    expect(middle).toContain('▼ ');
  });
});
