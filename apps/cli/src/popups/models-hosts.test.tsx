// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The `/models` popup in the hosts of the product ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §3, §6; [ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md); MVP-11 step 5): the chat the Home hosts, a
 * stand-alone chat and the bare Home, each in both placements.
 *
 * What it pins: a typed bare `/models` opens the popup from the host's own routing (never a submit); in a chat, `This chat` with another model
 * is the HOST's reseat (the stand-alone chat records the target and ends its driver; the Home rebuilds the chat in front through its builder),
 * and a build that fails says so on the Home's channel, never in the transcript; the model in force with another tier is the session's tier,
 * said on the hint row; `New chats` and the bare Home's `Enter` reach the Home's writer of the default and say what it came to on the hint
 * row (a refusal included), never as the Home's notice; the inline popup holds the tallest second step whole, so its `Enter` applies there
 * too; `/models x` and a host with no switch or no catalog dispatch the line; and the retired picker draws nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReasoningEffort } from '@relavium/shared';

import type { ReseatTarget } from '../commands/chat.js';
import { ConfigWriteRefusedError } from '../config/write.js';
import type { HomeChatSession, HomeModelsPort } from '../render/tui/home-controller.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { CATALOG, fakeModels, GRADED, OPENAI } from './models.test-support.js';
import { currentStep, visibleRows } from './popup-reducer.js';
import { MODEL_SWITCH_FAILED, type SettingsPort } from './settings-port.js';

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

/** The Home's catalog port over the test catalog, its default the graded model at `medium`, every write recorded (or failing as asked). */
function homeModels(write?: HomeModelsPort['writeDefault']) {
  const writes: { modelId: string; provider: string; effort: ReasoningEffort | undefined }[] = [];
  const port: HomeModelsPort = {
    load: () => ({ entries: CATALOG, refreshedAt: undefined }),
    refreshIfStale: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve({ providers: [] }),
    currentDefault: () => writes.at(-1)?.modelId ?? GRADED,
    currentEffort: () => 'medium',
    writeDefault: (modelId, provider, effort) => {
      writes.push({ modelId, provider, effort });
      return write?.(modelId, provider, effort) ?? Promise.resolve({ durability: 'confirmed' });
    },
  };
  return { port, writes };
}

/** What a chat host is mounted with: the session's settings port, the switch's record, and the Home's ports. */
function chatSetup(
  options: { readonly reseat?: 'never' | 'fails'; readonly switchless?: boolean } = {},
) {
  const announced: string[] = [];
  let bound: ((text: string) => void) | undefined;
  const fake = fakeModels({ noSwitch: true });
  const tiers: ReasoningEffort[] = [];
  const port: SettingsPort = {
    surface: 'standalone-chat',
    announce: (text) => {
      announced.push(text);
      bound?.(text);
    },
    models: {
      ...fake.member,
      setEffort: (tier) => {
        tiers.push(tier);
      },
    },
  };
  const reseats: ReseatTarget[] = [];
  const exits: number[] = [];
  const builds: { sessionId: string; target: ReseatTarget }[] = [];
  const home = homeModels();
  const reseatChat = (sessionId: string, target: ReseatTarget): Promise<HomeChatSession> => {
    builds.push({ sessionId, target });
    return options.reseat === 'fails'
      ? Promise.reject(new Error('the build failed'))
      : new Promise<never>(() => {});
  };
  return {
    port,
    announced,
    tiers,
    reseats,
    exits,
    builds,
    home,
    bind: (announce: ((text: string) => void) | undefined) => {
      bound = announce;
    },
    standalone: {
      ...(options.switchless === true
        ? {}
        : {
            onReseat: (target: ReseatTarget) => {
              reseats.push(target);
            },
          }),
      onExit: () => {
        exits.push(exits.length);
      },
      onSetEffort: (tier: ReasoningEffort) => {
        tiers.push(tier);
      },
    },
    hosted: {
      home: {
        deps: {
          models: home.port,
          ...(options.switchless === true ? {} : { reseatChat }),
        },
      },
      session: {
        onSetEffort: (tier: ReasoningEffort) => {
          tiers.push(tier);
        },
      },
    },
  };
}

async function mountChat(
  host: Host,
  variant: Variant,
  setup: ReturnType<typeof chatSetup>,
): Promise<ChatMount> {
  const m =
    host === 'chat'
      ? await mountHostedChat(variant, {
          settings: setup.port,
          seed: { model: GRADED, transcript: [] },
          hosted: setup.hosted,
        })
      : mountStandaloneChat(variant, {
          settings: setup.port,
          seed: { model: GRADED, transcript: [] },
          standalone: { ...setup.standalone, setAnnouncer: setup.bind },
        });
  // The Home binds the session's announcements to its channel in `driveHome`; the matrix Home has no line handler, so the test binds it.
  if (host === 'chat')
    setup.bind((text) => {
      m.notifications.notify(text);
    });
  await m.settle();
  return m;
}

const popupStep = (m: { readonly popups: ChatMount['popups'] }): number | undefined =>
  m.popups.getSnapshot().frame?.stepIndex;
const popupId = (m: { readonly popups: ChatMount['popups'] }): string | undefined =>
  m.popups.getSnapshot().frame?.spec.id;

/** Press `key` until the popup host admits it (a key on a frame not yet acknowledged is dropped by design), at most once after it moved. */
async function pressUntil(
  m: { readonly key: (bytes: string) => void },
  key: string,
  moved: () => boolean,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!moved()) m.key(key);
      expect(moved()).toBe(true);
    },
    { timeout: WAIT_MS, interval: 50 },
  );
}

/** `/models` typed, the popup open on its first step, its settle passed. */
async function openModels(m: ChatMount | HomeMount, type: () => Promise<void>): Promise<void> {
  await type();
  await vi.waitFor(() => expect(popupId(m)).toBe('models'), { timeout: WAIT_MS, interval: 15 });
  await vi.waitFor(() => expect(m.text()).toContain('models · '), {
    timeout: WAIT_MS,
    interval: 15,
  });
  m.skip(600);
}

/** The id of the row the popup's first step highlights now. */
const highlighted = (m: { readonly popups: ChatMount['popups'] }): string | undefined => {
  const frame = m.popups.getSnapshot().frame;
  if (frame === undefined) return undefined;
  const { state } = currentStep(frame);
  return visibleRows(state)[state.selected]?.id;
};

/** From the first step: `↓` until `gpt-5` is highlighted (a key on a frame not yet seen is dropped), `Enter` to its form. */
async function toOpenAiForm(m: ChatMount | HomeMount): Promise<void> {
  await vi.waitFor(
    () => {
      if (highlighted(m) !== OPENAI) m.key(KEYS.down);
      expect(highlighted(m)).toBe(OPENAI);
    },
    { timeout: WAIT_MS, interval: 50 },
  );
  await pressUntil(m, KEYS.enter, () => popupStep(m) === 1);
  await vi.waitFor(() => expect(m.text()).toContain('Reasoning effort'));
  m.skip(600);
}

const residue = (m: ChatMount) => ({
  transcript: m.store.getSnapshot().state.transcript,
  warnings: m.store.getSnapshot().state.warnings,
  notice:
    'controller' in m
      ? (m.controller as { getSnapshot: () => { notice?: string } }).getSnapshot().notice
      : undefined,
});

describe.each(HOSTS)('/models in the %s host', (host) => {
  describe.each(RENDERERS)('%s', (renderer) => {
    const variant = variantOf(renderer);

    it('a typed bare /models opens on the bound model from the host’s routing; This chat with another model is the host’s reseat; nothing is written', async () => {
      const setup = chatSetup();
      const m = await mountChat(host, variant, setup);
      try {
        const before = residue(m);
        await openModels(m, () => m.typeLine('/models'));
        expect(m.submitted).toEqual([]);
        expect(m.text()).toContain('current');
        await toOpenAiForm(m);
        // The data-leaves line is on the page before Enter (and the inline page holds the form whole, so Enter is offered there too).
        expect(m.text()).toContain('This chat moves from Anthropic to OpenAI.');
        expect(m.text()).toContain('Enter apply');
        await pressUntil(m, KEYS.enter, () => !m.popups.getSnapshot().open);
        if (host === 'standalone-chat') {
          expect(setup.reseats).toEqual([
            { modelId: OPENAI, provider: 'openai', reasoningEffort: 'medium' },
          ]);
          expect(setup.exits).toHaveLength(1);
        } else {
          await vi.waitFor(() => expect(setup.builds).toHaveLength(1));
          expect(setup.builds[0]).toEqual({
            sessionId: 'matrix-session',
            target: { modelId: OPENAI, provider: 'openai', reasoningEffort: 'medium' },
          });
        }
        expect(setup.announced).toEqual([]);
        expect(residue(m)).toEqual(before);
        expect(m.submitted).toEqual([]);
      } finally {
        m.unmount();
      }
    });

    it('the bound model with another tier is the session’s tier, said on the hint row once the popup is gone', async () => {
      const setup = chatSetup();
      const m = await mountChat(host, variant, setup);
      try {
        const before = residue(m);
        await openModels(m, () => m.typeLine('/models'));
        await pressUntil(m, KEYS.enter, () => popupStep(m) === 1);
        m.skip(600);
        m.key(KEYS.right);
        await m.settle();
        await pressUntil(m, KEYS.enter, () => !m.popups.getSnapshot().open);
        expect(setup.tiers).toEqual(['high']);
        expect(setup.reseats).toEqual([]);
        expect(setup.builds).toEqual([]);
        await vi.waitFor(() =>
          expect(m.text()).toContain('Reasoning effort: high · applies to the next message'),
        );
        expect(residue(m)).toEqual(before);
      } finally {
        m.unmount();
      }
    });

    it('`/models x` and a host with no switch dispatch the line (no popup; the retired picker draws nothing)', async () => {
      for (const [options, line] of [
        [{}, '/models x'],
        [{ switchless: true }, '/models'],
      ] as const) {
        const setup = chatSetup(options);
        const m = await mountChat(host, variant, setup);
        try {
          await m.typeLine(line);
          await vi.waitFor(() => expect(m.submitted).toEqual([line]), {
            timeout: WAIT_MS,
            interval: 15,
          });
          expect(m.popups.getSnapshot().open).toBe(false);
          expect(m.text()).not.toContain('Switch this chat’s model');
        } finally {
          m.unmount();
        }
      }
    });
  });
});

describe('the chat the Home hosts: its own switch and the Home’s writer', () => {
  it('a reseat whose build fails says so on the Home’s channel, never in the transcript, and the chat stays', async () => {
    const setup = chatSetup({ reseat: 'fails' });
    const m = await mountChat('chat', variantOf('alt'), setup);
    try {
      const before = residue(m);
      await openModels(m, () => m.typeLine('/models'));
      await toOpenAiForm(m);
      await pressUntil(m, KEYS.enter, () => !m.popups.getSnapshot().open);
      await vi.waitFor(() =>
        expect(m.notifications.getSnapshot().current?.text).toBe(MODEL_SWITCH_FAILED),
      );
      expect(residue(m)).toEqual(before);
    } finally {
      m.unmount();
    }
  });

  it('`New chats` writes the default through the Home’s writer and says it on the hint row; this chat is not switched', async () => {
    const setup = chatSetup();
    const m = await mountChat('chat', variantOf('inline'), setup);
    try {
      const before = residue(m);
      await openModels(m, () => m.typeLine('/models'));
      await toOpenAiForm(m);
      m.key(KEYS.down);
      await m.settle();
      await pressUntil(m, KEYS.enter, () => !m.popups.getSnapshot().open);
      await vi.waitFor(() => expect(setup.home.writes).toHaveLength(1));
      expect(setup.home.writes[0]).toEqual({
        modelId: OPENAI,
        provider: 'openai',
        effort: 'medium',
      });
      await vi.waitFor(() =>
        expect(m.notifications.getSnapshot().current?.text).toBe(
          'Default model: gpt-5 · applies to new chats',
        ),
      );
      expect(setup.builds).toEqual([]);
      expect(residue(m)).toEqual(before);
    } finally {
      m.unmount();
    }
  });
});

describe.each(RENDERERS)('/models on the bare Home (%s)', (renderer) => {
  const variant = variantOf(renderer);
  const typeKeys = async (m: HomeMount, line: string): Promise<void> => {
    for (const letter of line) m.controller.handleKey(letter, {});
    m.controller.handleKey('', { return: true });
    await m.settle();
  };

  it('opens from the Home’s routing over the Home’s own port; Enter sets the default through the Home’s writer and says so on the hint row', async () => {
    const home = homeModels();
    const m = mountHome(variant, { deps: { models: home.port } });
    try {
      await m.settle();
      await openModels(m, () => typeKeys(m, '/models'));
      expect(m.popups.getSnapshot().frame?.spec.origin).toBe('home');
      await toOpenAiForm(m);
      // No live chat: no `Apply to`, and the line says where new chats go.
      expect(m.text()).not.toContain('Apply to');
      expect(m.text()).toContain('New chats move from Anthropic to OpenAI.');
      expect(m.text()).toContain('Enter set default');
      await pressUntil(m, KEYS.enter, () => !m.popups.getSnapshot().open);
      await vi.waitFor(() => expect(home.writes).toHaveLength(1));
      expect(home.writes[0]).toEqual({ modelId: OPENAI, provider: 'openai', effort: 'medium' });
      await vi.waitFor(() =>
        expect(m.notifications.getSnapshot().current?.text).toBe(
          'Default model: gpt-5 · applies to new chats',
        ),
      );
      expect(m.controller.getSnapshot().notice).toBeUndefined();
      expect(m.controller.getSnapshot().submitBusy).toBe(false);
    } finally {
      m.unmount();
    }
  });

  it('a refused write says why on the hint row, and the Home takes input again', async () => {
    const home = homeModels(() => Promise.reject(new ConfigWriteRefusedError()));
    const m = mountHome(variant, { deps: { models: home.port } });
    try {
      await m.settle();
      await openModels(m, () => typeKeys(m, '/models'));
      await toOpenAiForm(m);
      await pressUntil(m, KEYS.enter, () => !m.popups.getSnapshot().open);
      await vi.waitFor(() =>
        expect(m.notifications.getSnapshot().current?.text).toBe(
          'Default not saved: the config is a symbolic link',
        ),
      );
      expect(m.controller.getSnapshot().notice).toBeUndefined();
      expect(m.controller.getSnapshot().submitBusy).toBe(false);
    } finally {
      m.unmount();
    }
  });

  it('a Home with no catalog says it in one line, and opens nothing', async () => {
    const m = mountHome(variant, {});
    try {
      await m.settle();
      await typeKeys(m, '/models');
      expect(m.popups.getSnapshot().open).toBe(false);
      expect(m.controller.getSnapshot().notice).toBe('/models is unavailable here.');
    } finally {
      m.unmount();
    }
  });
});
