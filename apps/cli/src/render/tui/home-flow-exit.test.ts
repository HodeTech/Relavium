/** A flow that comes to a sentence after the Home began to close says nothing (`announceFlowResult`): a closing channel is not told. */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createHomeController } from './home-controller.js';

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('a flow that comes to a sentence after the Home began to close', () => {
  it.each(['/init', '/import', '/pricing'] as const)(
    'R2-24 %s: the one notification is not said on a channel that is going',
    async (line) => {
      let finish: (text: string | undefined) => void = () => undefined;
      const result = new Promise<string | undefined>((resolve) => {
        finish = resolve;
      });
      const announce = vi.fn<(text: string) => void>();
      const flow = () => result;
      const controller = createHomeController({
        startChat: () => new Promise(() => undefined),
        homeStore: { read: () => EMPTY },
        schedule: () => () => undefined,
        onExit: vi.fn(),
        onError: (cause) => {
          throw cause;
        },
        announce,
        initializeProject: flow,
        importDefined: flow,
        pricing: flow,
      });
      controller.handlePaste(line);
      controller.handleKey('', { return: true });
      await settle();
      expect(controller.getSnapshot().nativeActionBusy, 'the flow is open').toBe(true);
      const terminating = controller.teardownActive();
      finish('Nothing was created.');
      await terminating;
      await settle();
      expect(announce).not.toHaveBeenCalled();
    },
  );

  it('R2-25 the same sentence, for a Home that stays, is said once', async () => {
    const announce = vi.fn<(text: string) => void>();
    const controller = createHomeController({
      startChat: () => new Promise(() => undefined),
      homeStore: { read: () => EMPTY },
      schedule: () => () => undefined,
      onExit: vi.fn(),
      onError: (cause) => {
        throw cause;
      },
      announce,
      initializeProject: () => Promise.resolve('Nothing was created.'),
    });
    controller.handlePaste('/init');
    controller.handleKey('', { return: true });
    await settle();
    expect(announce).toHaveBeenCalledExactlyOnceWith('Nothing was created.');
  });
});
