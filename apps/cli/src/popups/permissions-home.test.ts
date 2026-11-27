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
import type { RepoAllowlist } from '../permissions/chat-permissions.js';
import { displayWidth } from '../render/tui/viewport.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import type { PopupContent } from './frame-model.js';
import { legend } from '../render/tui/legend.js';
import { PERMISSIONS_STEP, WITHDRAW_CONTROL, homePermissionsContent } from './permissions-popup.js';
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
});

describe('R1-M proposed: what is stored cannot forge the page', () => {
  /** Every string the list step draws, raw (never JSON-escaped: an escape character must be seen as the character it is). */
  const drawn = (p: ReturnType<typeof opened>): string => {
    const content = p.content();
    if (content?.kind !== 'list') throw new Error('a list');
    return content.rows.map((row) => `${row.label}\n${row.detail ?? ''}`).join('\n');
  };
  const ESCAPE = String.fromCharCode(27);
  const BIDI = String.fromCharCode(0x202e);

  it('a remembered command and a repository allowlist entry carrying an escape, a bidi override, a fake marker or a fake key are drawn as text', () => {
    const hostile: PermissionsSnapshot = {
      project: {
        ok: true,
        rows: [
          {
            id: 'h',
            label: `${ESCAPE}[31mred ▼ 9 more [Enter] x`,
            remembered: '2026-11-20 09:12Z',
          },
        ],
      },
      session: undefined,
      allowlist: {
        ok: true,
        commands: [`${ESCAPE}[31mgit ${BIDI}status ▼ 9 more [Enter]`],
        globs: [`a${BIDI}b${ESCAPE}]0;title`],
        omitted: 0,
      },
    };
    const p = opened(fakeProjectPort(hostile).port);
    const text = drawn(p);
    expect(text).toContain('This repository · allowlist, read-only');
    expect(text.includes(ESCAPE), 'no escape character reaches the terminal').toBe(false);
    expect(text.includes(BIDI), 'no bidi override').toBe(false);
  });
});

describe('R1-M proposed: the repository’s allowlist is bounded', () => {
  it('draws at most four entry rows, the last of them the count of the rest, and counts what the snapshot left out too', () => {
    const many: PermissionsSnapshot = {
      ...ROWS,
      allowlist: {
        ok: true,
        commands: ['c1', 'c2', 'c3', 'c4', 'c5'],
        globs: ['g1', 'g2'],
        omitted: 3,
      },
    };
    const p = opened(fakeProjectPort(many).port);
    const content = p.content();
    if (content?.kind !== 'list') throw new Error('a list');
    const entries = content.rows.filter((row) => row.id.startsWith('allowlist-entry:'));
    expect(entries).toHaveLength(3);
    const more = content.rows.find((row) => row.id === 'allowlist-more');
    expect(more?.label).toBe('… 7 more in the config');
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

describe('the withdrawal line says `(wait)` while its dwell holds (review round 1, O-7)', () => {
  /** The legend the slot would draw for the frame on screen, judged with the host's lock now. */
  const legendNow = (p: ReturnType<typeof opened>): string => {
    const frame = p.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('open');
    const { items, exit } = popupLegend(frame, 17, 66, p.host.lock.read());
    return legend(items, exit);
  };

  it('`(wait)` marks the answer from the frame’s acknowledgement for 800 ms, and the mark goes when the answer counts', () => {
    const { port, withdraw } = fakeProjectPort();
    const p = opened(port);
    p.arm();
    expect(p.host.lock.read(), 'locked from the acknowledged frame').toBe(true);
    expect(legendNow(p)).toContain('Enter withdraw (wait)');
    p.clock.advance(799);
    expect(p.host.lock.read()).toBe(true);
    p.clock.advance(2);
    expect(p.host.lock.read(), 'the dwell has passed').toBe(false);
    expect(legendNow(p)).not.toContain('(wait)');
    expect(legendNow(p)).toContain('Enter withdraw');
    p.press('', ENTER);
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it('a press inside the mark withdraws nothing, and the popup says it was too soon: what the legend said', () => {
    const { port, withdraw } = fakeProjectPort();
    const p = opened(port);
    p.arm();
    p.clock.advance(400);
    expect(legendNow(p)).toContain('(wait)');
    p.press('', ENTER);
    expect(withdraw).not.toHaveBeenCalled();
    expect(p.notice()).toBe('Nothing withdrawn: too soon. [d] asks again.');
  });

  it('the list step is never marked: only the line that is answered by `Enter` holds its answer', () => {
    const { port } = fakeProjectPort();
    const p = opened(port);
    expect(p.host.lock.read()).toBe(false);
    expect(legendNow(p)).not.toContain('(wait)');
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

/** Every string a step draws, raw: `JSON.stringify` would show an escape character as the text `\u001b`, which no assertion on the character could see. */
const rawText = (content: PopupContent | undefined): string => {
  if (content === undefined) return '';
  if (content.kind === 'list')
    return content.rows
      .map((row) => `${row.label}\n${row.detail ?? ''}\n${row.effect ?? ''}`)
      .join('\n');
  return content.kind === 'report' ? content.lines.join('\n') : '';
};

describe('what is stored is drawn as the Home draws every stored word (review round 1, P-5/X-3/M-4)', () => {
  const ESC = String.fromCharCode(27);
  const hostileProject = (
    over: Partial<{ label: string; remembered: string }>,
  ): PermissionsSnapshot => ({
    project: {
      ok: true,
      rows: [{ id: 'h', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z', ...over }],
    },
    session: undefined,
  });

  it('a remembered command named like an escape, a marker or a key is plain text in the list and on the withdrawal line, and in the announcement', () => {
    const label = `${ESC}[31mred ▼ 9 more ▲ 3 more [Enter] x`;
    const p = opened(fakeProjectPort(hostileProject({ label })).port);
    const listed = rawText(p.content());
    expect(listed.includes(ESC), 'no escape character in the list').toBe(false);
    expect(listed).not.toMatch(/[▲▼]/u);
    expect(listed).not.toContain('[Enter]');
    p.arm();
    const line = rawText(p.content());
    expect(line.includes(ESC), 'no escape character on the line').toBe(false);
    expect(line).not.toMatch(/[▲▼]/u);
    expect(line).not.toContain('[Enter]');
    p.clock.advance(900);
    p.press('', ENTER);
    expect(p.announced.join('\n')).not.toMatch(/[▲▼]/u);
    expect(p.announced.join('\n')).not.toContain('[Enter]');
  });

  it('a date the store wrote is a stored word too: it cannot forge a marker in the row’s detail, or on the line', () => {
    const p = opened(fakeProjectPort(hostileProject({ remembered: '▼ 9 more [Enter]' })).port);
    const content = p.content();
    if (content?.kind !== 'list') throw new Error('a list');
    const row = content.rows.find((entry) => entry.id === 'entry:0');
    expect(row?.detail).not.toMatch(/[▲▼]/u);
    expect(row?.detail).not.toContain('[Enter]');
    p.arm();
    expect(rawText(p.content())).not.toMatch(/[▲▼]/u);
    expect(rawText(p.content())).not.toContain('[Enter]');
  });

  it('an allowlist entry that forges a marker or a key hint is plain text', () => {
    const snapshot: PermissionsSnapshot = {
      ...ROWS,
      allowlist: {
        ok: true,
        commands: ['▼ 9 more', '[Enter] details'],
        globs: ['▲ 3 more *'],
        omitted: 0,
      },
    };
    const text = rawText(opened(fakeProjectPort(snapshot).port).content());
    const entries = text.split('\n').filter((line) => /^(command|pattern) /u.test(line));
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).not.toMatch(/[▲▼]/u);
      expect(entry).not.toContain('[Enter]');
    }
  });
});

describe('the repository’s allowlist, read-only under the list (the tab’s tests, ported)', () => {
  /** The allowlist section as drawn lines: the Home's content of a snapshot whose project list is `count` remembered commands. */
  const sectionOf = (allowlist: RepoAllowlist | undefined, count = 1): string[] => {
    const rows = Array.from({ length: count }, (_, at) => ({
      id: `g${String(at)}`,
      label: `tool${String(at)}, 1 argument`,
      remembered: '2026-11-20 09:12Z',
    }));
    const snapshot: PermissionsSnapshot = {
      project: { ok: true, rows },
      session: undefined,
      ...(allowlist === undefined ? {} : { allowlist }),
    };
    return rawText(homePermissionsContent(snapshot)).split('\n');
  };

  it('is absent where the surface lists none (a snapshot without it draws nothing of it)', () => {
    expect(sectionOf(undefined).join('\n')).not.toContain('allowlist');
  });

  it('lists the entries and the patterns, each under its own word, with the counts, and says what the list is worth', () => {
    const lines = sectionOf({
      ok: true,
      commands: ['git status', 'npm test'],
      globs: ['git *'],
      omitted: 0,
    });
    expect(lines).toContain('This repository · allowlist, read-only (2 commands, 1 pattern)');
    expect(lines).toContain('A listed command still asks in a chat; its card only says so.');
    expect(lines).toContain('command git status');
    expect(lines).toContain('command npm test');
    expect(lines).toContain('pattern git *');
    expect(lines.some((line) => line.includes('more in the config'))).toBe(false);
  });

  it('masks an entry that is shaped like a key, command and pattern alike: the repository’s file can hold a pasted token', () => {
    const secret = `sk-ant-api03-${'K'.repeat(40)}`;
    const text = sectionOf({
      ok: true,
      commands: [`deploy --token ${secret}`],
      globs: [`curl -H "x-api-key: ${secret}" *`],
      omitted: 0,
    }).join('\n');
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain('KKKKKKKK');
    expect(text).toContain('command deploy --token ');
    // The Home's row scrub folds a bracketed word to parentheses (a `[Enter]` is no key hint here), and the mask is bracketed too.
    expect(text).toContain('(REDACTED)');
  });

  it('says nothing is listed for an empty allowlist, and says so for one that could not be read', () => {
    const empty = sectionOf({ ok: true, commands: [], globs: [], omitted: 0 });
    expect(empty).toContain('This repository · allowlist, read-only (0 commands, 0 patterns)');
    expect(empty).toContain('Nothing is listed in the repository’s [chat] config.');
    const unreadable = sectionOf({
      ok: false,
      text: 'The repository’s [chat] allowlist could not be read.',
    });
    expect(unreadable).toContain('This repository · allowlist, read-only');
    expect(unreadable).toContain('The repository’s [chat] allowlist could not be read.');
  });

  it('draws at most four entry rows, the last of them the count of the rest, and counts what the snapshot left out too', () => {
    const lines = sectionOf({
      ok: true,
      commands: ['a', 'b', 'c', 'd', 'e'],
      globs: ['g1'],
      omitted: 7,
    });
    expect(lines.filter((line) => /^(command|pattern) /u.test(line))).toEqual([
      'command a',
      'command b',
      'command c',
    ]);
    expect(lines).toContain('… 10 more in the config');
  });

  it('shows a control or an override character as a visible token, never as the character: the entries are the repository’s words', () => {
    const joined = sectionOf({
      ok: true,
      commands: [`git${String.fromCharCode(0x202e)}push`, `rm${String.fromCharCode(9)}x`],
      globs: [],
      omitted: 0,
    }).join('\n');
    expect(joined).not.toContain(String.fromCharCode(0x202e));
    expect(joined).not.toContain(String.fromCharCode(9));
    expect(joined).toContain('<U+202E>');
    expect(joined).toContain('<TAB>');
  });

  it('clips a long entry to the popup’s width instead of wrapping it', () => {
    const snapshot: PermissionsSnapshot = {
      ...ROWS,
      allowlist: { ok: true, commands: ['x'.repeat(500)], globs: [], omitted: 0 },
    };
    const frame = onTheHome(snapshot);
    const drawn = popupBoxOf(frame, {
      renderer: 'alt',
      color: false,
      size: { cols: 80, rows: 24 },
    });
    const entry = drawn.rows.find((row) => row.trim().startsWith('command x'));
    expect(entry).toBeDefined();
    expect(entry?.trim().endsWith('…') || entry?.trim().endsWith('...')).toBe(true);
    for (const row of drawn.rows) expect(displayWidth(row)).toBeLessThanOrEqual(drawn.width);
  });
});

/** The popup frame the Home opens over `snapshot` (its first step landed), for what is drawn rather than what is modelled. */
function onTheHome(snapshot: PermissionsSnapshot) {
  const p = opened(fakeProjectPort(snapshot).port);
  const frame = p.host.getSnapshot().frame;
  if (frame === undefined) throw new Error('the popup is open');
  return frame;
}
