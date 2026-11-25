/**
 * The `/permissions` popup's state machine through the settings opener and a real popup host on a manual clock
 * ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §2 as a popup, ADR-0148 §3, §6,
 * §10; MVP-11 step 5c): it opens on the lists read now; `[d]` (or `Del`) arms the highlighted row's withdrawal; `Enter` withdraws exactly
 * that row, by its identity, only through the host's guard (800 ms after the line's frame was seen, not after 10 s); the lists are read again
 * and the result is announced on the HOST's channel; `Esc` keeps the row, `Ctrl+C` closes; a failed write and a port that throws say so with
 * no path; nothing ever reaches anywhere but the popup and the host's channel.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  PermissionEntry,
  PermissionsPort,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../permissions/chat-permissions.js';
import { CliError } from '../process/errors.js';
import { PERMISSIONS_STEP, WITHDRAW_CONTROL } from './permissions-popup.js';
import { currentStep, visibleRows } from './popup-reducer.js';
import { DOWN, ENTER, ESC, settingsRig } from './settings.test-support.js';

const FULL: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [
      { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' },
      { id: 'b', label: 'pnpm, 2 arguments', remembered: '2026-11-21 16:40Z' },
    ],
  },
  session: [{ argv: ['git', 'status'], text: 'git status', alsoRemembered: false }],
};

/** A port over `initial` whose withdrawal removes the row it names (or answers `answer`), every call recorded. */
function fakePort(
  initial: PermissionsSnapshot = FULL,
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
    if (entry.kind === 'session')
      current = {
        ...current,
        session: (current.session ?? []).filter((row) => row.text !== entry.row.text),
      };
    return { tone: 'done', text: 'Withdrawn. Auto mode asks about it again.' };
  });
  const load = vi.fn(() => current);
  const port: PermissionsPort = { surface: 'chat', load, withdraw };
  return { port, withdraw, load };
}

/** The popup opened and settled over `port`, in `ask` mode. */
function opened(port: PermissionsPort, mode: () => 'ask' | 'auto' | 'plan' = () => 'ask') {
  const r = settingsRig();
  const result = r.open({ permissions: { port, mode } }, 'permissions');
  expect(result.opened).toBe(true);
  r.settle();
  const step = (): number | undefined => r.host.getSnapshot().frame?.stepIndex;
  const content = () => {
    const frame = r.host.getSnapshot().frame;
    return frame === undefined ? undefined : currentStep(frame).state.content;
  };
  const highlighted = (): string | undefined => {
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) return undefined;
    const { state } = currentStep(frame);
    return visibleRows(state)[state.selected]?.id;
  };
  /** `[d]` and the line's frame acknowledged, as the slot acknowledges it. */
  const arm = (key: 'd' | 'Del' = 'd'): void => {
    if (key === 'd') r.press('d');
    else r.press('', { delete: true });
    r.host.shown(r.host.getSnapshot());
  };
  const notice = (): string | undefined => r.notifications.getSnapshot().current?.text;
  return { ...r, step, content, highlighted, arm, notice };
}

describe('opening', () => {
  it('a `[d]` in the popup’s first half second is dropped without a word (nothing armed, nothing said); the next `[d]` after it arms', () => {
    const { port } = fakePort();
    const r = settingsRig();
    expect(r.open({ permissions: { port, mode: () => 'ask' } }, 'permissions').opened).toBe(true);
    r.host.shown(r.host.getSnapshot());
    r.clock.advance(100);
    r.press('d');
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(PERMISSIONS_STEP.list);
    expect(r.notifications.getSnapshot().current).toBeUndefined();
    expect(r.announced).toEqual([]);
    r.clock.advance(400); // the opening guard's settle has passed
    r.press('d');
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(PERMISSIONS_STEP.withdraw);
  });

  it('opens on the lists read now, the first remembered command highlighted, `[d]` offered', () => {
    const { port, load } = fakePort();
    const p = opened(port);
    expect(load).toHaveBeenCalledTimes(1);
    expect(p.host.getSnapshot().frame?.spec.id).toBe('permissions');
    expect(p.content()?.kind).toBe('list');
    expect(p.highlighted()).toBe('entry:0');
    const frame = p.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('open');
    expect(currentStep(frame).spec.controls).toEqual([WITHDRAW_CONTROL]);
  });

  it('a port that throws on the read (a defect) shows that it could not read, with nothing to arm; Esc closes', () => {
    const { port } = fakePort();
    const p = opened({
      ...port,
      load: () => {
        throw new Error('/home/someone/.relavium/grants: EACCES');
      },
    });
    expect(p.content()).toMatchObject({ kind: 'error', what: 'Could not read the permissions.' });
    expect(JSON.stringify(p.content())).not.toContain('/home/someone');
    p.press('d');
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    p.press('', ESC);
    expect(p.host.getSnapshot().open).toBe(false);
  });

  it('nothing to withdraw: the empty state, no `[d]` (a `d` arms nothing)', () => {
    const { port, withdraw } = fakePort({ project: { ok: true, rows: [] }, session: [] });
    const p = opened(port);
    expect(p.content()?.kind).toBe('empty');
    p.press('d');
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(withdraw).not.toHaveBeenCalled();
  });
});

describe('a withdrawal: [d], then Enter through the host’s guard', () => {
  it('`[d]` arms the highlighted row’s line, which names it; Enter 800 ms after the line was seen withdraws exactly it, by identity', () => {
    const { port, withdraw, load } = fakePort();
    const p = opened(port);
    p.arm();
    expect(p.step()).toBe(PERMISSIONS_STEP.withdraw);
    const line = p.content();
    expect(line?.kind === 'report' ? line.lines[1] : '').toBe(
      '  npm, 1 argument (remembered 2026-11-20 09:12Z)',
    );
    expect(withdraw, 'arming withdraws nothing').not.toHaveBeenCalled();
    p.clock.advance(800);
    p.press('', ENTER);
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw.mock.calls[0]?.[0]).toEqual({
      kind: 'project',
      row: FULL.project.ok ? FULL.project.rows[0] : undefined,
    });
    // The lists read again: the row is gone, the popup is back on them, and the result is the host's announcement.
    expect(load).toHaveBeenCalledTimes(2);
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    const labels = p.content()?.kind === 'list' ? JSON.stringify(p.content()) : '';
    expect(labels).toContain('This project · remembered (1)');
    expect(labels).not.toContain('npm, 1 argument');
    expect(p.announced).toEqual(['Withdrawn: npm, 1 argument']);
    expect(p.notice()).toBe('Withdrawn: npm, 1 argument');
    expect(p.host.getSnapshot().open, 'the popup stays open on the refreshed lists').toBe(true);
  });

  it('the Delete key arms it too; ↓ to the session approval withdraws that one by its exact argv', () => {
    const { port, withdraw } = fakePort();
    const p = opened(port);
    p.press('', DOWN);
    p.press('', DOWN);
    expect(p.highlighted()).toBe('entry:2');
    p.arm('Del');
    expect(p.step()).toBe(PERMISSIONS_STEP.withdraw);
    p.clock.advance(900);
    p.press('', ENTER);
    expect(withdraw.mock.calls[0]?.[0]).toEqual({ kind: 'session', row: FULL.session?.[0] });
    expect(p.announced).toEqual(['Withdrawn: git status']);
  });

  it('an Enter 799 ms after the line was seen withdraws nothing: the line is gone and the popup says why', () => {
    const { port, withdraw } = fakePort();
    const p = opened(port);
    p.arm();
    p.clock.advance(799);
    p.press('', ENTER);
    expect(withdraw).not.toHaveBeenCalled();
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.notice()).toBe('Nothing withdrawn: too soon, wait 2 s. [d] asks again.');
    expect(p.announced).toEqual([]);
  });

  it('after ten seconds the host takes the line away and the popup says time ran out; an Enter then withdraws nothing', () => {
    const { port, withdraw } = fakePort();
    const p = opened(port);
    p.arm();
    p.clock.advance(10_001);
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.notice()).toBe('Nothing withdrawn: time ran out. [d] asks again.');
    p.press('', ENTER);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('Esc keeps the row (back to the lists), and Esc again closes; Ctrl+C on the line steps back too, and on the lists closes', () => {
    const { port, withdraw } = fakePort();
    const p = opened(port);
    p.arm();
    p.clock.advance(900);
    p.press('', ESC);
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.host.getSnapshot().open).toBe(true);
    p.clock.advance(2100);
    p.arm();
    p.clock.advance(900);
    p.press('c', { ctrl: true });
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    p.press('c', { ctrl: true });
    expect(p.host.getSnapshot().open).toBe(false);
    expect(withdraw).not.toHaveBeenCalled();
    expect(p.announced).toEqual([]);
  });

  it('a letter typed over the line withdraws nothing; `[d]` then arms nothing until an arrow key, and says so', () => {
    const { port, withdraw } = fakePort();
    const p = opened(port);
    p.arm();
    p.clock.advance(900);
    p.press('x');
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.notice()).toBe('Nothing withdrawn: a key was typed. ↑/↓, then [d].');
    p.press('d');
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    p.press('', DOWN);
    p.press('', { upArrow: true });
    p.arm();
    expect(p.step()).toBe(PERMISSIONS_STEP.withdraw);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('SECURITY: a line typed ahead (`run the build`, Enter, Delete, Enter) at any pace withdraws nothing', () => {
    for (const pace of [0, 110, 400]) {
      const { port, withdraw } = fakePort();
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
});

describe('what a withdrawal says', () => {
  const answerOf = (answer: WithdrawAnswer) => fakePort(FULL, () => answer);
  const withdrawFirst = (port: PermissionsPort) => {
    const p = opened(port);
    p.arm();
    p.clock.advance(900);
    p.press('', ENTER);
    return p;
  };

  it('a note (the row was already gone; a session approval of it remains) is above the lists, and announced as withdrawn with a note', () => {
    const p = withdrawFirst(
      answerOf({
        tone: 'note',
        text: 'Withdrawn, but a session approval of it remains: it is still approved here.',
      }).port,
    );
    expect(JSON.stringify(p.content())).toContain(
      'Note: Withdrawn, but a session approval of it remains: it is',
    );
    expect(JSON.stringify(p.content())).toContain('still approved here.');
    expect(p.announced).toEqual(['Withdrawn, with a note: npm, 1 argument']);
  });

  it('a failed write of the grants file: the lists say why (a fixed sentence, no path), the host says it was not withdrawn', () => {
    const p = withdrawFirst(
      answerOf({ tone: 'failed', text: 'Could not write the withdrawal; nothing changed.' }).port,
    );
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(JSON.stringify(p.content())).toContain(
      'Not withdrawn: Could not write the withdrawal; nothing changed.',
    );
    expect(p.announced).toEqual(['Not withdrawn: npm, 1 argument']);
  });

  it('a port that throws says its CODE only on the host’s channel (never its message, which can carry a path)', () => {
    for (const [cause, code] of [
      [new Error('EACCES: /home/someone/.relavium/grants.json'), 'unexpected error'],
      [
        new CliError('storage_unavailable', 'the store at /home/someone is gone'),
        'storage_unavailable',
      ],
    ] as const) {
      const { port } = fakePort();
      const p = withdrawFirst({
        ...port,
        withdraw: () => {
          throw cause;
        },
      });
      expect(p.announced).toEqual([`Not withdrawn: ${code}`]);
      expect(JSON.stringify(p.content())).toContain(
        'Could not withdraw that row; nothing changed.',
      );
      expect(JSON.stringify(p.content())).not.toContain('/home/someone');
      expect(p.host.getSnapshot().open).toBe(true);
    }
  });

  it('lists that cannot be read again after a withdrawal are never shown stale: the step says so and offers nothing to arm', () => {
    const { port, withdraw } = fakePort();
    let reads = 0;
    const p = withdrawFirst({
      ...port,
      load: () => {
        reads += 1;
        if (reads > 1) throw new Error('gone');
        return FULL;
      },
    });
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(p.content()).toMatchObject({
      kind: 'error',
      what: 'Could not read the permissions again.',
    });
    p.press('d');
    expect(p.step()).toBe(PERMISSIONS_STEP.list);
    expect(p.announced).toEqual(['Withdrawn: npm, 1 argument']);
  });

  it('the last row withdrawn leaves the empty state; the note reads the mode at each read', () => {
    let mode: 'ask' | 'auto' = 'ask';
    const { port } = fakePort({
      project: { ok: true, rows: [{ id: 'a', label: 'npm, 1 argument', remembered: 'x' }] },
      session: [],
    });
    const p = opened(port, () => mode);
    expect(JSON.stringify(p.content())).toContain('ask mode · ');
    mode = 'auto';
    p.arm();
    p.clock.advance(900);
    p.press('', ENTER);
    expect(p.content()?.kind).toBe('empty');
  });
});
