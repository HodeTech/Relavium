/**
 * The loading echo of a chat that starts with no typed message ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): `c` on an agent's detail builds a chat bound to that agent, and while it builds the Home says so without echoing a
 * message nobody typed (no bare `>`). A typed first message is still echoed as before. The controller is real, its build never settles, and
 * the view is the mounted `RootApp`.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAgentsModel, type AgentsModelItem } from '../../history/agents-model.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { settleFrames, waitFor } from './harness-util.js';

afterEach(cleanup);

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

const ITEMS: readonly AgentsModelItem[] = [
  {
    entry: {
      slug: 'reviewer',
      name: 'Code Reviewer',
      path: '.relavium/agents/reviewer.agent.yaml',
      valid: true,
    },
    agent: {
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      system_prompt: 'You review code.',
      tools: ['read_file'],
    },
  },
];

function mount() {
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => EMPTY },
    agents: {
      read: () => ({
        model: buildAgentsModel(ITEMS),
        slugOf: (index) => ITEMS[index]?.entry.slug,
        pathOf: (index) => ITEMS[index]?.entry.path,
        definitionOf: (index) => {
          const item = ITEMS[index];
          return item?.agent === undefined ? undefined : { id: item.entry.slug, ...item.agent };
        },
      }),
    },
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      getSize={() => ({ cols: 100, rows: 30 })}
      subscribeResize={() => () => {}}
    />,
  );
  return { controller, harness };
}

describe('the loading echo', () => {
  it('draws no bare `>` for a chat that starts with no typed message, and says it is starting', async () => {
    const { controller, harness } = mount();
    await settleFrames();
    for (const ch of '/agents') controller.handleKey(ch, {});
    controller.handleKey('', { return: true });
    controller.handleKey('', { return: true }); // the detail of the only agent
    controller.handleKey('c', {});
    await waitFor(() => controller.getSnapshot().mode === 'loading');
    await waitFor(() => (harness.lastFrame() ?? '').includes('Starting chat…'));
    const lines = (harness.lastFrame() ?? '').split('\n').map((line) => line.trim());
    expect(lines, 'the loading echo is on screen').toContain('Starting chat… · [Ctrl+C] exit');
    expect(lines, 'and nothing was typed, so nothing is echoed').not.toContain('>');
  });

  it('still echoes the message that starts a chat when one was typed', async () => {
    const { controller, harness } = mount();
    await settleFrames();
    for (const ch of 'hello') controller.handleKey(ch, {});
    controller.handleKey('', { return: true });
    await waitFor(() => controller.getSnapshot().mode === 'loading');
    await waitFor(() => (harness.lastFrame() ?? '').includes('Starting chat…'));
    expect((harness.lastFrame() ?? '').split('\n').map((line) => line.trim())).toContain('> hello');
  });
});
