import type { ToolApprovalRequest } from '@relavium/core';
import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PermissionEntry,
  PermissionsPort,
  PermissionsSnapshot,
} from '../../permissions/chat-permissions.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { bracketed, settleFrames, waitFor } from './harness-util.js';

/**
 * The `/permissions` sheet mounted in the standalone `ChatApp` (ADR-0137 §2): the keyboard it owns, what it draws, and that a withdrawal
 * runs through the port. The pure half (the key ladder, the lines) is `permissions-sheet.test.ts`; this file is what only exists once the
 * component is mounted under ink: that the sheet takes the typed command instead of sending it, owns every key, keeps a paste out of the
 * composer, and gives way to a card.
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

const ESC = '\u001b';
const CTRL_C = '\u0003';
const ENTER = '\r';

function fakePort(initial: PermissionsSnapshot): {
  readonly port: PermissionsPort;
  readonly withdraw: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const withdraw = vi.fn((entry: PermissionEntry): string => {
    if (entry.kind === 'project' && current.project.ok) {
      current = {
        ...current,
        project: { ok: true, rows: current.project.rows.filter((row) => row.id !== entry.row.id) },
      };
      return `Withdrew ${entry.row.label}. Auto mode asks about it again.`;
    }
    return 'Session approval withdrawn. Auto mode asks about it again.';
  });
  return { port: { surface: 'chat', load: () => current, withdraw }, withdraw };
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

function mount(options: {
  readonly port?: PermissionsPort;
  readonly onSubmit?: (message: string) => Promise<void>;
  readonly onExit?: () => void;
}): {
  readonly view: ReturnType<typeof renderCapture>;
  readonly store: ReturnType<typeof createChatStore>;
} {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const view = renderCapture(
    <WritableCapture>
      <ChatApp
        store={store}
        onSubmit={options.onSubmit ?? (async () => {})}
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

async function openSheet(view: ReturnType<typeof renderCapture>): Promise<void> {
  view.stdin.write('/permissions');
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
    expect(text).toContain('↑/↓ select · d withdraw · Esc close');
    expect(submitted, 'the sheet took the command: nothing was sent to the model').toEqual([]);
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

  it('`d` asks and Enter withdraws through the port, by the row’s identity, and the sheet shows the answer', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    view.stdin.write('d');
    await until(() => frame(view).includes('Withdraw npm, 1 argument (2026-11-19 12:00Z)?'));
    expect(frame(view)).toContain('Enter withdraw · Esc keep');
    expect(withdraw, 'arming withdraws nothing').not.toHaveBeenCalled();
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('Withdrew npm, 1 argument.'));
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw.mock.calls[0]?.[0]).toMatchObject({ kind: 'project', row: { id: 'a' } });
    await settleFrames();
    expect(frame(view)).toContain('This project · remembered (1)');
    expect(frame(view)).toContain('↑/↓ select · d withdraw · Esc close');
  });

  it('any other key, Esc, and a paste drop the question and withdraw nothing; a second Esc closes', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    view.stdin.write('d');
    await until(() => frame(view).includes('Withdraw '));
    view.stdin.write('x');
    await until(() => !frame(view).includes('Enter withdraws'));
    view.stdin.write('d');
    await until(() => frame(view).includes('Enter withdraws'));
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Enter withdraws'));
    expect(frame(view), 'the first Esc kept the row and left the sheet open').toContain(
      'Permissions ·',
    );
    view.stdin.write('d');
    await until(() => frame(view).includes('Enter withdraws'));
    view.stdin.write(bracketed('please withdraw everything'));
    await until(() => !frame(view).includes('Enter withdraws'));
    await settleFrames();
    expect(withdraw).not.toHaveBeenCalled();
    expect(frame(view), 'the paste did not reach the composer').not.toContain(
      'please withdraw everything',
    );
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Permissions ·'));
  });

  it('Ctrl+C while a withdrawal waits closes the sheet and withdraws nothing', async () => {
    const { port, withdraw } = fakePort(SNAPSHOT);
    const { view } = mount({ port });
    await openSheet(view);
    view.stdin.write('d');
    await until(() => frame(view).includes('Enter withdraws'));
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
    view.stdin.write('d');
    await until(() => frame(view).includes('Enter withdraws'));
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('Could not withdraw that row; nothing changed.'));
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Permissions ·'));
  });
});
