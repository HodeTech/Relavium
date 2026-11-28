/**
 * The one source of what each chat mode does ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §6): its words follow the policy (ADR-0118/0130/0138), the notification after a change fits the room a notification has, the two modes
 * that approve without a card are the ones announced, and both `auto` confirmations state the `auto` sentence from here rather than a
 * second, drifting copy.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHAT_MODES, type ChatMode } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadResolvedConfig } from '../config/load.js';
import { POPUP_NOTICE_MAX_COLUMNS } from '../popups/geometry.js';
import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { displayWidth } from '../render/tui/viewport.js';
import { MODE_DESCRIPTION } from './chat-mode.js';
import {
  announcesEffect,
  MODE_AUTHORITY_RANK,
  MODE_EFFECT,
  MODE_NOT_RECORDED_NOTICE,
  modeAuthorityRank,
  modeChangedNotice,
  widensAuthority,
} from './mode-effects.js';
import { runModeSettings } from './mode-settings.js';
import { createStartingModeRuntime } from './starting-mode.js';

describe('the effects', () => {
  it('say what the policy does: accept-edits edits files but still asks for commands and network and refuses protected paths; auto still asks for a command nobody remembered or approved', () => {
    expect(MODE_EFFECT['accept-edits'].full).toBe(
      'Files are edited without asking; commands and network still ask, and protected paths stay refused.',
    );
    expect(MODE_EFFECT.auto.full).toBe(
      'File edits, network calls and other granted actions are approved without asking; a command still asks unless you remembered or approved it, and scope and protected-path rules still apply.',
    );
    // The same truth the bare `/mode` list states (MODE_DESCRIPTION), in its two load-bearing clauses.
    expect(MODE_DESCRIPTION.auto).toContain(
      'a command still asks unless you remembered or approved it',
    );
    expect(MODE_EFFECT.auto.full).toContain(
      'a command still asks unless you remembered or approved it',
    );
    expect(MODE_DESCRIPTION['accept-edits']).toContain('still asks for commands and network');
    expect(MODE_EFFECT['accept-edits'].full).toContain('commands and network still ask');
  });

  it('every mode has both forms, and every notification it makes fits beside a popup’s way back', () => {
    for (const mode of CHAT_MODES) {
      expect(MODE_EFFECT[mode].full.length).toBeGreaterThan(0);
      expect(MODE_EFFECT[mode].short.length).toBeGreaterThan(0);
      expect(displayWidth(modeChangedNotice(mode)), mode).toBeLessThanOrEqual(
        POPUP_NOTICE_MAX_COLUMNS,
      );
    }
    expect(displayWidth(MODE_NOT_RECORDED_NOTICE)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
    expect(modeChangedNotice('auto')).toBe('auto mode · commands ask; granted actions run unasked');
    expect(modeChangedNotice('accept-edits')).toBe(
      'accept-edits mode · files are edited without asking',
    );
  });

  it('announces a change into exactly the two modes that approve without a card', () => {
    expect(CHAT_MODES.filter((mode) => announcesEffect(mode))).toEqual(['accept-edits', 'auto']);
  });
});

describe('the authority order (the amended D-4)', () => {
  it('is plan < ask < accept-edits < auto, a strict order over every mode (not the Shift+Tab cycle)', () => {
    expect([...CHAT_MODES].sort((a, b) => modeAuthorityRank(a) - modeAuthorityRank(b))).toEqual([
      'plan',
      'ask',
      'accept-edits',
      'auto',
    ]);
    expect(new Set(Object.values(MODE_AUTHORITY_RANK)).size).toBe(CHAT_MODES.length);
  });

  it('a change widens exactly when the new mode ranks higher; no change and every narrowing do not', () => {
    const widening = CHAT_MODES.flatMap((from) =>
      CHAT_MODES.filter((to) => widensAuthority(from, to)).map((to) => `${from}→${to}`),
    );
    expect(widening.sort()).toEqual(
      [
        'plan→ask',
        'plan→accept-edits',
        'plan→auto',
        'ask→accept-edits',
        'ask→auto',
        'accept-edits→auto',
      ].sort(),
    );
    for (const mode of CHAT_MODES) expect(widensAuthority(mode, mode)).toBe(false);
  });
});

describe('the auto confirmations state the auto sentence from the one source', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** The mode settings flow over a real starting-mode runtime, answering `auto` and then declining the confirmation (nothing is written). */
  async function confirmationOf(live: boolean): Promise<string | undefined> {
    const root = mkdtempSync(join(tmpdir(), 'relavium-mode-effects-'));
    roots.push(root);
    const home = join(root, 'home');
    const cwd = join(root, 'workspace');
    mkdirSync(join(home, '.relavium'), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, '.relavium', 'config.toml'), '[preferences]\ndefault_mode = "ask"\n');
    const answers: (string | symbol)[] = ['auto'];
    const confirm = vi.fn<NativePromptFlow['confirm']>(() => Promise.resolve(false));
    const flow = {
      begin: vi.fn(() => new AbortController().signal),
      end: vi.fn(() => Promise.resolve()),
      cancel: () => undefined,
      note: vi.fn(),
      busy: vi.fn(),
      select: vi.fn<NativePromptFlow['select']>(() =>
        Promise.resolve(answers.shift() ?? NATIVE_PROMPT_CANCEL),
      ),
      confirm,
      pick: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
      text: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
      password: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    } satisfies NativePromptFlow;
    const onCurrentMode = vi.fn<(mode: ChatMode) => void>();
    await runModeSettings({
      runtime: createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true),
      cwd,
      interactive: true,
      flow,
      ...(live ? { currentMode: (): ChatMode => 'ask', onCurrentMode } : {}),
      notice: vi.fn(),
      assertAdmitting: () => undefined,
      publish: vi.fn(() => ({ durability: 'confirmed' as const })),
    });
    expect(onCurrentMode).not.toHaveBeenCalled(); // declined: nothing changed
    return confirm.mock.calls[0]?.[0];
  }

  it.each([
    ['the session’s auto', true, `${MODE_EFFECT.auto.full} Use auto for this session?`],
    [
      'the startup default auto',
      false,
      `${MODE_EFFECT.auto.full} Save auto as the global startup default?`,
    ],
  ] as const)('%s', async (_name, live, expected) => {
    expect(await confirmationOf(live)).toBe(expected);
  });
});
