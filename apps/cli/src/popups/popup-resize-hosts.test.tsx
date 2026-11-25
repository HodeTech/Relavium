// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * A resize and a suspension leave an open popup alive, in every host ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §4; MVP-11 step 4, review round 2, correctness #1 and security F5):
 *
 * - **A resize** reaches the popup host, and voids the popup's measured frame, BEFORE the frame at the new size is committed (the slot does it
 *   ahead of the popup). The stand-alone chat did it from a passive effect that ran AFTER that commit: it voided the new frame's
 *   acknowledgement as it was made, so the frame was never acknowledged, every key but `Esc` and `Ctrl+C` was dropped as unseen and a
 *   confirmation line was refused as "not yet shown" until something else re-rendered. After a resize a live key acts, in the stand-alone chat
 *   (both renderers), on the Home and in the chat the Home hosts (whose resize here is a real one: the test wires the Home's size and its resize
 *   subscription, which the matrix leaves inert).
 * - **A Home that starts below the floor** tells its popup host so on mount: a popup opened there is drawn as the notice, which has no legend
 *   row, so the notification channel is held for it.
 * - **`Ctrl+Z` and back** (`fg`): the renderer redraws its last output on resume but commits nothing, so the popup's frame is committed once
 *   more and acknowledged anew; a live key acts after it, and a confirmation line's dwell counts from THAT acknowledgement (round 3, HA04).
 * - **One dimension at a time** (round 3, S06/S07): a resize that changes only the rows, or only the columns, reaches the popup host too.
 * - **A narrower popup** (round 3, security L2): a line whose rows were whole at the old width and one of which the new width cuts is
 *   disarmed at the frame drawn at the new size, as `cut`.
 */
import { describe, expect, it, vi } from 'vitest';

import { createSuspendPort } from '../render/suspend.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import {
  KEYS,
  mountHome,
  type HomeMount,
  type HomeSetup,
} from '../render/tui/surface-matrix/home-host.js';
import { testReportPopup } from '../render/tui/surface-matrix/popup-fixture.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import type { PopupSpec } from './popup-reducer.js';

type Mount = HomeMount | ChatMount;
type Renderer = Variant['renderer'];

/** A popup of a list and a confirmation line its `[d]` arms (the line is short enough for every page). */
function listAndLine(origin: 'home' | 'chat'): PopupSpec {
  return {
    id: 'resize',
    title: '/resize',
    origin,
    rail: 'path',
    steps: [
      {
        name: 'List',
        content: {
          kind: 'list',
          rows: [
            { id: 'a', label: 'alpha row' },
            { id: 'b', label: 'bravo row' },
            { id: 'c', label: 'charlie row' },
          ],
        },
        controls: [{ key: 'd', verb: 'arm' }],
      },
      {
        name: 'Confirm',
        content: { kind: 'report', lines: ['Sends one request to:', '  https://a.example'] },
        back: 0,
        holds: 'chord',
        chord: { verb: 'send' },
      },
    ],
  };
}

/** A terminal whose size the Home reads and whose resize it hears, so a Home-mounted test really resizes (the matrix's own are inert). */
function liveTerminal(cols: number, rows: number) {
  let size = { cols, rows };
  const listeners = new Set<() => void>();
  const setup: Pick<HomeSetup, 'getSize' | 'subscribeResize'> = {
    getSize: () => size,
    subscribeResize: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    setup,
    resize: (m: Mount, next: { cols: number; rows: number }): void => {
      size = next;
      m.resize(next.cols, next.rows);
      for (const listener of [...listeners]) listener();
    },
  };
}

type HostName = 'standalone-chat' | 'home' | 'home-chat';
const HOSTS: readonly HostName[] = ['standalone-chat', 'home', 'home-chat'];
const RENDERERS: readonly Renderer[] = ['alt', 'inline'];

async function mountOn(host: HostName, variant: Variant) {
  const terminal = liveTerminal(variant.size.cols, variant.size.rows);
  const m: Mount =
    host === 'standalone-chat'
      ? mountStandaloneChat(variant)
      : host === 'home'
        ? mountHome(variant, terminal.setup)
        : await mountHostedChat(variant, { hosted: { home: terminal.setup } });
  return { m, resize: (cols: number, rows: number) => terminal.resize(m, { cols, rows }) };
}

const selected = (m: Mount): number | undefined => m.popups.getSnapshot().frame?.steps[0]?.selected;

/** Open the popup and wait until its first frame is drawn, measured and past its settle time. */
async function open(m: Mount, origin: 'home' | 'chat', chord = vi.fn()) {
  const opened = m.popups.openForUser(listAndLine(origin), {
    chord,
    control: (context, key) => {
      if (key === 'd') context.goToStep(1);
    },
  });
  expect(opened.opened).toBe(true);
  await m.until(() => m.frame().join('\n').includes('alpha row'));
  await m.settle();
  m.skip(600);
  return chord;
}

describe.each(HOSTS)('%s: after a resize a live key acts', (host) => {
  it.each(RENDERERS)(
    '%s: Down moves the selection after 80×24 → 100×30 and back',
    async (renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
      const { m, resize } = await mountOn(host, variant);
      try {
        await m.settle();
        await open(m, host === 'home' ? 'home' : 'chat');
        expect(selected(m)).toBe(0);
        resize(100, 30);
        await m.settle();
        await m.settle();
        m.key(KEYS.down);
        await m.until(() => selected(m) === 1);
        expect(selected(m)).toBe(1);
        resize(80, 24);
        await m.settle();
        await m.settle();
        m.key(KEYS.down);
        await m.until(() => selected(m) === 2);
        expect(selected(m)).toBe(2);
      } finally {
        m.unmount();
      }
    },
  );

  it.each(RENDERERS)(
    '%s: a line armed before the resize is answered after the dwell of its frame at the new size',
    async (renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
      const { m, resize } = await mountOn(host, variant);
      try {
        await m.settle();
        const chord = await open(m, host === 'home' ? 'home' : 'chat');
        m.key('d');
        await m.until(() => m.frame().join('\n').includes('https://a.example'));
        await m.settle();
        m.skip(2600);
        resize(100, 30);
        await m.settle();
        await m.settle();
        m.skip(900);
        m.key(KEYS.ctrlY);
        await m.until(() => chord.mock.calls.length === 1);
        expect(chord).toHaveBeenCalledOnce();
      } finally {
        m.unmount();
      }
    },
  );

  it.each(RENDERERS)(
    '%s: a Ctrl+Y right after the resize is refused and disarms the line with a reason (never silently dead); a re-armed line answers',
    async (renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
      const { m, resize } = await mountOn(host, variant);
      try {
        await m.settle();
        const refusals: string[] = [];
        const chord = vi.fn();
        const opened = m.popups.openForUser(listAndLine(host === 'home' ? 'home' : 'chat'), {
          chord,
          chordRefused: (_context, reason) => refusals.push(reason),
          control: (context, key) => {
            if (key === 'd') context.goToStep(1);
          },
        });
        expect(opened.opened).toBe(true);
        await m.until(() => m.frame().join('\n').includes('alpha row'));
        await m.settle();
        m.skip(600);
        m.key('d');
        await m.until(() => m.frame().join('\n').includes('https://a.example'));
        await m.settle();
        m.skip(2600);
        resize(100, 30);
        await m.settle();
        m.key(KEYS.ctrlY);
        await m.until(() => refusals.length === 1);
        expect(chord).not.toHaveBeenCalled();
        expect(['unseen', 'early']).toContain(refusals[0]);
        expect(m.popups.getSnapshot().frame?.stepIndex).toBe(0);
        // `[d]` asks again, and a patient press on the new line answers.
        m.skip(2600);
        await m.settle();
        m.key('d');
        await m.until(() => m.popups.getSnapshot().frame?.stepIndex === 1);
        await m.settle();
        m.skip(2600);
        m.key(KEYS.ctrlY);
        await m.until(() => chord.mock.calls.length === 1);
        expect(chord).toHaveBeenCalledOnce();
      } finally {
        m.unmount();
      }
    },
  );
});

describe.each(HOSTS)(
  '%s: a resize below the floor closes a line unanswered (ADR-0148 §4)',
  (host) => {
    it.each(RENDERERS)(
      '%s: 80×24 → 70×20 with the line armed: closed, nothing answered, and it says so',
      async (renderer) => {
        const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
        const { m, resize } = await mountOn(host, variant);
        try {
          await m.settle();
          const chord = await open(m, host === 'home' ? 'home' : 'chat');
          m.key('d');
          await m.until(() => m.frame().join('\n').includes('https://a.example'));
          await m.settle();
          resize(70, 20);
          await m.until(() => !m.popups.getSnapshot().open);
          expect(m.popups.getSnapshot().open).toBe(false);
          expect(chord).not.toHaveBeenCalled();
          // It says so (the Home holds its hint row below the floor, so the words wait until the terminal is large enough again).
          resize(80, 24);
          await m.until(
            () =>
              m.notifications.getSnapshot().current?.text.includes('nothing was answered') === true,
          );
          expect(m.notifications.getSnapshot().current?.text ?? '').toContain(
            'nothing was answered',
          );
        } finally {
          m.unmount();
        }
      },
    );
  },
);

describe('a Home that starts below the floor tells its popup host so on mount (security F5)', () => {
  it.each(RENDERERS)(
    '%s at 70×20: a popup opened there is the notice, and the notification channel is held for it',
    async (renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 70, rows: 20 } };
      const m = mountHome(variant);
      try {
        await m.settle();
        expect(m.popups.openForUser(testReportPopup('home')).opened).toBe(true);
        await m.until(() => m.text().includes('Terminal too small for this popup'));
        m.notifications.notify('QXF a notification');
        await m.settle();
        expect(m.notifications.getSnapshot().held).toBe(true);
        expect(m.notifications.getSnapshot().current).toBeUndefined();
        expect(m.text()).not.toContain('QXF');
      } finally {
        m.unmount();
      }
    },
  );
});

describe('Ctrl+Z, then back: the popup is acknowledged anew and takes a live key', () => {
  it.each(RENDERERS)('the stand-alone chat (%s)', async (renderer) => {
    const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
    const port = createSuspendPort();
    let resume: () => void = () => undefined;
    let suspended: Promise<void> | undefined;
    const m = mountStandaloneChat(variant, {
      standalone: {
        suspendPort: port,
        onSuspend: () => {
          const suspend = port.current();
          if (suspend === undefined) return;
          suspended = suspend(
            () =>
              new Promise<void>((resolve) => {
                resume = resolve;
              }),
          );
        },
      },
    });
    try {
      await m.settle();
      await open(m, 'chat');
      m.key('\u001a');
      await m.until(() => port.isSuspended());
      expect(port.isSuspended()).toBe(true);
      resume();
      await suspended;
      await m.settle();
      await m.settle();
      m.key(KEYS.down);
      await m.until(() => selected(m) === 1);
      expect(selected(m)).toBe(1);
    } finally {
      m.unmount();
    }
  });
});

describe('a resize of one dimension only reaches the popup host (round 3, mutants S06 and S07)', () => {
  describe.each(RENDERERS)('%s', (renderer) => {
    it.each([
      ['rows only', 80, 20],
      ['columns only', 70, 24],
    ] as const)(
      '%s: 80×24 → %i×%i with the line armed closes it unanswered',
      async (_what, cols, rows) => {
        const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
        const { m, resize } = await mountOn('home', variant);
        try {
          await m.settle();
          const chord = await open(m, 'home');
          m.key('d');
          await m.until(() => m.frame().join('\n').includes('https://a.example'));
          await m.settle();
          resize(cols, rows);
          await m.until(() => !m.popups.getSnapshot().open);
          expect(m.popups.getSnapshot().open).toBe(false);
          expect(chord).not.toHaveBeenCalled();
        } finally {
          m.unmount();
        }
      },
    );
  });
});

describe('a resize that makes the popup narrower than a row of its line disarms the line, as cut (round 3, security L2)', () => {
  describe.each(['standalone-chat', 'home'] as const)('%s', (host) => {
    it.each(RENDERERS)(
      '%s: a row of 70 columns, whole at 88×24 (74), is cut at 80×24 (66): the line goes back, told as cut, and nothing is answered',
      async (renderer) => {
        const variant: Variant = { renderer, color: false, size: { cols: 88, rows: 24 } };
        const { m, resize } = await mountOn(host, variant);
        try {
          await m.settle();
          const origin = host === 'home' ? 'home' : 'chat';
          const wide = `  https://${'a'.repeat(52)}.example`;
          expect(wide).toHaveLength(70);
          const spec = listAndLine(origin);
          const refusals: string[] = [];
          const chord = vi.fn();
          const opened = m.popups.openForUser(
            {
              ...spec,
              steps: spec.steps.map((step, index) =>
                index === 1
                  ? { ...step, content: { kind: 'report', lines: ['Sends one request to:', wide] } }
                  : step,
              ),
            },
            {
              chord,
              chordRefused: (_context, reason) => refusals.push(reason),
              control: (context, key) => {
                if (key === 'd') context.goToStep(1);
              },
            },
          );
          expect(opened.opened).toBe(true);
          await m.until(() => m.frame().join('\n').includes('alpha row'));
          await m.settle();
          m.skip(600);
          m.key('d');
          await m.until(() => m.frame().join('\n').includes('.example'));
          await m.settle();
          expect(m.frame().join('\n')).toContain('[Ctrl+Y] send');
          resize(80, 24);
          await m.until(() => refusals.length === 1);
          expect(refusals).toEqual(['cut']);
          expect(m.popups.getSnapshot().frame?.stepIndex).toBe(0);
          m.skip(2600);
          m.key(KEYS.ctrlY);
          await m.settle();
          expect(chord).not.toHaveBeenCalled();
        } finally {
          m.unmount();
        }
      },
    );
  });
});

describe('Ctrl+Z, then back: a confirmation line counts its dwell from the frame acknowledged on return (round 3, HA04)', () => {
  const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

  /** How many answers a `Ctrl+Y` pressed `wait` ms after the return gives, on a line that was on screen long before the suspension. */
  async function answersAfterReturn(host: 'home' | 'standalone-chat', wait: number) {
    const port = createSuspendPort();
    let resume: () => void = () => undefined;
    let suspended: Promise<void> | undefined;
    const onSuspend = (): void => {
      const suspend = port.current();
      if (suspend === undefined) return;
      suspended = suspend(
        () =>
          new Promise<void>((resolve) => {
            resume = resolve;
          }),
      );
    };
    const m: Mount =
      host === 'home'
        ? mountHome(variant, { props: { suspendPort: port, onSuspend } })
        : mountStandaloneChat(variant, { standalone: { suspendPort: port, onSuspend } });
    try {
      await m.settle();
      const chord = await open(m, host === 'home' ? 'home' : 'chat');
      m.key('d');
      await m.until(() => m.frame().join('\n').includes('https://a.example'));
      await m.settle();
      // Long past the line's dwell, its quiet gap and any lockout before the suspension.
      m.skip(3000);
      m.key('\u001a');
      await m.until(() => port.isSuspended());
      expect(port.isSuspended()).toBe(true);
      resume();
      await suspended;
      await m.settle();
      await m.settle();
      m.skip(wait);
      m.key(KEYS.ctrlY);
      await m.settle();
      await m.settle();
      return chord.mock.calls.length;
    } finally {
      m.unmount();
    }
  }

  it.each([
    ['home', 1300, 1],
    ['home', 500, 0],
    ['standalone-chat', 1300, 1],
    ['standalone-chat', 500, 0],
  ] as const)(
    '%s: a Ctrl+Y %i ms after the return gives %i answer(s)',
    async (host, wait, answers) => {
      expect(await answersAfterReturn(host, wait)).toBe(answers);
    },
  );
});
