import type { DoctorProbes } from '../../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../../home/home-store.js';
import { RootApp, type RootAppProps } from '../home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
  type HomeControllerState,
} from '../home-controller.js';
import type { RunCardSnapshot } from '../run-card-model.js';
import type { NoticeFlush } from '../../../engine/effect-retention.js';
import { createNativePromptChannel } from '../native-prompt-channel.js';
import type { ChatStoreController } from '../chat-store.js';
import { createChatStore } from '../chat-store.js';
import {
  FULLSCREEN_TRANSCRIPT_BOUND,
  INLINE_TRANSCRIPT_BOUND,
  type SessionViewSeed,
} from '../session-view-model.js';
import { mountInk, type InkMount, type MountOptions } from './mount.js';
import type { Variant } from './variants.js';

/**
 * The Home as a host of the surface matrix: a real `RootApp` over a real `HomeController`, with the ports a surface needs injected through
 * `createHomeController`'s own dependency record and `RootApp`'s own props (nothing of production is replaced). The ports are the same
 * fakes the Home's component tests use: no engine, no database, no operator home.
 */

export const EMPTY_SNAPSHOT: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

const STUB_DOCTOR_PROBES: DoctorProbes = { keychain: () => {}, config: () => {}, toolHost: {} };

/** What the controller's ports may need of the host they are built for. */
export interface HomeContext {
  /** The native prompt channel, when the setup asked for one. */
  readonly channel: NativePromptChannel | undefined;
  /** The renderer's own flush (`RootApp` publishes it): what a flow waits on before it acts on a painted card. Resolves at once until the renderer is ready. */
  readonly flushVisible: NoticeFlush;
}

type HomeDeps = Partial<Omit<HomeControllerDeps, 'homeStore' | 'onExit' | 'onError'>>;

/** What a surface says about the Home it needs; everything left out is the bare, keyed, empty Home. */
export interface HomeSetup {
  /** What the landing reads (the strip's sessions, runs and agents). Default: the empty Home. */
  readonly snapshot?: HomeSnapshot;
  /** `true` ⇒ no provider key (the first-run Home). */
  readonly keyless?: boolean;
  /** Overrides of the controller's own dependency record (the ports a surface reads). */
  readonly deps?: HomeDeps | ((context: HomeContext) => HomeDeps);
  /** Overrides of `RootApp`'s own props. */
  readonly props?: Partial<
    Omit<RootAppProps, 'controller' | 'getSize' | 'color' | 'alternateScreen'>
  >;
  /** `true` ⇒ the Home is wired to a native prompt channel, as `driveHome` wires it (a card flow can then be opened on it). */
  readonly nativePrompt?: boolean;
  /**
   * The chat session `startChat` hands back, given the chat store the variant needs (a full-screen Home gets a full-screen transcript
   * bound, an inline Home an inline one: `driveHome` derives both from the one decision). Absent ⇒ `startChat` never settles.
   */
  readonly session?: (store: ChatStoreController) => HomeChatSession;
  /** What the chat's view store is seeded with. */
  readonly chatSeed?: SessionViewSeed | undefined;
  /** Called when the cell ends: closes what the setup opened (a fixture database). */
  readonly dispose?: (() => void) | undefined;
}

export type NativePromptChannel = ReturnType<typeof createNativePromptChannel>;

export interface HomeMount extends InkMount {
  readonly controller: HomeController;
  /** The native prompt channel, when the setup asked for one. */
  readonly channel: NativePromptChannel | undefined;
  /** The in-Home chat's view store, when the setup gave a session. */
  readonly chatStore: ChatStoreController | undefined;
  /** The frame as one string. */
  text: () => string;
  /** Register something to close when the cell ends (a temporary directory a real flow was pointed at). */
  defer: (cleanup: () => void) => void;
  /** The host's own evidence that the landing's exact state is measured and flushed on screen: what a key that counts only once it is seen waits for. */
  homePainted: () => boolean;
  /** The same for the open gate card's exact snapshot. */
  cardPainted: () => boolean;
}

/** Bytes of keys the Home's one input owner forwards, by name (what a terminal sends). */
export const KEYS = {
  enter: '\r',
  escape: '\u001b',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  tab: '\t',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
  ctrlY: '\u0019',
  ctrlN: '\u000e',
  ctrlR: '\u0012',
  ctrlG: '\u0007',
} as const;

export function mountHome(
  variant: Variant,
  setup: HomeSetup = {},
  options: MountOptions = {},
): HomeMount {
  const snapshot = setup.snapshot ?? EMPTY_SNAPSHOT;
  const homeStore: HomeStore = { read: () => snapshot };
  const channel = setup.nativePrompt === true ? createNativePromptChannel() : undefined;
  let rendererFlush: NoticeFlush | undefined;
  const context: HomeContext = {
    channel,
    flushVisible: () => (rendererFlush === undefined ? Promise.resolve() : rendererFlush()),
  };
  const deps = typeof setup.deps === 'function' ? setup.deps(context) : setup.deps;
  const chatStore =
    setup.session === undefined
      ? undefined
      : createChatStore(
          variant.color,
          setup.chatSeed,
          variant.renderer === 'alt' ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
        );
  const session = setup.session;
  const real = createHomeController({
    doctorProbes: STUB_DOCTOR_PROBES,
    // As `driveHome` wires it from the colour setting: the lines the controller writes itself (the /doctor report, a leg's end, a model switch)
    // are drawn in the plain glyph forms exactly when colour is off, so the matrix reads them as a person does.
    plainGlyphs: !variant.color,
    startChat:
      session === undefined || chatStore === undefined
        ? () => new Promise<never>(() => {})
        : () => Promise.resolve(session(chatStore)),
    homeStore,
    schedule: () => () => {},
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
    ...deps,
  });
  // The host's evidence that a frame is on screen, as `RootApp` binds it: a key that counts only once it has been seen waits on THAT.
  let homeVisible: ((state: HomeControllerState) => boolean) | undefined;
  let cardVisible: ((snapshot: RunCardSnapshot) => boolean) | undefined;
  const controller: HomeController = {
    ...real,
    bindHomeFrame: (visible) => {
      homeVisible = visible;
      real.bindHomeFrame(visible);
    },
    bindGateCardFrame: (visible) => {
      cardVisible = visible;
      real.bindGateCardFrame(visible);
    },
  };
  if (setup.keyless === true) controller.setProviderState(true);
  const mount = mountInk(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={variant.color}
      getSize={() => variant.size}
      subscribeResize={() => () => {}}
      {...(variant.renderer === 'alt' ? { alternateScreen: true } : {})}
      {...(channel === undefined ? {} : { nativePrompt: channel.ui })}
      {...setup.props}
      onRendererReady={(flush) => {
        rendererFlush = flush;
        setup.props?.onRendererReady?.(flush);
      }}
    />,
    variant,
    options,
  );
  const cleanups: (() => void)[] = [];
  return {
    ...mount,
    defer: (cleanup) => {
      cleanups.push(cleanup);
    },
    unmount: () => {
      mount.unmount();
      channel?.ui.dispose();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    controller,
    channel,
    chatStore,
    text: () => mount.frame().join('\n'),
    homePainted: () => homeVisible?.(controller.getSnapshot()) === true,
    cardPainted: () => {
      const screen = controller.getSnapshot().screen;
      return screen?.kind === 'gate-card' && cardVisible?.(screen.card.getSnapshot()) === true;
    },
  };
}
