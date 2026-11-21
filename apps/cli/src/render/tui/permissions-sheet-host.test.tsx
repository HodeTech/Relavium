import type { ToolApprovalRequest } from '@relavium/core';
import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PermissionEntry,
  PermissionsPort,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../../permissions/chat-permissions.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { SHEET_CONFIRM_DWELL_MS, SHEET_SETTLE_MS } from './permissions-sheet.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { bracketed, settleFrames } from './harness-util.js';

/**
 * The `/permissions` sheet mounted in the standalone `ChatApp` (ADR-0137 §2): the keyboard it owns, what it draws, and that a withdrawal
 * runs through the port. The pure half (the key ladder, its clock, the lines) is `permissions-sheet.test.ts`; this file is what only exists
 * once the component is mounted under ink: that the sheet takes the typed command instead of sending it, owns every key, keeps a paste out
 * of the composer, refuses a key typed ahead, and gives way to a card. Its keys are timed in real time, as the card's are.
 */

function WritableCapture(props: { readonly children: ReactElement }): ReactElement {
  const { stdout } = useStdout();
  Object.defineProperty(stdout, 'writable', { value: true });
  return props.children;
}
afterEach(cleanup);

/**
 * Poll until `predicate` holds and FAIL if it never does. `harness-util`'s `waitFor` returns silently on a timeout, so a bare `await waitFor(...)`
 * asserts nothing (a removed paste handler survived the mutation sweep that way); a lone Esc is also held back a moment while the input layer
 * rules out an escape sequence, so the budget is real time, as in `interrupt-wiring.test.tsx`.
 */
const until = (predicate: () => boolean, timeout = 3000): Promise<void> =>
  vi.waitFor(
    () => {
      if (!predicate())
        throw new Error(`the condition did not become true: ${predicate.toString()}`);
    },
    { timeout, interval: 15 },
  );
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough that the sheet has settled and the keyboard has been quiet (the guards of ADR-0137 §2). */
const afterSettle = (): Promise<void> => sleep(SHEET_SETTLE_MS + 80);
const afterDwell = (): Promise<void> => sleep(SHEET_CONFIRM_DWELL_MS + 80);

const ESC = '\u001b';
const CTRL_C = '\u0003';
const ENTER = '\r';
const DOWN = '\u001b[B';
const UP = '\u001b[A';
const WITHDRAWN = 'Withdrawn. Auto mode asks about it again.';

function fakePort(initial: PermissionsSnapshot): {
  readonly port: PermissionsPort;
  readonly withdraw: ReturnType<typeof vi.fn>;
  readonly load: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const withdraw = vi.fn((entry: PermissionEntry): WithdrawAnswer => {
    if (entry.kind === 'project' && current.project.ok) {
      current = {
        ...current,
        project: { ok: true, rows: current.project.rows.filter((row) => row.id !== entry.row.id) },
      };
      return { tone: 'done', text: WITHDRAWN };
    }
    return { tone: 'done', text: 'Session approval withdrawn. It needs approval again.' };
  });
  const load = vi.fn(() => current);
  return { port: { surface: 'chat', load, withdraw }, withdraw, load };
}

const SNAPSHOT: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [
      { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' },
      { id: 'b', label: 'node, 1 argument', remembered: '2026-11-18 09:30Z' },
    ],
  },
  session: [{ argv: ['git', 'status'], text: 'git status', alsoRemembered: false }],
};

type Mounted = {
  readonly view: ReturnType<typeof renderCapture>;
  readonly store: ReturnType<typeof createChatStore>;
};

function mount(options: {
  readonly port?: PermissionsPort;
  readonly onSubmit?: (message: string) => Promise<void>;
  readonly onExit?: () => void;
}): Mounted {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const view = renderCapture(
    <WritableCapture>
      <ChatApp
        store={store}
        onSubmit={options.onSubmit ?? (() => Promise.resolve())}
        shouldStop={() => false}
        onExit={options.onExit ?? (() => {})}
        onError={() => {}}
        onModeChange={() => {}}
        {...(options.port === undefined ? {} : { permissions: options.port })}
      />
    </WritableCapture>,
  );
  return { view, store };
}

const frame = (view: ReturnType<typeof renderCapture>): string => view.lastFrame() ?? '';

async function openSheet(
  view: ReturnType<typeof renderCapture>,
  typed = '/permissions',
): Promise<void> {
  view.stdin.write(typed);
  view.stdin.write(ENTER);
  await until(() => frame(view).includes('Permissions ·'));
  await settleFrames();
}

describe('the permissions sheet in the standalone chat', () => {
  it('opens on the typed command instead of sending it, and draws the project and the session sections with the legend', async () => {
    const submitted: string[] = [];
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({
      port,
      onSubmit: (message) => {
        submitted.push(message);
        return Promise.resolve();
      },
    });
    await openSheet(view);
    const text = frame(view);
    expect(text).toContain('Permissions · ask mode');
    expect(text).toContain('This project · remembered (2)');
    expect(text).toContain('› npm, 1 argument');
    expect(text).toContain('This session · approved (1)');
    expect(text).toContain('git status');
    expect(text).toContain('↑/↓ select · [d / Del] withdraw · Esc close');
    expect(submitted, 'the sheet took the command: nothing was sent to the model').toEqual([]);
  });

  it('opens on the command typed with trailing spaces too', async () => {
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view, '/permissions   ');
    expect(frame(view)).toContain('This project · remembered (2)');
  });

  it('is not opened where no port is wired: the command is sent on to the dispatch', async () => {
    const submitted: string[] = [];
    const { view } = mount({
      onSubmit: (message) => {
        submitted.push(message);
        return Promise.resolve();
      },
    });
    view.stdin.write('/permissions');
    view.stdin.write(ENTER);
    await until(() => submitted.length === 1);
    expect(submitted).toEqual(['/permissions']);
    expect(frame(view)).not.toContain('Permissions ·');
  });

  it('does not open when the port cannot be read, and says so', async () => {
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({
      port: {
        ...port,
        load: () => {
          throw new Error('boom');
        },
      },
    });
    view.stdin.write('/permissions');
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('Could not read the permissions.'));
    expect(frame(view)).not.toContain('Permissions ·');
  });

  it('Esc closes it and Ctrl+C closes it without ending the session', async () => {
    const onExit = vi.fn();
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({ port, onExit });
    await openSheet(view);
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Permissions ·'));
    await openSheet(view);
    view.stdin.write(CTRL_C);
    await until(() => !frame(view).includes('Permissions ·'));
    await settleFrames();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('owns every key: what is typed while it is open does not reach the composer', async () => {
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    view.stdin.write('hello world');
    await settleFrames();
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Permissions ·'));
    expect(frame(view)).not.toContain('hello world');
  });

  it('`d` asks and Enter withdraws through the port, by the row’s identity, once each has had its moment', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    await afterSettle();
    view.stdin.write('d');
    await until(() =>
      frame(view).includes('Withdraw npm, 1 argument (2026-11-19 12:00Z)? Any other key keeps it.'),
    );
    expect(frame(view)).toContain('[Enter] withdraw · Esc keep');
    expect(withdraw, 'arming withdraws nothing').not.toHaveBeenCalled();
    await afterDwell();
    view.stdin.write(ENTER);
    await until(() => frame(view).includes(WITHDRAWN));
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw.mock.calls[0]?.[0]).toMatchObject({ kind: 'project', row: { id: 'a' } });
    await settleFrames();
    expect(frame(view)).toContain('This project · remembered (1)');
    expect(frame(view)).toContain('↑/↓ select · [d / Del] withdraw · Esc close');
  });

  it('a port that throws on a withdrawal leaves the sheet open and says so as a failure, with the cross', async () => {
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({
      port: {
        ...port,
        withdraw: () => {
          throw new Error('boom');
        },
      },
    });
    await openSheet(view);
    await afterSettle();
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    await afterDwell();
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('✗ Could not withdraw that row; nothing changed.'));
    expect(frame(view)).toContain('Permissions ·');
  });

  it('SECURITY: keys typed ahead after the command withdraw nothing, even a line that ends in d and an Enter', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    view.stdin.write('/permissions');
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('Permissions ·'));
    // The person goes on typing at once: "run the build", then Enter; and a Delete key then Enter.
    for (const char of 'run the build') view.stdin.write(char);
    view.stdin.write(ENTER);
    view.stdin.write('\u001b[3~'); // the Delete key
    view.stdin.write(ENTER);
    await settleFrames();
    await sleep(50);
    expect(withdraw).not.toHaveBeenCalled();
    expect(frame(view)).toContain('This project · remembered (2)');
  });

  it('a hasty Enter after the question drops it with a note and withdraws nothing', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    await afterSettle();
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    view.stdin.write(ENTER);
    await until(() =>
      frame(view).includes('Too early or too late for Enter — nothing was withdrawn.'),
    );
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('any other key, Esc, and a paste drop the question and withdraw nothing; a second Esc closes', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    await afterSettle();
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    view.stdin.write('x');
    await until(() => !frame(view).includes('Any other key keeps it.'));
    // The `x` was typing: `d` arms nothing until an arrow key says the person is choosing a row.
    view.stdin.write('d');
    await until(() => frame(view).includes('Typed keys are ignored here.'));
    view.stdin.write(DOWN);
    view.stdin.write(UP);
    await settleFrames();
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Any other key keeps it.'));
    expect(frame(view), 'the first Esc kept the row and left the sheet open').toContain(
      'Permissions ·',
    );
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    view.stdin.write(bracketed('please withdraw everything'));
    await until(() => !frame(view).includes('Any other key keeps it.'));
    await settleFrames();
    expect(withdraw).not.toHaveBeenCalled();
    expect(frame(view), 'the paste did not reach the composer').not.toContain(
      'please withdraw everything',
    );
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Permissions ·'));
    // The composer is hidden while the sheet is open, so the assertion above can pass on a paste that went to it; once the sheet is gone the
    // prompt is drawn again, and it must be empty.
    await settleFrames();
    expect(frame(view), 'the paste did not wait in the prompt behind the sheet').not.toContain(
      'please withdraw everything',
    );
  });

  it('SECURITY: a line typed ahead at a HUMAN pace, then a pause, then d, then a pause, then Enter, withdraws nothing (security sitting 2, M1)', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    view.stdin.write('/permissions');
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('Permissions ·'));
    // "the tests passed", a character every 110 ms; then 350 ms, `d` (the last letter of "passed" typed as its own key), 380 ms, Enter.
    for (const char of 'the tests passe') {
      view.stdin.write(char);
      await sleep(110);
    }
    await sleep(350);
    view.stdin.write('d');
    await sleep(380);
    view.stdin.write(ENTER);
    await settleFrames();
    expect(withdraw).not.toHaveBeenCalled();
    expect(frame(view)).not.toContain('Any other key keeps it.');
    expect(frame(view)).toContain('This project · remembered (2)');
  });

  it('a d pressed at once says to wait, is not typing, and arms when pressed again after a moment', async () => {
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    view.stdin.write('/permissions');
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('Permissions ·'));
    view.stdin.write('d');
    await until(() => frame(view).includes('Wait a moment, then press d.'));
    await afterSettle();
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    expect(frame(view)).toContain('Any other key keeps it.');
  });

  it('closes cleanly: after Esc the keyboard is the composer’s again (the ref is cleared, not only the state)', async () => {
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Permissions ·'));
    view.stdin.write('hello again');
    await until(() => frame(view).includes('hello again'));
    expect(frame(view)).not.toContain('Permissions ·');
  });

  it('takes the composer’s place while open: the idle prompt and its hint are not drawn under the sheet, and come back when it closes', async () => {
    const { port } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await until(() => frame(view).includes('/ for commands'));
    await openSheet(view);
    expect(frame(view)).not.toContain('/ for commands');
    view.stdin.write(ESC);
    await until(() => frame(view).includes('/ for commands'));
  });

  it('reads the terminal’s real width AND height: either one below the floor says so', async () => {
    const { port } = fakePort(SNAPSHOT);
    for (const [columns, rows] of [
      [80, 23],
      [79, 30],
    ] as const) {
      const { view } = mount({ port });
      Object.defineProperty(view.stdout, 'columns', { value: columns, configurable: true });
      Object.defineProperty(view.stdout, 'rows', { value: rows, configurable: true });
      view.stdout.emit('resize');
      await openSheet(view);
      expect(frame(view), `${String(columns)}x${String(rows)}`).toContain(
        'Enlarge the terminal to use this screen',
      );
      cleanup();
    }
    const { view } = mount({ port });
    Object.defineProperty(view.stdout, 'columns', { value: 100, configurable: true });
    Object.defineProperty(view.stdout, 'rows', { value: 30, configurable: true });
    view.stdout.emit('resize');
    await openSheet(view);
    expect(frame(view)).not.toContain('Enlarge the terminal');
  });

  it('Ctrl+C while a withdrawal waits closes the sheet and withdraws nothing', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    await afterSettle();
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    await afterDwell();
    view.stdin.write(CTRL_C);
    await until(() => !frame(view).includes('Permissions ·'));
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('gives way to a card that arrives: the sheet closes and the card is shown', async () => {
    const { port } = fakePort(SNAPSHOT);
    const { view, store } = mount({ port });
    await openSheet(view);
    const request: ToolApprovalRequest = {
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: 'notes.md' },
      unredactedPreview: { path: 'notes.md' },
    };
    void store.requestApproval(request, false);
    await until(() => !frame(view).includes('Permissions ·'));
    await until(() => frame(view).includes('Esc stops the turn'));
    expect(frame(view)).toContain('Esc stops the turn');
    expect(frame(view)).not.toContain('Permissions ·');
  });

  it('survives a port that throws on a withdrawal: the sheet says nothing changed and stays usable', async () => {
    const { port } = fakePort(SNAPSHOT);
    const throwing: PermissionsPort = {
      ...port,
      withdraw: () => {
        throw new Error('boom');
      },
    };
    const { view } = mount({ port: throwing });
    await openSheet(view);
    await afterSettle();
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    await afterDwell();
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('Could not withdraw that row; nothing changed.'));
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Permissions ·'));
    expect(frame(view)).not.toContain('Permissions ·');
  });

  it('closes, and says so, when the list cannot be read again after a withdrawal: it never stays armed on a stale list', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    let reads = 0;
    const flaky: PermissionsPort = {
      ...port,
      load: () => {
        reads += 1;
        if (reads > 1) throw new Error('boom');
        return SNAPSHOT;
      },
    };
    const { view } = mount({ port: flaky });
    await openSheet(view);
    await afterSettle();
    view.stdin.write('d');
    await until(() => frame(view).includes('Any other key keeps it.'));
    await afterDwell();
    view.stdin.write(ENTER);
    await until(() => !frame(view).includes('Permissions ·'));
    expect(withdraw).toHaveBeenCalledTimes(1);
    await until(() => frame(view).includes('Could not read the permissions again.'));
  });

  it('draws only the way out below 80x24 and arms nothing there', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    Object.defineProperty(view.stdout, 'columns', { value: 70, configurable: true });
    Object.defineProperty(view.stdout, 'rows', { value: 20, configurable: true });
    view.stdout.emit('resize');
    await openSheet(view);
    expect(frame(view)).toContain('Enlarge the terminal to use this screen — Esc closes.');
    await afterSettle();
    view.stdin.write('d');
    await settleFrames();
    await afterDwell();
    view.stdin.write(ENTER);
    await settleFrames();
    expect(frame(view)).not.toContain('Any other key keeps it.');
    expect(withdraw).not.toHaveBeenCalled();
  });
});

describe('the permissions sheet in the full-screen chat', () => {
  it('does not scroll the transcript behind it: PgUp and the wheel reach the sheet, never the viewport', async () => {
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.appendUser(`MSG${String(i)}`);
    const { port } = fakePort(SNAPSHOT);
    const view = renderCapture(
      <WritableCapture>
        <ChatApp
          store={store}
          alternateScreen
          onSubmit={() => Promise.resolve()}
          shouldStop={() => false}
          onExit={() => {}}
          onError={() => {}}
          onModeChange={() => {}}
          permissions={port}
        />
      </WritableCapture>,
    );
    Object.defineProperty(view.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(view.stdout, 'rows', { value: 30, configurable: true });
    view.stdout.emit('resize');
    await until(() => frame(view).includes('MSG59'));
    await openSheet(view);
    expect(frame(view)).toContain('MSG59'); // following the tail, with the sheet docked under it
    view.stdin.write('\u001b[5~'); // PgUp: the sheet's own page key
    await settleFrames();
    view.stdin.write('\u001b[<64;10;5M'); // a wheel-up report (SGR mouse)
    await settleFrames();
    expect(frame(view)).toContain('Permissions ·');
    expect(frame(view), 'the transcript did not scroll behind the sheet').toContain('MSG59');
  });
});
