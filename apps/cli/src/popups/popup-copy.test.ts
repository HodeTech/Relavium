/**
 * `[c] copy` on the popups that show a report ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1): on the four report popups it puts exactly the lines the popup draws on the clipboard, as plain text, scrubbed like everything drawn, says
 * what happened in the sentences of one family (the doctor's too: `copyPopupText`), is offered only where there is a report to copy, and writes
 * nothing but a notification.
 */
import type { ClipboardOutcome, ClipboardWriter } from '../render/clipboard.js';
import { describe, expect, it, vi } from 'vitest';

import { boundAgentView, type BoundAgentView } from '../chat/bound-agent-view.js';
import { buildPaletteEntries } from '../render/tui/palette-entries.js';
import { CHAT_KEYS } from '../render/tui/chat-keys.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import { displayWidth } from '../render/tui/viewport.js';
import { agentReportLines } from './agent-popup.js';
import { COST_STEP, costReportLines } from './cost-popup.js';
import { ENTER, ESC, CTRL } from './doctor.test-support.js';
import { popupText } from './frame-model.js';
import { helpLines } from './help-popup.js';
import { popupLegend } from './popup-reducer.js';
import {
  copyControlsFor,
  copyPopupText,
  popupCopyNotice,
  reportCopyText,
  popupCopyUnavailable,
} from './popup-copy.js';
import type { ReportsPort } from './report-port.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import {
  catalogEntry,
  costReading,
  costRow,
  fakeCost,
  fakeWorkflows,
  reportRig,
  settleWork,
  type ReportRig,
} from './report.test-support.js';

// Built at runtime (no contiguous secret literal: leakwatch).
const SECRET = ['sk', 'ant', 'copy', 'ABCDEF1234567890XYZ'].join('-');
const EVIL = `x\u001b[31m [Ctrl+Y] allow · [d] ${SECRET} ✓› ‮`;
const VARIANT = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } } as const;
const KEYS = Object.values(CHAT_KEYS);

/** A clipboard that records every text it was asked to write, and answers `outcome` (the characters written by default). */
function spyClipboard(outcome?: ClipboardOutcome | (() => never)) {
  const texts: string[] = [];
  const writer: ClipboardWriter = (text) => {
    texts.push(text);
    if (typeof outcome === 'function') return outcome();
    return outcome ?? { kind: 'written', characters: text.length };
  };
  return { writer, texts };
}

const view = (over: Partial<Parameters<typeof boundAgentView>[0]> = {}): BoundAgentView =>
  boundAgentView(
    {
      id: 'reviewer',
      name: 'Code reviewer',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'You review code and say what is wrong with it.',
      tools: ['read_file', 'search_files'],
      ...over,
    },
    'high',
  );

/** Open `kind` on a rig with `port`, let its content land and the opening guard's settle pass. */
async function opened(
  kind: 'agent' | 'cost' | 'workflows' | 'help',
  port: Partial<ReportsPort>,
  r: ReportRig = reportRig(),
) {
  r.open(port, kind === 'cost' ? { kind, release: false } : { kind });
  r.show();
  await settleWork();
  r.clock.advance(600);
  return r;
}

/** The text of the clipboard write made by the next `[c]`. */
async function copied(r: ReportRig, texts: readonly string[]): Promise<string> {
  const before = texts.length;
  r.press('c');
  await settleWork();
  expect(texts.length, 'one write').toBe(before + 1);
  return texts.at(-1) ?? '';
}

const flows = () =>
  fakeWorkflows(() => ({
    kind: 'catalog',
    workflows: [catalogEntry('deploy'), catalogEntry('broken', false)],
    agents: [catalogEntry('coder')],
  }));

describe('the copy is exactly the lines the popup draws', () => {
  it('/agent: its report lines, one to a row', async () => {
    const clip = spyClipboard();
    const agent = view();
    const r = await opened('agent', { agent: () => agent, clipboard: clip.writer });
    expect(await copied(r, clip.texts)).toBe(agentReportLines(agent).map(popupText).join('\n'));
    // Drawn: every copied row is a row of the frame, in order (the report is short enough to be whole on screen).
    const frame = r.host.getSnapshot().frame;
    const drawn = popupBoxOf(frame, VARIANT).rows.map((row) => row.trim());
    let from = 0;
    for (const line of (clip.texts[0] ?? '').split('\n').filter((row) => row !== '')) {
      const at = drawn.findIndex((row, index) => index >= from && row === line.trim());
      expect(at, line).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
  });

  it('/cost: the report lines of the reading it shows, a held estimate included', async () => {
    const clip = spyClipboard();
    const fake = fakeCost({ held: 450 });
    const r = await opened('cost', { cost: fake.port, clipboard: clip.writer });
    const text = await copied(r, clip.texts);
    expect(text).toBe(costReportLines(costReading(450)).map(popupText).join('\n'));
    expect(text).toContain('~$0.0000045 estimated, possibly billed');
    // Copying reads nothing and releases nothing.
    expect(fake.calls).toEqual(['read']);
  });

  it('/workflows: the catalog, an invalid entry flagged', async () => {
    const clip = spyClipboard();
    const r = await opened('workflows', { workflows: flows().port, clipboard: clip.writer });
    expect(await copied(r, clip.texts)).toBe(
      'Workflows (2):\n  deploy\n  broken (invalid)\nAgents (1):\n  coder',
    );
  });

  it.each(['standalone-chat', 'home-chat'] as const)(
    '/help on %s: the palette’s commands and the chat’s keys',
    async (surface) => {
      const clip = spyClipboard();
      const r = await opened('help', {
        surface,
        help: { keys: KEYS },
        clipboard: clip.writer,
      });
      const text = await copied(r, clip.texts);
      expect(text).toBe(helpLines(surface, KEYS).map(popupText).join('\n'));
      const entries = buildPaletteEntries(surface, { hasSession: true, hasKey: true });
      expect(entries.length).toBeGreaterThan(10);
      for (const entry of entries) expect(text).toContain(`/${entry.command.name}`);
    },
  );

  it('is plain text: no escape, one line to a row, and the same words in the plain glyph form', async () => {
    const lines = ['one', '  two ✓', 'three'];
    expect(reportCopyText(lines, false)).toBe('one\n  two  \nthree');
    expect(reportCopyText(lines, true)).toBe(reportCopyText(lines, false));
    const clip = spyClipboard();
    const r = await opened('workflows', {
      workflows: flows().port,
      clipboard: clip.writer,
      plainGlyphs: true,
    });
    const text = await copied(r, clip.texts);
    // eslint-disable-next-line no-control-regex -- the point of the check
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/u);
  });
});

describe('what a hostile field never carries to the clipboard', () => {
  const clean = (text: string): void => {
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('‮');
    expect(text).not.toContain('[Ctrl+Y]');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('✓');
    expect(text).not.toContain('›');
  };

  it('/agent: a hostile name, model, tool and prompt', async () => {
    const clip = spyClipboard();
    const hostile: BoundAgentView = {
      ...view(),
      name: EVIL,
      detail: { ...view().detail, model: EVIL, tools: [EVIL], promptHead: EVIL },
    };
    const r = await opened('agent', { agent: () => hostile, clipboard: clip.writer });
    clean(await copied(r, clip.texts));
  });

  it('/cost: a hostile model id', async () => {
    const clip = spyClipboard();
    const reading = costReading(450, undefined, [
      costRow({ model: EVIL, costMicrocents: 12_000, conservativeMicrocents: 450 }),
    ]);
    const r = await opened('cost', {
      cost: { read: () => reading, release: vi.fn() },
      clipboard: clip.writer,
    });
    clean(await copied(r, clip.texts));
  });

  it('/workflows: a hostile slug', async () => {
    const clip = spyClipboard();
    const hostile = fakeWorkflows(() => ({
      kind: 'catalog',
      workflows: [catalogEntry(EVIL, false)],
      agents: [catalogEntry(EVIL)],
    }));
    const r = await opened('workflows', { workflows: hostile.port, clipboard: clip.writer });
    clean(await copied(r, clip.texts));
  });

  it('/help: a hostile key name and verb the port handed in', async () => {
    const clip = spyClipboard();
    const r = await opened('help', {
      help: { keys: [{ keys: EVIL, verb: EVIL }] },
      clipboard: clip.writer,
    });
    const text = await copied(r, clip.texts);
    // The heading is there: a slice from a missing heading would be the whole text, or its last character, and prove nothing.
    expect(text.split('\n')).toContain('Keys');
    const keys = text.slice(text.indexOf('\nKeys\n'));
    // The key row is there with the visible start of the hostile name, so there is something that has to be clean.
    expect(keys.split('\n').length).toBeGreaterThan(1);
    expect(keys).toMatch(/^ {2}x/mu);
    clean(keys);
  });
});

describe('[c] is offered only where there is a report to copy', () => {
  /** What the step lists now, and what pressing `c` does on it. */
  function offered(r: ReportRig): { controls: readonly string[]; legend: string } {
    const frame = r.host.getSnapshot().frame;
    return {
      controls: r.controls(),
      legend: frame === undefined ? '' : JSON.stringify(popupLegend(frame).items),
    };
  }

  it('/cost: not while it loads, not when the read failed; offered once it landed', async () => {
    const clip = spyClipboard();
    // Loading: a read that never answers.
    const loading = reportRig();
    loading.open(
      { cost: { read: () => new Promise(() => {}), release: vi.fn() }, clipboard: clip.writer },
      { kind: 'cost', release: false },
    );
    loading.show();
    await settleWork();
    loading.clock.advance(600);
    expect(loading.content().kind).toBe('loading');
    expect(offered(loading).controls).toEqual([]);
    loading.press('c');
    // A read that failed.
    const failed = reportRig();
    failed.open(
      {
        cost: {
          read: () => {
            throw new Error('PRIVATE');
          },
          release: vi.fn(),
        },
        clipboard: clip.writer,
      },
      { kind: 'cost', release: false },
    );
    failed.show();
    await settleWork();
    failed.clock.advance(600);
    expect(failed.content().kind).toBe('error');
    expect(offered(failed).controls).toEqual([]);
    expect(offered(failed).legend).not.toContain('copy');
    failed.press('c');
    await settleWork();
    expect(clip.texts).toEqual([]);
    expect(failed.notifications.getSnapshot().current).toBeUndefined();
    // Landed.
    const ok = await opened('cost', { cost: fakeCost({ held: 0 }).port, clipboard: clip.writer });
    expect(offered(ok).controls).toEqual(['c']);
    expect(offered(ok).legend).toContain('"copy"');
  });

  it('/workflows: not while it scans, not on an empty project, no project or a fault; offered with a catalog', async () => {
    const clip = spyClipboard();
    const states: readonly [string, Parameters<typeof fakeWorkflows>[0], readonly string[]][] = [
      ['scanning', () => new Promise(() => {}), []],
      ['an empty project', () => ({ kind: 'catalog', workflows: [], agents: [] }), []],
      ['no project', () => ({ kind: 'no-project' }), []],
      ['a fault', () => ({ kind: 'fault', reason: 'too many workflow files' }), []],
      [
        'a catalog',
        () => ({ kind: 'catalog', workflows: [catalogEntry('deploy')], agents: [] }),
        ['c'],
      ],
    ];
    for (const [name, answer, controls] of states) {
      const r = await opened('workflows', {
        workflows: fakeWorkflows(answer).port,
        clipboard: clip.writer,
      });
      expect(offered(r).controls, name).toEqual(controls);
      r.press('c');
      await settleWork();
    }
    // Only the catalog was copied.
    expect(clip.texts).toHaveLength(1);
  });

  it('/agent: not when its view could not be made', async () => {
    const clip = spyClipboard();
    const r = await opened('agent', {
      agent: () => {
        throw new Error('PRIVATE');
      },
      clipboard: clip.writer,
    });
    expect(r.content().kind).toBe('error');
    expect(offered(r).controls).toEqual([]);
    r.press('c');
    await settleWork();
    expect(clip.texts).toEqual([]);
  });

  it('is on the report step of /cost and not on the release line or its result', async () => {
    const clip = spyClipboard();
    const fake = fakeCost({ held: 450 });
    const r = await opened('cost', { cost: fake.port, clipboard: clip.writer });
    expect(r.controls()).toEqual(['r', 'c']);
    // The release line lists no control; a `c` there is a key that is not the chord, so it disarms the line and copies nothing.
    r.press('r');
    await settleWork();
    r.show();
    expect(r.step()).toBe(COST_STEP.release);
    expect(r.controls()).toEqual([]);
    const line = r.host.getSnapshot().frame;
    expect(line && JSON.stringify(popupLegend(line).items)).not.toContain('copy');
    r.clock.advance(900);
    r.press('c');
    await settleWork();
    expect(clip.texts).toEqual([]);
    expect(fake.release).not.toHaveBeenCalled();
    expect(r.step()).toBe(COST_STEP.cost);
    // The result: released, and no control; `c` there does nothing. (The lockout of the refused key passes first.)
    r.clock.advance(2100);
    r.press('r');
    await settleWork();
    r.show();
    r.clock.advance(900);
    r.press('y', CTRL);
    await settleWork();
    expect(r.step()).toBe(COST_STEP.done);
    expect(r.controls()).toEqual([]);
    r.clock.advance(600);
    r.press('c');
    await settleWork();
    expect(clip.texts).toEqual([]);
    expect(r.host.getSnapshot().open).toBe(true);
    r.press('', ENTER);
    expect(r.host.getSnapshot().open).toBe(false);
  });

  it('a typed /cost --release opens on the line, with no copy until the report is reached', async () => {
    const clip = spyClipboard();
    const r = reportRig();
    r.open(
      { cost: fakeCost({ held: 450 }).port, clipboard: clip.writer },
      { kind: 'cost', release: true },
    );
    r.show();
    await settleWork();
    expect(r.step()).toBe(COST_STEP.release);
    expect(r.controls()).toEqual([]);
    r.clock.advance(600);
    r.press('', ESC);
    expect(r.step()).toBe(COST_STEP.cost);
    expect(r.controls()).toEqual(['r', 'c']);
  });
});

describe('what [c] says', () => {
  it.each([
    ['/agent', 'Agent'],
    ['/cost', 'Cost'],
    ['/workflows', 'Workflows'],
    ['/help', 'Help'],
  ] as const)(
    '%s with no clipboard says copying is not available here, and nothing else',
    async (_name, label) => {
      const r = reportRig();
      const port: Partial<ReportsPort> = {
        agent: () => view(),
        cost: fakeCost({ held: 450 }).port,
        workflows: flows().port,
        help: { keys: KEYS },
      };
      const kind = label.toLowerCase() as 'agent' | 'cost' | 'workflows' | 'help';
      await opened(kind, port, r);
      r.press('c');
      await settleWork();
      expect(r.notifications.getSnapshot().current?.text).toBe(
        `${label}: copying is not available here.`,
      );
      // That one line is the whole of what the press said: no write was attempted behind it, so no second line waits.
      expect(r.notifications.getSnapshot().queued).toBe(0);
      expect(r.host.getSnapshot().open).toBe(true);
    },
  );

  it('says what it wrote, that the request failed or that the report is too large, in the one family of sentences', async () => {
    const written = spyClipboard();
    const r = await opened('workflows', { workflows: flows().port, clipboard: written.writer });
    r.press('c');
    await settleWork();
    expect(r.notifications.getSnapshot().current?.text).toBe(
      `Workflows: sent ${String((written.texts[0] ?? '').length)} characters to the clipboard.`,
    );
    expect(r.notifications.getSnapshot().queued).toBe(0);
    for (const [outcome, said] of [
      [{ kind: 'failed' } as const, 'Workflows: the clipboard request failed.'],
      [
        { kind: 'too-large', base64Length: 99_999, limit: 74_994 } as const,
        'Workflows: too large for the clipboard.',
      ],
    ] as const) {
      const clip = spyClipboard(outcome);
      const again = await opened('workflows', { workflows: flows().port, clipboard: clip.writer });
      again.press('c');
      await settleWork();
      expect(again.notifications.getSnapshot().current?.text).toBe(said);
      expect(again.notifications.getSnapshot().queued).toBe(0);
    }
  });

  it('a clipboard that throws is a notification, never an unhandled rejection', async () => {
    const clip = spyClipboard(() => {
      throw new Error('PRIVATE /tmp/x');
    });
    const r = await opened('help', { help: { keys: KEYS }, clipboard: clip.writer });
    r.press('c');
    await settleWork();
    expect(r.notifications.getSnapshot().current?.text).toBe('Help: the clipboard request failed.');
    expect(r.notifications.getSnapshot().current?.text).not.toContain('PRIVATE');
  });

  it('every sentence of a copy fits the popup’s legend row at the 80-column floor, whatever the report’s name and a six-digit count', () => {
    for (const label of ['Agent', 'Cost', 'Workflows', 'Help']) {
      const said = [
        popupCopyNotice(label, { kind: 'written', characters: 999_999 }),
        popupCopyNotice(label, { kind: 'failed' }),
        popupCopyNotice(label, { kind: 'too-large', base64Length: 99_999, limit: 74_994 }),
        popupCopyUnavailable(label),
      ];
      expect(said.filter((text) => text !== undefined)).toHaveLength(4);
      for (const text of said) {
        expect(displayWidth(text ?? ''), text).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
        expect(text).toMatch(new RegExp(`^${label}: `, 'u'));
      }
    }
  });

  it('an empty write says nothing', () => {
    expect(popupCopyNotice('Cost', { kind: 'empty' })).toBeUndefined();
  });

  it('only a report is offered a copy', () => {
    expect(copyControlsFor({ kind: 'report' })).toEqual([{ key: 'c', verb: 'copy' }]);
    for (const kind of ['loading', 'empty', 'error', 'list'])
      expect(copyControlsFor({ kind })).toEqual([]);
  });
});

describe('the legend keeps [c] copy (ADR-0148 §1)', () => {
  it.each(['agent', 'cost', 'workflows', 'help'] as const)(
    '%s: the copy outlasts the scroll hint, and on /cost the release too, when the row is short',
    async (kind) => {
      const clip = spyClipboard();
      const r = await opened(kind, {
        agent: () => view(),
        cost: fakeCost({ held: 450 }).port,
        workflows: flows().port,
        help: { keys: KEYS },
        clipboard: clip.writer,
      });
      const frame = r.host.getSnapshot().frame;
      if (frame === undefined) throw new Error('open');
      const { items, priority } = popupLegend(frame);
      const at = (key: string): number =>
        items.findIndex((item) => 'keys' in item && item.keys === key);
      expect(at('c')).toBeGreaterThanOrEqual(0);
      const kept = priority ?? [];
      const copy = kept[at('c')] ?? -1;
      items.forEach((_item, index) => {
        if (index !== at('c')) expect(kept[index] ?? 0, `item ${String(index)}`).toBeLessThan(copy);
      });
      // Drawn at 80×24, the row names it whole.
      const rows = popupBoxOf(frame, VARIANT).rows.join('\n');
      expect(rows).toContain('[c] copy');
    },
  );
});

describe('copyPopupText: the one send of every popup, the doctor’s included', () => {
  const sendOnce = async (
    clipboard: ClipboardWriter | undefined,
    label: string,
    text: string,
  ): Promise<string[]> => {
    const said: string[] = [];
    copyPopupText({ notify: (line) => said.push(line) }, { clipboard }, label, text);
    await settleWork();
    return said;
  };

  it('writes the text it is given as it is, and says how many characters went, under the popup’s name', async () => {
    const clip = spyClipboard();
    const text = 'doctor: all checks passed\n  ok  OS keychain  reachable';
    expect(await sendOnce(clip.writer, 'Doctor', text)).toEqual([
      `Doctor: sent ${String(text.length)} characters to the clipboard.`,
    ]);
    expect(clip.texts).toEqual([text]);
  });

  it('with no clipboard says copying is not available here, and writes nothing', async () => {
    expect(await sendOnce(undefined, 'Doctor', 'a report')).toEqual([
      'Doctor: copying is not available here.',
    ]);
  });

  it.each([
    [{ kind: 'failed' } as const, 'Doctor: the clipboard request failed.'],
    [
      { kind: 'too-large', base64Length: 99_999, limit: 74_994 } as const,
      'Doctor: too large for the clipboard.',
    ],
  ])('says that a write that %o did not happen', async (outcome, said) => {
    expect(await sendOnce(() => outcome, 'Doctor', 'a report')).toEqual([said]);
  });

  it('a clipboard that throws is a notification, never a throw, and an empty write says nothing', async () => {
    const throwing: ClipboardWriter = () => {
      throw new Error('PRIVATE');
    };
    expect(await sendOnce(throwing, 'Doctor', 'a report')).toEqual([
      'Doctor: the clipboard request failed.',
    ]);
    expect(await sendOnce(() => ({ kind: 'empty' }), 'Doctor', '')).toEqual([]);
  });
});
