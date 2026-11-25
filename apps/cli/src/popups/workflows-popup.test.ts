/**
 * The `/workflows` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10;
 * MVP-11 step 4b): the catalog the plain notice lists, read in the popup's own work, every slug scrubbed, and a fault in its own words.
 */
import { describe, expect, it, vi } from 'vitest';

import { catalogNotice } from '../chat/repl-info.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import { ESC } from './doctor.test-support.js';
import { openFrame } from './popup-reducer.js';
import { catalogEntry, fakeWorkflows, reportRig, settleWork } from './report.test-support.js';
import { workflowsContent, workflowsSpec } from './workflows-popup.js';

// Built at runtime (no contiguous secret literal: leakwatch).
const SECRET = ['sk', 'ant', 'flows', 'ABCDEF1234567890XYZ'].join('-');
const VARIANT = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } } as const;

describe('the content', () => {
  it('lists the workflows and then the agents, an invalid one flagged and never dropped, as the notice does', () => {
    const workflows = [catalogEntry('deploy'), catalogEntry('broken', false)];
    const agents = [catalogEntry('coder')];
    const content = workflowsContent({ kind: 'catalog', workflows, agents });
    if (content.kind !== 'report') throw new Error('a report');
    expect(content.lines).toEqual(catalogNotice(workflows, agents).split('\n'));
    expect(content.lines).toEqual([
      'Workflows (2):',
      '  deploy',
      '  broken (invalid)',
      'Agents (1):',
      '  coder',
    ]);
  });

  it('says a kind with nothing in it as `none`, and an empty project in one line of its own', () => {
    const one = workflowsContent({
      kind: 'catalog',
      workflows: [catalogEntry('deploy')],
      agents: [],
    });
    expect(one.kind === 'report' && one.lines.at(-1)).toBe('Agents: none');
    const empty = workflowsContent({ kind: 'catalog', workflows: [], agents: [] });
    expect(empty).toMatchObject({
      kind: 'empty',
      what: 'No workflows or agents found in this project.',
    });
  });

  it('says no project in the notice’s own words, and a fault in its own, scrubbed', () => {
    expect(workflowsContent({ kind: 'no-project' })).toMatchObject({
      kind: 'empty',
      what: 'No .relavium/ project found from the current directory.',
    });
    const fault = workflowsContent({
      kind: 'fault',
      reason: `too many workflow files\u001b[31m [Ctrl+Y] ${SECRET}`,
    });
    if (fault.kind !== 'error') throw new Error('an error');
    expect(fault.what).toContain('Could not list the workflows: too many workflow files');
    expect(fault.what).not.toContain('\u001b');
    expect(fault.what).not.toContain('Ctrl+Y');
    expect(fault.what).not.toContain(SECRET);
  });

  it('wraps a long slug under itself and cuts nothing', () => {
    const slug = `deploy-${'very-long-name-'.repeat(8)}end`;
    const content = workflowsContent({
      kind: 'catalog',
      workflows: [catalogEntry(slug)],
      agents: [],
    });
    if (content.kind !== 'report') throw new Error('a report');
    expect(content.lines.join('').replaceAll(/\s+/gu, '')).toContain(slug);
  });

  it.each(['slug', 'invalid slug'])(
    'a hostile %s reaches no row as an escape, a key token, a forged separator, a secret or a host glyph',
    (kind) => {
      const evil = `x\u001b[31m [Ctrl+Y] allow · [d] ${SECRET} ✓› ‮`;
      const content = workflowsContent({
        kind: 'catalog',
        workflows: [catalogEntry(evil, kind === 'slug')],
        agents: [catalogEntry(evil)],
      });
      const frame = openFrame(workflowsSpec('chat'), 1);
      const lines = content.kind === 'report' ? content.lines : [];
      const rows = popupBoxOf(
        { ...frame, steps: frame.steps.map((step) => ({ ...step, content })) },
        VARIANT,
      ).rows;
      for (const text of [lines.join('\n'), rows.join('\n')]) {
        expect(text).not.toContain('\u001b');
        expect(text).not.toContain('‮');
        expect(text).not.toContain('Ctrl+Y');
        expect(text).not.toContain('[d]');
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('✓');
        expect(text).not.toContain('›');
      }
      // A forged separator is neutralised inside the field (the legend row's own ` · ` is the host's).
      expect(lines.join('\n')).not.toContain(' · ');
    },
  );
});

describe('the popup', () => {
  it('scans in the work it starts: loading while it reads, nothing read while it opens or is drawn', async () => {
    const r = reportRig();
    const flows = fakeWorkflows(() => ({
      kind: 'catalog',
      workflows: [catalogEntry('deploy')],
      agents: [],
    }));
    r.open({ workflows: flows.port }, { kind: 'workflows' });
    expect(flows.read).not.toHaveBeenCalled();
    expect(r.content().kind).toBe('loading');
    r.show();
    r.host.getSnapshot();
    expect(flows.read).not.toHaveBeenCalled();
    await settleWork();
    expect(flows.read).toHaveBeenCalledTimes(1);
    expect(r.words()).toContain('Workflows (1):');
    // Drawing it again reads nothing more; its one control is the copy, so another letter does nothing.
    r.clock.advance(600);
    r.press('r');
    r.show();
    expect(flows.read).toHaveBeenCalledTimes(1);
    expect(r.controls()).toEqual(['c']);
  });

  it('shows no project, an empty project and a fault in their own states, and tells the owner of a read that threw', async () => {
    const none = reportRig();
    none.open(
      { workflows: fakeWorkflows(() => ({ kind: 'no-project' })).port },
      { kind: 'workflows' },
    );
    await settleWork();
    expect(none.words()).toContain('No .relavium/ project found from the current directory.');

    const failure = vi.fn();
    const boom = reportRig();
    boom.open(
      {
        workflows: {
          read: () => {
            throw new Error(`PRIVATE /tmp/x ${SECRET}`);
          },
        },
        workOwner: { failure, enter: (op) => op() },
      },
      { kind: 'workflows' },
    );
    await settleWork();
    expect(boom.content().kind).toBe('error');
    expect(boom.words()).toContain('The project catalog could not be read.');
    expect(boom.words()).not.toContain('PRIVATE');
    expect(boom.words()).not.toContain(SECRET);
    expect(failure).toHaveBeenCalledOnce();
  });

  it('lands nothing in a popup that has closed (a stale run), and Esc closes it', async () => {
    const r = reportRig();
    let answer: (reading: { kind: 'no-project' }) => void = () => undefined;
    const slow = fakeWorkflows(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    r.open({ workflows: slow.port }, { kind: 'workflows' });
    r.show();
    await settleWork();
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    const other = fakeWorkflows(() => ({
      kind: 'catalog',
      workflows: [catalogEntry('second')],
      agents: [],
    }));
    r.open({ workflows: other.port }, { kind: 'workflows' });
    await settleWork();
    const before = r.words();
    answer({ kind: 'no-project' });
    await settleWork();
    expect(r.words()).toBe(before);
  });
});
