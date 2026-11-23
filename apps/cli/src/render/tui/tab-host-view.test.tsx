import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type {
  PermissionsPort,
  PermissionsSnapshot,
  RepoAllowlist,
} from '../../permissions/chat-permissions.js';
import { bracketed, settleFrames } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { initialPermissionsSheetState, type SheetMessage } from './permissions-sheet.js';
import { enterTab, freshTabMemory, type TabHostState, type TabId } from './tab-host.js';
import { TabHostView } from './tab-host-view.js';

/**
 * The tab host as the terminal shows it ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, ADR-0122 §7): at 80×24 inside 23 rows, below the minimum with a stated hint, with colour on and with it off, in the inline and the
 * full-screen renderer through a mounted `RootApp` with real stdin bytes, and that a paste is dropped. `tab-host.test.ts` owns the model;
 * this file owns what is drawn from it and the wiring above it. The port and the clock are scripted: no operator home is read.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
/** Any foreground colour code (the regular and the bright palette). */
const ANY_COLOUR = new RegExp(`${ESC}\\[(3[0-7]|9[0-7])m`, 'u');
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');
const lineWith = (text: string, needle: string): string =>
  text.split('\n').find((line) => line.includes(needle)) ?? '';

const SNAPSHOT: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [
      { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' },
      { id: 'b', label: 'node, 1 argument', remembered: '2026-11-18 09:30Z' },
    ],
  },
  session: undefined,
};
const ALLOWLIST: RepoAllowlist = {
  ok: true,
  commands: ['git status', 'npm test'],
  globs: ['git *'],
  omitted: 0,
};
const portOf = (snapshot: PermissionsSnapshot): PermissionsPort => ({
  surface: 'project',
  load: () => snapshot,
  withdraw: () => ({ tone: 'done', text: 'Withdrawn.' }),
});

const hostOn = (tab: TabId, snapshot: PermissionsSnapshot = SNAPSHOT): TabHostState =>
  enterTab(freshTabMemory(tab), tab, { port: portOf(snapshot), now: 0 });
/** The Permissions tab with its sheet changed by `change`. */
const permissions = (
  change: (sheet: ReturnType<typeof initialPermissionsSheetState>) => object,
  snapshot: PermissionsSnapshot = SNAPSHOT,
): TabHostState => {
  const host = hostOn('permissions', snapshot);
  if (host.sheet === undefined) throw new Error('the Permissions tab holds no sheet');
  return { ...host, sheet: { ...host.sheet, ...change(host.sheet) } };
};

/** The frame with its style codes, as a terminal that has them draws it. */
const frame = (state: TabHostState, color: boolean, columns = 80, rows = 24): string =>
  render(<TabHostView state={state} color={color} columns={columns} rows={rows} />).lastFrame() ??
  '';
/** The frame without them: what a person without styling reads. */
const text = (state: TabHostState, columns = 80, rows = 24): string =>
  plain(frame(state, false, columns, rows));

describe('TabHostView at 80×24', () => {
  it.each(['defined', 'active', 'history', 'permissions'] as const)(
    '%s: draws within 23 rows, the strip first and the legend last, and never wider than the margin allows',
    (tab) => {
      const lines = text(hostOn(tab)).split('\n');
      expect(lines.length).toBeLessThanOrEqual(23);
      expect(lines[0]).toContain('▸ ');
      expect(lines[1]?.startsWith('───')).toBe(true);
      expect(lines.at(-1)).toContain('Esc close');
      for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(78);
    },
  );

  it('fits 23 rows with a long list and a long allowlist, the cursor kept in view', () => {
    const many: PermissionsSnapshot = {
      project: {
        ok: true,
        rows: Array.from({ length: 40 }, (_, i) => ({
          id: `g${String(i)}`,
          label: `tool${String(i)}, 1 argument`,
          remembered: '2026-11-19 12:00Z',
        })),
      },
      session: undefined,
      allowlist: {
        ok: true,
        commands: Array.from({ length: 30 }, (_, i) => `cmd-${String(i)}`),
        globs: ['a *', 'b *'],
        omitted: 20,
      },
    };
    const state = permissions((sheet) => ({ cursor: 25, snapshot: sheet.snapshot }), many);
    const lines = text(state).split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(lines.some((line) => line.startsWith('› tool25, 1 argument'))).toBe(true);
    expect(lines.join('\n')).toContain('more in the config');
  });

  it('says what it shows on each placeholder, in a word as well as a glyph', () => {
    for (const [tab, title] of [
      ['defined', 'Defined'],
      ['active', 'Active'],
      ['history', 'History'],
    ] as const) {
      const drawn = text(hostOn(tab));
      expect(drawn).toContain(`▸ ${title}`);
      expect(drawn).toContain(`${title} — available in the next increment.`);
    }
  });
});

describe('TabHostView below the minimum', () => {
  it.each([
    [79, 24],
    [80, 23],
    [60, 20],
  ])(
    'at %i×%i it says to enlarge, names the way out, and draws nothing of the screen',
    (columns, rows) => {
      expect(text(hostOn('permissions'), columns, rows).split('\n')).toEqual([
        'Enlarge the terminal to use this screen — Esc closes.',
        'Esc close',
      ]);
    },
  );
});

describe('TabHostView with colour on', () => {
  it('draws the current tab bold and the others dim, the rule dim, the selected row cyan with its key in red, and the allowlist heading bold', () => {
    const drawn = frame(hostOn('permissions', { ...SNAPSHOT, allowlist: ALLOWLIST }), true);
    const strip = lineWith(drawn, '▸ Permissions');
    expect(strip).toContain(`${BOLD}▸ Permissions`);
    expect(strip).toContain(`${DIM}Defined`);
    expect(lineWith(drawn, '────').startsWith(DIM)).toBe(true);
    const selected = lineWith(drawn, '› npm, 1 argument');
    expect(selected).toContain(CYAN);
    expect(selected).toMatch(new RegExp(`${ESC}\\[31m\\[d\\]`, 'u'));
    expect(lineWith(drawn, 'This repository · allowlist')).toContain(BOLD);
    expect(lineWith(drawn, 'git status'), 'the word that says what it is, dimmed').toContain(
      `${DIM}  command`,
    );
    expect(lineWith(drawn, 'Tab'), 'the legend: the keys apart from the words').toContain(
      `${BOLD}←/→`,
    );
  });

  it('draws a withdrawal’s answer by its tone: done in green with a tick, a failure in red with a cross, a note in yellow', () => {
    const answer = (message: SheetMessage): string =>
      frame(
        permissions(() => ({ message })),
        true,
      );
    expect(lineWith(answer({ tone: 'done', text: 'Withdrawn.' }), '✓')).toContain(GREEN);
    expect(lineWith(answer({ tone: 'failed', text: 'No room.' }), '✗')).toContain(RED);
    expect(lineWith(answer({ tone: 'note', text: 'Already gone.' }), 'Already gone.')).toContain(
      YELLOW,
    );
  });

  it('draws a placeholder’s unreadable sentence in red', () => {
    const state: TabHostState = { ...hostOn('permissions'), sheet: undefined, unreadable: true };
    expect(lineWith(frame(state, true), 'Could not read the permissions.')).toContain(RED);
  });
});

describe('TabHostView with colour off (NO_COLOR)', () => {
  it('emits no colour at all, and a glyph and a word still tell every state', () => {
    const states: readonly (readonly [string, TabHostState, readonly string[]])[] = [
      ['the current tab', hostOn('permissions'), ['▸ Permissions']],
      ['a selected row', hostOn('permissions'), ['› npm, 1 argument', '[d] withdraw']],
      [
        'a waiting question',
        permissions(() => ({ armed: true })),
        [
          '[Enter] withdraw',
          'Withdraw npm, 1 argument (2026-11-19 12:00Z)? Any other key keeps it.',
          '[Enter] withdraw · Esc keep',
        ],
      ],
      [
        'a done answer',
        permissions(() => ({ message: { tone: 'done', text: 'Withdrawn.' } })),
        ['✓ Withdrawn.'],
      ],
      [
        'a failed answer',
        permissions(() => ({ message: { tone: 'failed', text: 'No room.' } })),
        ['✗ No room.'],
      ],
      [
        'a note',
        permissions(() => ({ message: { tone: 'note', text: 'Already gone.' } })),
        ['Already gone.'],
      ],
      [
        'rows above and below the window',
        permissions(() => ({ cursor: 14 }), {
          project: {
            ok: true,
            rows: Array.from({ length: 40 }, (_, i) => ({
              id: `g${String(i)}`,
              label: `tool${String(i)}, 1 argument`,
              remembered: '2026-11-19 12:00Z',
            })),
          },
          session: undefined,
        }),
        ['▲ ', ' more', '▼ '],
      ],
      [
        'an unreadable tab',
        { ...hostOn('permissions'), sheet: undefined, unreadable: true },
        ['Could not read the permissions.'],
      ],
      [
        'a placeholder',
        hostOn('history'),
        ['▸ History', 'History — available in the next increment.'],
      ],
      [
        'the allowlist',
        hostOn('permissions', { ...SNAPSHOT, allowlist: ALLOWLIST }),
        [
          'This repository · allowlist, read-only (2 commands, 1 pattern)',
          'command git status',
          'pattern git *',
        ],
      ],
      [
        'an allowlist that could not be read',
        hostOn('permissions', {
          ...SNAPSHOT,
          allowlist: { ok: false, text: 'The repository’s [chat] allowlist could not be read.' },
        }),
        ['The repository’s [chat] allowlist could not be read.'],
      ],
    ];
    for (const [name, state, words] of states) {
      const styled = frame(state, false);
      expect(styled, name).not.toMatch(ANY_COLOUR);
      for (const word of words) expect(plain(styled), `${name}: ${word}`).toContain(word);
    }
  });
});

// ---- Through a mounted RootApp ----------------------------------------------------------------------------------------------

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

/** The Home with its tab host open on Permissions, mounted in the inline renderer or (`alternateScreen`) the full-screen one. */
function mountTabHost(
  options: { alternateScreen?: boolean; size?: { cols: number; rows: number } } = {},
) {
  const size = options.size ?? { cols: 80, rows: 24 };
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    permissions: portOf({ ...SNAPSHOT, allowlist: ALLOWLIST }),
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  });
  expect(controller.openScreen('tab-host', { tab: 'permissions' })).toBe(true);
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
  // `force-color.js` makes chalk emit its codes under vitest, so the frame is read without them: what a person without styling reads.
  return { controller, harness, frame: (): string => plain(harness.lastFrame() ?? '') };
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

describe.each([
  ['the inline renderer', false],
  ['the full-screen renderer', true],
] as const)('RootApp in %s', (_name, alternateScreen) => {
  it('draws the tab host in place of the landing at 80×24, in at most 23 rows, with no prompt and no strip', async () => {
    const m = mountTabHost({ alternateScreen });
    await until(() => m.frame().includes('▸ Permissions'));
    const lines = m.frame().split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(m.frame()).toContain('This project · remembered (2)');
    expect(m.frame()).toContain(
      '←/→ tab · Tab cycle · ↑/↓ select · [d / Del] withdraw · Esc close',
    );
    expect(m.frame(), 'no prompt behind the screen').not.toContain('/ for commands');
  });

  it('moves between tabs with the keys a person presses, and Esc leaves for the landing', async () => {
    const m = mountTabHost({ alternateScreen });
    await until(() => m.frame().includes('▸ Permissions'));
    m.harness.stdin.write(`${ESC}[D`); // ←
    await until(() => m.frame().includes('▸ History'));
    expect(m.frame()).toContain('History — available in the next increment.');
    m.harness.stdin.write('\t');
    await until(() => m.frame().includes('▸ Permissions'));
    m.harness.stdin.write(ESC);
    await until(() => m.controller.getSnapshot().screen === undefined);
    await until(() => m.frame().includes('/ for commands'));
  });

  it('drops a paste: it reaches neither the screen nor the prompt behind it', async () => {
    const m = mountTabHost({ alternateScreen });
    await until(() => m.frame().includes('▸ Permissions'));
    const before = m.frame();
    m.harness.stdin.write(bracketed('hello world'));
    await settleFrames();
    expect(m.controller.getSnapshot().input.text).toBe('');
    expect(m.frame(), 'nothing of it is drawn').not.toContain('hello');
    expect(m.frame()).toBe(before);
    expect(m.controller.getSnapshot().screen?.kind).toBe('tab-host');
  });

  it('below 80×24 draws the one-line hint and takes only Esc and Ctrl+C', async () => {
    const m = mountTabHost({ alternateScreen, size: { cols: 70, rows: 20 } });
    await until(() => m.frame().includes('Enlarge the terminal'));
    expect(m.frame().split('\n')).toEqual([
      'Enlarge the terminal to use this screen — Esc closes.',
      'Esc close',
    ]);
    m.harness.stdin.write(`${ESC}[D`);
    await settleFrames();
    const screen = m.controller.getSnapshot().screen;
    expect(
      screen?.kind === 'tab-host' ? screen.host.tab : undefined,
      'a tab key is not delivered',
    ).toBe('permissions');
    m.harness.stdin.write('\u0003');
    await until(() => m.controller.getSnapshot().screen === undefined);
  });
});
