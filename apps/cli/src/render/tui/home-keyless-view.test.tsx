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
