// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The `/effort` popup in the hosts of the product ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 step 5): the chat the Home hosts and a stand-alone chat, each in both placements. What it pins: a typed or palette-selected bare
 * `/effort` opens the popup from the host's own routing (never through a submit); `Enter` applies the tier through the port, closes the popup,
 * and the host's notification says so on the hint row once the popup is gone; nothing reaches the transcript, its warnings line or the Home's
 * notice; a typed `/effort high`, a model with no tier and a host with no settings port dispatch the line as before; and the retired overlay
 * draws nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReasoningEffort } from '@relavium/shared';

import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { KEYS } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { openSettings, type SettingsPort } from './settings-port.js';

type Host = 'chat' | 'standalone-chat';
const HOSTS: readonly Host[] = ['chat', 'standalone-chat'];
const RENDERERS = ['alt', 'inline'] as const;
const variantOf = (renderer: (typeof RENDERERS)[number]): Variant => ({
  renderer,
  color: false,
  size: { cols: 80, rows: 24 },
});

const WAIT_MS = 10_000;
vi.setConfig({ testTimeout: 3 * WAIT_MS });

afterEach(() => {
  vi.useRealTimers();
});

/** A settings port whose `/effort` offers `tiers`, the tier in force `low`, every apply and announcement recorded. */
function settingsWith(tiers: readonly ReasoningEffort[]) {
  const applied: ReasoningEffort[] = [];
  const announced: string[] = [];
  let current: ReasoningEffort | undefined = 'low';
  // The host binds the announcement to its channel; the fixture forwards to whatever it bound (as the line handler's `announce` does).
  let bound: ((text: string) => void) | undefined;
  const port: SettingsPort = {
    surface: 'standalone-chat',
    announce: (text) => {
      announced.push(text);
      bound?.(text);
    },
    effort: {
      model: () => 'claude-sonnet-4-6',
      tiers: () => tiers,
      current: () => current,
      apply: (effort) => {
        applied.push(effort);
        current = effort;
      },
    },
  };
  return {
    port,
    applied,
    announced,
    bind: (announce: ((text: string) => void) | undefined) => {
      bound = announce;
    },
  };
}

async function mountWith(
  host: Host,
  variant: Variant,
  settings: ReturnType<typeof settingsWith> | undefined,
): Promise<ChatMount> {
  const setup = settings === undefined ? {} : { settings: settings.port };
  const m =
    host === 'chat'
      ? await mountHostedChat(variant, setup)
      : mountStandaloneChat(variant, {
          ...setup,
          ...(settings === undefined ? {} : { standalone: { setAnnouncer: settings.bind } }),
        });
  // The Home binds the session's announcements to its channel in `driveHome`; the matrix Home has no line handler, so the test binds it.
  if (host === 'chat' && settings !== undefined)
    settings.bind((text) => {
      m.notifications.notify(text);
    });
  await m.settle();
  return m;
}

const popupId = (m: ChatMount): string | undefined => m.popups.getSnapshot().frame?.spec.id;
const residue = (m: ChatMount) => ({
  transcript: m.store.getSnapshot().state.transcript,
  warnings: m.store.getSnapshot().state.warnings,
  notice:
    'controller' in m
      ? (m.controller as { getSnapshot: () => { notice?: string } }).getSnapshot().notice
      : undefined,
});

describe.each(HOSTS)('/effort in the %s host', (host) => {
  describe.each(RENDERERS)('%s', (renderer) => {
    const variant = variantOf(renderer);

    it('a typed bare /effort opens the popup from the host’s routing; Enter applies, closes and announces on the hint row; nothing else is written', async () => {
      const settings = settingsWith(['off', 'low', 'medium', 'high', 'max']);
      const m = await mountWith(host, variant, settings);
      try {
        const before = residue(m);
        await m.typeLine('/effort');
        await vi.waitFor(() => expect(popupId(m)).toBe('effort'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        await vi.waitFor(() => expect(m.text()).toContain('brief reasoning · current'));
        expect(m.submitted).toEqual([]);
        // Past the opening guard's settle time: the popup host's clock is real time plus what was skipped.
        m.skip(600);
        m.key('\u001b[B'); // ↓: low → medium
        await m.settle();
        // A key on a frame that has not been acknowledged yet is dropped by the host (by design), and `settle` does not promise the
        // acknowledgement under load: press `Enter` until it is admitted. The first admitted press applies (the port records it at once),
        // and nothing is pressed again after that, so it cannot apply twice.
        await vi.waitFor(
          () => {
            if (m.popups.getSnapshot().open && settings.applied.length === 0) m.key(KEYS.enter);
            expect(m.popups.getSnapshot().open).toBe(false);
          },
          { timeout: WAIT_MS, interval: 50 },
        );
        expect(settings.applied).toEqual(['medium']);
        expect(settings.announced).toEqual([
          'Reasoning effort: medium · applies to the next message',
        ]);
        // The host's own notification, drawn on the hint row now the popup is gone.
        expect(m.notifications.getSnapshot().current?.text).toBe(
          'Reasoning effort: medium · applies to the next message',
        );
        await vi.waitFor(() => expect(m.text()).toContain('Reasoning effort: medium'));
        expect(residue(m)).toEqual(before);
        expect(m.submitted).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('`/effort high`, a model with no tier, and a host with no settings port dispatch the line (no popup, no overlay)', async () => {
      for (const [settings, line] of [
        [settingsWith(['low', 'high']), '/effort high'],
        [settingsWith([]), '/effort'],
        [undefined, '/effort'],
      ] as const) {
        const m = await mountWith(host, variant, settings);
        try {
          await m.typeLine(line);
          await vi.waitFor(() => expect(m.submitted).toEqual([line]), {
            timeout: WAIT_MS,
            interval: 15,
          });
          expect(m.popups.getSnapshot().open).toBe(false);
          // The retired overlay's header is drawn nowhere.
          expect(m.text()).not.toContain('Reasoning effort ·');
          expect(settings?.applied ?? []).toEqual([]);
        } finally {
          m.unmount();
        }
      }
    });
  });
});

describe('openSettings, the eager loader', () => {
  it('loads the lazy half and opens through it; a refused open is the host’s answer', async () => {
    const settings = settingsWith(['low', 'high']);
    const m = mountStandaloneChat(variantOf('alt'), { settings: settings.port });
    try {
      await m.settle();
      await openSettings({
        host: m.popups,
        port: settings.port,
        command: 'effort',
        origin: 'chat',
      });
      expect(popupId(m)).toBe('effort');
    } finally {
      m.unmount();
    }
  });
});
