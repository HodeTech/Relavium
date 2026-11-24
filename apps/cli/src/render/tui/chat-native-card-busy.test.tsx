import './force-color.js';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runExportCard, type ExportPort } from './export-card.js';
import { chatIsBusy } from './chat-ink.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
  type ChatSetup,
} from './surface-matrix/chat-host.js';
import { openModeFlow } from './surface-matrix/home-flows.js';
import { KEYS, type NativePromptChannel } from './surface-matrix/home-host.js';
import { CHAT_SURFACES } from './surface-matrix/surfaces-chat.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * A slash command that waits on its own card is not a running turn ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §2 and §3: a legend names what its key does, and a key that closes a card stops nothing). `/mode` and `/export` open a card of the native prompt
 * channel and the line handler waits on it, so the chat is "submitting" for as long as the card is up; the busy line (`Working… · Esc stops the turn`)
 * used to stay on screen the whole time, beside the card's own `Esc close`, and said an `Esc` that only closes the card stops the turn.
 *
 * Observed in the chat the Home hosts (the stand-alone chat hides its conversation behind the card, so it never drew the line); the stand-alone
 * chat is held to the same words here all the same.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

const VARIANT: Variant = { renderer: 'alt', color: true, size: { cols: 80, rows: 24 } };

/** The busy line's own words, the two halves a person reads. */
const BUSY_WORDS = ['Working…', 'Esc stops the turn'] as const;

const EXPORT_PORT: ExportPort = {
  prepare: (slug) => ({
    ok: true,
    offer: { kind: 'workflow', slug, destination: `./${slug}.yaml`, bytes: 4096 },
    commit: () => ({ ok: true, written: `Wrote ./${slug}.yaml.` }),
  }),
};

interface CardCommand {
  readonly line: string;
  /** What is on screen only while the command's card is. */
  readonly landmark: string;
  readonly open: (channel: NativePromptChannel, mount: ChatMount) => void;
}

const CARD_COMMANDS: readonly CardCommand[] = [
  {
    line: '/mode',
    landmark: 'Choose a global startup default',
    open: (_channel, mount) => {
      openModeFlow(mount);
    },
  },
  {
    line: '/export',
    landmark: 'Write the file',
    open: (channel) => {
      runExportCard({ flow: channel.flow, port: EXPORT_PORT }, 'nightly-report').catch(
        () => undefined,
      );
    },
  },
];

/** A promise that settles when the channel's card is gone: the line handler's wait on its own prompt. */
function untilCardCloses(channel: NativePromptChannel): Promise<void> {
  return new Promise((resolve) => {
    const stop = channel.ui.subscribe(() => {
      if (!channel.ui.getSnapshot().active) {
        stop();
        resolve();
      }
    });
  });
}

/** Mount a chat whose line handler opens the command's card and then waits for it, as the real handler does. */
async function mountWaiting(
  host: 'chat' | 'standalone-chat',
  command: CardCommand,
  aborted: () => void,
): Promise<ChatMount> {
  // The line handler is built before the chat it belongs to is mounted, and opens its card on that chat's own channel.
  const mounted: { chat?: ChatMount } = {};
  const handle = (line: string): Promise<void> => {
    const chat = mounted.chat;
    if (line !== command.line || chat?.channel === undefined) return Promise.resolve();
    command.open(chat.channel, chat);
    return untilCardCloses(chat.channel);
  };
  const setup: ChatSetup =
    host === 'chat'
      ? { nativePrompt: true, hosted: { session: { processLine: handle, onAbort: aborted } } }
      : { nativePrompt: true, standalone: { onSubmit: handle } };
  const mount =
    host === 'chat' ? await mountHostedChat(VARIANT, setup) : mountStandaloneChat(VARIANT, setup);
  mounted.chat = mount;
  await mount.settle();
  return mount;
}

describe.each(CARD_COMMANDS)('$line, which waits on its own card', (command) => {
  it.each(['chat', 'standalone-chat'] as const)(
    'draws no busy line and no Esc that stops a turn beside the card (%s)',
    async (host) => {
      const mount = await mountWaiting(host, command, () => {});
      try {
        await mount.typeLine(command.line);
        await mount.until(() => mount.text().includes(command.landmark));
        await mount.settle();
        const frame = mount.text();
        expect(frame, 'the card is up').toContain(command.landmark);
        for (const words of BUSY_WORDS) expect(frame, frame).not.toContain(words);
        expect(frame, 'the card names its own Esc').toMatch(/Esc (close|back|denies)/u);
      } finally {
        mount.unmount();
      }
    },
  );

  it.each(['chat', 'standalone-chat'] as const)(
    'closes the card on Esc and stops nothing: the legend on screen is the handler (%s)',
    async (host) => {
      const aborted = vi.fn();
      const mount = await mountWaiting(host, command, aborted);
      try {
        await mount.typeLine(command.line);
        await mount.until(() => mount.text().includes(command.landmark));
        await mount.settle();
        mount.key(KEYS.escape);
        // A lone ESC byte is told from the start of a sequence by a short wait in ink's input parser: real time, so the poll is by the clock.
        await vi.waitFor(
          async () => {
            await mount.settle();
            expect(mount.text()).not.toContain(command.landmark);
          },
          { timeout: 3000, interval: 20 },
        );
        expect(mount.text(), mount.text()).not.toContain(command.landmark);
        expect(aborted, 'Esc on a card is not the abort of a turn').not.toHaveBeenCalled();
        expect(mount.store.getSnapshot().state.status, 'no turn was running').not.toBe('running');
      } finally {
        mount.unmount();
      }
    },
  );
});

describe('a turn that really runs still says how to stop it', () => {
  it.each(['chat', 'standalone-chat'] as const)(
    'draws the busy line with Esc stops the turn while a turn streams (%s)',
    async (host) => {
      const mount =
        host === 'chat' ? await mountHostedChat(VARIANT, {}) : mountStandaloneChat(VARIANT, {});
      try {
        mount.store.apply({
          type: 'session:turn_started',
          sessionId: 'matrix-session',
          sequenceNumber: 1,
          timestamp: '2026-11-25T00:00:00.000Z',
        });
        mount.store.tick();
        await mount.until(() => mount.text().includes('Esc stops the turn'));
        expect(mount.text()).toContain('Working…');
        expect(mount.text()).toContain('Esc stops the turn');
      } finally {
        mount.unmount();
      }
    },
  );
});

describe('the commands that open a sheet or a picker of the chat itself', () => {
  // `/models`, `/effort`, `/permissions` and `/agent` are opened by the chat before it submits anything, so the chat is never "submitting"
  // behind them: whatever Esc does there (it closes the list), the screen must not also say that it stops a turn.
  const OWN_SURFACES = CHAT_SURFACES.filter((entry) =>
    ['model-picker', 'effort-picker', 'sheet-permissions', 'sheet-agent'].some((name) =>
      entry.id.endsWith(`.${name}`),
    ),
  );

  it.each(OWN_SURFACES)('$id says no turn is running', async (entry) => {
    const setup: ChatSetup =
      (typeof entry.setup === 'function' ? await entry.setup(VARIANT) : entry.setup) ?? {};
    const mount =
      entry.host === 'chat'
        ? await mountHostedChat(VARIANT, setup)
        : mountStandaloneChat(VARIANT, setup);
    try {
      await mount.settle();
      await entry.open(mount);
      await mount.settle();
      const frame = mount.text();
      expect(frame, 'the surface is open').toContain(
        typeof entry.landmark === 'string' ? entry.landmark : '',
      );
      for (const words of BUSY_WORDS) expect(frame, frame).not.toContain(words);
    } finally {
      mount.unmount();
    }
  });
});

describe('chatIsBusy', () => {
  const idle = { turnRunning: false, shellBusy: false, submitBusy: false, nativePrompt: false };

  it('is busy for a turn, a shell command and a submit, and idle for nothing', () => {
    expect(chatIsBusy(idle)).toBe(false);
    expect(chatIsBusy({ ...idle, turnRunning: true })).toBe(true);
    expect(chatIsBusy({ ...idle, shellBusy: true })).toBe(true);
    expect(chatIsBusy({ ...idle, submitBusy: true })).toBe(true);
  });

  it('is not busy for a submit that only waits on a card, but is for a turn or a shell command behind one', () => {
    expect(chatIsBusy({ ...idle, submitBusy: true, nativePrompt: true })).toBe(false);
    expect(chatIsBusy({ ...idle, submitBusy: true, nativePrompt: true, turnRunning: true })).toBe(
      true,
    );
    expect(chatIsBusy({ ...idle, submitBusy: true, nativePrompt: true, shellBusy: true })).toBe(
      true,
    );
    expect(chatIsBusy({ ...idle, nativePrompt: true })).toBe(false);
  });
});
