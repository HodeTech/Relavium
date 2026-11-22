import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { HomeView } from './home-view.js';

describe('keyless Home view', () => {
  it.each([true, false])(
    'keeps the focused Continue session and prompt visible in a full strip (keyless=%s)',
    (keyless) => {
      const sessions = Array.from({ length: 8 }, (_, n) => ({
        sessionId: `session-${n}`,
        title: `Conversation ${n} ${'long title '.repeat(30)}`,
        workingDir: `/workspace/${'long directory/'.repeat(30)}`,
        agentSlug: 'chat',
        modelId: 'model',
        status: 'ended' as const,
        updatedAt: '2026-11-10T00:00:00.000Z',
        totalCostMicrocents: 0,
      }));
      const view = render(
        <HomeView
          snapshot={{
            attention: { gates: [], failedRuns: [] },
            recentSessions: sessions,
            recentRuns: [],
            recentAgents: [],
            unreadableRunIds: Array.from({ length: 50 }, (_, n) => `run-${n}`),
            isEmpty: false,
          }}
          editor={{ text: '', cursor: 0 }}
          nowMs={0}
          cols={80}
          rows={24}
          color={false}
          keyless={keyless}
          notice={'notice '.repeat(100)}
          continueSessionId="session-7"
        />,
      );
      const frame = view.lastFrame() ?? '';
      expect(frame).toContain('> Conversation 7');
      expect(frame).toContain('Enter resume');
      expect(frame).toContain('/workspace/');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      view.unmount();
    },
  );
  it('keeps setup and prompt visible at 80x24 by trimming management rows first', () => {
    const view = render(
      <HomeView
        snapshot={{
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: Array.from({ length: 50 }, (_, i) => `id-${i}`),
          isEmpty: false,
        }}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={80}
        rows={24}
        color={false}
        keyless
      />,
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Connect a provider');
    expect(frame).toContain('Enter to set up');
    expect(frame).not.toContain('↓ Continue');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    view.unmount();
  });
});

/** The Home's hint bar says what the keys do now (2.5.C S6): one sentence per state, drawn wide enough that none is cut. */
describe('the Home hint bar', () => {
  const session = {
    sessionId: 'session-1',
    title: 'Conversation',
    workingDir: '/workspace/project',
    agentSlug: 'chat',
    modelId: 'model',
    status: 'ended' as const,
    updatedAt: '2026-11-10T00:00:00.000Z',
    totalCostMicrocents: 0,
  };
  const frameOf = (over: {
    text?: string;
    sessions?: readonly (typeof session)[];
    continueSessionId?: string;
    interruptArmed?: boolean;
  }): string => {
    const sessions = over.sessions ?? [];
    const view = render(
      <HomeView
        snapshot={{
          attention: { gates: [], failedRuns: [] },
          recentSessions: sessions,
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: sessions.length === 0,
        }}
        editor={{ text: over.text ?? '', cursor: (over.text ?? '').length }}
        nowMs={0}
        cols={120}
        rows={30}
        color={false}
        continueSessionId={over.continueSessionId}
        interruptArmed={over.interruptArmed}
      />,
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    return frame;
  };

  it('asks for the second Ctrl+C while the first is armed', () => {
    expect(frameOf({ interruptArmed: true })).toContain('Press Ctrl+C again to exit');
  });

  it('names the session picker keys while a session is being continued', () => {
    expect(frameOf({ sessions: [session], continueSessionId: 'session-1' })).toContain(
      '↑/↓ select session · Enter resume · Esc return to prompt · Ctrl+C twice to exit',
    );
  });

  it('says how to send once the person is composing', () => {
    expect(frameOf({ text: 'hello', sessions: [session] })).toContain(
      'Enter to start the chat · Ctrl+J newline · Ctrl+C twice to exit',
    );
  });

  it('offers Continue beside the palette at an empty prompt when there are sessions to continue, and does not when there are none', () => {
    expect(frameOf({ sessions: [session] })).toContain(
      '/ commands · ↓ Continue · type a message to chat · Ctrl+C twice to exit',
    );
    expect(frameOf({})).toContain(
      '/ for commands · type a message to start a chat · Ctrl+C twice to exit',
    );
  });
});
