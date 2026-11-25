import type { ComponentProps } from 'react';

import { ChatApp } from '../chat-ink.js';
import { createChatStore, type ChatStoreController } from '../chat-store.js';
import type { HomeChatSession, HomeModelsPort } from '../home-controller.js';
import {
  FULLSCREEN_TRANSCRIPT_BOUND,
  INLINE_TRANSCRIPT_BOUND,
  type SessionViewSeed,
} from '../session-view-model.js';
import {
  mountHome,
  type HomeMount,
  type HomeSetup,
  type NativePromptChannel,
} from './home-host.js';
import { createNativePromptChannel } from '../native-prompt-channel.js';
import {
  createNotificationChannel,
  type NotificationChannel,
} from '../../../popups/notifications.js';
import type { DoctorPort } from '../../../popups/doctor-port.js';
import type { ReportsPort } from '../../../popups/report-port.js';
import type { SettingsPort } from '../../../popups/settings-port.js';
import { createPopupHost, type PopupHost } from '../../../popups/popup-host.js';
import type { PopupFrame } from '../../../popups/popup-reducer.js';
import { mountInk, type InkMount, type MountOptions } from './mount.js';
import type { Variant } from './variants.js';

/**
 * The two chat hosts of the surface matrix. A chat surface is the same `ChatView` under two owners: `ChatApp` for `relavium chat`, and
 * `RootApp` for the chat the Home hosts, so each is mounted in both and registered once, driven through the one {@link ChatMount} shape.
 */

type ChatAppProps = ComponentProps<typeof ChatApp>;

/** What a chat surface needs of the session behind it: the ports a card or a sheet reads, in the shape each host takes them. */
export interface ChatSetup {
  /** `true` ⇒ the chat is wired to a native prompt channel, as the chat driver wires it (a card flow can then be opened on it). */
  readonly nativePrompt?: boolean | undefined;
  /** What the store is seeded with (the bound model decides whether `/effort` has tiers to offer). */
  readonly seed?: SessionViewSeed | undefined;
  /** The store's own state before the surface opens (a transcript line, a mode). Called once, on the freshly built store. */
  readonly prepare?: ((store: ChatStoreController) => void) | undefined;
  /** Ports of the stand-alone chat (`ChatApp`'s own props). */
  readonly standalone?: Partial<Omit<ChatAppProps, 'store' | 'alternateScreen'>> | undefined;
  /** The Home-hosted chat's session ports, and the Home's own model catalog port (the Home's `/models` reads it). */
  readonly hosted?:
    | {
        readonly session?: Partial<Omit<HomeChatSession, 'store'>> | undefined;
        readonly models?: HomeModelsPort | undefined;
        readonly home?: HomeSetup | undefined;
      }
    | undefined;
  /** The chat's `/doctor` popup port: the stand-alone chat's prop, or the Home-hosted chat's session field (with the Home wired to open it). */
  readonly doctor?: DoctorPort | undefined;
  /**
   * The chat's report popups' port (`/agent`, `/cost`, `/workflows`, `/help`; ADR-0148 §10): the stand-alone chat's prop, or the Home-hosted
   * chat's session field (with the Home wired to open them).
   */
  readonly reports?: ReportsPort | undefined;
  /**
   * The chat's settings popups' port (`/effort` today; ADR-0148 §3, §6): the stand-alone chat's prop, or the Home-hosted chat's session field
   * (with the Home wired to open them).
   */
  readonly settings?: SettingsPort | undefined;
}

/** A mounted chat, whichever host owns it. */
export interface ChatMount extends InkMount {
  readonly host: 'chat' | 'standalone-chat';
  /** The host's popup host: the Home's, or the stand-alone chat's (on its store's key history). */
  readonly popups: PopupHost;
  /** The host's notification channel. */
  readonly notifications: NotificationChannel;
  /** The native prompt channel, when the setup asked for one. */
  readonly channel: NativePromptChannel | undefined;
  /** Register something to close when the cell ends (a temporary directory a real flow was pointed at). */
  defer: (cleanup: () => void) => void;
  readonly store: ChatStoreController;
  /** The lines the chat handed to its session (what was submitted, slash commands included). */
  readonly submitted: readonly string[];
  /** The frame as one string. */
  text: () => string;
  /**
   * Type a line the way a person does, as one chunk and then Enter: a typed `/name` is a command, never the palette (which only opens on a
   * lone `/`), so this is the way to run a command whatever the host.
   */
  typeLine: (line: string) => Promise<void>;
  /** Move the popup host's clock on by `ms` (real time plus what was skipped). */
  skip: (ms: number) => void;
  /** The popup on top of the host's popup host, as it is now. */
  popupFrame: () => PopupFrame | undefined;
}

const boundOf = (variant: Variant) =>
  variant.renderer === 'alt' ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND;

/** `relavium chat`: `ChatApp` over a store built for the variant, with the ports the surface asks for. */
export function mountStandaloneChat(
  variant: Variant,
  setup: ChatSetup = {},
  options: MountOptions = {},
): ChatMount {
  const store = createChatStore(variant.color, setup.seed, boundOf(variant));
  setup.prepare?.(store);
  const submitted: string[] = [];
  // As the chat host makes them: the native channel, the popups and the store share the store's ONE key history (ADR-0148 §2).
  const channel =
    setup.nativePrompt === true
      ? createNativePromptChannel({ history: store.keyHistory })
      : undefined;
  const notifications = createNotificationChannel();
  let skipped = 0;
  const popups = createPopupHost({
    now: () => performance.now() + skipped,
    history: store.keyHistory,
    notifications,
    placement: variant.renderer === 'alt' ? 'overlay' : 'replace',
  });
  const cleanups: (() => void)[] = [];
  const mount = mountInk(
    <ChatApp
      store={store}
      onSubmit={(message) => {
        submitted.push(message);
        return Promise.resolve();
      }}
      shouldStop={() => false}
      onExit={() => {}}
      onError={(cause) => {
        throw cause;
      }}
      onModeChange={() => {}}
      alternateScreen={variant.renderer === 'alt'}
      {...(channel === undefined ? {} : { modePrompt: { ui: channel.ui, ready: () => {} } })}
      popups={popups}
      notifications={notifications}
      {...(setup.doctor === undefined ? {} : { doctor: setup.doctor })}
      {...(setup.reports === undefined ? {} : { reports: setup.reports })}
      {...(setup.settings === undefined ? {} : { settings: setup.settings })}
      {...setup.standalone}
    />,
    variant,
    options,
  );
  return {
    ...mount,
    unmount: () => {
      mount.unmount();
      channel?.ui.dispose();
      popups.dispose();
      notifications.dispose();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    defer: (cleanup) => {
      cleanups.push(cleanup);
    },
    channel,
    popups,
    notifications,
    host: 'standalone-chat',
    store,
    submitted,
    text: () => mount.frame().join('\n'),
    typeLine: async (line) => {
      mount.key(line);
      await mount.settle();
      mount.key('\r');
      await mount.settle();
    },
    skip: (ms) => {
      skipped += ms;
    },
    popupFrame: () => popups.getSnapshot().frame,
  };
}

/** The chat the Home hosts: the Home with a first message sent, so a session and its store are in front of it. */
export async function mountHostedChat(
  variant: Variant,
  setup: ChatSetup = {},
  options: MountOptions = {},
): Promise<ChatMount> {
  const hosted = setup.hosted;
  const homeSetup: HomeSetup | undefined = {
    ...hosted?.home,
    ...(setup.nativePrompt === true ? { nativePrompt: true } : {}),
    ...(setup.doctor === undefined ? {} : { doctor: setup.doctor }),
    ...(setup.reports === undefined ? {} : { reports: setup.reports }),
    ...(setup.settings === undefined ? {} : { settings: setup.settings }),
  };
  const homeDeps = homeSetup?.deps;
  const submitted: string[] = [];
  const home: HomeMount = mountHome(
    variant,
    {
      ...homeSetup,
      ...(setup.seed === undefined ? {} : { chatSeed: setup.seed }),
      deps: (context) => ({
        ...(typeof homeDeps === 'function' ? homeDeps(context) : homeDeps),
        // The Home's chat opens `/models` only when a live reseat is wired (`reseatChat`); a reseat that never settles is enough to open it.
        ...(hosted?.models === undefined
          ? {}
          : { models: hosted.models, reseatChat: () => new Promise<never>(() => {}) }),
      }),
      session: (store) => {
        setup.prepare?.(store);
        return {
          store,
          sessionId: 'matrix-session',
          processLine: (line) => {
            submitted.push(line);
            return Promise.resolve();
          },
          shouldStop: () => false,
          stopReason: () => 'exit',
          teardown: () => Promise.resolve(),
          ...(setup.doctor === undefined ? {} : { doctor: setup.doctor }),
          ...(setup.reports === undefined ? {} : { reports: setup.reports }),
          ...(setup.settings === undefined ? {} : { settings: setup.settings }),
          ...hosted?.session,
        };
      },
    },
    options,
  );
  await home.settle();
  // A first message starts the chat; the controller enters it on the next microtask.
  home.controller.handleKey('h', {});
  home.controller.handleKey('', { return: true });
  await home.until(() => home.controller.getSnapshot().mode === 'chat');
  await home.settle();
  const store = home.chatStore;
  if (store === undefined) throw new Error('the Home did not build a chat store');
  submitted.length = 0; // the first message (`h`) started the chat; only what comes after belongs to the surface
  return {
    ...home,
    host: 'chat',
    store,
    submitted,
    text: () => home.frame().join('\n'),
    typeLine: async (line) => {
      home.key(line);
      await home.settle();
      home.key('\r');
      await home.settle();
    },
  };
}
