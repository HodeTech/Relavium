// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The four report popups in the hosts of the product ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10, MVP-11 step 4b): the chat the Home hosts and a stand-alone chat, each in both placements, and the Home's own landing, which does not
 * change. What it pins: a typed or palette-selected line opens its popup from the host's own routing (never through a submit, so the open gate
 * never takes the command's own line for a turn in flight); a line that is not exactly one of the four, and a host that wired none, dispatch as
 * before; nothing reaches the transcript or the Home's notice; a release asks the host's own state at the answer; and a mid-turn open is refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome } from '../render/tui/surface-matrix/home-host.js';
import {
  REPORT_LANDMARKS,
  reportsPortFor,
  type ReportState,
} from '../render/tui/surface-matrix/report-fixture.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { COST_STEP } from './cost-popup.js';
import { reportCopyText } from './popup-copy.js';
import { openReport, type ReportsPort } from './report-port.js';

type Host = 'chat' | 'standalone-chat';
const HOSTS: readonly Host[] = ['chat', 'standalone-chat'];
const RENDERERS = ['alt', 'inline'] as const;
const variantOf = (renderer: (typeof RENDERERS)[number]): Variant => ({
  renderer,
  color: false,
  size: { cols: 80, rows: 24 },
});

afterEach(() => {
  vi.useRealTimers();
});

async function mountWith(host: Host, variant: Variant, reports: ReportsPort): Promise<ChatMount> {
  const m =
    host === 'chat'
      ? await mountHostedChat(variant, { reports })
      : mountStandaloneChat(variant, { reports });
  await m.settle();
  return m;
}

/** The cost port of a ports object a test built with one. */
function costOf(port: ReportsPort): NonNullable<ReportsPort['cost']> {
  if (port.cost === undefined) throw new Error('the fixture has a cost port');
  return port.cost;
}

const popupId = (m: ChatMount): string | undefined => m.popups.getSnapshot().frame?.spec.id;
const popupStep = (m: ChatMount): number | undefined => m.popups.getSnapshot().frame?.stepIndex;
const opens = async (m: ChatMount, id: string): Promise<void> => {
  await vi.waitFor(() => expect(popupId(m)).toBe(id), { timeout: 3000, interval: 15 });
  await m.settle();
};
const closes = async (m: ChatMount): Promise<void> => {
  await vi.waitFor(() => expect(m.popups.getSnapshot().open).toBe(false), {
    timeout: 3000,
    interval: 15,
  });
};
/**
 * What the chat shows in its transcript and in its warnings line, and (the Home) in its notice: the places a popup must leave alone (ADR-0148 §6:
 * it writes nothing into the conversation and nothing into a Home notice, and a note on the warnings line is a line of the chat too).
 */
const residue = (m: ChatMount) => ({
  transcript: m.store.getSnapshot().state.transcript,
  warnings: m.store.getSnapshot().state.warnings,
  notice:
    'controller' in m
      ? (m.controller as { getSnapshot: () => { notice?: string } }).getSnapshot().notice
      : undefined,
});

const LINES: readonly (readonly [string, string, ReportState])[] = [
  ['/agent', 'agent', 'agent'],
  ['/cost', 'cost', 'cost-held'],
  ['/workflows', 'workflows', 'workflows'],
  ['/help', 'help', 'help'],
];

describe.each(HOSTS)('the reports in the %s host', (host) => {
  describe.each(RENDERERS)('%s', (renderer) => {
    const variant = variantOf(renderer);

    it.each(LINES)(
      '%s opens the popup from the host’s routing, and writes nothing into the transcript or the Home’s notice',
      async (line, id, state) => {
        const m = await mountWith(host, variant, reportsPortFor('standalone-chat', state));
        try {
          const before = residue(m);
          await m.typeLine(line);
          await opens(m, id);
          await vi.waitFor(() =>
            expect(m.text()).toContain(REPORT_LANDMARKS[state === 'cost-held' ? 'cost' : state]),
          );
          // The line never reached the chat's dispatch (it would have printed its text into the transcript).
          expect(m.submitted).toEqual([]);
          m.key(KEYS.escape);
          await closes(m);
          expect(residue(m)).toEqual(before);
          expect(m.submitted).toEqual([]);
        } finally {
          m.unmount();
        }
      },
    );

    it.each(LINES)(
      '%s: [c] copy writes the report to the host’s clipboard and says so, and writes nothing into the transcript, the warnings line or the Home’s notice',
      async (line, id, state) => {
        const written: string[] = [];
        const port: ReportsPort = {
          ...reportsPortFor('standalone-chat', state),
          clipboard: (text) => {
            written.push(text);
            return { kind: 'written', characters: text.length };
          },
        };
        const m = await mountWith(host, variant, port);
        try {
          const before = residue(m);
          await m.typeLine(line);
          await opens(m, id);
          await vi.waitFor(() => expect(m.text()).toContain('[c] copy'));
          await m.settle();
          m.skip(600);
          m.key('c');
          await vi.waitFor(() => expect(written).toHaveLength(1));
          // What was written is the report the popup draws: its own lines, one to a row (the popup's step holds them), not just something of a size.
          const frame = m.popups.getSnapshot().frame;
          const shown = frame?.steps[frame.stepIndex]?.content;
          if (shown?.kind !== 'report') throw new Error('the step shows a report');
          expect(shown.lines.length).toBeGreaterThan(1);
          expect(written[0]).toBe(reportCopyText(shown.lines, false));
          expect(written[0]?.split('\n')).toHaveLength(shown.lines.length);
          const said = `${{ agent: 'Agent', cost: 'Cost', workflows: 'Workflows', help: 'Help' }[id as 'agent']}: sent ${String(written[0]?.length)} characters to the terminal clipboard.`;
          expect(m.submitted).toEqual([]);
          m.key(KEYS.escape);
          await closes(m);
          // One notification, and it is the whole of what the copy left (the inline block hides the hint row, so it is drawn once the popup is gone).
          await vi.waitFor(() => expect(m.notifications.getSnapshot().current?.text).toBe(said));
          expect(residue(m)).toEqual(before);
        } finally {
          m.unmount();
        }
      },
    );

    it('a line selected in the palette opens the popup as the same line typed does', async () => {
      const m = await mountWith(host, variant, reportsPortFor('standalone-chat', 'cost-held'));
      try {
        const before = residue(m);
        m.key('/');
        await m.settle();
        m.key('cost');
        await m.settle();
        m.key(KEYS.enter);
        await opens(m, 'cost');
        expect(m.submitted).toEqual([]);
        expect(residue(m)).toEqual(before);
      } finally {
        m.unmount();
      }
    });

    it('`/cost --release` opens ON the confirmation line, which only Ctrl+Y answers, and the result is a step of the popup', async () => {
      const port = reportsPortFor('standalone-chat', 'cost-release');
      const release = vi.spyOn(costOf(port), 'release');
      const m = await mountWith(host, variant, port);
      try {
        const before = residue(m);
        await m.typeLine('/cost --release');
        await opens(m, 'cost');
        expect(popupStep(m)).toBe(COST_STEP.release);
        await vi.waitFor(() => expect(m.text()).toContain('This lifts about'));
        // The frame is on screen; a Ctrl+Y inside the dwell (past the opening guard's settle, short of 800 ms) is refused.
        await m.settle();
        m.skip(600);
        m.key(KEYS.ctrlY);
        await m.settle();
        expect(release).not.toHaveBeenCalled();
        expect(popupStep(m)).toBe(COST_STEP.cost);
        // Again, on a typed line, after the dwell.
        m.key(KEYS.escape);
        await closes(m);
        m.skip(3000);
        await m.typeLine('/cost --release');
        await opens(m, 'cost');
        await vi.waitFor(() => expect(m.text()).toContain('This lifts about'));
        await m.settle();
        m.skip(900);
        m.key(KEYS.ctrlY);
        await vi.waitFor(() => expect(m.text()).toContain('back to the cap.'));
        expect(release).toHaveBeenCalledOnce();
        expect(popupStep(m)).toBe(COST_STEP.done);
        m.key(KEYS.enter);
        await closes(m);
        expect(residue(m)).toEqual(before);
        expect(m.submitted).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('the answer asks the HOST whether a turn is in flight: one that started after the line was drawn releases nothing', async () => {
      const port = reportsPortFor('standalone-chat', 'cost-release');
      const release = vi.spyOn(costOf(port), 'release');
      const m = await mountWith(host, variant, port);
      try {
        await m.typeLine('/cost --release');
        await opens(m, 'cost');
        await vi.waitFor(() => expect(m.text()).toContain('This lifts about'));
        await m.settle();
        // The chat's store says a turn is running at the moment of the answer (nothing the popup opened over).
        m.store.apply({
          type: 'session:turn_started',
          sessionId: 'matrix-session',
          sequenceNumber: 1,
          timestamp: '2026-11-25T00:00:00.000Z',
        });
        m.skip(900);
        m.key(KEYS.ctrlY);
        await m.settle();
        expect(release).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(m.text()).toContain('A turn is running, so nothing was released.'),
        );
      } finally {
        m.unmount();
      }
    });

    it('an open while a turn runs is refused with one notification and opens nothing', async () => {
      const m = await mountWith(host, variant, reportsPortFor('standalone-chat', 'cost-held'));
      try {
        m.store.apply({
          type: 'session:turn_started',
          sessionId: 'matrix-session',
          sequenceNumber: 1,
          timestamp: '2026-11-25T00:00:00.000Z',
        });
        await openReport({
          host: m.popups,
          port: reportsPortFor('standalone-chat', 'cost-held'),
          line: { kind: 'cost', release: false },
          origin: 'chat',
          turnInFlight: () => true,
        });
        expect(m.popups.getSnapshot().open).toBe(false);
        // One notification (the channel holds it while a turn is on screen, so it is queued, not yet drawn).
        const notified = m.notifications.getSnapshot();
        expect((notified.current === undefined ? 0 : 1) + notified.queued).toBe(1);
      } finally {
        m.unmount();
      }
    });

    it.each(['/agent now', '/cost --force', '/workflows list', '/help me'])(
      '%s is not a report line: it is dispatched, and no popup opens',
      async (line) => {
        const m = await mountWith(host, variant, reportsPortFor('standalone-chat', 'cost-held'));
        try {
          await m.typeLine(line);
          await vi.waitFor(() => expect(m.submitted).toEqual([line]));
          expect(m.popups.getSnapshot().open).toBe(false);
        } finally {
          m.unmount();
        }
      },
    );

    it('a host that wired only some of the reports opens those and dispatches the rest', async () => {
      const full = reportsPortFor('standalone-chat', 'cost-held');
      const m = await mountWith(host, variant, { surface: 'standalone-chat', help: full.help });
      try {
        await m.typeLine('/cost');
        await vi.waitFor(() => expect(m.submitted).toEqual(['/cost']));
        expect(m.popups.getSnapshot().open).toBe(false);
        await m.typeLine('/help');
        await opens(m, 'help');
        expect(m.submitted).toEqual(['/cost']);
      } finally {
        m.unmount();
      }
    });
  });
});

describe('the popup opens before the line is a submit', () => {
  // A chat whose submits never settle: a line that WENT through the submit would hold `submitBusy` true, and the open gate would refuse the popup.
  it('a stand-alone chat opens it although a submit in flight would have refused it', async () => {
    const m = mountStandaloneChat(variantOf('alt'), {
      reports: reportsPortFor('standalone-chat', 'cost-held'),
      standalone: { onSubmit: () => new Promise<void>(() => {}) },
    });
    try {
      await m.settle();
      await m.typeLine('/cost');
      await opens(m, 'cost');
      expect(m.notifications.getSnapshot().current?.text ?? '').not.toContain('cannot open');
    } finally {
      m.unmount();
    }
  });

  it('the chat the Home hosts opens it although a submit in flight would have refused it', async () => {
    // The first line starts the chat and settles; every line after it never does.
    let lines = 0;
    const m = await mountHostedChat(variantOf('alt'), {
      reports: reportsPortFor('home-chat', 'cost-held'),
      hosted: {
        session: {
          processLine: () => (lines++ === 0 ? Promise.resolve() : new Promise<void>(() => {})),
        },
      },
    });
    try {
      await m.settle();
      await m.typeLine('/cost');
      await opens(m, 'cost');
      expect(m.notifications.getSnapshot().current?.text ?? '').not.toContain('cannot open');
    } finally {
      m.unmount();
    }
  });
});

describe('the Home’s own landing does not change', () => {
  it('`/help` and `/workflows` stay the Home’s screens, `/cost` and `/agent` say they work in a chat, and no popup opens', async () => {
    const m = mountHome(variantOf('alt'), { reports: reportsPortFor('home-chat', 'cost-held') });
    try {
      await m.settle();
      const type = async (line: string): Promise<void> => {
        m.key(`\u001b[200~${line}\u001b[201~`);
        await m.until(() => m.controller.getSnapshot().input.text === line);
        m.key(KEYS.enter);
        await m.settle();
      };
      await type('/cost');
      expect(m.controller.getSnapshot().notice).toContain('/cost works in a chat');
      await type('/agent');
      expect(m.controller.getSnapshot().notice).toContain('/agent works in a chat');
      await type('/help');
      expect(m.controller.getSnapshot().screen?.kind).toBe('help');
      m.key(KEYS.escape);
      await m.settle();
      await type('/workflows');
      expect(m.popups.getSnapshot().open).toBe(false);
    } finally {
      m.unmount();
    }
  });
});
