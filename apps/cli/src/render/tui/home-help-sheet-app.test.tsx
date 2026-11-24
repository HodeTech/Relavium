import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOME_PALETTE_COMMANDS } from '../../commands/repl-commands.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { HELP_SHEET_ROWS, HOME_KEYS } from './help-sheet.js';
import { bracketed, settleFrames } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';

/**
 * The landing's `/help` sheet as the terminal shows it ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, ADR-0122 §7): through a mounted `RootApp` with real stdin bytes, in the inline and the full-screen renderer, at 80×24 and below it.
 * `help-sheet.test.ts` owns the model and `home-help-sheet.test.ts` the controller; this file owns that the view is wired to the slot, that the
 * sheet takes the body of the landing, and that the bytes of Esc and Ctrl+C reach it.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

/** The Home with the sheet typed for, mounted in the inline renderer or (`alternateScreen`) the full-screen one. */
function mountHelp(
  options: { alternateScreen?: boolean; size?: { cols: number; rows: number } } = {},
) {
  const size = options.size ?? { cols: 80, rows: 24 };
  const onExit = vi.fn();
  const startChat = vi.fn(() => new Promise<never>(() => {}));
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat,
    homeStore: { read: () => EMPTY },
    schedule: () => () => {},
    onExit,
    onError: (cause) => {
      throw cause;
    },
  });
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      getSize={() => size}
      subscribeResize={() => () => {}}
      {...(options.alternateScreen === true ? { alternateScreen: true } : {})}
    />,
  );
  return {
    controller,
    harness,
    onExit,
    startChat,
    frame: (): string => plain(harness.lastFrame() ?? ''),
  };
}

/** Poll until `predicate` holds and FAIL if it never does (a bare wait that gives up quietly would assert nothing). */
const until = (predicate: () => boolean, timeout = 3000): Promise<void> =>
  vi.waitFor(
    () => {
      if (!predicate())
        throw new Error(`the condition did not become true: ${predicate.toString()}`);
    },
    { timeout, interval: 15 },
  );

/** What a person types to reach the sheet: a pasted line, so that its `/` is not the palette's opener, and Enter. */
async function typeHelp(m: ReturnType<typeof mountHelp>): Promise<void> {
  m.harness.stdin.write(bracketed('/help'));
  await until(() => m.controller.getSnapshot().input.text === '/help');
  m.harness.stdin.write('\r');
  await until(() => m.controller.getSnapshot().screen?.kind === 'help');
}

describe.each([
  ['the inline renderer', false],
  ['the full-screen renderer', true],
] as const)('the /help sheet in %s', (_name, alternateScreen) => {
  it('opens from a typed /help, takes the body of the landing at 80×24 in at most 23 rows, and names the commands and the keys', async () => {
    const m = mountHelp({ alternateScreen });
    await until(() => m.frame().includes('[/] commands'));
    await typeHelp(m);
    await until(() => m.frame().includes('Keys of the Home'));
    const frame = m.frame();
    expect(frame.split('\n').length).toBeLessThanOrEqual(HELP_SHEET_ROWS);
    expect(frame, 'no prompt behind the screen').not.toContain('[/] commands');
    expect(frame).toContain('Commands');
    // Every command is named as a whole word (it has its own row with a description, or is one of the names the last rows hold).
    for (const command of HOME_PALETTE_COMMANDS)
      expect(frame, `/${command.name}`).toMatch(new RegExp(`/${command.name}(?=\\s|$)`, 'mu'));
    for (const key of Object.values(HOME_KEYS)) expect(frame, key.keys).toContain(key.keys);
    expect(frame.split('\n').at(-1)).toBe('Esc / [Ctrl+C] close');
    expect(m.startChat).not.toHaveBeenCalled();
  });

  it('closes with the bytes of Esc, and the landing is back with its prompt', async () => {
    const m = mountHelp({ alternateScreen });
    await typeHelp(m);
    m.harness.stdin.write(ESC);
    await until(() => m.controller.getSnapshot().screen === undefined);
    await until(() => m.frame().includes('[/] commands'));
    expect(m.frame()).not.toContain('Keys of the Home');
  });

  it('closes with the bytes of Ctrl+C, and that arms nothing and exits nothing', async () => {
    const m = mountHelp({ alternateScreen });
    await typeHelp(m);
    m.harness.stdin.write('\u0003');
    await until(() => m.controller.getSnapshot().screen === undefined);
    await until(() => m.frame().includes('[/] commands'));
    expect(m.controller.getSnapshot().interruptArmed).toBe(false);
    expect(m.onExit).not.toHaveBeenCalled();
  });

  it('takes no other key and drops a paste: nothing reaches the prompt behind it', async () => {
    const m = mountHelp({ alternateScreen });
    await typeHelp(m);
    const before = m.frame();
    m.harness.stdin.write('x');
    m.harness.stdin.write(bracketed('hello world'));
    await settleFrames();
    expect(m.controller.getSnapshot().input.text).toBe('');
    expect(m.frame()).toBe(before);
    expect(m.controller.getSnapshot().screen?.kind).toBe('help');
  });

  it('below 80×24 draws the two-line hint and still closes with Esc', async () => {
    const m = mountHelp({ alternateScreen, size: { cols: 70, rows: 20 } });
    expect(m.controller.openScreen('help')).toBe(true);
    await until(() => m.frame().includes('Enlarge the terminal'));
    expect(m.frame().split('\n')).toEqual(['Enlarge the terminal.', 'Esc / [Ctrl+C] close']);
    m.harness.stdin.write(ESC);
    await until(() => m.controller.getSnapshot().screen === undefined);
  });
});
