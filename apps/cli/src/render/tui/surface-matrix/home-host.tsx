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
import { createChordHistory } from '../chord-guard.js';
import {
  createNotificationChannel,
  type NotificationChannel,
} from '../../../popups/notifications.js';
import {
  openSettings,
  type SettingsKind,
  type SettingsPort,
} from '../../../popups/settings-port.js';
import { openDoctor, type DoctorPort } from '../../../popups/doctor-port.js';
import {
  openReport,
  type ParsedReportLine,
  type ReportsPort,
} from '../../../popups/report-port.js';
import { createPopupHost, type PopupHost } from '../../../popups/popup-host.js';
import type { PopupFrame } from '../../../popups/popup-reducer.js';
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
  /** The terminal's size as the Home reads it, for a test that resizes. Default: the cell's size. */
  readonly getSize?: (() => { cols: number; rows: number }) | undefined;
  /** How the Home hears a resize, for a test that resizes. Default: it never does. */
  readonly subscribeResize?: ((onResize: () => void) => () => void) | undefined;
  /**
   * The Home's `/doctor` popup port: given, the controller opens the popup on the Home's popup host as `driveHome` wires it (`openDoctor`), for
   * the landing and, with a session whose `doctor` is set, for the chat it hosts. Absent ⇒ `/doctor` says the doctor is not available here.
   */
  readonly doctor?: DoctorPort | undefined;
  /**
   * Given, the controller opens the report popups (`/agent`, `/cost`, `/workflows`, `/help`; ADR-0148 §10) on the Home's popup host as `driveHome`
   * wires it (`openReport`) for the chat it hosts, whose session carries the port. Absent ⇒ those commands are dispatched to the chat.
   */
  readonly reports?: ReportsPort | undefined;
  /**
   * Given, the controller opens the settings popups (`/effort` today; ADR-0148 §3, §6) on the Home's popup host as `driveHome` wires it
   * (`openSettings`) for the chat it hosts, whose session carries the port. Absent ⇒ those commands are dispatched to the chat.
   */
  readonly settings?: SettingsPort | undefined;
}

export type NativePromptChannel = ReturnType<typeof createNativePromptChannel>;

export interface HomeMount extends InkMount {
  readonly controller: HomeController;
  /** The Home's popup host (as `driveHome` wires it: on the Home's one chord history, placed by the renderer). */
  readonly popups: PopupHost;
  /** The Home's notification channel. */
  readonly notifications: NotificationChannel;
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
  /** Move the popup host's clock on by `ms` (it is real time plus what was skipped): a dwell or a settle passes without a sleep. */
  skip: (ms: number) => void;
  /** The popup on top of the Home's popup host, as it is now (the frame a popup surface's box is computed from). */
  popupFrame: () => PopupFrame | undefined;
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
  // One chord history for the Home, as `driveHome` makes it: the native channel, the controller's cards, the chat store and the popups share it.
  const chordHistory = createChordHistory();
  const channel =
    setup.nativePrompt === true ? createNativePromptChannel({ history: chordHistory }) : undefined;
  const notifications = createNotificationChannel();
  // The popup host's clock is real time plus what a surface skipped: a dwell or a settle can pass at once, and nothing else moves.
  let skipped = 0;
  const popupNow = (): number => performance.now() + skipped;
  const popups = createPopupHost({
    now: popupNow,
    history: chordHistory,
    notifications,
    placement: variant.renderer === 'alt' ? 'overlay' : 'replace',
  });
  const doctor = setup.doctor;
  const reports = setup.reports;
  const settings = setup.settings;
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
          { history: chordHistory },
        );
  const session = setup.session;
  const real = createHomeController({
    // As `driveHome` wires it from the colour setting: the lines the controller writes itself (a leg's end, a model switch)
    // are drawn in the plain glyph forms exactly when colour is off, so the matrix reads them as a person does.
    plainGlyphs: !variant.color,
    startChat:
      session === undefined || chatStore === undefined
        ? () => new Promise<never>(() => {})
        : () => Promise.resolve(session(chatStore)),
    homeStore,
    schedule: () => () => {},
    chordHistory,
    popupOpen: () => popups.getSnapshot().open,
    ...(doctor === undefined
      ? {}
      : {
          openDoctor: ({
            deep,
            chat,
          }: {
            readonly deep: boolean;
            readonly chat?: DoctorPort | undefined;
          }) => {
            void openDoctor({
              host: popups,
              port: chat ?? doctor,
              deep,
              origin: chat === undefined ? 'home' : 'chat',
              now: popupNow,
            });
          },
        }),
    ...(reports === undefined
      ? {}
      : {
          openReport: ({
            line,
            chat,
            turnInFlight,
          }: {
            readonly line: ParsedReportLine;
            readonly chat: ReportsPort;
            readonly turnInFlight: () => boolean;
          }) => {
            void openReport({ host: popups, port: chat, line, origin: 'chat', turnInFlight });
          },
        }),
    ...(settings === undefined
      ? {}
      : {
          openSettings: ({
            command,
            chat,
          }: {
            readonly command: SettingsKind;
            readonly chat: SettingsPort;
          }) => {
            void openSettings({ host: popups, port: chat, command, origin: 'chat' });
          },
        }),
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
      getSize={setup.getSize ?? (() => variant.size)}
      subscribeResize={setup.subscribeResize ?? (() => () => {})}
      {...(variant.renderer === 'alt' ? { alternateScreen: true } : {})}
      {...(channel === undefined ? {} : { nativePrompt: channel.ui })}
      popups={popups}
      notifications={notifications}
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
      popups.dispose();
      notifications.dispose();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    controller,
    popups,
    notifications,
    channel,
    chatStore,
    text: () => mount.frame().join('\n'),
    homePainted: () => homeVisible?.(controller.getSnapshot()) === true,
    skip: (ms) => {
      skipped += ms;
    },
    popupFrame: () => popups.getSnapshot().frame,
    cardPainted: () => {
      const screen = controller.getSnapshot().screen;
      return screen?.kind === 'gate-card' && cardVisible?.(screen.card.getSnapshot()) === true;
    },
  };
}
