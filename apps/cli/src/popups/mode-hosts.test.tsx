// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The `/mode` popup in the hosts of the product ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 unit 8, OD-25: one list, two actions): the chat the Home hosts and a stand-alone chat, each in both placements. What it pins: a
 * typed bare `/mode` opens the popup from the host's own routing, before any submit; `Enter` applies the highlighted mode to this chat through the
 * port and closes the popup (ONE step: there is no second screen), `Enter` on the mode in force keeps, `[s]` hands the highlighted mode to the
 * startup-default flow; nothing reaches the transcript, its warnings line or the Home's notice; a typed `/mode plan` and a host whose port has no
 * `/mode` member dispatch the line, as before.
 */
import type { ChatMode } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { KEYS } from '../render/tui/surface-matrix/home-host.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import type { SettingsPort } from './settings-port.js';

type Host = 'chat' | 'standalone-chat';
const HOSTS: readonly Host[] = ['chat', 'standalone-chat'];
const RENDERERS = ['alt', 'inline'] as const;
const variantOf = (renderer: (typeof RENDERERS)[number]): Variant => ({
  renderer,
  color: false,
  size: { cols: 80, rows: 24 },
});

/** A patient press: past the form's lockout after the answer that reached it (a held key never applies a form; an early press restarts the wait). */
const PATIENT_MS = APPROVAL_LOCKOUT_MS + 100;
const WAIT_MS = 10_000;
vi.setConfig({ testTimeout: 3 * WAIT_MS });

afterEach(() => {
  vi.useRealTimers();
});

/** A settings port with a `/mode` member over fakes (the mode in force `ask`), every apply and hand-off recorded; or one without it. */
function settingsWith(withMode: boolean) {
  const applied: ChatMode[] = [];
  const saved: ChatMode[] = [];
  let current: ChatMode = 'ask';
  const port: SettingsPort = {
    surface: 'standalone-chat',
    announce: () => {},
    ...(withMode
      ? {
          mode: {
            scope: 'chat' as const,
            current: () => current,
            apply: (mode: ChatMode) => {
              applied.push(mode);
              current = mode;
              return true;
            },
            startup: () => 'ask' as const,
            saveStartupDefault: (mode: ChatMode) => {
              saved.push(mode);
              return Promise.resolve({ kind: 'said' as const });
            },
          },
        }
      : {}),
  };
  return { port, applied, saved };
}

async function mountWith(host: Host, variant: Variant, port: SettingsPort): Promise<ChatMount> {
  const m =
    host === 'chat'
      ? await mountHostedChat(variant, { settings: port })
      : mountStandaloneChat(variant, { settings: port });
  await m.settle();
  return m;
}

const popupStep = (m: ChatMount): string | undefined => {
  const frame = m.popups.getSnapshot().frame;
  return frame === undefined ? undefined : `${frame.spec.id}:${String(frame.stepIndex)}`;
};
const residue = (m: ChatMount) => ({
  transcript: m.store.getSnapshot().state.transcript,
  warnings: m.store.getSnapshot().state.warnings,
  notice:
    'controller' in m
      ? (m.controller as { getSnapshot: () => { notice?: string } }).getSnapshot().notice
      : undefined,
});

/**
 * Press `Enter` until the popup leaves `from` (a key on a frame that has not been acknowledged yet is dropped by the host by design, and a
 * settle does not promise the acknowledgement under load). The first admitted press moves it, and nothing is pressed after that.
 */
async function enterFrom(m: ChatMount, from: string | undefined): Promise<void> {
  await vi.waitFor(
    () => {
      if (popupStep(m) === from) {
        // A patient press, a moment after the key before it: a form's `Enter` inside the previous key's quiet gap is a held key's repeat and
        // never applies (`popup-host.ts`, "A held key never applies a form").
        m.skip(PATIENT_MS);
        m.key(KEYS.enter);
      }
      expect(popupStep(m)).not.toBe(from);
    },
    { timeout: WAIT_MS, interval: 50 },
  );
}

describe.each(HOSTS)('/mode in the %s host', (host) => {
  describe.each(RENDERERS)('%s', (renderer) => {
    const variant = variantOf(renderer);

    it('a typed bare /mode opens the popup from the host’s routing; ↓ then one Enter applies plan to this chat and closes; nothing else is written', async () => {
      const settings = settingsWith(true);
      const m = await mountWith(host, variant, settings.port);
      try {
        const before = residue(m);
        await m.typeLine('/mode');
        await vi.waitFor(() => expect(popupStep(m)).toBe('mode:0'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        // the state words, right-aligned: the mode in force is also the startup default
        await vi.waitFor(() => expect(m.text()).toContain('this chat · startup'));
        expect(m.text()).not.toContain('step 1 of');
        expect(m.submitted).toEqual([]);
        m.skip(PATIENT_MS);
        m.key(KEYS.down); // ask → plan
        await m.settle();
        await vi.waitFor(() => expect(m.text()).toContain('Enter use in this chat'));
        await enterFrom(m, 'mode:0');
        expect(m.popups.getSnapshot().open).toBe(false);
        expect(settings.applied).toEqual(['plan']);
        expect(settings.saved).toEqual([]);
        expect(residue(m)).toEqual(before);
        expect(m.submitted).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('Enter on the mode the popup opened on keeps it: the popup closes, nothing is applied or handed off, and no second screen opens', async () => {
      const settings = settingsWith(true);
      const m = await mountWith(host, variant, settings.port);
      try {
        await m.typeLine('/mode');
        await vi.waitFor(() => expect(popupStep(m)).toBe('mode:0'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        await vi.waitFor(() => expect(m.text()).toContain('Enter keep'));
        await enterFrom(m, 'mode:0');
        expect(m.popups.getSnapshot().open).toBe(false);
        expect(settings.applied).toEqual([]);
        expect(settings.saved).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('[s] hands the highlighted mode to the startup-default flow: the popup closes and applies nothing to this chat', async () => {
      const settings = settingsWith(true);
      const m = await mountWith(host, variant, settings.port);
      try {
        await m.typeLine('/mode');
        await vi.waitFor(() => expect(popupStep(m)).toBe('mode:0'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        m.skip(PATIENT_MS);
        m.key(KEYS.down); // plan
        await m.settle();
        await vi.waitFor(() => expect(m.text()).toContain('[s] startup'));
        await vi.waitFor(
          () => {
            if (popupStep(m) === 'mode:0') {
              m.skip(PATIENT_MS);
              m.key('s');
            }
            expect(settings.saved).toEqual(['plan']);
          },
          { timeout: WAIT_MS, interval: 50 },
        );
        expect(m.popups.getSnapshot().open).toBe(false);
        expect(settings.applied).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('a bare /mode chosen in the / palette opens the popup the same way (never a submit)', async () => {
      const settings = settingsWith(true);
      const m = await mountWith(host, variant, settings.port);
      try {
        m.key('/');
        await vi.waitFor(() => expect(m.text()).toContain('Enter run'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        for (const char of 'mode') m.key(char);
        await m.settle();
        m.key(KEYS.enter);
        await vi.waitFor(() => expect(popupStep(m)).toBe('mode:0'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        expect(m.submitted).toEqual([]);
        expect(settings.applied).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('`/mode plan` and a host whose port has no /mode member dispatch the line (no popup)', async () => {
      for (const [settings, line] of [
        [settingsWith(true), '/mode plan'],
        [settingsWith(false), '/mode'],
      ] as const) {
        const m = await mountWith(host, variant, settings.port);
        try {
          await m.typeLine(line);
          await vi.waitFor(() => expect(m.submitted).toEqual([line]), {
            timeout: WAIT_MS,
            interval: 15,
          });
          expect(m.popups.getSnapshot().open).toBe(false);
          expect(settings.applied).toEqual([]);
        } finally {
          m.unmount();
        }
      }
    });
  });
});
