// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import './force-color.js';

/**
 * The `@` attachments of a chat follow its draft, in both chat hosts (MVP-11 unit 7, round 2 sitting #3): the chat the Home hosts (its
 * controller) and `relavium chat` (`ChatApp`), mounted on the real Ink renderer. One rule, `attachmentsOfDraft`, and one guard,
 * `PickEnterLock`, serve both owners, so each is pressed in each:
 *
 * - a file whose `@path` marker left the draft is dropped at that edit: its chip (`📎 @notes.md · Esc clears them`) goes from the screen, and
 *   a marker pasted later sends plain text (the sitting's `atbschat`);
 * - a held `Enter` that chose the file in the picker sends nothing, over the terminal's held-key grid (the first repeat after 250 to 1800 ms,
 *   then every 30 or 100 ms: `atheldchat`), and a patient `Enter` after the key was let go for the whole window sends the message with it.
 *
 * Both owners read the clock through `performance.now()`, which is moved on here by hand (real time plus what was skipped), so the windows pass
 * without a sleep. No escape of a special character is written into this file: each is built from its code point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PICK_ENTER_LOCKOUT_MS } from './attachments.js';
import type { MentionReader } from './mention.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import { KEYS } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

const CONTENT = 'FILE-CONTENT-MARKER-4242';
const READER: MentionReader = {
  list: () => Promise.resolve([{ name: 'notes.md', type: 'file', path: 'notes.md' }]),
  read: () => Promise.resolve({ content: CONTENT, sizeBytes: CONTENT.length }),
};
const VARIANT: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 30 } };
const ESC = String.fromCharCode(0x1b);
const BACKSPACE = String.fromCharCode(0x7f);
const paste = (text: string): string => `${ESC}[200~${text}${ESC}[201~`;
const CHIP = '📎 @notes.md';
const WAIT = { timeout: 5000, interval: 5 } as const;
vi.setConfig({ testTimeout: 30_000 });

type Host = 'chat' | 'standalone-chat';
const HOSTS: readonly Host[] = ['chat', 'standalone-chat'];

let skipped = 0;
beforeEach(() => {
  skipped = 0;
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skipped);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function mount(host: Host): Promise<ChatMount> {
  const m =
    host === 'chat'
      ? await mountHostedChat(VARIANT, { hosted: { session: { mentionReader: READER } } })
      : mountStandaloneChat(VARIANT, { standalone: { mentionReader: READER } });
  await m.settle();
  return m;
}

/** One key, landed on its own frame, at the clock as it is now. */
async function press(m: ChatMount, bytes: string): Promise<void> {
  m.key(bytes);
  await m.settle();
}

/** `@`, the listing, and the one `Enter` that chooses `notes.md`; then its read lands and the marker is in the draft. */
async function pickNotes(m: ChatMount): Promise<void> {
  await press(m, '@');
  await vi.waitFor(() => expect(m.text()).toContain('notes.md'), WAIT);
  await press(m, KEYS.enter);
  await vi.waitFor(() => expect(m.text()).toContain(CHIP), WAIT);
}

describe.each(HOSTS)('in the %s host', (host) => {
  it('atbschat: deleting the marker takes the chip away, and a marker pasted later sends plain text', async () => {
    const m = await mount(host);
    try {
      await pickNotes(m);
      for (let i = 0; i < '@notes.md '.length; i += 1) await press(m, BACKSPACE);
      await vi.waitFor(() => expect(m.text()).not.toContain('📎'), WAIT);
      for (const char of 'hello') await press(m, char);
      await press(m, paste(' @notes.md please'));
      expect(m.text(), 'a pasted marker brings no chip back').not.toContain('📎');
      await press(m, KEYS.enter);
      await vi.waitFor(() => expect(m.submitted).toEqual(['hello @notes.md please']), WAIT);
    } finally {
      m.unmount();
    }
  });

  it.each(
    [250, 500, 660, 1800].flatMap((delay) => [30, 100].map((rate) => [delay, rate] as const)),
  )(
    'atheldchat: a held Enter (first repeat after %i ms, then every %i ms) chooses the file and sends nothing; a patient Enter sends it',
    async (delay, rate) => {
      const m = await mount(host);
      try {
        await pickNotes(m);
        skipped += delay;
        for (let held = 0; held < 2 * PICK_ENTER_LOCKOUT_MS; held += rate) {
          await press(m, KEYS.enter);
          skipped += rate;
        }
        expect(m.submitted, 'nothing was sent').toEqual([]);
        expect(m.text()).toContain(CHIP);
        skipped += PICK_ENTER_LOCKOUT_MS;
        await press(m, KEYS.enter);
        await vi.waitFor(() => expect(m.submitted).toHaveLength(1), WAIT);
        expect(m.submitted[0]?.startsWith('@notes.md')).toBe(true);
        expect(m.submitted[0]).toContain(CONTENT);
      } finally {
        m.unmount();
      }
    },
  );

  it('a key typed right after the choice makes the next Enter the person’s', async () => {
    const m = await mount(host);
    try {
      await pickNotes(m);
      await press(m, 'x');
      await press(m, KEYS.enter);
      await vi.waitFor(() => expect(m.submitted).toHaveLength(1), WAIT);
      expect(m.submitted[0]?.startsWith('@notes.md x')).toBe(true);
      expect(m.submitted[0]).toContain(CONTENT);
    } finally {
      m.unmount();
    }
  });
});
