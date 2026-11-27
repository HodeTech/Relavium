/**
 * `p` on the Runs screen ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §5, MVP-8 step 4): pin or unpin the run of a History row (a workflow is pinned in the `/workflows` popup: `popups/home-workflows-pin.test.ts`).
 * The toggle runs through the tab host's own
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

import { createPinPort } from '../../home/pin-port.js';
import { createHistorySource } from '../../history/history-source.js';
import { seedRun } from '../../test-support.js';
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

const pinPort = (): PinPort => createPinPort({ store, workflowRoot: () => ROOT, now: () => T0 });

/** The Runs screen entered on `tab` over the real store, with the keys going through its own fold. */
function rig(
  tab: TabId,
  over: {
    readonly history?: HistoryPort;
    readonly pins?: PinPort | undefined;
  } = {},
) {
  const pins = 'pins' in over ? over.pins : pinPort();
  const context = (): TabHostContext => ({
    ...(over.history === undefined ? {} : { history: over.history }),
    pins,
    now: 10_000,
  });
  let state: TabHostState = enterTab(freshTabMemory(tab), tab, context());
  const press = (input: string, key: ChatKey = {}) => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  return {
    press,
    get state(): TabHostState {
      return state;
    },
    text: () =>
      tabHostLines(state, { columns: 80, terminalRows: 24 })
        .map((line) => line.text)
        .join('\n'),
    message: (): string | undefined => state.history?.message,
  };
}

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
    // The sentence the `/workflows` popup gives, with the store's own counts: the total, and how many of them this list does not hold.
    expect(r.message()).toBe(
      `Cannot pin a1b2c3d4: ${String(MAX_RUN_PINS)} is the limit; ${String(MAX_RUN_PINS)} stored, ${String(MAX_RUN_PINS)} of them workflows.`,
    );
    expect(store.listPins({ kind: 'run' })).toEqual([]);
    expect(r.read.mock.calls).toHaveLength(readsBefore);
    expect(r.state.history?.read).toBe(before);
  });

  it('at the cap names the counts from the store, runs included: the run pins are what this list holds, the workflow pins are not', async () => {
    for (let index = 0; index < 3; index += 1)
      store.pinItem({ kind: 'run', projectRoot: '', ref: `r${String(index)}`, at: index });
    for (let index = 0; index < MAX_RUN_PINS - 3; index += 1)
      store.pinItem({
        kind: 'workflow',
        projectRoot: ROOT,
        ref: `w${String(index)}`,
        at: 100 + index,
      });
    const r = await historyRig();
    // The three run pins name no run: they head the list as missing entries, and the run itself is the last entry.
    r.press('', { end: true });
    r.press('p');
    expect(r.message()).toBe(
      `Cannot pin a1b2c3d4: ${String(MAX_RUN_PINS)} is the limit; ${String(MAX_RUN_PINS)} stored, ${String(MAX_RUN_PINS - 3)} of them workflows.`,
    );
  });

  describe('at the cap, when the pin port cannot say what the store holds', () => {
    const full = (): void => {
      for (let index = 0; index < MAX_RUN_PINS; index += 1)
        store.pinItem({ kind: 'workflow', projectRoot: ROOT, ref: `w${String(index)}`, at: index });
    };
    const LIMIT_ALONE = `Cannot pin a1b2c3d4: ${String(MAX_RUN_PINS)} pins is the limit. Unpin one first.`;

    it('says the limit alone when it has no counts', async () => {
      full();
      const r = await historyRig({ pins: { ...pinPort(), counts: undefined } });
      r.press('p');
      expect(r.message()).toBe(LIMIT_ALONE);
    });

    it('says the limit alone, and nothing of the fault, when asking for them throws', async () => {
      full();
      const r = await historyRig({
        pins: {
          ...pinPort(),
          counts: () => {
            throw new Error('PRIVATE-STORE-FAULT');
          },
        },
      });
      r.press('p');
      expect(r.message()).toBe(LIMIT_ALONE);
      expect(r.message()).not.toContain('PRIVATE');
    });
  });

  it('says that nothing was removed, not that it unpinned, when the store held no such pin any more', async () => {
    const r = await historyRig();
    r.press('p');
    expect(r.message()).toBe('Pinned a1b2c3d4.');
    // Another process removed the pin after the list was read: the row still says pinned.
    store.unpinItem({ kind: 'run', projectRoot: '', ref: RUN });
    r.press('p');
    expect(r.message()).toBe('Nothing was removed: a1b2c3d4 is not pinned.');
    expect(r.message()).not.toContain('Unpinned');
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
