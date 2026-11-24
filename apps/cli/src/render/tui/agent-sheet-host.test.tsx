import type { ToolApprovalRequest } from '@relavium/core';
import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { boundAgentView, type BoundAgentView } from '../../chat/bound-agent-view.js';
import { buildDefaultChatAgent } from '../../chat/default-agent.js';
import type { PermissionsPort, PermissionsSnapshot } from '../../permissions/chat-permissions.js';
import { AGENT_UNREADABLE } from './agent-sheet.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { bracketed, settleFrames, withoutStyles } from './harness-util.js';

/**
 * The `/agent` sheet mounted in the standalone `ChatApp` (ADR-0140 §3): that it takes the typed command instead of sending it, owns every
 * key, keeps a paste out of the composer, shares the ONE sheet slot with `/permissions`, and gives way to a card. The pure half (what it
 * lists, how it fits 80×24, its notice) is `agent-sheet.test.ts`. Its keys are timed in real time, as the permissions sheet's are.
 */

function WritableCapture(props: { readonly children: ReactElement }): ReactElement {
  const { stdout } = useStdout();
  Object.defineProperty(stdout, 'writable', { value: true });
  return props.children;
}
afterEach(cleanup);

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
const DOWN = '\u001b[B';

const VIEW: BoundAgentView = boundAgentView(
  buildDefaultChatAgent('claude-sonnet-4-6', 'medium', 'anthropic'),
  'medium',
);
const OPUS: BoundAgentView = boundAgentView(
  buildDefaultChatAgent('claude-opus-4-8', undefined, 'anthropic'),
  undefined,
);

const SNAPSHOT: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [{ id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' }],
  },
  session: [],
};
const port: PermissionsPort = { surface: 'chat', load: () => SNAPSHOT, withdraw: vi.fn() };

type Mounted = {
  readonly view: ReturnType<typeof renderCapture>;
  readonly store: ReturnType<typeof createChatStore>;
};

function mount(options: {
  readonly boundAgent?: () => BoundAgentView;
  readonly permissions?: PermissionsPort;
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
        {...(options.boundAgent === undefined ? {} : { boundAgent: options.boundAgent })}
        {...(options.permissions === undefined ? {} : { permissions: options.permissions })}
      />
    </WritableCapture>,
  );
  return { view, store };
}

const frame = (view: ReturnType<typeof renderCapture>): string =>
  withoutStyles(view.lastFrame() ?? '');
const SHEET = 'Agent · relavium-chat';

async function openAgent(view: ReturnType<typeof renderCapture>, typed = '/agent'): Promise<void> {
  view.stdin.write(typed);
  view.stdin.write(ENTER);
  await until(() => frame(view).includes(SHEET));
  await settleFrames();
}

describe('the /agent sheet in the standalone chat', () => {
  it('opens on the typed command instead of sending it, and draws the bound agent’s fields with the way out', async () => {
    const submitted: string[] = [];
    const { view } = mount({
      boundAgent: () => VIEW,
      onSubmit: (message) => {
        submitted.push(message);
        return Promise.resolve();
      },
    });
    await openAgent(view);
    const text = frame(view);
    expect(text).toContain('claude-sonnet-4-6');
    expect(text).toContain('anthropic');
    expect(text).toContain('the built-in chat agent');
    expect(text).toContain('Reasoning effort  medium');
    expect(text).toContain('Esc / [Ctrl+C] close');
    expect(submitted, 'the typed command was not sent to the model or the dispatch').toEqual([]);
  });

  it('opens on the command typed with trailing spaces', async () => {
    const { view } = mount({ boundAgent: () => VIEW });
    await openAgent(view, '/agent   ');
    expect(frame(view)).toContain(SHEET);
  });

  it('opens when /agent is chosen from the palette, as the typed command does', async () => {
    const { view } = mount({ boundAgent: () => VIEW });
    view.stdin.write('/');
    await until(() => frame(view).includes('/agent'));
    for (const char of 'agent') {
      view.stdin.write(char);
      await settleFrames();
    }
    view.stdin.write(ENTER);
    await until(() => frame(view).includes(SHEET));
    expect(frame(view)).toContain(SHEET);
  });

  it('draws the definition the host hands it AT THE MOMENT it opens: a reseated session’s view shows the new model', async () => {
    let current = VIEW;
    const { view } = mount({ boundAgent: () => current });
    await openAgent(view);
    expect(frame(view)).toContain('claude-sonnet-4-6');
    view.stdin.write(ESC);
    await until(() => !frame(view).includes(SHEET));
    current = OPUS;
    await openAgent(view);
    expect(frame(view)).toContain('claude-opus-4-8');
    expect(frame(view)).not.toContain('claude-sonnet-4-6');
  });

  it('is not opened where no view is wired, or with an argument: the command is sent on to the dispatch', async () => {
    const submitted: string[] = [];
    const sink = (message: string): Promise<void> => {
      submitted.push(message);
      return Promise.resolve();
    };
    const bare = mount({ onSubmit: sink });
    bare.view.stdin.write('/agent');
    bare.view.stdin.write(ENTER);
    await until(() => submitted.length === 1);
    cleanup();
    const wired = mount({ boundAgent: () => VIEW, onSubmit: sink });
    wired.view.stdin.write('/agent now');
    wired.view.stdin.write(ENTER);
    await until(() => submitted.length === 2);
    expect(submitted).toEqual(['/agent', '/agent now']);
    expect(frame(wired.view)).not.toContain(SHEET);
  });

  it('Esc closes it and Ctrl+C closes it without ending the session', async () => {
    const onExit = vi.fn();
    const { view } = mount({ boundAgent: () => VIEW, onExit });
    await openAgent(view);
    view.stdin.write(ESC);
    await until(() => !frame(view).includes(SHEET));
    await openAgent(view);
    view.stdin.write(CTRL_C);
    await until(() => !frame(view).includes(SHEET));
    await settleFrames();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('owns every key: typed text, Enter, an arrow and a chord do not reach the composer, and the sheet stays open', async () => {
    const submitted: string[] = [];
    const { view } = mount({
      boundAgent: () => VIEW,
      onSubmit: (message) => {
        submitted.push(message);
        return Promise.resolve();
      },
    });
    await openAgent(view);
    view.stdin.write('hello world');
    view.stdin.write(ENTER);
    view.stdin.write(DOWN);
    view.stdin.write('\u000f'); // Ctrl+O, a card chord
    await settleFrames();
    expect(frame(view), 'still open: no key but Esc and Ctrl+C closes it').toContain(SHEET);
    expect(submitted, 'the Enter did not send what was typed').toEqual([]);
    view.stdin.write(ESC);
    await until(() => !frame(view).includes(SHEET));
    await settleFrames();
    expect(frame(view), 'nothing typed under the sheet waits in the prompt').not.toContain(
      'hello world',
    );
  });

  it('drops a paste: it stays out of the composer, and the sheet is as it was', async () => {
    const { view } = mount({ boundAgent: () => VIEW });
    await openAgent(view);
    view.stdin.write(bracketed('please run everything'));
    await settleFrames();
    expect(frame(view)).toContain(SHEET);
    view.stdin.write(ESC);
    await until(() => !frame(view).includes(SHEET));
    await settleFrames();
    expect(frame(view), 'the paste did not wait in the prompt behind the sheet').not.toContain(
      'please run everything',
    );
  });

  it('shares the one sheet slot with /permissions: typing the other command into an open sheet opens nothing, and each works once the other is closed', async () => {
    const { view } = mount({ boundAgent: () => VIEW, permissions: port });
    await openAgent(view);
    view.stdin.write('/permissions');
    view.stdin.write(ENTER);
    await settleFrames();
    expect(frame(view), 'the permissions sheet did not open over the agent sheet').not.toContain(
      'Permissions ·',
    );
    expect(frame(view)).toContain(SHEET);
    view.stdin.write(ESC);
    await until(() => !frame(view).includes(SHEET));
    view.stdin.write('/permissions');
    view.stdin.write(ENTER);
    await until(() => frame(view).includes('Permissions ·'));
    await settleFrames();
    expect(frame(view), 'one sheet at a time').not.toContain(SHEET);
    view.stdin.write('/agent');
    view.stdin.write(ENTER);
    await settleFrames();
    expect(frame(view), 'the agent sheet did not open over the permissions sheet').not.toContain(
      SHEET,
    );
    view.stdin.write(ESC);
    await until(() => !frame(view).includes('Permissions ·'));
    await openAgent(view);
    expect(frame(view)).toContain('claude-sonnet-4-6');
  });

  it('closes cleanly: after Esc the keyboard is the composer’s again (the ref is cleared, not only the state)', async () => {
    const { view } = mount({ boundAgent: () => VIEW });
    await openAgent(view);
    view.stdin.write(ESC);
    await until(() => !frame(view).includes(SHEET));
    view.stdin.write('hello again');
    await until(() => frame(view).includes('hello again'));
    expect(frame(view)).toContain('hello again');
  });

  it('gives way to a card that arrives: the sheet closes and the card is shown', async () => {
    const { view, store } = mount({ boundAgent: () => VIEW });
    await openAgent(view);
    const request: ToolApprovalRequest = {
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: 'notes.md' },
      unredactedPreview: { path: 'notes.md' },
    };
    void store.requestApproval(request, false);
    await until(() => !frame(view).includes(SHEET));
    await until(() => frame(view).includes('Esc stops the turn'));
    expect(frame(view)).not.toContain(SHEET);
  });

  it('does not open when the view cannot be made: the chat says so, and the prompt is still usable', async () => {
    const { view } = mount({
      boundAgent: () => {
        throw new Error('boom');
      },
    });
    view.stdin.write('/agent');
    view.stdin.write(ENTER);
    await until(() => frame(view).includes(AGENT_UNREADABLE));
    expect(frame(view)).not.toContain(SHEET);
    view.stdin.write('still typing');
    await until(() => frame(view).includes('still typing'));
  });

  it('reads the terminal’s real width and height: below 80×24 it draws only the way out, and Esc still closes it', async () => {
    const { view } = mount({ boundAgent: () => VIEW });
    Object.defineProperty(view.stdout, 'columns', { value: 70, configurable: true });
    Object.defineProperty(view.stdout, 'rows', { value: 20, configurable: true });
    view.stdout.emit('resize');
    await openAgent(view);
    expect(frame(view)).toContain('Enlarge the terminal to use this screen.');
    expect(frame(view)).not.toContain('claude-sonnet-4-6');
    view.stdin.write(ESC);
    await until(() => !frame(view).includes(SHEET));
  });
});
