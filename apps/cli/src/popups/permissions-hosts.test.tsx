// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The chat's `/permissions` popup in the hosts of the product ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2 as a popup, ADR-0148 §3, §6, §10; MVP-11 step 5c): the chat the Home hosts and a stand-alone chat, each in both placements. What it pins: a
 * typed bare `/permissions` opens the popup from the host's own routing (never through a submit, and never the retired docked sheet); `[d]`
 * then `Enter` withdraws the highlighted row through the port, the popup stays on the lists read again, and the host's notification says so;
 * nothing reaches the transcript, its warnings line or the Home's notice; an `Enter` that comes too soon withdraws nothing; a typed
 * `/permissions x` and a host with no settings port dispatch the line as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PermissionEntry,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../permissions/chat-permissions.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { KEYS } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { PERMISSIONS_STEP } from './permissions-popup.js';
import type { SettingsPort } from './settings-port.js';

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

const SNAPSHOT: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [{ id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' }],
  },
  session: [{ argv: ['git', 'status'], text: 'git status', alsoRemembered: false }],
};

/** A settings port whose only member is `/permissions` over a fake port, every withdrawal and announcement recorded. */
function permissionsSettings() {
  let current = SNAPSHOT;
  const withdrawn: PermissionEntry[] = [];
  const announced: string[] = [];
  let bound: ((text: string) => void) | undefined;
  const port: SettingsPort = {
    surface: 'standalone-chat',
    announce: (text) => {
      announced.push(text);
      bound?.(text);
    },
    permissions: {
      mode: () => 'ask',
      port: {
        surface: 'chat',
        load: () => current,
        withdraw: (entry): WithdrawAnswer => {
          withdrawn.push(entry);
          if (entry.kind === 'project') current = { ...current, project: { ok: true, rows: [] } };
          return { tone: 'done', text: 'Withdrawn. Auto mode asks about it again.' };
        },
      },
    },
  };
  return {
    port,
    withdrawn,
    announced,
    bind: (announce: ((text: string) => void) | undefined) => {
      bound = announce;
    },
  };
}

async function mountWith(
  host: Host,
  variant: Variant,
  settings: ReturnType<typeof permissionsSettings> | undefined,
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

const residue = (m: ChatMount) => ({
  transcript: m.store.getSnapshot().state.transcript,
  warnings: m.store.getSnapshot().state.warnings,
  notice:
    'controller' in m
      ? (m.controller as { getSnapshot: () => { notice?: string } }).getSnapshot().notice
      : undefined,
});

/** `/permissions` typed, the popup drawn on its lists and its settle time passed. */
async function openList(m: ChatMount): Promise<void> {
  await m.typeLine('/permissions');
  await vi.waitFor(() => expect(m.popups.getSnapshot().frame?.spec.id).toBe('permissions'), {
    timeout: WAIT_MS,
    interval: 15,
  });
  await vi.waitFor(() => expect(m.text()).toContain('This project · remembered (1)'), {
    timeout: WAIT_MS,
    interval: 15,
  });
  await m.settle();
  m.skip(600);
}

/**
 * `[d]`, and the withdrawal's line drawn and acknowledged. A `[d]` the host dropped (a key that arrives before the popup's first frame was
 * acknowledged is dropped, and a loaded machine makes that race possible) arms nothing, so it is pressed again, a gap later, until the popup is on
 * its line: and never once it is, because a second `d` on the line is a key typed since `[d]`.
 */
async function arm(m: ChatMount): Promise<void> {
  const onLine = (): boolean =>
    m.popups.getSnapshot().frame?.stepIndex === PERMISSIONS_STEP.withdraw;
  m.key('d');
  await m.settle();
  await vi.waitFor(
    () => {
      if (!onLine()) m.key('d');
      expect(onLine()).toBe(true);
    },
    { timeout: WAIT_MS, interval: 400 },
  );
  await vi.waitFor(() => expect(m.text()).toContain('Withdraw this remembered command?'), {
    timeout: WAIT_MS,
    interval: 15,
  });
  await m.settle();
}

describe.each(HOSTS)('/permissions in the %s host', (host) => {
  describe.each(RENDERERS)('%s', (renderer) => {
    const variant = variantOf(renderer);

    it('a typed bare /permissions opens the popup from the host’s routing; [d] then Enter withdraws the row, the lists are read again, the host announces it; nothing else is written', async () => {
      const settings = permissionsSettings();
      const m = await mountWith(host, variant, settings);
      try {
        const before = residue(m);
        await openList(m);
        expect(m.submitted, 'the line was never submitted').toEqual([]);
        // The retired docked sheet's title is drawn nowhere.
        expect(m.text()).not.toContain('Permissions · ask mode');
        await arm(m);
        expect(m.text()).toContain('Enter withdraw');
        // 900 ms after the line, but inside two seconds of the Enter that typed the command: that key starts the line's lockout (a held Enter
        // cannot reach the line on its repeat), so this one withdraws nothing and says why.
        m.skip(900);
        m.key(KEYS.enter);
        await vi.waitFor(() => expect(m.text()).toContain('Nothing withdrawn: too soon.'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        expect(settings.withdrawn).toEqual([]);
        // Asked again once the lockout has passed: the patient Enter withdraws.
        m.skip(2100);
        await arm(m);
        m.skip(900);
        m.key(KEYS.enter);
        await vi.waitFor(() => expect(settings.withdrawn).toHaveLength(1), {
          timeout: WAIT_MS,
          interval: 15,
        });
        expect(settings.withdrawn[0]).toMatchObject({ kind: 'project', row: { id: 'a' } });
        await vi.waitFor(() => expect(m.text()).toContain('This project · remembered (0)'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        expect(m.popups.getSnapshot().open, 'the popup stays on the lists').toBe(true);
        expect(settings.announced).toEqual(['Withdrawn: npm, 1 argument']);
        await vi.waitFor(() => expect(m.text()).toContain('Withdrawn: npm, 1 argument'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        expect(residue(m)).toEqual(before);
        expect(m.submitted).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('an Enter too soon after [d] withdraws nothing, and the popup says why', async () => {
      const settings = permissionsSettings();
      const m = await mountWith(host, variant, settings);
      try {
        await openList(m);
        await arm(m);
        m.key(KEYS.enter);
        await vi.waitFor(() => expect(m.text()).toContain('Nothing withdrawn: too soon.'), {
          timeout: WAIT_MS,
          interval: 15,
        });
        expect(settings.withdrawn).toEqual([]);
        expect(settings.announced).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('`/permissions x` and a host with no settings port dispatch the line (no popup, no sheet)', async () => {
      for (const [settings, line] of [
        [permissionsSettings(), '/permissions x'],
        [undefined, '/permissions'],
      ] as const) {
        const m = await mountWith(host, variant, settings);
        try {
          await m.typeLine(line);
          await vi.waitFor(() => expect(m.submitted).toEqual([line]), {
            timeout: WAIT_MS,
            interval: 15,
          });
          expect(m.popups.getSnapshot().open).toBe(false);
          expect(m.text()).not.toContain('Permissions · ask mode');
          expect(settings?.withdrawn ?? []).toEqual([]);
        } finally {
          m.unmount();
        }
      }
    });
  });
});
