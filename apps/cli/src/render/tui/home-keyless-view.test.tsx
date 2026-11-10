import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { HomeView } from './home-view.js';

describe('keyless Home view', () => {
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
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    view.unmount();
  });
});
