/**
 * `[p]` in the `/workflows` popup ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §5;
 * [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4 D1): pin or unpin the workflow whose detail is open, through the Home's own pin
 * port over the real store (`createRunPinStore` over an in-memory `history.db`, behind `createPinPort`), so what a test reads back is the row the store
 * holds, under the key the store keys it by. These are the cases the Defined tab's `p` was held to (the tab left the screen with OD-24): the key is the
 * project root and the catalog slug, the highlight follows the workflow, the cap is the store's (fifty pins, the fifty-first refused), a pin that is no
 * entry of the catalogue (another project's, or one whose workflow left) stays a row and can be removed so a slot is never held by a pin no one can free.
 */
import {
  MAX_RUN_PINS,
  createClient,
  createRunPinStore,
  runMigrations,
  type DbClient,
  type RunPinStore,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefinedPort } from '../home/defined-port.js';
import { createPinPort } from '../home/pin-port.js';
import type { PinPort } from '../render/tui/tab-host-pin.js';
import type { CatalogEntry } from '../workflows/catalog.js';
import {
  DOWN,
  ENTER,
  ESC,
  detailOf,
  fakeWorkflows,
  homeRig,
  invalidWorkflowEntry,
  settleWork,
  type HomeRig,
} from './home-popups.test-support.js';
import { WORKFLOWS_STEP } from './home-workflows-popup.js';

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

const entry = (slug: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  nodeCount: 2,
  path: `.relavium/workflows/${slug}.relavium.yaml`,
  valid: true,
  ...over,
});
const pinPort = (): PinPort => createPinPort({ store, workflowRoot: () => ROOT, now: () => T0 });
const workflowPins = () => store.listPins({ kind: 'workflow', projectRoot: ROOT });

/** The popup over the real store: the catalogue is the Defined port's own read, the pins are the Home's pin port. */
async function open(
  entries: readonly CatalogEntry[],
  over: { readonly pins?: PinPort | undefined; readonly withoutAllPins?: boolean } = {},
) {
  const reads = vi.fn();
  const defined = createDefinedPort({
    catalog: { list: () => entries },
    pins: () => workflowPins(),
    allPins: over.withoutAllPins === true ? undefined : () => store.listPins(),
  });
  const fakes = fakeWorkflows(entries, {
    describe: () => detailOf(),
  });
  const rig = homeRig();
  const port = {
    ...fakes.port,
    read: () => {
      reads();
      return defined.read();
    },
    pins: 'pins' in over ? over.pins : pinPort(),
  };
  expect(rig.open('workflows', { workflows: port }).opened).toBe(true);
  await settleWork();
  rig.settle();
  return { rig, reads };
}

/** `Enter` on the highlighted row (its detail), and the read lands. */
async function intoDetail(rig: HomeRig): Promise<void> {
  rig.press('', ENTER);
  await settleWork();
  rig.clock.advance(700);
}

/** The highlight moved to the row whose id is `id`. */
function moveTo(rig: HomeRig, id: string): void {
  for (let presses = 0; presses < 80 && rig.highlighted() !== id; presses += 1) rig.press('', DOWN);
  expect(rig.highlighted()).toBe(id);
}

/** The next notification, once the one showing has had its time. */
function said(rig: HomeRig): string | undefined {
  const current = rig.notice();
  rig.clock.advance(3100);
  return current;
}

describe('`[p]` pins the workflow, `[p]` again unpins it, and the highlight stays on the workflow', () => {
  const entries = [entry('alpha'), entry('beta'), entry('gamma')];

  it('pins under the project root and the catalog slug, moves the row to the pinned rows at the top, and puts it back on the next `[p]`', async () => {
    const { rig, reads } = await open(entries);
    moveTo(rig, 'wf:2');
    await intoDetail(rig);
    rig.press('p');
    expect(workflowPins()).toMatchObject([{ kind: 'workflow', projectRoot: ROOT, ref: 'gamma' }]);
    expect(said(rig)).toBe('Pinned gamma.');
    // Pinned rows sort first: the catalogue behind has `gamma` on top, the highlight still on it.
    rig.press('', ESC);
    expect(rig.highlighted()).toBe('wf:2');
    const list = rig.content();
    if (list.kind !== 'list') throw new Error('list');
    expect(list.rows.find((row) => row.id === 'wf:2')?.tail?.after).toBe('pinned');
    expect(list.rows.filter((row) => row.section !== true).map((row) => row.id)).toEqual([
      'wf:2',
      'wf:0',
      'wf:1',
    ]);
    await intoDetail(rig);
    rig.press('p');
    expect(workflowPins(), 'a second `[p]` unpins it').toEqual([]);
    expect(said(rig)).toBe('Unpinned gamma.');
    // One read when the popup opened, one per toggle, after the toggle: the row's pin word is the store's.
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it('shows what the store holds, not what the toggle guessed: a pin made elsewhere meanwhile reads as pinned', async () => {
    const { rig } = await open(entries);
    // Another process pinned `beta` after the popup read the catalogue; the row still says unpinned.
    store.pinItem({ kind: 'workflow', projectRoot: ROOT, ref: 'beta', at: T0 });
    moveTo(rig, 'wf:1');
    await intoDetail(rig);
    rig.press('p');
    expect(said(rig)).toBe('Pinned beta.');
    expect(workflowPins(), 'it is one pin, not two').toHaveLength(1);
  });

  it('keys the pin by the project root: the same slug in another project is not pinned', async () => {
    const { rig } = await open(entries);
    await intoDetail(rig);
    rig.press('p');
    expect(store.listPins({ kind: 'workflow', projectRoot: '/work/other' })).toEqual([]);
    expect(workflowPins()).toHaveLength(1);
  });
});

describe('at the cap', () => {
  const entries = [entry('alpha'), entry('beta')];
  const fill = (count: number): void => {
    for (let index = 0; index < count; index += 1)
      expect(
        store.pinItem({ kind: 'run', projectRoot: '', ref: `r${String(index)}`, at: index }),
      ).toBe('pinned');
  };

  it('shows the reason with what the store holds, in one notification, changes nothing and reads nothing again', async () => {
    fill(MAX_RUN_PINS);
    const { rig, reads } = await open(entries);
    moveTo(rig, 'wf:1');
    await intoDetail(rig);
    const before = reads.mock.calls.length;
    rig.press('p');
    expect(said(rig)).toMatch(/^Cannot pin/u);
    expect(store.listPins()).toHaveLength(MAX_RUN_PINS);
    expect(workflowPins()).toEqual([]);
    expect(reads.mock.calls.length, 'nothing changed, so nothing was read again').toBe(before);
    expect(rig.step()).toBe(WORKFLOWS_STEP.detail);
  });

  it('lists the pins of other projects as rows, and `[p]` on such a row removes it by its row id so the pin then fits', async () => {
    // One stale pin of this project, twenty pinned in another project, and runs for the rest: fifty in all.
    store.pinItem({ kind: 'workflow', projectRoot: ROOT, ref: 'gone', at: 1 });
    for (let index = 0; index < 20; index += 1)
      store.pinItem({
        kind: 'workflow',
        projectRoot: '/work/other',
        ref: `w${String(index)}`,
        at: 2 + index,
      });
    for (let index = 0; index < MAX_RUN_PINS - 21; index += 1)
      store.pinItem({ kind: 'run', projectRoot: '', ref: `r${String(index)}`, at: 100 + index });
    expect(store.listPins()).toHaveLength(MAX_RUN_PINS);
    const { rig } = await open(entries);
    expect(rig.words()).toContain('other project');
    expect(rig.words()).toContain('not in catalog');
    // A pin of another project can be neither run nor exported: `[r]` says why and the popup stays.
    const otherRows = (): string[] => {
      const content = rig.content();
      return content.kind === 'list'
        ? content.rows
            .filter((row) => row.id.startsWith('pin:') && row.tail?.words.startsWith('other'))
            .map((row) => row.id)
        : [];
    };
    const target = otherRows().at(-1);
    if (target === undefined) throw new Error('an other-project row');
    moveTo(rig, target);
    const targetRow = rig.content();
    const targetName =
      targetRow.kind === 'list'
        ? (targetRow.rows.find((row) => row.id === target)?.label.trim() ?? '')
        : '';
    rig.press('r');
    expect(said(rig)).toMatch(/^Cannot run/u);
    expect(rig.isOpen()).toBe(true);
    // At the cap a pin is refused, and the sentence names the stored total and what is not this project's.
    await intoDetail(rig);
    expect(rig.controls()).toEqual(['p']);
    const before = store.listPins().length;
    rig.press('p');
    expect(store.listPins()).toHaveLength(before - 1);
    // The row that was open is the one that went, by its name and its project (the other nineteen stay).
    expect(said(rig)).toBe(`Unpinned ${targetName}.`);
    expect(store.listPins({ kind: 'workflow', projectRoot: '/work/other' })).toHaveLength(19);
    expect(
      store.listPins({ kind: 'workflow', projectRoot: '/work/other' }).map((pin) => pin.ref),
    ).not.toContain(targetName);
    expect(rig.step(), 'the row left the list: the popup is on the catalogue').toBe(
      WORKFLOWS_STEP.list,
    );
    // The freed slot takes a pin of the catalogue.
    moveTo(rig, 'wf:0');
    await intoDetail(rig);
    rig.press('p');
    expect(said(rig)).toBe('Pinned alpha.');
  });

  it('two other projects pin a workflow of the same name: `[p]` removes the one whose row is open, never the other (the row’s own pin id is its identity)', async () => {
    store.pinItem({ kind: 'workflow', projectRoot: '/work/other-a', ref: 'deploy', at: 1 });
    store.pinItem({ kind: 'workflow', projectRoot: '/work/other-b', ref: 'deploy', at: 2 });
    const { rig } = await open([entry('alpha')]);
    const content = rig.content();
    if (content.kind !== 'list') throw new Error('list');
    const pinRows = content.rows.filter((row) => row.id.startsWith('pin:')).map((row) => row.id);
    expect(pinRows).toHaveLength(2);
    const second = pinRows[1];
    if (second === undefined) throw new Error('a second row');
    moveTo(rig, second);
    const keptRoot = store.listPins({ kind: 'workflow' }).map((pin) => pin.projectRoot);
    expect(keptRoot).toHaveLength(2);
    await intoDetail(rig);
    rig.press('p');
    expect(said(rig)).toBe('Unpinned deploy.');
    expect(store.listPins({ kind: 'workflow' })).toHaveLength(1);
  });
});

describe('what `[p]` says when the store is not what the popup read', () => {
  const entries = [entry('alpha')];

  it('says that nothing was removed, not that it unpinned, when the store held no such pin any more', async () => {
    store.pinItem({ kind: 'workflow', projectRoot: ROOT, ref: 'alpha', at: T0 });
    const { rig } = await open(entries);
    await intoDetail(rig);
    // Another process removed the pin after the popup read it: the row still says pinned.
    store.unpinItem({ kind: 'workflow', projectRoot: ROOT, ref: 'alpha' });
    rig.press('p');
    expect(said(rig)).toBe('Nothing was removed: alpha is not pinned.');
  });

  it('removes a pin whose workflow left the catalogue by its row', async () => {
    store.pinItem({ kind: 'workflow', projectRoot: ROOT, ref: 'gone', at: T0 });
    const { rig } = await open(entries);
    expect(rig.words()).toContain('not in catalog');
    await intoDetail(rig); // the pin that left sorts first: it is the highlighted row
    expect(rig.controls()).toEqual(['p']);
    rig.press('p');
    expect(workflowPins()).toEqual([]);
    expect(said(rig)).toBe('Unpinned gone.');
    expect(rig.words()).not.toContain('not in catalog');
  });

  it('refuses to pin a file that did not parse, says why, and writes and reads nothing', async () => {
    const { rig, reads } = await open([
      invalidWorkflowEntry('broken', 'a workflow must declare a node'),
    ]);
    // An invalid row opens a short report; `[p]` is not offered for a row that is not pinned, and the key does nothing.
    await intoDetail(rig);
    const before = reads.mock.calls.length;
    rig.press('p');
    expect(store.listPins()).toEqual([]);
    expect(reads.mock.calls).toHaveLength(before);
  });

  it('says pinning is unavailable, and changes nothing, when the Home has no pin store', async () => {
    const { rig } = await open(entries, { pins: undefined });
    await intoDetail(rig);
    rig.press('p');
    expect(said(rig)).toBe('Pinning is unavailable in this session.');
    expect(store.listPins()).toEqual([]);
  });

  it('says the pin could not be changed, in words that carry nothing stored, when the store refuses', async () => {
    const refusing: PinPort = {
      ...pinPort(),
      pinWorkflow: () => {
        throw new Error('PRIVATE-STORED-VALUE');
      },
    };
    const { rig } = await open(entries, { pins: refusing });
    await intoDetail(rig);
    rig.press('p');
    const note = said(rig);
    expect(note).toBe('Could not change the pin of alpha.');
    expect(note).not.toContain('PRIVATE');
  });
});
