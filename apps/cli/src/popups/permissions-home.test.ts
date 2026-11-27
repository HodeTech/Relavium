/**
 * The bare Home's `/permissions` popup ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4, OD-24 D1; [ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §3 as a popup): the chat popup's Home variant over the PROJECT's port. It lists the remembered commands and the repository's allowlist read-only
 * (no "This session": a Home has no session, and no mode), says in one note that only auto mode runs a remembered command unasked, and `[d]` withdraws
 * a remembered command behind the SAME two-step line as a chat's (the host's guard: 800 ms after the line was seen, never a held key, never a typed
 * line). The guard pins of the chat's popup are run again here on the Home's surface, so the Home cannot be a weaker door to the same write.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  PermissionEntry,
  PermissionsPort,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../permissions/chat-permissions.js';
import { PERMISSIONS_STEP, WITHDRAW_CONTROL } from './permissions-popup.js';
import { currentStep, popupLegend, visibleRows } from './popup-reducer.js';
import { openSettingsPopup } from './settings-session.js';
import { DOWN, ENTER, ESC, settingsRig } from './settings.test-support.js';

const ROWS: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [
      { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' },
      { id: 'b', label: 'pnpm, 2 arguments', remembered: '2026-11-21 16:40Z' },
    ],
  },
  session: undefined,
  allowlist: { ok: true, commands: ['git status', 'pnpm test'], globs: ['pnpm run *'], omitted: 0 },
};

/** A project port over `initial` whose withdrawal removes the row it names (or answers `answer`), every call recorded. */
function fakeProjectPort(
  initial: PermissionsSnapshot = ROWS,
  answer?: (entry: PermissionEntry) => WithdrawAnswer,
) {
  let current = initial;
  const withdraw = vi.fn((entry: PermissionEntry): WithdrawAnswer => {
    if (answer !== undefined) return answer(entry);
    if (entry.kind === 'project' && current.project.ok)
      current = {
        ...current,
        project: { ok: true, rows: current.project.rows.filter((row) => row.id !== entry.row.id) },
      };
    return { tone: 'done', text: 'Withdrawn. Auto mode asks about it again.' };
  });
  const load = vi.fn(() => current);
  const port: PermissionsPort = { surface: 'project', load, withdraw };
  return { port, withdraw, load };
}

/** The Home's popup opened and settled over `port`; `closed` is what a bare `relavium permissions` hangs its exit on. */
function opened(port: PermissionsPort, closed?: () => void) {
  const r = settingsRig();
  const announced: string[] = [];
  const result = openSettingsPopup({
    host: r.host,
    port: {
      surface: 'home',
      announce: (text) => {
        announced.push(text);
        r.notifications.notify(text);
      },
      permissions: { port },
    },
    command: 'permissions',
    origin: 'home',
    ...(closed === undefined ? {} : { closed }),
  });
  expect(result.opened).toBe(true);
  r.settle();
  const step = (): number | undefined => r.host.getSnapshot().frame?.stepIndex;
  const content = () => {
    const frame = r.host.getSnapshot().frame;
    return frame === undefined ? undefined : currentStep(frame).state.content;
  };
  const words = (): string => JSON.stringify(content());
  const highlighted = (): string | undefined => {
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) return undefined;
    const { state } = currentStep(frame);
    return visibleRows(state)[state.selected]?.id;
  };
  /** `[d]` and the line's frame acknowledged, as the slot acknowledges it. */
  const arm = (): void => {
    r.press('d');
    r.host.shown(r.host.getSnapshot());
  };
  const notice = (): string | undefined => r.notifications.getSnapshot().current?.text;
  return { ...r, announced, step, content, words, highlighted, arm, notice };
}

describe('what the Home’s popup lists', () => {
  it('the remembered commands of this project and the repository’s allowlist, read-only, with the note; no session section, no mode', () => {
    const { port } = fakeProjectPort();
    const p = opened(port);
    const words = p.words();
    expect(words).toContain('This project · remembered (2)');
    expect(words).toContain('npm, 1 argument');
    expect(words).toContain('pnpm, 2 arguments');
    expect(words).toContain('This repository · allowlist, read-only (2 commands, 1 pattern)');
    expect(words).toContain('git status');
    expect(words).toContain('pnpm run *');
    expect(words).toContain('Only auto mode runs a remembered command unasked');
    expect(words).not.toContain('This session');
    expect(p.highlighted(), 'the first remembered command is highlighted').toBe('entry:0');
  });

  it('is said to be from the Home, and its way back says where it goes', () => {
    const { port } = fakeProjectPort();
    const p = opened(port);
    const frame = p.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('open');
    expect(frame.spec.origin).toBe('home');
    expect(popupLegend(frame).exit).toMatchObject({ verb: 'back to Home' });
  });

  it('a repository whose allowlist cannot be read says so in a fixed sentence, and the remembered commands still list', () => {
    const { port } = fakeProjectPort({
      ...ROWS,
      allowlist: { ok: false, text: 'The repository’s allowlist could not be read.' },
    });
    const p = opened(port);
    expect(p.words()).toContain('The repository’s allowlist could not be read.');
    expect(p.words()).toContain('npm, 1 argument');
  });

  it('nothing remembered: a report of the same lines with no `[d]` (nothing to arm), and a `d` arms nothing', () => {
    const { port, withdraw } = fakeProjectPort({
      project: { ok: true, rows: [] },
      session: undefined,
      allowlist: { ok: true, commands: [], globs: [], omitted: 0 },
    });
    const p = opened(port);
    expect(p.content()?.kind).toBe('report');
    expect(p.words()).toContain('Nothing is remembered for this project.');
    p.press('d');
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('offers `[d]` only while there is a remembered command to withdraw', () => {
    const { port } = fakeProjectPort();
    const p = opened(port);
    const frame = p.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('open');
    expect(currentStep(frame).spec.controls).toEqual([WITHDRAW_CONTROL]);
  });

  it('a command named like a heading, a key or an escape is drawn as text, in the list and on the line', () => {
    const esc = String.fromCharCode(27);
    const hostile: PermissionsSnapshot = {
      project: {
        ok: true,
        rows: [
          { id: 'h', label: `${esc}[31mred ▼ 9 more [Enter] x`, remembered: '2026-11-20 09:12Z' },
        ],
      },
      session: undefined,
    };
    const { port } = fakeProjectPort(hostile);
    const p = opened(port);
    expect(p.words().includes(esc)).toBe(false);
    p.arm();
    expect(p.words().includes(esc)).toBe(false);
  });
});

describe('a withdrawal on the Home: [d], then Enter through the host’s guard', () => {
  it('`[d]` arms the highlighted row’s line, which names it; Enter 800 ms after the line was seen withdraws exactly it, by identity, and tells the Home’s channel', () => {
    const { port, withdraw, load } = fakeProjectPort();
    const p = opened(port);
    p.arm();
    expect(p.step()).toBe(PERMISSIONS_STEP.withdraw);
    expect(p.words()).toContain('npm, 1 argument (remembered 2026-11-20 09:12Z)');
    expect(withdraw, 'arming withdraws nothing').not.toHaveBeenCalled();
    p.clock.advance(800);
    p.press('', ENTER);
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw.mock.calls[0]?.[0]).toEqual({
      kind: 'project',
      row: ROWS.project.ok ? ROWS.project.rows[0] : undefined,
    });
    // The lists are read again: the row is gone, the popup is back on them, and the result is the host's announcement.
    expect(load).toHaveBeenCalledTimes(2);
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.words()).toContain('This project · remembered (1)');
    expect(p.words()).not.toContain('npm, 1 argument');
    expect(p.announced).toEqual(['Withdrawn: npm, 1 argument']);
    expect(p.host.getSnapshot().open, 'the popup stays open on the refreshed lists').toBe(true);
  });

  it('an Enter 799 ms after the line was seen withdraws nothing: the line is gone and the popup says why', () => {
    const { port, withdraw } = fakeProjectPort();
    const p = opened(port);
    p.arm();
    p.clock.advance(799);
    p.press('', ENTER);
    expect(withdraw).not.toHaveBeenCalled();
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.notice()).toBe('Nothing withdrawn: too soon. [d] asks again.');
  });

  it('an Enter before the line’s frame was seen on screen withdraws nothing, however late it comes', () => {
    const { port, withdraw } = fakeProjectPort();
    const p = opened(port);
    p.press('d'); // armed, but the host has not measured and flushed its frame
    expect(p.step()).toBe(PERMISSIONS_STEP.withdraw);
    p.clock.advance(5_000);
    p.press('', ENTER);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('a held `Enter` (every repeat of one press) withdraws nothing, and neither does the one that ends it', () => {
    const { port, withdraw } = fakeProjectPort();
    const p = opened(port);
    p.arm();
    p.clock.advance(900);
    p.press('', { return: true, eventType: 'repeat' });
    p.press('', { return: true, eventType: 'repeat' });
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('a `[d]` held down arms the line once and withdraws nothing: its repeats are not answers, and the Enter that follows them inside the lockout is not either', () => {
    const { port, withdraw } = fakeProjectPort();
    const p = opened(port);
    p.press('d');
    p.host.shown(p.host.getSnapshot());
    for (let repeat = 0; repeat < 6; repeat += 1) {
      p.clock.advance(30);
      p.press('d', { eventType: 'repeat' });
    }
    p.press('', ENTER);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('after ten seconds the host takes the line away; an Enter then withdraws nothing', () => {
    const { port, withdraw } = fakeProjectPort();
    const p = opened(port);
    p.arm();
    p.clock.advance(10_001);
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.notice()).toBe('Nothing withdrawn: time ran out. [d] asks again.');
    p.press('', ENTER);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('Esc keeps the row and goes back to the lists; Esc again closes to the Home; Ctrl+C on the line steps back too', () => {
    const { port, withdraw } = fakeProjectPort();
    let closed = 0;
    const p = opened(port, () => {
      closed += 1;
    });
    p.arm();
    p.clock.advance(900);
    p.press('', ESC);
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.host.getSnapshot().open).toBe(true);
    expect(closed, 'a step back is not a close').toBe(0);
    p.clock.advance(2100);
    p.arm();
    p.clock.advance(900);
    p.press('c', { ctrl: true });
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    p.press('', ESC);
    expect(p.host.getSnapshot().open).toBe(false);
    expect(closed, 'a close tells the Home once').toBe(1);
    expect(withdraw).not.toHaveBeenCalled();
    expect(p.announced).toEqual([]);
  });

  it('a letter typed over the line withdraws nothing, and a line typed ahead (`run the build`, Enter, Delete, Enter) at any pace withdraws nothing', () => {
    for (const pace of [0, 110, 400]) {
      const { port, withdraw } = fakeProjectPort();
      const p = opened(port);
      for (const key of [...'run the build'].map((char) => [char, {}] as const)) {
        p.press(key[0], key[1]);
        p.clock.advance(pace);
      }
      p.press('', ENTER);
      p.clock.advance(pace);
      p.press('', { delete: true });
      p.host.shown(p.host.getSnapshot());
      p.clock.advance(pace + 900);
      p.press('', ENTER);
      expect(withdraw, `${String(pace)} ms a key`).not.toHaveBeenCalled();
      expect(p.step()).toBe(PERMISSIONS_STEP.list);
    }
  });

  it('a withdrawal that cannot be written says so, with no path, and the row stays in the list', () => {
    const { port } = fakeProjectPort(ROWS, () => ({
      tone: 'failed',
      text: 'Could not write the withdrawal; nothing changed.',
    }));
    const p = opened(port);
    p.arm();
    p.clock.advance(900);
    p.press('', ENTER);
    expect(p.announced).toEqual(['Not withdrawn: npm, 1 argument']);
    expect(p.words()).toContain('Not withdrawn: Could not write the withdrawal; nothing changed.');
    expect(p.words()).toContain('npm, 1 argument');
  });
});

describe('closing', () => {
  it('tells the Home however the popup closed (a bare `relavium permissions` ends with it), once', () => {
    const { port } = fakeProjectPort();
    const closed = vi.fn();
    const p = opened(port, closed);
    p.press('', DOWN);
    expect(closed).not.toHaveBeenCalled();
    p.press('', ESC);
    expect(p.host.getSnapshot().open).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
