import type { ComponentProps } from 'react';

import type { ModelCatalogEntry } from '@relavium/llm';

import type { ChatModelsPort } from '../../../commands/chat.js';
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
}

/** A mounted chat, whichever host owns it. */
export interface ChatMount extends InkMount {
  readonly host: 'chat' | 'standalone-chat';
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
  const channel = setup.nativePrompt === true ? createNativePromptChannel() : undefined;
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
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    defer: (cleanup) => {
      cleanups.push(cleanup);
    },
    channel,
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
  };
}

/** The chat the Home hosts: the Home with a first message sent, so a session and its store are in front of it. */
export async function mountHostedChat(
  variant: Variant,
  setup: ChatSetup = {},
  options: MountOptions = {},
): Promise<ChatMount> {
  const hosted = setup.hosted;
  const homeSetup: HomeSetup | undefined =
    setup.nativePrompt === true ? { ...hosted?.home, nativePrompt: true } : hosted?.home;
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

/** A one-entry model catalog, enough for the model picker to draw and be chosen from. */
export const CATALOG_ENTRY: ModelCatalogEntry = {
  modelId: 'claude-sonnet-4-5',
  displayName: 'Claude Sonnet 4.5',
  provider: 'anthropic',
  pricingSource: 'catalog',
  priceKnown: true,
  available: true,
  deprecated: false,
};

/** The stand-alone chat's catalog port over the one entry. */
export const standaloneModelsPort: ChatModelsPort = {
  boundModel: CATALOG_ENTRY.modelId,
  load: () => ({ entries: [CATALOG_ENTRY], refreshedAt: undefined }),
  refresh: () => Promise.resolve({ providers: [] }),
  refreshIfStale: () => Promise.resolve(undefined),
};

/** The Home's catalog port over the one entry. */
export const homeModelsPort: HomeModelsPort = {
  load: () => ({ entries: [CATALOG_ENTRY], refreshedAt: undefined }),
  refreshIfStale: () => Promise.resolve(undefined),
  refresh: () => Promise.resolve({ providers: [] }),
  currentDefault: () => undefined,
  currentEffort: () => undefined,
  writeDefault: () => {},
};
