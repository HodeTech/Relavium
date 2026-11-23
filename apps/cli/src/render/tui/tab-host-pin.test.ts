/**
 * `p` on the Home's tabs ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §5, MVP-8 step 4): pin or unpin the workflow of a Defined row and the run of a History row. The toggle runs through the tab host's own
 * fold over the real store (`createRunPinStore` over an in-memory `history.db`, behind the Home's `createPinPort`), so what a test reads
 * back is the row the store holds, under the key the store keys it by. The cap is the store's: fifty pins, the fifty-first refused.
 */
import {
  MAX_RUN_PINS,
  createClient,
  createRunHistoryReader,
  createRunPinStore,
  runMigrations,
  type DbClient,
  type RunPinStore,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefinedPort } from '../../home/defined-port.js';
import { createPinPort } from '../../home/pin-port.js';
import { createHistorySource } from '../../history/history-source.js';
import { seedRun } from '../../test-support.js';
import type { CatalogEntry } from '../../workflows/catalog.js';
import type { ChatKey } from './chat-input.js';
import {
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLines,
  type TabHostContext,
  type TabHostState,
  type TabId,
} from './tab-host.js';
import type { HistoryPort } from './tab-host-history.js';
import { PIN_UNAVAILABLE, type PinPort } from './tab-host-pin.js';

const ROOT = '/work/project';
const T0 = 1_750_000_000_000;
const DOWN: ChatKey = { downArrow: true };

let client: DbClient;
let store: RunPinStore;

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createRunPinStore(client.db);
});
afterEach(() => {
  client.sqlite.close();
});

const entry = (slug: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  path: `.relavium/workflows/${slug}.relavium.yaml`,
  valid: true,
  ...over,
});

const pinPort = (): PinPort => createPinPort({ store, workflowRoot: () => ROOT, now: () => T0 });

const workflowPins = () => store.listPins({ kind: 'workflow', projectRoot: ROOT });

/** The tab host entered on `tab` over the real store, with the keys going through its own fold. */
function rig(
  tab: TabId,
  over: {
    readonly entries?: readonly CatalogEntry[];
    readonly history?: HistoryPort;
    readonly pins?: PinPort | undefined;
  } = {},
) {
  const list = vi.fn(() => over.entries ?? []);
  const defined = createDefinedPort({
    catalog: { list },
    pins: () => workflowPins(),
  });
  const reads = vi.fn(defined.read);
  const pins = 'pins' in over ? over.pins : pinPort();
  const context = (): TabHostContext => ({
    port: undefined,
    defined: { read: reads },
    ...(over.history === undefined ? {} : { history: over.history }),
    pins,
    now: 10_000,
    canArm: true,
  });
  let state: TabHostState = enterTab(freshTabMemory(tab), tab, context());
  const press = (input: string, key: ChatKey = {}) => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  return {
    reads,
    press,
    get state(): TabHostState {
      return state;
    },
    text: () =>
      tabHostLines(state, { columns: 80, terminalRows: 24 })
        .map((line) => line.text)
        .join('\n'),
    message: (): string | undefined => state.defined?.message ?? state.history?.message,
  };
}

describe('p on a Defined row pins the workflow, p again unpins it, and the cursor stays on the row', () => {
  const entries = [entry('alpha'), entry('beta'), entry('gamma')];

  it('pins under the project root and the catalog slug, moves the row to the pinned rows at the top, and puts it back on the next p', () => {
    const r = rig('defined', { entries });
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.state.defined?.cursor).toBe(2);
    expect(r.text()).toMatch(/› gamma/u);

    r.press('p');
    expect(workflowPins()).toMatchObject([{ kind: 'workflow', projectRoot: ROOT, ref: 'gamma' }]);
    expect(r.message()).toBe('Pinned gamma.');
    // Pinned rows sort first: the row moved to the top, and the cursor went with it.
    expect(r.state.defined?.cursor).toBe(0);
    expect(r.state.defined?.read.model.rows[0]).toMatchObject({ slug: 'gamma', pinned: true });
    expect(r.text()).toMatch(/› gamma\s+★ pinned/u);

    r.press('p');
    expect(workflowPins(), 'a second p unpins it').toEqual([]);
    expect(r.message()).toBe('Unpinned gamma.');
    expect(
      r.state.defined?.cursor,
      'and the row is back in the catalog’s order, under the cursor',
    ).toBe(2);
    expect(r.text()).toMatch(/› gamma\s+· unpinned/u);
    // One read per toggle, after the toggle: the row's pin word is the store's.
    expect(r.reads).toHaveBeenCalledTimes(3);
  });

  it('shows what the store holds, not what the toggle guessed: a pin made elsewhere meanwhile reads as pinned', () => {
    const r = rig('defined', { entries });
    // Another process pinned `beta` after this tab was read; the row still says unpinned.
    store.pinItem({ kind: 'workflow', projectRoot: ROOT, ref: 'beta', at: T0 });
    r.press('', DOWN);
    r.press('p');
    expect(r.message()).toBe('Pinned beta.');
    expect(workflowPins(), 'it is one pin, not two').toHaveLength(1);
    expect(r.state.defined?.read.model.rows[0]).toMatchObject({ slug: 'beta', pinned: true });
  });

  it('keys the pin by the project root: the same slug in another project is not pinned', () => {
    const r = rig('defined', { entries });
    r.press('p');
    expect(store.listPins({ kind: 'workflow', projectRoot: '/work/other' })).toEqual([]);
    expect(workflowPins()).toHaveLength(1);
  });

  it('at the cap shows the reason in the message row, changes nothing, and reads nothing again', () => {
    for (let index = 0; index < MAX_RUN_PINS; index += 1)
      expect(
        store.pinItem({ kind: 'run', projectRoot: '', ref: `r${String(index)}`, at: index }),
      ).toBe('pinned');
    const r = rig('defined', { entries });
    const before = r.state;
    const readsBefore = r.reads.mock.calls.length;
    r.press('', DOWN);
    r.press('p');
    expect(r.message()).toBe(
      `Cannot pin beta: ${String(MAX_RUN_PINS)} pins is the limit. Unpin one first.`,
    );
    expect(store.listPins()).toHaveLength(MAX_RUN_PINS);
    expect(workflowPins()).toEqual([]);
    expect(r.reads.mock.calls.length, 'nothing changed, so nothing was read again').toBe(
      readsBefore,
    );
    expect(r.state.defined?.read, 'the rows are the very ones that were read').toBe(
      before.defined?.read,
    );
    expect(r.state.defined?.cursor).toBe(1);
    // The next key drops the message, as every message is dropped.
    r.press('', DOWN);
    expect(r.message()).toBeUndefined();
  });

  it('removes a pin whose workflow left the catalog by its row', () => {
    store.pinItem({ kind: 'workflow', projectRoot: ROOT, ref: 'gone', at: T0 });
    const r = rig('defined', { entries: [entry('alpha')] });
    // The pin that left is first, and is the cursor's row.
    expect(r.text()).toContain('? not in catalog');
    r.press('p');
    expect(workflowPins()).toEqual([]);
    expect(r.message()).toBe('Unpinned gone.');
    expect(r.state.defined?.read.model.rows.map((row) => row.slug)).toEqual(['alpha']);
  });

  it('refuses to pin a file that did not parse, says why, and writes and reads nothing', () => {
    const r = rig('defined', {
      entries: [entry('broken', { valid: false, error: 'a workflow must declare a node' })],
    });
    const readsBefore = r.reads.mock.calls.length;
    r.press('p');
    expect(r.message()).toBe('Cannot pin broken: a workflow must declare a node.');
    expect(store.listPins()).toEqual([]);
    expect(r.reads.mock.calls.length).toBe(readsBefore);
  });

  it('says so, and changes nothing, when the Home has no pin store', () => {
    const r = rig('defined', { entries, pins: undefined });
    r.press('p');
    expect(r.message()).toBe(PIN_UNAVAILABLE);
    expect(store.listPins()).toEqual([]);
  });

  it('says the pin could not be changed, in words that carry nothing stored, when the store refuses', () => {
    const refusing: PinPort = {
      ...pinPort(),
      pinWorkflow: () => {
        throw new Error('PRIVATE-STORED-VALUE');
      },
    };
    const r = rig('defined', { entries, pins: refusing });
    r.press('p');
    expect(r.message()).toBe('Could not change the pin of alpha.');
    expect(r.message()).not.toContain('PRIVATE');
  });
});

describe('p on a History row pins the run under its canonical key', () => {
  const RUN = 'a1b2c3d4-0000-4000-8000-000000000001';

  async function historyRig(over: { readonly pins?: PinPort | undefined } = {}) {
    await seedRun(client.db, { slug: 'wf', runId: RUN, state: 'completed', atMs: T0 });
    client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(ROOT, RUN);
    const source = createHistorySource({
      reader: createRunHistoryReader(client.db),
      listRunPins: () => store.listPins({ kind: 'run' }),
      projectRoot: ROOT,
      now: () => T0 + 60_000,
    });
    const read = vi.fn(source.read);
    const history: HistoryPort = {
      read,
      cost: source.cost,
      loadDetail: () => Promise.resolve({ kind: 'missing' }),
    };
    // `assign`, not a spread: the rig's `state` is a getter, and a spread would copy the value it had when the rig was made.
    return Object.assign(
      rig('history', { history, ...('pins' in over ? { pins: over.pins } : {}) }),
      {
        read,
      },
    );
  }

  it('pins the run by its FULL id with no project root, shows it pinned above the list and on its row, and unpins on the next p', async () => {
    const r = await historyRig();
    r.press('p');
    const pins = store.listPins({ kind: 'run' });
    expect(pins).toHaveLength(1);
    // The canonical key of a run: its kind, no project (a run id is global), and the whole id (not the eight characters the row draws).
    expect(pins[0]).toMatchObject({ kind: 'run', projectRoot: '', ref: RUN, oversized: false });
    expect(r.message()).toBe('Pinned a1b2c3d4.');
    const text = r.text();
    expect(text).toContain('Pinned (1)');
    expect(text.match(/★ pinned/gu)).toHaveLength(2);
    // The cursor stayed on the run: it is the row in the page, which now sits under the pinned section.
    expect(r.state.history?.focus).toBe(`row:${RUN}`);

    r.press('p');
    expect(store.listPins({ kind: 'run' })).toEqual([]);
    expect(r.message()).toBe('Unpinned a1b2c3d4.');
    expect(r.text()).not.toContain('Pinned (');
    expect(r.state.history?.focus).toBe(`row:${RUN}`);
  });

  it('unpins from the pinned section, where the cursor then falls on the same run in the page', async () => {
    const r = await historyRig();
    r.press('p');
    // Move up onto the pinned entry (it is the first entry), and press p there.
    r.press('', { upArrow: true });
    expect(r.state.history?.focus).toBe(`pin:${RUN}`);
    r.press('p');
    expect(store.listPins({ kind: 'run' })).toEqual([]);
    expect(r.state.history?.focus).toBe(`row:${RUN}`);
  });

  it('at the cap shows the reason, changes nothing, and reads the page no more', async () => {
    const r = await historyRig();
    for (let index = 0; index < MAX_RUN_PINS; index += 1)
      store.pinItem({ kind: 'workflow', projectRoot: ROOT, ref: `w${String(index)}`, at: index });
    const readsBefore = r.read.mock.calls.length;
    const before = r.state.history?.read;
    r.press('p');
    expect(r.message()).toBe(
      `Cannot pin a1b2c3d4: ${String(MAX_RUN_PINS)} pins is the limit. Unpin one first.`,
    );
    expect(store.listPins({ kind: 'run' })).toEqual([]);
    expect(r.read.mock.calls.length).toBe(readsBefore);
    expect(r.state.history?.read).toBe(before);
  });

  it('removes a pin whose run is gone by its row', async () => {
    store.pinItem({ kind: 'run', projectRoot: '', ref: 'ghost-run', at: T0 });
    const r = await historyRig();
    expect(r.text()).toContain('? missing');
    r.press('p');
    expect(store.listPins({ kind: 'run' })).toEqual([]);
    expect(r.message()).toBe('Unpinned ghost-run.');
  });

  it('says pinning is unavailable, and writes nothing, when the Home has no pin store', async () => {
    const r = await historyRig({ pins: undefined });
    r.press('p');
    expect(r.message()).toBe(PIN_UNAVAILABLE);
    expect(store.listPins()).toEqual([]);
  });
});
