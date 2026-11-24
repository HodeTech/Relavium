import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createHomeController, type HomeController } from './home-controller.js';

/**
 * One fact, one wording (MVP-11 Step 2 review, C8): the bare Home has no conversation to clear. The palette shows `/clear` dim with the reason
 * and answers `Enter` on it with `/clear is unavailable: no conversation to clear.`; a TYPED `/clear` said `No active conversation to clear
 * — type a message to start one.` instead, which on a keyless Home even invited a message that cannot start a chat.
 */
const SNAPSHOT: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const ENTER = { return: true } as const;
const WORDS = '/clear is unavailable: no conversation to clear.';

function home(keyless: boolean): HomeController {
  return createHomeController({
    homeStore: { read: () => SNAPSHOT },
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: vi.fn(),
    onExit: () => {},
    onError: () => {},
    providerSetup: { initialKeyless: keyless, open: () => Promise.resolve() },
  });
}

describe.each([
  ['a Home with a key', false],
  ['a keyless Home', true],
])('%s: /clear with no conversation', (_name, keyless) => {
  it('answers the same words typed (as a pasted line) and from the dim palette row', () => {
    const typed = home(keyless);
    typed.handlePaste('/clear');
    typed.handleKey('', ENTER);
    expect(typed.getSnapshot().notice).toBe(WORDS);

    const palette = home(keyless);
    palette.handleKey('/', {});
    for (const ch of 'clear') palette.handleKey(ch, {});
    palette.handleKey('', ENTER);
    expect(palette.getSnapshot().notice).toBe(WORDS);
    expect(palette.getSnapshot().palette, 'a dim row keeps the palette open').toBeDefined();

    expect(typed.getSnapshot().notice).toBe(palette.getSnapshot().notice);
  });

  it('does not invite typing a message, and never starts a chat', () => {
    const c = home(keyless);
    c.handlePaste('/clear');
    c.handleKey('', ENTER);
    expect(c.getSnapshot().notice).not.toContain('type a message');
    expect(c.getSnapshot().mode).toBe('home');
  });
});
