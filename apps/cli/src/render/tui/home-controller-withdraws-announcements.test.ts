/**
 * The Home's notifications are about the Home, so they go when a conversation comes in front (MVP-11 unit 7, round 1: CO76;
 * `withdrawAnnouncements`), once, and not before: typing on the Home and a provider state change leave them where they are.
 */
import { describe, expect, it, vi } from 'vitest';

import { createHomeController, type HomeChatSession } from './home-controller.js';
import { ENTER, settle, snapshotOf } from './home-controller.test-support.js';

describe('the Home withdraws its announcements when a conversation comes in front, and not before', () => {
  it('typing and a provider state change leave them; starting the chat withdraws them once', async () => {
    const withdraw = vi.fn();
    const controller = createHomeController({
      startChat: () => new Promise<HomeChatSession>(() => {}),
      homeStore: { read: () => snapshotOf({}) },
      withdrawAnnouncements: withdraw,
      onExit: () => {},
      onError: (cause) => {
        throw cause;
      },
    });
    controller.handleKey('a', {});
    controller.handleKey('b', {});
    controller.setProviderState(false);
    expect(controller.getSnapshot().mode).toBe('home');
    expect(withdraw, 'the Home is still the Home').not.toHaveBeenCalled();
    controller.handleKey('', ENTER);
    await settle();
    expect(controller.getSnapshot().mode).not.toBe('home');
    expect(withdraw).toHaveBeenCalledTimes(1);
    controller.setProviderState(true);
    await settle();
    expect(
      withdraw,
      'a change while the conversation is in front withdraws nothing more',
    ).toHaveBeenCalledTimes(1);
  });
});
