/**
 * The `/workflows` popup on the Home through the opener and a real popup host on a manual clock ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md)
 * §4 D1): the catalogue is read in the popup's own work; `Enter` opens one workflow's detail (its description, inputs, nodes, file and last three
 * runs); `[r]`, `[x]` and `[h]` close the popup and ask the host; `[p]` pins in place; `Esc` steps back and closes; a stored word is the Home's row
 * scrub's; a read that lands late lands nowhere; and a held key answers nothing.
 */
import { describe, expect, it } from 'vitest';

import { CliError } from '../process/errors.js';
import {
  DOWN,
  ENTER,
  ESC,
  detailOf,
  fakeWorkflows,
  homeRig,
  invalidWorkflowEntry,
  recordingOwner,
  settleWork,
  workflowEntry,
} from './home-popups.test-support.js';
import type { WorkflowsAt } from './home-port.js';
import { WORKFLOWS_STEP } from './home-workflows-popup.js';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

/** The popup opened and its catalogue landed and settled. */
async function opened(fakes = fakeWorkflows(), at?: WorkflowsAt) {
  const rig = homeRig();
  expect(rig.open('workflows', { workflows: fakes.port }, at).opened).toBe(true);
  await settleWork();
  rig.settle();
  return { rig, fakes };
}

describe('the catalogue', () => {
  it('opens loading, then lists the workflows: a heading with the count, a row each, the first highlighted, `[r]` and `[h]` offered', async () => {
    const rig = homeRig();
    const fakes = fakeWorkflows();
    expect(rig.open('workflows', { workflows: fakes.port }).opened).toBe(true);
    expect(rig.content().kind).toBe('loading');
    expect(fakes.read).not.toHaveBeenCalled(); // not before the frame was given back
    await settleWork();
    expect(fakes.read).toHaveBeenCalledTimes(1);
    expect(rig.content().kind).toBe('list');
    expect(rig.words()).toContain('This project · 2 workflows');
    expect(rig.words()).toContain('backup-db');
    expect(rig.words()).toContain('3 nodes');
    expect(rig.highlighted()).toBe('wf:0');
    expect(rig.controls()).toEqual(['r', 'h']);
  });

  it('says how the last run stands, in a word, and `pinned` as a word', async () => {
    const fakes = fakeWorkflows(
      [workflowEntry('backup-db'), workflowEntry('flaky'), workflowEntry('review')],
      { pinned: ['backup-db'], now: NOW },
    );
    fakes.runs.set('backup-db', [{ runId: 'r1', status: 'completed', at: ago(3 * HOUR) }]);
    fakes.runs.set('flaky', [{ runId: 'r2', status: 'failed', at: ago(2 * HOUR) }]);
    fakes.runs.set('review', [{ runId: 'r3', status: 'paused', at: ago(5 * 60_000) }]);
    const { rig } = await opened(fakes);
    const words = rig.words();
    expect(words).toMatch(/backup-db\s+3 nodes\s+done 3h ago\s+pinned/u);
    expect(words).toMatch(/flaky\s+3 nodes\s+failed 2h ago/u);
    expect(words).toMatch(/review\s+3 nodes\s+waiting 5m/u);
  });

  it('shows a file that did not parse as `invalid` with the catalogue’s reason, and never hides it', async () => {
    const fakes = fakeWorkflows([
      workflowEntry('ok'),
      invalidWorkflowEntry('broken', 'workflow.nodes: required'),
    ]);
    const { rig } = await opened(fakes);
    expect(rig.words()).toContain('broken');
    expect(rig.words()).toContain('invalid');
    const content = rig.content();
    if (content.kind !== 'list') throw new Error('list');
    expect(content.rows.find((row) => row.id === 'wf:1')?.effect).toContain(
      'workflow.nodes: required',
    );
  });

  it('says so when the project has no workflow, in words with the next action; `[h]` still leads to the runs', async () => {
    const { rig } = await opened(fakeWorkflows([]));
    expect(rig.content().kind).toBe('empty');
    expect(rig.words()).toContain('No workflows in this project.');
    expect(rig.words()).toContain('/init');
    expect(rig.controls()).toEqual(['h']);
  });

  it('a catalogue that cannot be read is a state in the popup, in the catalog’s own words scrubbed; any other fault is the owner’s', async () => {
    const rig = homeRig();
    const failures: unknown[] = [];
    const port = {
      workflows: {
        ...fakeWorkflows().port,
        read: () => {
          throw new CliError(
            'invalid_invocation',
            'too many workflow files in the catalog (more than 500).',
          );
        },
      },
      workOwner: recordingOwner(failures),
    };
    expect(rig.open('workflows', port).opened).toBe(true);
    await settleWork();
    expect(rig.content().kind).toBe('error');
    expect(rig.words()).toContain('could not be listed');
    expect(rig.words()).toContain('too many workflow files');
    expect(failures).toEqual([]);

    const rig2 = homeRig();
    const boom = new Error('/home/x/.relavium: EIO');
    expect(
      rig2.open('workflows', {
        workflows: {
          ...fakeWorkflows().port,
          read: () => {
            throw boom;
          },
        },
        workOwner: recordingOwner(failures),
      }).opened,
    ).toBe(true);
    await settleWork();
    expect(failures).toEqual([boom]);
    expect(rig2.words()).not.toContain('/home/x');
    expect(rig2.words()).toContain('could not be listed');
  });

  it('`Esc` closes it on the first step and changes nothing', async () => {
    const { rig, fakes } = await opened();
    rig.press('', ESC);
    expect(rig.isOpen()).toBe(false);
    expect(fakes.asked).toEqual([]);
    expect(fakes.pins.calls).toEqual([]);
  });
});

describe('the detail', () => {
  it('`Enter` reads the workflow and shows its description, inputs, node chain, file and last three runs; its controls are `[r]`, `[x]`, `[p]`', async () => {
    const fakes = fakeWorkflows([workflowEntry('release-notes', { name: 'Release notes' })], {
      now: NOW,
    });
    fakes.runs.set('release-notes', [
      { runId: '41ae651d-aaaa', status: 'paused', at: ago(5 * 60_000) },
      { runId: '092e6161-bbbb', status: 'completed', at: ago(48 * HOUR) },
      { runId: 'fa7f8a61-cccc', status: 'failed', at: ago(96 * HOUR) },
    ]);
    const { rig } = await opened(fakes);
    rig.press('', ENTER);
    expect(rig.step()).toBe(WORKFLOWS_STEP.detail);
    expect(rig.content().kind).toBe('loading');
    expect(fakes.describe).not.toHaveBeenCalled();
    await settleWork();
    expect(fakes.describe).toHaveBeenCalledWith('.relavium/workflows/release-notes.relavium.yaml');
    expect(fakes.lastRuns).toHaveBeenCalledWith('release-notes', 3);
    const words = rig.words();
    expect(words).toContain('release-notes · Release notes');
    expect(words).toContain('Drafts release notes for a version.');
    expect(words).toMatch(/Inputs\s+version \(string, required\)/u);
    expect(words).toMatch(/Nodes\s+start → draft → approve \(approval, 10 min\)/u);
    expect(words).toContain('.relavium/workflows/release-notes.relavium.yaml');
    expect(words).toContain('Last runs');
    expect(words).toMatch(/waiting\s+5m\s+41ae651d/u);
    expect(words).toMatch(/done\s+2d ago\s+092e6161/u);
    expect(words).toMatch(/failed\s+4d ago\s+fa7f8a61/u);
    expect(rig.controls()).toEqual(['r', 'x', 'p']);
    expect(
      rig.highlighted(),
      'the page opens at its title: no last run is in front for an Enter to open (a held or doubled Enter stops here)',
    ).toBe('title');
  });

  it('a detail opened after another was left on a last run opens at its title again, never on the line the last page ended on (no stale highlight for an Enter to open)', async () => {
    const fakes = fakeWorkflows([workflowEntry('alpha'), workflowEntry('beta')], { now: NOW });
    for (const slug of ['alpha', 'beta'])
      fakes.runs.set(slug, [
        { runId: `${slug}-run-1-full-id`, status: 'completed', at: ago(HOUR) },
      ]);
    const { rig } = await opened(fakes);
    rig.press('', ENTER);
    await settleWork();
    rig.clock.advance(700);
    for (let step = 0; step < 30 && rig.highlighted() !== 'run:0'; step += 1) rig.press('', DOWN);
    expect(rig.highlighted()).toBe('run:0');
    rig.press('', ESC);
    expect(rig.step()).toBe(WORKFLOWS_STEP.list);
    rig.press('', DOWN);
    rig.press('', ENTER);
    await settleWork();
    expect(rig.step()).toBe(WORKFLOWS_STEP.detail);
    expect(rig.words()).toContain('beta');
    expect(rig.highlighted(), 'at the title, not on the last page’s run').toBe('title');
  });

  it.each([
    ['a doubled Enter, 60 ms apart', 60],
    ['a held Enter at 25 Hz', 40],
  ])(
    '%s stops at the detail: the host is never asked for the Runs screen (review round 1, X-5/O-6)',
    async (_name, gap) => {
      const fakes = fakeWorkflows([workflowEntry('backup-db')], { now: NOW });
      fakes.runs.set('backup-db', [
        { runId: '41ae651d-aaaa', status: 'completed', at: ago(HOUR) },
        { runId: '092e6161-bbbb', status: 'failed', at: ago(2 * HOUR) },
      ]);
      const { rig } = await opened(fakes);
      rig.press('', ENTER);
      // The repeats come while the detail is read and after it landed: neither answers.
      for (let repeat = 0; repeat < 5; repeat += 1) {
        rig.clock.advance(gap);
        rig.press('', { return: true, eventType: 'repeat' });
        rig.press('', ENTER);
      }
      await settleWork();
      for (let repeat = 0; repeat < 25; repeat += 1) {
        rig.clock.advance(gap);
        rig.press('', repeat % 2 === 0 ? ENTER : { return: true, eventType: 'repeat' });
      }
      expect(rig.step()).toBe(WORKFLOWS_STEP.detail);
      expect(rig.isOpen()).toBe(true);
      expect(fakes.asked, 'nothing was opened').toEqual([]);
      expect(rig.highlighted()).toBe('title');
    },
  );

  it('a workflow file added between the detail and the refresh after `[p]` moves the indices: the detail does not turn into another workflow’s, it goes back to the catalogue (review round 1, X-4)', async () => {
    const fakes = fakeWorkflows([workflowEntry('backup-db'), workflowEntry('release-notes')], {
      now: NOW,
    });
    const { rig } = await opened(fakes);
    rig.press('', ENTER);
    await settleWork();
    rig.clock.advance(700);
    expect(rig.words()).toContain('backup-db');
    // Another terminal adds a file that sorts before it: its entry index is now another workflow's.
    fakes.entries.unshift(workflowEntry('aaa-added'));
    rig.press('p');
    expect(rig.step(), 'back on the catalogue').toBe(WORKFLOWS_STEP.list);
    expect(rig.words()).toContain('aaa-added');
    expect(fakes.pins.calls, 'the pin was written for the workflow that was in front').toEqual([
      'pin backup-db',
    ]);
  });

  it.each([
    [
      'the same slug declared by another file',
      { path: '.relavium/workflows/elsewhere.relavium.yaml' },
    ],
    ['the same file under another slug (its id was edited)', { slug: 'renamed' }],
  ] as const)(
    'the file at the detail’s index is another one after the refresh (%s): the detail goes back to the catalogue, whichever of its slug and its path moved',
    async (_what, over) => {
      const fakes = fakeWorkflows([workflowEntry('backup-db'), workflowEntry('release-notes')], {
        now: NOW,
      });
      const { rig } = await opened(fakes);
      rig.press('', ENTER);
      await settleWork();
      rig.clock.advance(700);
      expect(rig.step()).toBe(WORKFLOWS_STEP.detail);
      fakes.entries[0] = { ...workflowEntry('backup-db'), ...over };
      rig.press('p');
      expect(rig.step(), 'back on the catalogue').toBe(WORKFLOWS_STEP.list);
    },
  );

  it('a workflow with no run says so; `Enter` is then offered nowhere', async () => {
    const { rig } = await opened(fakeWorkflows([workflowEntry('fresh')]));
    rig.press('', ENTER);
    await settleWork();
    expect(rig.words()).toContain('No run of this workflow in this directory yet.');
    rig.clock.advance(700);
    const before = rig.step();
    rig.press('', ENTER);
    expect(rig.step()).toBe(before);
    expect(rig.isOpen()).toBe(true);
  });

  it('`Esc` steps back to the catalogue with the highlight where it was, then closes', async () => {
    const { rig } = await opened();
    rig.press('', DOWN);
    expect(rig.highlighted()).toBe('wf:1');
    rig.press('', ENTER);
    await settleWork();
    rig.press('', ESC);
    expect(rig.step()).toBe(WORKFLOWS_STEP.list);
    expect(rig.highlighted()).toBe('wf:1');
    rig.press('', ESC);
    expect(rig.isOpen()).toBe(false);
  });

  it('a detail that cannot be read is a state with the catalogue’s words scrubbed, and the way on inside the popup', async () => {
    const fakes = fakeWorkflows(undefined, {
      describe: () => {
        throw new CliError('invalid_invocation', 'workflow.nodes[0].type: unknown');
      },
    });
    const { rig } = await opened(fakes);
    rig.press('', ENTER);
    await settleWork();
    expect(rig.content().kind).toBe('error');
    expect(rig.words()).toContain('This workflow could not be read.');
    // The Home's row scrub makes a bracket a parenthesis (a bracketed word could pass for a key): `[0]` is drawn `(0)`.
    expect(rig.words()).toContain('workflow.nodes(0).type: unknown');
    expect(rig.words()).toContain('Go back');
    expect(rig.controls()).toEqual([]);
  });

  it('a store that cannot give the last runs leaves the detail without them, and the popup stays', async () => {
    const fakes = fakeWorkflows();
    fakes.lastRuns.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const { rig } = await opened(fakes);
    rig.press('', ENTER);
    await settleWork();
    expect(rig.content().kind).toBe('list');
    expect(rig.words()).toContain('No run of this workflow in this directory yet.');
    expect(rig.controls()).toEqual(['r', 'x', 'p']);
  });

  it('a result that lands after the person went back lands nowhere', async () => {
    const fakes = fakeWorkflows();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rig = homeRig();
    expect(
      rig.open('workflows', {
        workflows: {
          ...fakes.port,
          describe: (path) => {
            void gate;
            return fakes.describe(path);
          },
        },
      }).opened,
    ).toBe(true);
    await settleWork();
    rig.settle();
    rig.press('', ENTER);
    rig.press('', ESC); // back before the read was answered
    release();
    await settleWork();
    expect(rig.step()).toBe(WORKFLOWS_STEP.list);
  });
});

describe('what the keys hand the host', () => {
  it('`[r]` on the catalogue closes the popup and asks the host to run the highlighted workflow, by the slug and the path the read holds', async () => {
    const { rig, fakes } = await opened();
    rig.press('', DOWN);
    rig.press('r');
    expect(rig.isOpen()).toBe(false);
    expect(fakes.asked, 'pressed on the catalogue: the host brings the catalogue back').toEqual([
      'run release-notes .relavium/workflows/release-notes.relavium.yaml from list',
    ]);
  });

  it('`[r]` and `[x]` on the detail act on the workflow whose detail is open', async () => {
    const { rig, fakes } = await opened();
    rig.press('', ENTER);
    await settleWork();
    rig.clock.advance(700);
    rig.press('x');
    expect(rig.isOpen()).toBe(false);
    expect(fakes.asked, 'pressed on the detail: the host brings the detail back').toEqual([
      'export backup-db from detail',
    ]);

    const second = await opened();
    second.rig.press('', ENTER);
    await settleWork();
    second.rig.clock.advance(700);
    second.rig.press('r');
    expect(second.fakes.asked).toEqual([
      'run backup-db .relavium/workflows/backup-db.relavium.yaml from detail',
    ]);
  });

  it('`[x]` is not a key of the catalogue (it lives in the detail’s legend): it does nothing there', async () => {
    const { rig, fakes } = await opened();
    rig.press('x');
    rig.press('p');
    expect(rig.isOpen()).toBe(true);
    expect(fakes.asked).toEqual([]);
    expect(fakes.pins.calls).toEqual([]);
  });

  it('`[h]` closes the popup and opens the Runs screen; `Enter` on a last run opens that run’s detail there', async () => {
    const first = await opened();
    first.rig.press('h');
    expect(first.rig.isOpen()).toBe(false);
    expect(first.fakes.asked).toEqual(['runs']);

    const fakes = fakeWorkflows();
    fakes.runs.set('backup-db', [{ runId: 'run-1-full-id', status: 'completed', at: ago(HOUR) }]);
    const second = await opened(fakes);
    second.rig.press('', ENTER);
    await settleWork();
    second.rig.clock.advance(700);
    // The page opens at its title; ↓ walks down to the last run, which is the one line that answers `Enter`.
    for (let step = 0; step < 30 && second.rig.highlighted() !== 'run:0'; step += 1)
      second.rig.press('', DOWN);
    expect(second.rig.highlighted()).toBe('run:0');
    second.rig.press('', ENTER);
    expect(second.rig.isOpen()).toBe(false);
    expect(fakes.asked).toEqual(['runs run-1-full-id']);
  });

  it('a row that is no workflow of the catalogue makes no request: `[r]` says why in one notification and the popup stays', async () => {
    const fakes = fakeWorkflows([invalidWorkflowEntry('broken', 'workflow.nodes: required')]);
    const { rig } = await opened(fakes);
    rig.press('r');
    expect(rig.isOpen()).toBe(true);
    expect(fakes.asked).toEqual([]);
    expect(rig.notice()).toMatch(/^Cannot run broken/u);
  });

  it('an invalid file’s long reason on its detail is cut between words with `…`, never in the middle of one (review round 2, O2-11)', async () => {
    const reason = Array.from({ length: 60 }, (_, at) => `word${String(at)}`).join(' ');
    const fakes = fakeWorkflows([invalidWorkflowEntry('broken', reason)]);
    const { rig } = await opened(fakes);
    rig.press('', ENTER);
    await settleWork();
    const content = rig.content();
    if (content.kind !== 'report') throw new Error('a report');
    const lines = content.lines.filter((line) => line.includes('word'));
    expect(lines.length, 'a few rows, not one and not the whole reason').toBeGreaterThan(1);
    const last = lines.at(-1) ?? '';
    expect(last.endsWith('…')).toBe(true);
    const lastWord = last.replace(/…$/u, '').trimEnd().split(' ').at(-1) ?? '';
    expect(reason.split(' '), 'a whole word before the mark').toContain(lastWord);
  });

  it('a key held down answers nothing: nothing is asked before the frame was seen, or inside the half second after it', async () => {
    const rig = homeRig();
    const fakes = fakeWorkflows();
    expect(rig.open('workflows', { workflows: fakes.port }).opened).toBe(true);
    await settleWork();
    rig.press('r'); // before the first frame was shown
    rig.host.shown(rig.host.getSnapshot());
    rig.clock.advance(100);
    rig.press('r'); // inside the settle
    rig.press('', ENTER);
    rig.press('h');
    expect(rig.isOpen()).toBe(true);
    expect(rig.step()).toBe(WORKFLOWS_STEP.list);
    expect(fakes.asked).toEqual([]);
  });
});

describe('`[p]`', () => {
  it('pins in place, reads the rows again, keeps the highlight on the workflow and changes the verb; a second `[p]` unpins', async () => {
    const fakes = fakeWorkflows([workflowEntry('a'), workflowEntry('b'), workflowEntry('c')]);
    const { rig } = await opened(fakes);
    rig.press('', DOWN);
    rig.press('', DOWN); // c
    rig.press('', ENTER);
    await settleWork();
    rig.clock.advance(700);
    expect(rig.controls()).toEqual(['r', 'x', 'p']);
    rig.press('p');
    expect(fakes.pins.calls).toEqual(['pin c']);
    expect(rig.notice()).toBe('Pinned c.');
    expect(fakes.read).toHaveBeenCalledTimes(2);
    expect(rig.words()).toContain('pinned');
    // The catalogue behind has the pinned row first, the highlight still on `c`.
    rig.press('', ESC);
    expect(rig.highlighted()).toBe('wf:2');
    const list = rig.content();
    if (list.kind !== 'list') throw new Error('list');
    expect(list.rows.filter((row) => row.section !== true).map((row) => row.id)).toEqual([
      'wf:2',
      'wf:0',
      'wf:1',
    ]);
    rig.press('', ENTER);
    await settleWork();
    rig.clock.advance(700);
    rig.press('p');
    expect(fakes.pins.calls).toEqual(['pin c', 'unpin c']);
    // The popup's newer word on itself replaces its older one at once (review round 2, O2-6): the title says `unpinned` and so does the row.
    expect(rig.notice()).toBe('Unpinned c.');
  });

  it('a pin the store refuses at its cap changes nothing and says why, in one notification that fits the channel', async () => {
    const fakes = fakeWorkflows([workflowEntry('a')], { full: true });
    const { rig } = await opened(fakes);
    rig.press('', ENTER);
    await settleWork();
    rig.clock.advance(700);
    rig.press('p');
    expect(rig.notice()).toBe('Cannot pin a: 50 pins is the limit. Unpin one first.');
    expect(rig.step()).toBe(WORKFLOWS_STEP.detail);
    expect(fakes.read).toHaveBeenCalledTimes(1);
  });

  it('a Home with no pin store says pinning is unavailable', async () => {
    const fakes = fakeWorkflows([workflowEntry('a')]);
    const rig = homeRig();
    rig.open('workflows', { workflows: { ...fakes.port, pins: undefined } });
    await settleWork();
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    rig.clock.advance(700);
    rig.press('p');
    expect(rig.notice()).toBe('Pinning is unavailable in this session.');
  });
});

describe('a pin that is no entry of the catalogue stays a row, so its slot can be freed', () => {
  it('a pin whose workflow left the catalogue opens a short report and can be unpinned; it can be neither run nor exported', async () => {
    const fakes = fakeWorkflows([workflowEntry('kept')], { pinned: ['gone'] });
    const { rig } = await opened(fakes);
    expect(rig.words()).toContain('gone');
    expect(rig.words()).toContain('not in catalog');
    rig.press('', ENTER); // `gone` sorts first: pinned rows lead
    expect(rig.step()).toBe(WORKFLOWS_STEP.detail);
    expect(rig.content().kind).toBe('report');
    expect(rig.words()).toContain('It can be unpinned here');
    expect(rig.controls()).toEqual(['p']);
    rig.clock.advance(700);
    rig.press('r');
    rig.press('x');
    expect(fakes.asked).toEqual([]);
    rig.press('p');
    expect(fakes.pins.calls).toEqual(['unpin row 1']);
    // The row is gone from the new read, so the popup goes back to the catalogue.
    expect(rig.step()).toBe(WORKFLOWS_STEP.list);
    expect(rig.words()).not.toContain('not in catalog');
  });
});

describe('reopened on a workflow (a flow handed it back)', () => {
  it('opens on the detail of that workflow with the catalogue behind it highlighted on it', async () => {
    const fakes = fakeWorkflows([workflowEntry('a'), workflowEntry('b')]);
    const rig = homeRig();
    expect(
      rig.open('workflows', { workflows: fakes.port }, { slug: 'b', step: 'detail' }).opened,
    ).toBe(true);
    await settleWork();
    await settleWork();
    expect(rig.step()).toBe(WORKFLOWS_STEP.detail);
    expect(rig.words()).toContain('b');
    rig.settle();
    rig.press('', ESC);
    expect(rig.step()).toBe(WORKFLOWS_STEP.list);
    expect(rig.highlighted()).toBe('wf:1');
  });

  it('reopened from the catalogue row it was pressed on: the catalogue, the highlight on that workflow, and no detail', async () => {
    const fakes = fakeWorkflows([workflowEntry('a'), workflowEntry('b')]);
    const rig = homeRig();
    expect(
      rig.open('workflows', { workflows: fakes.port }, { slug: 'b', step: 'list' }).opened,
    ).toBe(true);
    await settleWork();
    await settleWork();
    expect(rig.step()).toBe(WORKFLOWS_STEP.list);
    expect(rig.highlighted()).toBe('wf:1');
    expect(fakes.describe, 'no detail was read').not.toHaveBeenCalled();
  });

  it('a workflow that left the catalogue opens the catalogue', async () => {
    const rig = homeRig();
    expect(
      rig.open('workflows', { workflows: fakeWorkflows().port }, { slug: 'nobody', step: 'detail' })
        .opened,
    ).toBe(true);
    await settleWork();
    expect(rig.step()).toBe(WORKFLOWS_STEP.list);
  });
});

describe('what a stored word cannot do', () => {
  const HOSTILE = [
    `${String.fromCharCode(27)}[31mred`,
    '▼ 9 more',
    '[Enter] open',
    `a${String.fromCharCode(0x202e)}b`,
    'Press Ctrl+Y now',
    'x'.repeat(500),
  ];

  it.each(HOSTILE)(
    'a workflow named %j is drawn as a line of text: nothing forged, nothing wider than its place',
    async (name) => {
      const fakes = fakeWorkflows([
        workflowEntry('hostile', { name, path: `.relavium/workflows/${name}.yaml` }),
      ]);
      fakes.describe.mockReturnValue(
        detailOf({
          description: name,
          inputs: [{ name, type: name, required: true }],
          nodes: [{ id: name, note: name }],
        }),
      );
      const { rig } = await opened(fakes);
      rig.press('', ENTER);
      await settleWork();
      const content = rig.content();
      if (content.kind !== 'list') throw new Error('list');
      for (const row of content.rows) {
        for (const text of [row.label, row.detail ?? '', row.effect ?? '']) {
          expect([27, 0x202e].some((code) => text.includes(String.fromCharCode(code)))).toBe(false);
          expect(text).not.toMatch(/▼ \d+ more/u);
          expect(text).not.toMatch(/\[Enter\]/u);
          expect(text).not.toMatch(/Ctrl\+Y/u);
          expect([...text].length).toBeLessThanOrEqual(120);
        }
      }
    },
  );
});

describe('the slug and an invalid file’s note are stored words too', () => {
  const FORGED = [
    `${String.fromCharCode(27)}[31mred`,
    '▼ 9 more',
    '[Enter] open',
    'Press Ctrl+Y now',
  ];

  it.each(FORGED)(
    'a workflow slug and a parse note of %j are drawn as text in the list, its effect and the detail',
    async (hostile) => {
      const fakes = fakeWorkflows([
        workflowEntry(`ok-${hostile}`),
        invalidWorkflowEntry(`bad-${hostile}`, hostile),
      ]);
      const { rig } = await opened(fakes);
      const listed = rig.content();
      if (listed.kind !== 'list') throw new Error('list');
      const texts = (
        rows: readonly {
          label: string;
          detail?: string | undefined;
          effect?: string | undefined;
          tail?: { words: string } | undefined;
        }[],
      ): string[] =>
        rows.flatMap((row) => [
          row.label,
          row.detail ?? '',
          row.effect ?? '',
          row.tail?.words ?? '',
        ]);
      const all = texts(listed.rows);
      rig.press('', DOWN); // the invalid row: its effect says why it cannot run
      rig.press('r'); // and so does the notification of `[r]` on it
      const notified = rig.notice() ?? '';
      const effects = rig.content();
      if (effects.kind !== 'list') throw new Error('list');
      rig.press('', ENTER); // its detail
      await settleWork();
      const detail = rig.content();
      const lines =
        detail.kind === 'list'
          ? texts(detail.rows)
          : detail.kind === 'report'
            ? [...detail.lines]
            : [];
      for (const text of [...all, ...texts(effects.rows), ...lines, notified]) {
        expect(text.includes(String.fromCharCode(27)), text).toBe(false);
        expect(text, text).not.toMatch(/▼ \d+ more/u);
        expect(text, text).not.toMatch(/\[Enter\]/u);
        expect(text, text).not.toMatch(/Ctrl\+Y/u);
      }
    },
  );
});

describe('the catalog’s own words of a failed read are stored words too', () => {
  it.each(['▼ 9 more', '[Enter] open', 'Press Ctrl+Y now'])(
    'an unreadable catalogue saying %j is drawn as text',
    async (hostile) => {
      const rig = homeRig();
      const port = {
        workflows: {
          ...fakeWorkflows().port,
          read: () => {
            throw new CliError('invalid_invocation', hostile);
          },
        },
        workOwner: recordingOwner([]),
      };
      expect(rig.open('workflows', port).opened).toBe(true);
      await settleWork();
      const words = rig.words();
      expect(words).not.toMatch(/▼ \d+ more/u);
      expect(words).not.toMatch(/\[Enter\]/u);
      expect(words).not.toMatch(/Ctrl\+Y/u);
    },
  );
});
