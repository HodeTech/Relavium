import { createMeasuredFrameAcknowledgement } from './measured-frame-acknowledgement.js';
import { ToolReviewHost } from './tool-review-view.js';
import { QuestionCardHost } from './question-card-view.js';
import { CheckpointCardHost } from './checkpoint-card-view.js';
import { CliError } from '../../process/cli-error.js';
import { NativePromptView } from './native-prompt-view.js';
import { bindPopupHost, type PopupSheetSources } from '../../popups/popup-bind.js';
import { popupRefusal } from '../../popups/popup-refusal.js';
import { nativeFramed } from '../../popups/native-popup-body.js';
import type { NotificationChannel, NotificationSnapshot } from '../../popups/notifications.js';
import {
  createPopupAcknowledgement,
  type PopupAcknowledgement,
} from '../../popups/popup-acknowledgement.js';
import type { PopupHost, PopupHostSnapshot, PopupRefusal } from '../../popups/popup-host.js';
import {
  dimsBackdrop,
  PopupSlot,
  slotDrawing,
  type PopupSlotProps,
} from '../../popups/popup-slot.js';
import type { PopupPlacement } from '../../popups/geometry.js';
import type { NativePromptUi, NativePromptSnapshot } from './native-prompt-channel.js';
import {
  createNativePromptAcknowledgement,
  nativePromptFits,
} from './native-prompt-acknowledgement.js';
import { displayWidth } from './viewport.js';
import { Box, useApp, useInput, usePaste, useStdout, type DOMElement, type Key } from 'ink';
import { BackdropDim, Text } from './text.js';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { PendingAttachment } from './attachments.js';
import {
  chatIsBusy,
  ChatView,
  ChromeColumn,
  composerEditor,
  dockedCardOpen,
  hintRowNotification,
  useCopiedToast,
} from './chat-ink.js';
import { chatFrameRows } from './chat-layout.js';
import { useVisibleRenderFlush } from './render-acknowledgement.js';
import {
  createTranscriptAcknowledgement,
  type TranscriptAcknowledgement,
} from './transcript-acknowledgement.js';
import type { EditorState } from './chat-input.js';
import { pressesOnly } from './chord-guard.js';
import { isInterruptKey } from './interrupt-keymap.js';
import { transcriptScrollGeometry, transcriptSelectionText } from './chat-projection.js';
import { chatGrid } from './chat-grid.js';
import { sanitizeInline } from '../sanitize.js';
import type { ChatStoreController } from './chat-store.js';
import {
  homeOverlayFlags,
  type GateCardScreen,
  type HomeController,
  type HomeControllerState,
  homeTurnFacts,
} from './home-controller.js';
import {
  cardFlagsFrom,
  holdsCustody,
  landingPromptHidden,
  mouseCapturedFrom,
  NO_OVERLAYS,
  noticePagingBlocked,
  occupiesRows,
  overlayOwnsKeyboard,
  pointerBlocked,
  promptHidden,
  scrollKeysBlocked,
  type OverlayFlags,
} from './overlay-flags.js';
import { currentStep } from '../../popups/popup-reducer.js';
import type { GateCardFrame } from './gate-card-frame.js';
import { ExitGuardCard, HomeView } from './home-view.js';
import { exitKey, keyToken, legend } from './legend.js';
import { RunScreenView } from './run-screen-view.js';
import { RunCardView } from './run-card-view.js';
import { useWaitClock, waitClockForm, type WaitClockForm } from './wait-clock.js';
import { createGateCardFrame } from './gate-card-frame.js';
import {
  homeFitsTerminal,
  homeIsEmpty,
  hostedRunLabel,
  tooSmallMessage,
} from './home-projection.js';
import { layoutHomeNotice } from './home-notice.js';
import { slideOffsetAt } from './home-pages.js';
import { stripReach } from './strip-focus.js';
import { layoutColumns } from './layout-columns.js';
import type { ReverseSearchState } from './input-history.js';
import type { MentionState } from './mention.js';
import { MentionView } from './mention-view.js';
import { TabHostView } from './tab-host-view.js';
import { chatPaletteRows } from './palette-view.js';
import type { OpenPalette } from './palette-reducer.js';
import { colorProps, dimProps } from './projection.js';
import { ReverseSearchView } from './reverse-search-view.js';
import { createMouseReportReader, type MouseEvent as TerminalMouseEvent } from './mouse.js';
import {
  normalizeSelection,
  type SelectionRange,
  type SelectionState,
  routeMouseSelection,
} from './selection.js';
import {
  effectiveOffset,
  INITIAL_SCROLL,
  reduceScroll,
  scrollMotionForKey,
  WHEEL_LINES,
  type ScrollGeometry,
  type ViewportGeometry,
  type ScrollState,
} from './scroll.js';

export type { HomeChatSession } from './home-controller.js';

import { attemptClipboardWrite, type ClipboardWriter } from '../clipboard.js';
import type { SuspendPort } from '../suspend.js';
import type { NoticeFlush } from '../../engine/effect-retention.js';

export interface RootAppProps {
  readonly nativePrompt?: NativePromptUi;
  /**
   * The Home's popup host ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2): this
   * root routes keys and pastes to it while a popup is open, draws its popup in the one overlay slot (the last child of the root), measures it,
   * closes it unanswered when a sheet arrives, and resets a card's evidence when one opens over it. Absent ⇒ no popup ever opens.
   */
  readonly popups?: PopupHost | undefined;
  /** The Home's one notification channel: drawn on the hint row of the landing and of the chat, held while a decision is on screen. */
  readonly notifications?: NotificationChannel | undefined;
  /** Synchronous native teardown seal, including mouse and paste routes before controller dispatch. */
  readonly inputEnabled?: () => boolean;
  /** Publishes a mounted render acknowledgement bound to this Ink tree and its exact output stream. */
  readonly onRendererReady?: (flushVisible: NoticeFlush) => void;
  readonly onRendererError?: (error: Error) => void;
  readonly controller: HomeController;
  readonly nowMs: () => number;
  readonly color: boolean;
  readonly getSize: () => { cols: number; rows: number };
  /** Subscribe to terminal resizes; returns an unsubscribe. */
  readonly subscribeResize: (onResize: () => void) => () => void;
  /** `true` ⇒ mounted on ink 7's alternate screen (2.6.F Step 4b, ADR-0068 §c) — the in-Home chat's transcript
   *  renders through the scroll viewport (bounded to the resize-tracked size) instead of `<Static>`. Resolved by
   *  `driveHome` (`resolveRenderMode`); absent/false ⇒ the inline renderer. */
  readonly alternateScreen?: boolean;
  /** The ADR-0068 §e suspend port (2.6.F Step 5d). `RootApp` attaches ink's `useApp().suspendTerminal` to it while
   *  mounted — the ONLY way the non-React slash dispatch (`createHomeController` is built before this tree exists)
   *  can reach `/scrollback` and `/edit`. Absent (a test) ⇒ the hatches notice "needs an interactive terminal". */
  readonly suspendPort?: SuspendPort | undefined;
  /** Request POSIX job control. In Ink raw mode Ctrl-Z is input, not a kernel SIGTSTP, so this routes both forms
   *  through the shared release → stop → reclaim coordinator. Absent on a focused component test ⇒ a harmless no-op. */
  readonly onSuspend?: (() => void) | undefined;
  /** Write the in-Home chat's mouse selection to the system clipboard over OSC 52 (2.6.F Step 6). Absent ⇒ the
   *  selection still highlights but copy-on-select is inert (a test that wires no terminal). */
  readonly clipboard?: ClipboardWriter | undefined;
  /** Explicit masked review copy; independent of mouse selection preferences. */
  readonly reviewClipboard?: ClipboardWriter | undefined;
  /** `[preferences].show_banner` (2.6.F Step 5g) — forwarded verbatim to `HomeView` (`showsLandingBlock`: absent or `true` draws page 1's block). */
  readonly showBanner?: boolean | undefined;
  /**
   * Turn terminal mouse reporting on/off as the in-Home CHAT takes and gives up the screen (2.6.F Step 6g).
   *
   * Capturing the mouse for the whole Home was a regression: the landing has no viewport to wheel-scroll and no in-app
   * selection, so the user lost the emulator's native click-drag there and got nothing back — they could not even copy
   * a session id off the strip. Absent (or `--no-mouse` / `[preferences].mouse = false`) ⇒ never captured.
   */
  readonly setMouseCapture?: ((enabled: boolean) => void) | undefined;
}

/** The chat region: subscribes to the chat store (re-render on stream events) and renders the pure {@link ChatView},
 *  plus the `/` palette overlay (2.5.C S3b) when open. It owns NO `useInput` — {@link RootApp} is the single
 *  raw-mode owner and forwards keys to the controller. */
function ChatRegion(
  props: Readonly<{
    store: ChatStoreController;
    reviewSize: { cols: number; rows: number };
    reviewCustody: () => boolean;
    reviewClipboard: ClipboardWriter | undefined;
    acknowledgement: TranscriptAcknowledgement;
    editor: EditorState;
    /** What owns the keyboard, as of this render (`overlay-flags.ts`): the region draws no idle prompt under a submode. */
    overlays: OverlayFlags;
    /** The open `/` palette: its state and the rows it reads, built once per change by the controller (the key fold and this view share them). */
    palette: OpenPalette | undefined;
    search: ReverseSearchState | undefined;
    mention: MentionState | undefined;
    /** The wall-clock as a FUNCTION, not a pre-computed number: `ChatRegion` re-renders every frame while a turn
     *  streams (its own store subscription flushes on `tick`, chat-store.ts), whereas its parent `RootApp` only
     *  re-renders on controller state changes. So the live-turn timer (2.5.H) MUST read the clock here, per frame —
     *  a number prop frozen at the parent's last render would stick the elapsed at 0s for the whole pre-token wait. */
    now: () => number;
    /** The live terminal width (resize-tracked in `RootApp`) — bounds the reasoning panel to N rendered rows (2.5.H). */
    cols: number;
    /** PRESENT ⇒ the alt-screen renderer (2.6.F Step 4b, ADR-0068 §c): the chat region is bounded to the terminal
     *  size and the transcript renders through the scroll viewport instead of `<Static>`, carrying the RootApp-held
     *  `scroll` state (4b-2) + the `onMeasure` geometry-lift. Absent ⇒ inline. */
    viewport:
      | {
          readonly rows: number;
          readonly cols: number;
          readonly scroll: ScrollState;
          /** The active mouse selection, document-ordered (2.6.F Step 6). */
          readonly selection?: SelectionRange | undefined;
          readonly onMeasure: (geom: ViewportGeometry) => void;
        }
      | undefined;
    shellBusy: boolean;
    submitBusy: boolean;
    shellCommand: string | undefined;
    historyEntries: readonly string[];
    attachments: readonly PendingAttachment[];
    /** The interrupt keymap is armed (ADR-0115 §1) — the idle hint then says a second `Ctrl+C` ends the chat. */
    interruptArmed: boolean;
    /** `true` for ~2s after a copy-on-select (2.6.F Step 6i) — forwarded to `ChatView`'s toast. */
    copied: boolean;
    /** Reserve bounded screen space for the active native card without unmounting Static. */
    promptHeight?: number | undefined;
    /** The notification the hint row shows in place of the hint (the Home's one channel), or `undefined`. */
    notification?: string | undefined;
    /** The lowercase provider id of the chat's bound agent, first on the status line (ADR-0146 §2): the session's own, read where the region is mounted. */
    provider?: string | undefined;
    /** Whether the composer draws its cursor cell: `false` while a popup is drawn over the chat, whose keys they are (ADR-0148 §2). Absent ⇒ drawn. */
    composerCursor?: boolean | undefined;
  }>,
): ReactElement {
  // A reseat replaces the view store while preserving sessionId and RootApp. Reset Static's
  // printed-item cursor for that new transcript owner; inline stores contain only new entries.
  // Keep the root input/terminal owner mounted and the terminal's existing scrollback intact.
  const [transcriptOwner, setTranscriptOwner] = useState({ store: props.store, generation: 0 });
  if (transcriptOwner.store !== props.store) {
    setTranscriptOwner({ store: props.store, generation: transcriptOwner.generation + 1 });
  }
  const {
    state,
    tick,
    color,
    mode,
    reasoningEffort,
    reasoningVisible,
    review,
    toolDisplays,
    markdown,
    displaySuspended,
    approval,
    question,
    checkpoint,
  } = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  // Whether a sheet is docked, read from the store this region renders (ADR-0147 §1: the sheet takes the prompt block's place). The host's own
  // flags are computed when the HOME renders, which a card that the store publishes on its own does not cause, so they can be a frame behind it.
  const sheetDocked = dockedCardOpen({
    approval: approval !== undefined,
    question: question !== undefined,
    checkpoint: checkpoint !== undefined,
  });
  // Read the clock in THIS per-frame component (see the `now` prop doc) so the elapsed advances live.
  const nowMs = props.now();
  const viewport = props.viewport;
  // The rows the region is bounded to: the viewport's own, else the room a native card leaves, else none.
  const boundedRows = viewport === undefined ? props.promptHeight : viewport.rows;
  // A sheet's wait clock ticks in the alternate screen (the viewport is present exactly there) and is static inline (ADR-0147 §2).
  const waitClock = waitClockForm(viewport !== undefined);
  return (
    // Alt-screen (Step 4b): bound the chat region to the terminal `rows` so `ChatView`'s flex-grow viewport has a
    // height to fill below any keyboard-owning overlay (palette / search / model-picker / …); inline ⇒ unbounded.
    <Box
      flexDirection="column"
      width={layoutColumns(props.cols)}
      {...(boundedRows === undefined ? {} : { height: boundedRows, overflowY: 'hidden' })}
    >
      <ChatView
        hidden={review !== undefined && review.screen !== 'card'}
        toolDisplays={toolDisplays}
        markdown={markdown}
        displaySuspended={displaySuspended}
        acknowledgement={props.acknowledgement}
        key={transcriptOwner.generation}
        state={state}
        tick={tick}
        nowMs={nowMs}
        color={color}
        editor={props.editor}
        composerCursor={props.composerCursor}
        surface="home-chat"
        provider={props.provider}
        // The header is the introduction of a chat's FIRST mount (inline: written once into the scrollback). A reseat or a `/clear` hands the
        // region a new store under the same root, which bumps the generation: the same chat goes on, and nothing is written again.
        introduction={transcriptOwner.generation === 0}
        running={chatIsBusy({
          turnRunning: state.status === 'running',
          shellBusy: props.shellBusy,
          submitBusy: props.submitBusy,
          nativePrompt: props.overlays.nativePrompt,
          approvalCard: state.approvalSinceMs !== undefined,
        })}
        mode={mode}
        reasoningEffort={reasoningEffort}
        reasoningVisible={reasoningVisible}
        attachments={props.attachments}
        busyCommand={props.shellCommand}
        columns={props.cols}
        viewport={viewport}
        interruptArmed={props.interruptArmed}
        copied={props.copied}
        paletteOpen={promptHidden(props.overlays)}
        palette={
          props.palette === undefined
            ? undefined
            : {
                list: props.palette.list,
                state: props.palette.state,
                maxRows: chatPaletteRows(props.reviewSize.rows, props.palette.list),
              }
        }
        notification={props.notification}
        cardDocked={sheetDocked}
        terminalRows={props.reviewSize.rows}
      />
      {/* The docked approval card (ADR-0129), below the live region like the other overlays. */}
      <ToolReviewHost
        store={props.store}
        size={props.reviewSize}
        hasCustody={props.reviewCustody}
        clipboard={props.reviewClipboard}
        color={color}
        waitClock={waitClock}
      />
      {/* The docked `ask_user` question card (ADR-0132) — where the approval card sits, never both at once. */}
      <QuestionCardHost
        store={props.store}
        size={props.reviewSize}
        hasCustody={props.reviewCustody}
        color={color}
        waitClock={waitClock}
      />
      {/* The docked continue checkpoint (ADR-0136 §4) — the same place, never together with another card. */}
      <CheckpointCardHost
        store={props.store}
        size={props.reviewSize}
        hasCustody={props.reviewCustody}
        color={color}
        waitClock={waitClock}
      />
      {/* The history search and the `@` completion list are host-drawn rows below the prompt that show stored names (a history line, a file name):
          they stand in the content column of the grid like the prompt block above them, never in the margin (unit 9). */}
      {props.search !== undefined && (
        <ChromeColumn columns={props.cols}>
          <ReverseSearchView state={props.search} entries={props.historyEntries} color={color} />
        </ChromeColumn>
      )}
      {props.mention !== undefined && (
        <ChromeColumn columns={props.cols}>
          <MentionView state={props.mention} color={color} />
        </ChromeColumn>
      )}
    </Box>
  );
}

/**
 * One key through the Home host's card pipeline, in the order the host runs it. Exported so the controller tests drive the very
 * routing the host does instead of keeping a copy of it.
 *
 * Any key but `Ctrl+C` ends the armed interrupt state first, whatever consumes it afterwards (ADR-0115 §1). Then the chat store's
 * cards get the key: the card owns every answer key. A card that stopped on it has already been settled (an approval as a
 * REJECTION, before the abort: ADR-0115 §2), so a `Ctrl+C` it reports as `abort` goes on to the controller as itself and the keymap
 * arms or ends the session, while an `Esc` is the plain stop and reaches the controller as an Esc, which never arms. A `Ctrl+C` that
 * answered a checkpoint "stop" aborts nothing (the engine ends the turn itself, ADR-0136 §2) but starts the window all the same.
 * Returns whether the key was consumed.
 */
export function routeKeyThroughCards(
  controller: Pick<HomeController, 'handleKey' | 'interruptAnswered' | 'disarmInterrupt'>,
  store: Pick<ChatStoreController, 'handleReviewInput'> | undefined,
  input: string,
  key: Parameters<HomeController['handleKey']>[1],
): boolean {
  const interrupt = isInterruptKey(input, key);
  if (!interrupt) controller.disarmInterrupt();
  const action = store?.handleReviewInput(input, key);
  if (action === 'handled') return true;
  if (action === 'stop-answered') {
    controller.interruptAnswered();
    return true;
  }
  if (action === 'abort') {
    if (interrupt) controller.handleKey(input, key);
    else controller.handleKey('\u001b', { escape: true });
    return true;
  }
  return false;
}

/**
 * The Home host's record of what owns the keyboard: the controller's, with the native prompt channel's and the popup host's on top (both are
 * the HOST's; the controller never sees the channel and reads only whether a popup is open). One builder for the render's snapshot and for the
 * live read of a handler. Who owns the keys and whether the body's rows are taken are two facts (ADR-0148 §2): a native card, a framed block
 * inline and an inline popup take the rows (`replacesBody`); a popup or a framed prompt in the overlay keeps the body drawn behind it.
 */
export function hostOverlayFlags(
  state: HomeControllerState,
  prompt: NativePromptSnapshot,
  popup: PopupHostSnapshot,
  placement: PopupPlacement,
): OverlayFlags {
  return {
    ...homeOverlayFlags(state),
    nativePrompt: prompt.active,
    popup: popup.open,
    replacesBody:
      nativeTakesRows(prompt, placement) || (popup.open && popup.placement === 'replace'),
  };
}

/** Whether the channel's prompt takes the body's rows: a card always, a prompt drawn as a popup only as a block in the flow (inline). */
function nativeTakesRows(prompt: NativePromptSnapshot, placement: PopupPlacement): boolean {
  return prompt.active && (!nativeFramed(prompt) || placement === 'replace');
}

/** Whether the channel's prompt is a CARD (drawn by `NativePromptView`), not a prompt drawn in the popup frame. */
function nativeCardShown(prompt: NativePromptSnapshot): boolean {
  return prompt.active && !nativeFramed(prompt);
}

const CLOSED_POPUPS: PopupHostSnapshot = {
  open: false,
  depth: 0,
  placement: 'overlay',
  frame: undefined,
};
const closedPopups = (): PopupHostSnapshot => CLOSED_POPUPS;
const noPopupSubscribe = (): (() => void) => () => {};
const NO_NOTIFICATION: NotificationSnapshot = { current: undefined, queued: 0, held: false };
const noNotification = (): NotificationSnapshot => NO_NOTIFICATION;

/**
 * The single-ink-tree shell for the bare-invocation Home (2.5.B / ADR-0054): ONE `useInput` owner over a
 * `home | loading | chat` mode machine. The session state machine lives in {@link HomeController} (a plain
 * external store, unit-tested without ink); `RootApp` is a thin view that subscribes to it, forwards every key to
 * `controller.handleKey`, and renders the Home strip, the loading echo, or the chat region from the published
 * state. The clock + terminal size are injected so the strip degrade (<80×24) and the relative times are testable.
 */
export function RootApp(props: Readonly<RootAppProps>): ReactElement {
  const clipboardFeedbackMounted = useRef(true);
  useLayoutEffect(() => {
    clipboardFeedbackMounted.current = true;
    return () => {
      clipboardFeedbackMounted.current = false;
    };
  }, []);
  const { controller, getSize, subscribeResize, color } = props;
  const { stdout } = useStdout();
  const getSizeRef = useRef(getSize);
  getSizeRef.current = getSize;
  const propsRef = useRef(props);
  propsRef.current = props;
  /** Where a popup is drawn on this renderer: over the body in the alternate screen, in its place inline (ADR-0148 §4). */
  const placement: PopupPlacement = props.alternateScreen === true ? 'overlay' : 'replace';
  /** What owns the keyboard NOW: the controller's state, the prompt channel and the popup host, read at the call (a handler, a custody check), never a render's. */
  const liveOverlays = (): OverlayFlags =>
    hostOverlayFlags(
      controller.getSnapshot(),
      propsRef.current.nativePrompt?.getSnapshot() ?? emptyPrompt,
      propsRef.current.popups?.getSnapshot() ?? CLOSED_POPUPS,
      placement,
    );
  const [nativeAcknowledgement] = useState(() =>
    props.nativePrompt === undefined
      ? undefined
      : createNativePromptAcknowledgement(
          props.nativePrompt,
          () => getSizeRef.current(),
          () =>
            propsRef.current.inputEnabled?.() !== false &&
            propsRef.current.suspendPort?.isSuspended() !== true &&
            stdout.writable !== false &&
            !stdout.destroyed &&
            !stdout.writableEnded,
        ),
  );
  useEffect(() => () => nativeAcknowledgement?.dispose(), [nativeAcknowledgement]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const prompt = useSyncExternalStore(
    props.nativePrompt?.subscribe ?? emptyPromptSubscribe,
    props.nativePrompt?.getSnapshot ?? emptyPromptSnapshot,
  );
  const popupSnapshot = useSyncExternalStore(
    props.popups?.subscribe ?? noPopupSubscribe,
    props.popups?.getSnapshot ?? closedPopups,
  );
  const notification = useSyncExternalStore(
    props.notifications?.subscribe ?? noPopupSubscribe,
    props.notifications?.getSnapshot ?? noNotification,
  );
  /** What owned the keyboard at this render: every render-time gate below asks it, and the prompt's rows are `prompt`'s own. */
  const flags = hostOverlayFlags(state, prompt, popupSnapshot, placement);
  // The exit guard's lockout as its legend draws it (`(wait)`): the controller's display value, beside its state; one repaint when it opens.
  const exitGuardLocked = useSyncExternalStore(
    controller.exitGuardLock.subscribe,
    controller.exitGuardLock.read,
  );
  const [acknowledgement] = useState(() =>
    createTranscriptAcknowledgement(() => controller.getSnapshot().session?.store),
  );
  useEffect(() => {
    // Home remains mounted after chat ends; do not retain the departed viewport's transcript.
    if (state.mode !== 'chat') acknowledgement.clearViewport();
  }, [state.mode, acknowledgement]);
  // Attach ink's `suspendTerminal` to the ADR-0068 §e port while this tree is mounted (2.6.F Step 5d). `useApp()` is
  // the only place it exists, and the in-Home chat's slash dispatch runs outside React — so the port is the bridge.
  // Invoked as a METHOD (`app.suspendTerminal(cb)`), never as a bare destructured reference: ink 7 hands it out
  // unbound off the prototype, so this form is immune to how the context object is shaped.
  const app = useApp();
  const suspendPort = props.suspendPort;
  // Bumped once a suspension is over: one render then commits an open popup's frame again (see below).
  const [, setReclaimed] = useState(0);
  // The popup's acknowledgement is created further down; the suspension reads it when it happens, never while this effect is set up.
  const popupAcknowledgementRef = useRef<PopupAcknowledgement<PopupHostSnapshot> | undefined>(
    undefined,
  );
  useEffect(() => {
    if (suspendPort === undefined) return;
    suspendPort.attach(async (callback) => {
      controller.getSnapshot().session?.store.invalidateToolReview();
      popupAcknowledgementRef.current?.invalidate();
      try {
        await app.suspendTerminal(callback);
      } finally {
        // Reclaim requires new measured, flushed evidence; pre-suspend reveal never survives.
        controller.getSnapshot().session?.store.invalidateToolReview();
        // The renderer redraws its last output on resume but commits nothing, so an open popup's frame would never be measured again and every
        // key but `Esc` and `Ctrl+C` would stay dropped as unseen: one render commits it anew, and its acknowledgement (flushed after the
        // terminal is ours again) is new evidence, its dwell counted from it.
        popupAcknowledgementRef.current?.invalidate();
        setReclaimed((count) => count + 1);
      }
    });
    return () => suspendPort.attach(undefined);
  }, [app, suspendPort, controller]);
  const [size, setSize] = useState(getSize);
  const [homeFrame] = useState(() =>
    createMeasuredFrameAcknowledgement({
      current: controller.getSnapshot,
      getSize: () => getSizeRef.current(),
      hasCustody: () =>
        propsRef.current.inputEnabled?.() !== false &&
        propsRef.current.suspendPort?.isSuspended() !== true &&
        holdsCustody(liveOverlays()) &&
        stdout.writable !== false &&
        !stdout.destroyed &&
        !stdout.writableEnded,
      // The keys that waited while the Home's pages slid are applied once the arrival is on screen (MVP-11 unit 7).
      onAcknowledge: (snapshot) => controller.homeFrameShown?.(snapshot),
    }),
  );
  useEffect(() => () => homeFrame.dispose(), [homeFrame]);
  // The exit guard's `Ctrl+Y` cancels a run for good, so the controller asks this whether the exact landing it holds is on screen.
  useEffect(() => {
    controller.bindHomeFrame(homeFrame.visible);
    return () => controller.bindHomeFrame(undefined);
  }, [controller, homeFrame]);
  // The gate and budget card's own measured-frame evidence: the card takes an affirmative chord only while its exact snapshot is on
  // screen, and its dwell counts from the first frame that was (ADR-0139 §4). The controller asks it through `bindGateCardFrame`.
  const [cardFrame] = useState(() =>
    createGateCardFrame({
      current: () => {
        const screen = controller.getSnapshot().screen;
        return screen?.kind === 'gate-card' ? screen.card.getSnapshot() : undefined;
      },
      getSize: () => getSizeRef.current(),
      hasCustody: () =>
        propsRef.current.inputEnabled?.() !== false &&
        propsRef.current.suspendPort?.isSuspended() !== true &&
        holdsCustody(liveOverlays()) &&
        stdout.writable !== false &&
        !stdout.destroyed &&
        !stdout.writableEnded,
      shown: (snapshot) => {
        const screen = controller.getSnapshot().screen;
        if (screen?.kind === 'gate-card') screen.card.shown(snapshot);
      },
    }),
  );
  useEffect(() => {
    controller.bindGateCardFrame(cardFrame.visible);
    return () => {
      controller.bindGateCardFrame(undefined);
      cardFrame.dispose();
    };
  }, [controller, cardFrame]);
  // ---- The popup (ADR-0148 §2) ----------------------------------------------------------------------------------------------------
  // Its measured-frame evidence: the popup's content node, exactly the geometry's, measured and flushed. A popup holds custody only while no
  // native prompt (a card or a sheet) is over it, the terminal is ours and the Home takes input.
  const [popupAcknowledgement] = useState<PopupAcknowledgement<PopupHostSnapshot> | undefined>(
    () => {
      const popups = props.popups;
      if (popups === undefined) return undefined;
      return createPopupAcknowledgement<PopupHostSnapshot>({
        current: popups.getSnapshot,
        getSize: () => getSizeRef.current(),
        hasCustody: () =>
          propsRef.current.inputEnabled?.() !== false &&
          propsRef.current.suspendPort?.isSuspended() !== true &&
          propsRef.current.nativePrompt?.getSnapshot().active !== true &&
          stdout.writable !== false &&
          !stdout.destroyed &&
          !stdout.writableEnded,
        shown: (snapshot) => popups.shown(snapshot),
      });
    },
  );
  popupAcknowledgementRef.current = popupAcknowledgement;
  useEffect(() => {
    const popups = props.popups;
    if (popups === undefined || popupAcknowledgement === undefined) return;
    return bindPopupHost({
      popups,
      acknowledgement: popupAcknowledgement,
      // The opening rules (ADR-0148 §2): no turn running, no card or sheet open, no two-step armed, nothing else owning the keyboard.
      gate: () =>
        homePopupRefusal(controller.getSnapshot(), propsRef.current.nativePrompt?.getSnapshot()),
      // A popup that opens over a card (only a race can do it) resets the card's acknowledgement and dwell origin: the card is measured again
      // on a new frame before anything on it counts. Synchronous, in the popup host's own publication.
      onRevoke: () => {
        homeFrame.invalidate();
        cardFrame.invalidate();
        nativeAcknowledgement?.invalidate();
        controller.getSnapshot().session?.store.invalidateToolReview();
      },
      // A sheet that ARRIVES over a popup wins: the popup closes unanswered (ADR-0148 §2). Each source is watched for a sheet that was not
      // there before: a card of the live chat, a native card, the exit guard, a gate card.
      watchSheets: homeSheetSources(controller, propsRef.current.nativePrompt),
    });
  }, [controller, popupAcknowledgement, homeFrame, cardFrame, nativeAcknowledgement, props.popups]);
  // The notification channel is held while a decision is on screen or the hint row is not drawn, so it never paints over a card's rows and a
  // notification nobody could see is not spent. Followed from every source, not from this root's renders: a chat's card comes and goes in the
  // chat store, which this root does not re-render for.
  useEffect(() => {
    const notifications = props.notifications;
    if (notifications === undefined) return;
    const sync = (): void => {
      notifications.hold(
        notificationHeld(
          controller.getSnapshot(),
          propsRef.current.nativePrompt?.getSnapshot() ?? emptyPrompt,
          propsRef.current.popups?.getSnapshot() ?? CLOSED_POPUPS,
          liveOverlays(),
          getSizeRef.current(),
        ),
      );
    };
    const popups = props.popups;
    return watchHomeSources(
      controller,
      props.nativePrompt,
      popups === undefined ? [] : [popups.subscribe],
      sync,
    );
    // `size` re-runs it on a resize: the hint row is not drawn below the floor.
  }, [controller, props.notifications, props.nativePrompt, props.popups, size.cols, size.rows]);
  const [noticeWindow, setNoticeWindow] = useState({
    revision: state.noticeRevision,
    cols: size.cols,
    rows: size.rows,
    page: 0,
  });
  const noticeWindowRef = useRef(noticeWindow);
  const sameNotice =
    noticeWindow.revision === state.noticeRevision &&
    Object.is(noticeWindow.cols, size.cols) &&
    Object.is(noticeWindow.rows, size.rows);
  const noticePage = sameNotice ? noticeWindow.page : 0;
  if (!sameNotice) {
    const reset = { revision: state.noticeRevision, cols: size.cols, rows: size.rows, page: 0 };
    noticeWindowRef.current = reset;
    setNoticeWindow(reset);
  }
  // The alt-screen transcript SCROLL state (2.6.F Step 4b-2) — RootApp-local (a pure-render concern, like `size`;
  // NOT session state), ref-shadowed for coalesced-chunk safety, and the viewport's live geometry lifted into
  // `scrollGeomRef` via `onMeasure` so a scroll key reduces against the SAME geometry the viewport windows with.
  const [scroll, setScroll] = useState<ScrollState>(INITIAL_SCROLL);
  const scrollRef = useRef<ScrollState>(INITIAL_SCROLL);
  // Survives an SGR mouse report SPLIT across two `useInput` calls (Step 6f). One reader per mount: it holds the
  // fragment, so it must not be re-created on every render.
  const mouseReaderRef = useRef(createMouseReportReader());
  // Whether the transcript was following the tail when the current gesture began — a plain click restores it.
  const followedBeforeSelectionRef = useRef(false);
  // Whether a left-button gesture is in flight — set by a press inside the viewport, cleared on release. Distinct from
  // a retained highlight, so a stray click after a copy cannot re-copy it (Step 6h review).
  const gestureActiveRef = useRef(false);
  // The copy-on-select confirmation toast (2.6.F Step 6i) — same as `relavium chat`.
  const { copied, flashCopied } = useCopiedToast();
  // The mouse selection (2.6.F Step 6) — held exactly like `scroll`: state for the render, a ref so a coalesced drag
  // burst (several SGR reports in ONE stdin read) reduces off the latest rather than the render closure.
  const [selection, setSelection] = useState<SelectionState | undefined>(undefined);
  const selectionRef = useRef<SelectionState | undefined>(undefined);
  // Seeded at zero: the post-commit measure fills it on the first frame. `top`/`left`/`width` are the box's position
  // in ink's frame — the mouse handler's half of the row→line mapping (Step 6).
  const scrollGeomRef = useRef<ViewportGeometry>({
    totalLines: 0,
    height: 0,
    width: 0,
    top: 0,
    left: 0,
  });
  const applySelection = (next: SelectionState | undefined): void => {
    selectionRef.current = next;
    setSelection(next);
  };
  const applyScroll = (next: ScrollState): void => {
    scrollRef.current = next;
    setScroll(next);
  };

  // Tell the controller the size, so a sheet or a popup knows whether it can show its question (ADR-0147 §1, ADR-0148 §2).
  useEffect(() => {
    controller.setTerminalSize(size.cols, size.rows);
  }, [controller, size.cols, size.rows]);
  // Re-measure on a terminal resize so the <80×24 degrade (and the strip width) tracks the live size.
  useEffect(
    () =>
      subscribeResize(() => {
        nativeAcknowledgement?.invalidate();
        homeFrame.invalidate();
        cardFrame.invalidate();
        controller.getSnapshot().session?.store.invalidateToolReview();
        // The popup host is told by the slot, in the render this size causes, before the popup's frame at the size is committed (and on mount,
        // so a Home that starts below the floor knows it): a step that holds a chord or a secret is not left pending behind the notice below
        // the floor (ADR-0148 §4).
        setSize(getSize());
      }),
    [subscribeResize, getSize, nativeAcknowledgement, cardFrame],
  );

  // Reset the scroll to the TAIL when the chat SESSION changes — a fresh chat, a `/clear` swap, or a `/models` reseat
  // (RootApp is NOT remounted across a swap the way driveInk remounts ChatApp, so without this a new session would
  // inherit the prior one's frozen offset). Keyed on the session OBJECT identity, NOT `sessionId`: a `/models` reseat
  // deliberately PRESERVES the sessionId across the swap (the reseated session adopts the same durable row —
  // home-controller `reseatChat`), so a string-keyed effect would MISS a reseat and leave a scrolled-away transcript
  // frozen (Step-4b-2 Sonnet review). The controller carries `state.session` by reference across non-swap updates and
  // mints a fresh object only on startChat/clearChat/reseatChat, so the object identity fires exactly on a swap.
  // Entering chat (undefined ⇒ session) and leaving it (session ⇒ undefined) also re-follow.
  const session = state.session;
  useEffect(() => {
    applyScroll(INITIAL_SCROLL); // reset on the session-object transition only (deps = [session]); applyScroll only
  }, [session]); // touches render-stable refs + setState, so it is intentionally omitted from the deps.

  // In the alt-screen in-Home chat, PgUp/PgDn/Ctrl+Home/Ctrl+End SCROLL the transcript viewport (Step 4b-2) BEFORE
  // the key reaches the controller — inline mode keeps native scrollback, and a bare Home / a non-chat mode has no
  // viewport, so those fall straight through. Gated on NO keyboard-owning overlay (palette / search / mention /
  // model-picker / a popup) — mirroring ChatApp's after-overlays ordering, so an overlay that
  // later paged with PgUp/PgDn keeps its keys. The approval prompt is in the fixed live region (always visible), so
  // no force-follow is needed (parity with `ChatApp`).
  const noOverlay = !scrollKeysBlocked(flags);
  const altChat = props.alternateScreen === true && state.mode === 'chat' && noOverlay;
  // Capture the mouse exactly while the CHAT owns the screen — not while an overlay is open over it (a transient
  // state; toggling DECSET per overlay would be churn, and a report there is consumed and ignored anyway).
  const mouseCaptured =
    props.alternateScreen === true && state.mode === 'chat' && mouseCapturedFrom(flags);
  const setMouseCapture = props.setMouseCapture;
  useEffect(() => {
    setMouseCapture?.(mouseCaptured);
  }, [mouseCaptured, setMouseCapture]);

  // Reduce against LIVE geometry (parity with `ChatApp`): wrap the session store's CURRENT transcript at the keypress
  // for a fresh `totalLines`, not the `onMeasure` ref which lags by up to a commit — else a mid-stream burst makes
  // `settle` resume-follow against a stale bottom (Step-4b-2 Sonnet review). `getSnapshot()` reads the store fresh
  // regardless of closure staleness; no session (bare Home) ⇒ the lifted geometry, nothing to move. Hoisted out of
  // `useInput` at Step 6 so the scroll keymap and the selection reducer share ONE definition.
  const liveGeom = (): ScrollGeometry => {
    const store = state.session?.store;
    return store === undefined
      ? scrollGeomRef.current
      : transcriptScrollGeometry(
          store.getSnapshot().state.transcript,
          chatGrid(size.cols), // the grid the hosted `ChatView` draws with: its viewport's columns are these
          scrollGeomRef.current.height,
          store.getSnapshot().color,
          store.getSnapshot().toolDisplays,
        );
  };

  /** Reduce one non-wheel mouse report into the in-Home chat's selection (2.6.F Step 6) — the same reducer, the same
   *  viewport facts, and therefore the same behaviour as `relavium chat`. */
  const routeSelection = (event: TerminalMouseEvent): void => {
    routeMouseSelection(event, {
      geometry: () => {
        const measured = scrollGeomRef.current;
        const live = liveGeom();
        return {
          top: measured.top,
          left: measured.left,
          height: live.height,
          totalLines: live.totalLines,
          offset: effectiveOffset(scrollRef.current, live),
        };
      },
      current: () => selectionRef.current,
      setSelection: applySelection,
      copy: copySelection,
      scrollBy: (motion: 'line-up' | 'line-down') =>
        applyScroll(reduceScroll(scrollRef.current, motion, liveGeom())),
      pauseFollow: () => {
        const scroll = scrollRef.current;
        followedBeforeSelectionRef.current = scroll.following;
        if (!scroll.following) return;
        applyScroll({ offset: effectiveOffset(scroll, liveGeom()), following: false });
      },
      restoreFollow: () => {
        if (!followedBeforeSelectionRef.current) return;
        applyScroll({ ...scrollRef.current, following: true });
      },
      gestureActive: () => gestureActiveRef.current,
      setGestureActive: (active: boolean) => {
        gestureActiveRef.current = active;
      },
    });
  };

  /** Copy on release. SILENT on success: a notice would append a transcript entry and shift the very lines the user
   *  just selected. Only a refusal (past the terminal's OSC 52 length floor) is worth telling them about. */
  const copySelection = (state_: SelectionState): void => {
    const clipboard = props.clipboard;
    const session = state.session;
    const current = controller.getSnapshot();
    const store = session?.store;
    if (
      clipboard === undefined ||
      !mouseCapturedFrom(liveOverlays()) ||
      store === undefined ||
      current.mode !== 'chat' ||
      current.session !== session
    )
      return;
    // The content a person sees, without the margin (OQ9): the one copy path of both chat hosts.
    const selected = transcriptSelectionText(
      store.getSnapshot().state.transcript,
      chatGrid(size.cols),
      normalizeSelection(state_),
      store.getSnapshot().color,
      store.getSnapshot().toolDisplays,
    );
    void attemptClipboardWrite(clipboard, selected)
      .then((outcome) => {
        const current = controller.getSnapshot();
        if (
          !clipboardFeedbackMounted.current ||
          current.mode !== 'chat' ||
          current.session !== session ||
          session?.shouldStop() === true ||
          props.inputEnabled?.() === false ||
          !mouseCapturedFrom(liveOverlays())
        )
          return;
        if (outcome.kind === 'written') flashCopied();
        else if (outcome.kind === 'failed') {
          store.note('Clipboard request failed locally — use /scrollback or /edit.');
        } else if (outcome.kind === 'too-large') {
          store.note(
            `selection too large to copy (${Math.ceil(outcome.base64Length / 1024)} KB) — use /scrollback or /edit`,
          );
        }
      })
      .catch((cause: unknown) =>
        props.onRendererError?.(new CliError('cli_internal', '', { cause })),
      );
  };

  // A resize re-wraps the transcript, and a session swap (`/clear`, a reseat) replaces it — either way every
  // display-line index the selection holds moves. Drop it rather than highlight, and copy, the wrong text.
  useEffect(() => {
    applySelection(undefined);
  }, [size.cols, state.session]);

  /** One wheel notch. Kept beside `routeSelection` so the two mouse verbs read alike. */
  const routeWheel = (direction: 'up' | 'down'): void => {
    const geom = liveGeom();
    const motion = direction === 'up' ? 'line-up' : 'line-down';
    let next = scrollRef.current;
    for (let i = 0; i < WHEEL_LINES; i += 1) next = reduceScroll(next, motion, geom);
    applyScroll(next);
  };

  /**
   * Consume a mouse report, if `input` is one. Returns `true` when it was — the caller must then type NOTHING: a
   * report's raw bytes must never reach the Home prompt, the `/` palette filter, or a card. That is
   * true in EVERY mode and behind EVERY overlay; only the ROUTING is gated on the chat owning the screen.
   */
  const consumeMouseReport = (input: string): boolean => {
    if (props.alternateScreen !== true) return false;
    const read = mouseReaderRef.current.read(input);
    if (read.kind === 'none') return false;
    const mouse = read.kind === 'event' ? read.event : undefined;
    if (
      mouse !== undefined &&
      altChat && // the submodes, as of the last render
      // The prompt and the cards are read NOW, so a report that arrives in the chunk that opened one is not routed under it.
      !pointerBlocked({
        ...NO_OVERLAYS,
        ...cardFlagsFrom(controller.getSnapshot().session?.store.getSnapshot()),
        nativePrompt: props.nativePrompt?.getSnapshot().active === true,
        popup: props.popups?.getSnapshot().open === true,
      })
    ) {
      if (mouse.kind === 'wheel') routeWheel(mouse.direction);
      else routeSelection(mouse);
    }
    return true;
  };

  /** Whether a key is delivered to the Home below 80×24: `Esc`, `Ctrl+C` and `Ctrl+D`, and `Ctrl+Y` and `Ctrl+N` while the exit-guard card is open. */
  const deliveredBelowMinimum = (input: string, key: Key, exitGuardOpen: boolean): boolean => {
    if (key.escape) return true;
    if (!key.ctrl) return false;
    return input === 'c' || input === 'd' || (exitGuardOpen && (input === 'y' || input === 'n'));
  };

  /** Whether `PgUp` or `PgDn` pages the landing's notice: the bare landing with a notice, and no card, screen or overlay over it. */
  const pagesNotice = (current: HomeControllerState, key: Key): boolean =>
    current.mode === 'home' &&
    current.notice !== undefined &&
    !noticePagingBlocked(homeOverlayFlags(current)) &&
    (key.pageUp || key.pageDown);

  /**
   * `Enter` on a row `↓` just moved onto (a session to resume, a run to open) counts only once that very frame is on screen: a coalesced
   * `↓` + `Enter` cannot act on a row the person has not seen, so the key is swallowed until it is.
   * (Only on the Home's pages: a screen in the slot has no list on screen to measure, and its own Enter must reach it. Not while the pages
   * slide: the controller drops an `Enter` pressed then, and an answer chord, when it is pressed, since no frame has shown the page at rest.)
   */
  const enterOnUnseenRow = (current: HomeControllerState, key: Key): boolean =>
    key.return &&
    current.screen === undefined &&
    current.slide === undefined &&
    current.stripFocus !== undefined &&
    !homeFrame.visible(current);

  /**
   * A key while the terminal is below 80×24: only the way out is delivered to the Home, and with the exit-guard card open its two chords too
   * (the degrade shows the card); any other key is not delivered, but a card that is open counts it as typing, so a chord soon after it is
   * refused.
   */
  const routeBelowFloor = (current: HomeControllerState, input: string, key: Key): void => {
    if (deliveredBelowMinimum(input, key, current.exitGuard !== undefined))
      controller.handleKey(input, key);
    else if (current.screen?.kind === 'gate-card') current.screen.card.unseenInput();
  };

  const routeHomeInput = (input: string, key: Key): boolean => {
    const current = controller.getSnapshot();
    if (current.mode === 'chat') return false;
    const live = getSizeRef.current();
    if (enterOnUnseenRow(current, key)) return true;
    if (!homeFitsTerminal(live.cols, live.rows)) {
      routeBelowFloor(current, input, key);
      return true;
    }
    if (!pagesNotice(current, key)) return false;
    const previous = noticeWindowRef.current;
    const same =
      previous.revision === current.noticeRevision &&
      Object.is(previous.cols, live.cols) &&
      Object.is(previous.rows, live.rows);
    // The notice is laid out for the page in front, exactly as the view lays it out (the landing keeps the hosted run's row under its status line).
    const onLanding =
      current.homePage !== 'work' || homeIsEmpty(current.snapshot, current.parkedRuns);
    const layout = layoutHomeNotice({
      notice: current.notice,
      editor: current.input,
      cols: live.cols,
      rows: live.rows,
      showBanner: props.showBanner,
      onLanding,
      hasSessions: current.snapshot.recentSessions.length > 0,
      ...stripReach(current.parkedRuns, current.snapshot),
      reservedRows: onLanding && hostedRunLabel(current.hostedRun) !== undefined ? 1 : 0,
      page: same ? previous.page : 0,
    });
    if (layout === undefined || layout.maxPage === 0) return false;
    const next = {
      revision: current.noticeRevision,
      cols: live.cols,
      rows: live.rows,
      page: Math.max(0, Math.min(layout.maxPage, layout.page + (key.pageUp ? -1 : 1))),
    };
    noticeWindowRef.current = next;
    setNoticeWindow(next);
    return true;
  };

  const readHomeKey = (input: string, key: Key): void => {
    if (props.inputEnabled?.() === false) return;
    // Ink raw mode parses Ctrl-Z as Ctrl+`z` (some harnesses surface the literal SUB byte). Consume it BEFORE mouse,
    // overlays, and the Home controller so it can neither type into a prompt nor answer a pending approval.
    if (
      input === '\x1a' ||
      (key.ctrl === true && key.meta !== true && input.toLowerCase() === 'z')
    ) {
      controller.getSnapshot().session?.store.invalidateToolReview();
      homeFrame.invalidate();
      cardFrame.invalidate();
      popupAcknowledgement?.invalidate();
      props.onSuspend?.();
      return;
    }
    if (props.nativePrompt?.getSnapshot().active === true) {
      if (consumeMouseReport(input)) return;
      if (nativeAcknowledgement?.inputVisible(input, key) !== true) {
        if (
          key.escape ||
          key.meta ||
          (key.ctrl && input.toLowerCase() === 'c') ||
          input.includes('\x1b') ||
          input.includes('\x03')
        )
          props.nativePrompt.input('\x1b', key);
        // Any other key is not delivered (the card is not visible), but it is typing as far as the chord guard is concerned: while a
        // card is open, every key the person types in the composer reaches the channel's typeahead and quiet layers, seen or not.
        // A key typed with NO card open never gets here: it is a composer edit, not typeahead.
        else props.nativePrompt.unseenInput(input, key);
        return;
      }
      props.nativePrompt.input(input, key);
      return;
    }
    if (controller.getSnapshot().nativeActionBusy) return;
    // An open popup owns every key (ADR-0148 §2): this root is the one reader and routes them to it, as it routes them to a card. A mouse
    // report is consumed first so its bytes can never type into the popup.
    if (props.popups?.getSnapshot().open === true) {
      if (consumeMouseReport(input)) return;
      props.popups.input(input, key);
      return;
    }
    if (consumeMouseReport(input)) return;
    if (routeKeyThroughCards(controller, controller.getSnapshot().session?.store, input, key))
      return;
    if (routeHomeInput(input, key)) return;
    if (altChat) {
      // Esc DISMISSES a live selection. Gated on an IDLE chat: while a turn streams, Esc is the mid-turn ABORT that
      // `controller.handleKey` reduces, and shadowing an abort with a cosmetic clear would be a bad trade. Mirrors
      // ChatApp exactly — a click still clears the highlight mid-turn.
      const chatRunning = state.session?.store.getSnapshot().state.status === 'running';
      if (key.escape === true && !chatRunning && selectionRef.current !== undefined) {
        applySelection(undefined);
        return;
      }
      const motion = scrollMotionForKey(key);
      if (motion !== undefined) {
        applyScroll(reduceScroll(scrollRef.current, motion, liveGeom()));
        return;
      }
    }
    controller.handleKey(input, key);
  };
  // The Home's one reader never hears a key's release (`pressesOnly`: a release would type a letter twice and give a card or a line a second
  // `Ctrl+Y`).
  useInput(pressesOnly(readHomeKey));
  // Bracketed paste arrives on ink 7's native `usePaste` channel (separate from `useInput`): the whole paste is
  // one `text` event, so a multi-line block appends verbatim and a pasted approval token never reaches the key
  // reducers (ADR-0068). The controller gates it (drops behind an overlay / pending approval / mid-turn).
  usePaste((text) => {
    if (props.inputEnabled?.() === false) return;
    if (props.nativePrompt?.getSnapshot().active === true) {
      if (nativeAcknowledgement?.pasteVisible() === true) props.nativePrompt.paste(text);
      else props.nativePrompt.unseenInput();
      return;
    }
    if (controller.getSnapshot().nativeActionBusy) return;
    // A paste goes into a popup's text field or nowhere: never to the composer behind it.
    if (props.popups?.getSnapshot().open === true) {
      props.popups.paste(text);
      return;
    }
    const live = getSizeRef.current();
    if (controller.getSnapshot().mode !== 'chat' && !homeFitsTerminal(live.cols, live.rows)) return;
    controller.handlePaste(text);
  });
  const flushVisible = useVisibleRenderFlush(
    props.onRendererError,
    props.suspendPort,
    acknowledgement,
    nativeAcknowledgement,
  );
  useEffect(() => {
    props.onRendererReady?.(flushVisible);
  }, [flushVisible, props.onRendererReady]);

  // The one overlay slot (ADR-0148 §2): the LAST child of the root in every branch, and the only absolutely positioned node of the CLI.
  const slotProps: PopupSlotProps = {
    host: props.popups,
    acknowledgement: popupAcknowledgement,
    native:
      nativeAcknowledgement === undefined
        ? undefined
        : { snapshot: prompt, acknowledgement: nativeAcknowledgement },
    placement,
    size,
    color,
    flush: () => app.waitUntilRenderFlush(),
  };
  // The slot tells the popup host the size, and voids its frame, before it commits the frame at that size (and once on mount).
  const slot = <PopupSlot {...slotProps} />;
  // The body behind the slot is the backdrop of an open popup, drawn dim, exactly when the slot is drawing an overlay box over it (ADR-0148 §4).
  // It is the slot's own predicate, asked of the slot's own props, and the slot itself stays OUTSIDE the dimmed subtree in every branch: the
  // popup's cells are never dim, and nothing that is not the slot is positioned absolutely. A boolean: it changes only when a popup opens or closes.
  // The same predicate takes the cursor out of the composer and the notification off the hint row while a popup is drawn.
  const drawing = slotDrawing(slotProps, popupSnapshot);
  const dimmed = dimsBackdrop(drawing, color);
  const composer = composerEditor(state.input, drawing);
  const hintNotification = hintRowNotification(notification.current?.text, drawing);
  // In the overlay the root must be as tall as the screen less a row, so the absolutely positioned popup lies inside it.
  const overlayOpen =
    placement === 'overlay' && (popupSnapshot.open || (prompt.active && nativeFramed(prompt)));
  if (state.mode === 'chat' && state.session !== undefined) {
    return (
      <>
        <BackdropDim dimmed={dimmed}>
          <ChatRegion
            acknowledgement={acknowledgement}
            store={state.session.store}
            reviewSize={size}
            reviewCustody={() =>
              props.inputEnabled?.() !== false &&
              props.suspendPort?.isSuspended() !== true &&
              holdsCustody(liveOverlays())
            }
            reviewClipboard={props.reviewClipboard}
            editor={state.input}
            composerCursor={drawing === undefined}
            provider={state.session.provider}
            overlays={flags}
            palette={state.palette}
            search={state.search}
            mention={state.mention}
            now={props.nowMs}
            cols={size.cols}
            // Alt-screen (Step 4b): the resize-tracked size bounds the chat region + wraps the transcript viewport, which
            // carries the scroll state (4b-2) + reports its geometry back into `scrollGeomRef` for the scroll keymap.
            viewport={
              props.alternateScreen === true
                ? {
                    rows: chatViewportRows(flags, prompt, size),
                    cols: size.cols,
                    scroll,
                    // Document-ordered here, once: the viewport draws it, `copySelection` re-derives it for the clipboard.
                    ...(selection === undefined
                      ? {}
                      : { selection: normalizeSelection(selection) }),
                    onMeasure: (g: ViewportGeometry): void => {
                      scrollGeomRef.current = g;
                    },
                  }
                : undefined
            }
            interruptArmed={state.interruptArmed}
            shellBusy={state.shellBusy}
            submitBusy={state.submitBusy}
            shellCommand={state.shellCommand}
            historyEntries={state.historyEntries}
            attachments={state.attachments}
            copied={copied}
            promptHeight={chatPromptHeight(flags, prompt, size)}
            notification={hintNotification}
          />
          {nativeAcknowledgement && (
            <NativePromptView
              snapshot={prompt}
              color={color}
              acknowledgement={nativeAcknowledgement}
              size={size}
            />
          )}
        </BackdropDim>
        {slot}
      </>
    );
  }
  if (state.mode === 'loading') {
    return (
      <LoadingEcho
        width={layoutColumns(size.cols)}
        // The echo is a landing too: the exit-guard card is drawn in it, and its `Ctrl+Y` counts only for a frame measured and flushed, as
        // on the Home (ADR-0139 §6). A loading frame that is never committed would leave the card offering a key that is always refused.
        onFrame={(node) => {
          homeFrame.commit(state, node, () => app.waitUntilRenderFlush());
        }}
      >
        <BackdropDim dimmed={dimmed}>
          {state.pendingMessage !== '' && (
            // A chat that starts with no typed message (an agent's `c`, ADR-0140 §3) has nothing to echo: no bare `>` is drawn for it.
            <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
              {'> '}
              {sanitizeInline(state.pendingMessage)}
            </Text>
          )}
          {!homeFitsTerminal(size.cols, size.rows) && (
            // The landing says so below 80×24 and so does its echo: a card drawn in the degrade, and a `Ctrl+Y` that answers nothing
            // there, are explained by the one line that says what to do about it.
            <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
              {tooSmallMessage(size.cols, size.rows)}
            </Text>
          )}
          {state.exitGuard === undefined ? (
            <Text {...dimProps(color)} wrap="truncate-end">
              {STARTING_CHAT_LINE}
            </Text>
          ) : (
            <ExitGuardCard
              phase={state.exitGuard}
              hostedRun={state.hostedRun}
              color={color}
              columns={size.cols}
              locked={exitGuardLocked}
            />
          )}
          {nativeAcknowledgement && (
            <NativePromptView
              snapshot={prompt}
              color={color}
              acknowledgement={nativeAcknowledgement}
              size={size}
            />
          )}
        </BackdropDim>
        {slot}
      </LoadingEcho>
    );
  }
  return (
    <Box
      flexDirection="column"
      width={layoutColumns(size.cols)}
      {...landingRootHeight(occupiesRows(flags) && nativeCardShown(prompt), overlayOpen, size)}
    >
      <BackdropDim dimmed={dimmed}>
        {nativeAcknowledgement && (
          <NativePromptView
            snapshot={prompt}
            color={color}
            acknowledgement={nativeAcknowledgement}
            size={size}
          />
        )}
        {/* A screen of the slot (ADR-0140 §1) takes the body of the landing: the strip and the prompt are not drawn while it is open. */}
        {!occupiesRows(flags) && state.screen?.kind === 'run-view' && (
          <RunScreenView
            runId={state.screen.runId}
            store={state.screen.store}
            hostedRun={state.hostedRun}
            notices={state.screen.notices}
            interruptArmed={state.interruptArmed}
            openGate={state.gateCards}
            gateOpenFailed={state.screen.note !== undefined}
            columns={size.cols}
            rows={size.rows}
            color={color}
          />
        )}
        {!occupiesRows(flags) && state.screen?.kind === 'gate-card' && (
          <GateCardScreenView
            screen={state.screen}
            frame={cardFrame}
            flush={() => app.waitUntilRenderFlush()}
            columns={size.cols}
            rows={size.rows}
            nowMs={props.nowMs()}
            color={color}
            waitClock={waitClockForm(props.alternateScreen)}
          />
        )}
        {!occupiesRows(flags) && state.screen?.kind === 'tab-host' && (
          <TabHostView
            state={state.screen.host}
            color={color}
            columns={size.cols}
            rows={size.rows}
          />
        )}
        {!occupiesRows(flags) && state.screen === undefined && (
          <HomeView
            onFrame={(node) => {
              homeFrame.commit(state, node, () => app.waitUntilRenderFlush());
            }}
            snapshot={state.snapshot}
            editor={composer}
            notice={state.notice}
            nowMs={props.nowMs()}
            cols={Number.isFinite(size.cols) ? size.cols : 0}
            rows={size.rows}
            color={color}
            paletteOpen={landingPromptHidden(flags)}
            {...(state.palette === undefined ? {} : { palette: state.palette })}
            mention={state.session === undefined ? state.mention : undefined}
            showBanner={props.showBanner}
            alternateScreen={props.alternateScreen === true}
            status={state.status}
            keyless={state.keyless}
            parkedRuns={state.parkedRuns}
            stripFocus={state.stripFocus}
            page={state.homePage}
            slideOffset={slideOffsetAt(size.rows, state.slide)}
            noticePage={noticePage}
            interruptArmed={state.interruptArmed}
            hostedRun={state.hostedRun}
            exitGuard={state.exitGuard}
            exitGuardLocked={exitGuardLocked}
            notification={hintNotification}
          />
        )}
        {/* The `/` palette is drawn by `HomeView`, in the prompt's place, so that the strip and the notice leave it its rows. */}
      </BackdropDim>
      {slot}
    </Box>
  );
}

/** The line under the echo of a message while the first chat is built: `Ctrl+C` leaves the Home from here (ADR-0145 §3). Exported for the legend golden. */
export const STARTING_CHAT_LINE = legend(
  [{ text: 'Starting chat…' }],
  exitKey.leave('exit', 'Ctrl+C'),
);

/**
 * The echo shown while the first chat is being built: the person's first line, and the exit-guard card when one is open. Every commit of
 * its box goes to the Home's measured-frame evidence (`onFrame`), as `HomeView`'s does for the landing: a React commit alone is never
 * evidence that the card was delivered.
 */
function LoadingEcho(
  props: Readonly<{
    width: number;
    onFrame: (node: DOMElement | null) => void;
    children: ReactNode;
  }>,
): ReactElement {
  const frame = useRef<DOMElement | null>(null);
  useLayoutEffect(() => {
    props.onFrame(frame.current);
  });
  return (
    <Box ref={frame} flexDirection="column" width={props.width}>
      {props.children}
    </Box>
  );
}

/**
 * The landing root's height: a native card that takes the rows fills the screen (one row when the screen cannot hold it), clipping what
 * overflows; an overlay keeps the root as tall as the screen less a row, so the absolutely positioned popup lies inside it; otherwise the root
 * takes its content's height.
 */
function landingRootHeight(
  nativeCardTakesRows: boolean,
  overlayOpen: boolean,
  size: { readonly cols: number; readonly rows: number },
): { readonly height?: number; readonly overflowY?: 'hidden'; readonly minHeight?: number } {
  if (nativeCardTakesRows)
    return { height: nativePromptFits(size) ? size.rows : 1, overflowY: 'hidden' };
  return overlayOpen ? { minHeight: Math.max(1, size.rows - 1) } : {};
}

/**
 * The gate or budget card of the slot, painted from the card's own snapshots. The view is pure; this is its one effect: every commit of
 * the card's box goes to the card's measured-frame evidence, which tells the card when a NEW frame was measured and flushed.
 */
function GateCardScreenView(
  props: Readonly<{
    screen: GateCardScreen;
    frame: GateCardFrame;
    flush: () => Promise<void>;
    columns: number;
    rows: number;
    nowMs: number;
    color: boolean;
    /** The sheet's wait clock: ticking in the alternate screen, static inline (ADR-0147 §2). */
    waitClock: WaitClockForm;
  }>,
): ReactElement {
  const { card } = props.screen;
  const snapshot = useSyncExternalStore(card.subscribe, card.getSnapshot);
  // The card's own one-second timer (it has no store tick): a display value of this view, in no snapshot and read by no guard, so a re-render
  // it causes re-commits the same snapshot, which the measured-frame evidence does not count as a new frame (ADR-0147 §2).
  const clock = useWaitClock(
    snapshot.phase === 'open' ? props.screen.waitingSinceMs : undefined,
    props.waitClock,
  );
  // The lockout as the legend draws it (`(wait)`): the card's display value, one repaint when it opens; no frame's identity changes.
  const locked = useSyncExternalStore(card.lock.subscribe, card.lock.read);
  return (
    <RunCardView
      snapshot={snapshot}
      columns={props.columns}
      rows={props.rows}
      nowMs={props.nowMs}
      clock={clock}
      locked={locked}
      color={props.color}
      onFrame={(node) => {
        props.frame.commit(snapshot, node, props.flush);
      }}
    />
  );
}

/**
 * Why a popup may not open on the Home now ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2), or `undefined` when it may: the one refusal (`popup-refusal.ts`) over the Home's facts. A chat is being built; a card of the live chat is
 * open; a sheet (a native card, the exit guard, a gate card) is; a turn, a submit, a `!` command or a native action runs; the interrupt keymap
 * is armed (a two-step); or something else owns the keyboard (a palette, a picker, a sheet, a screen). The popup host asks this at every open
 * and says the reason in one notification.
 */
export function homePopupRefusal(
  state: HomeControllerState,
  native: NativePromptSnapshot | undefined,
): PopupRefusal | undefined {
  const cards = cardFlagsFrom(state.session?.store.getSnapshot());
  return popupRefusal({
    starting: state.mode === 'loading',
    cards: cards.approval || cards.review || cards.question || cards.checkpoint,
    sheet:
      native?.active === true ||
      state.exitGuard !== undefined ||
      state.screen?.kind === 'gate-card',
    turn: homeTurnFacts(state),
    armed: state.interruptArmed,
    overlay: overlayOwnsKeyboard(homeOverlayFlags(state)),
  });
}

/**
 * The kinds of sheet the Home has and how to follow them, for {@link bindPopupHost}: a card of the live chat, a native card, the exit guard, a
 * gate card, followed through the controller, the live chat's store (across a new session) and the native prompt channel. One of them that
 * ARRIVES (it was not there a moment before) closes the open popup unanswered: the sheet wins and nothing is restored (ADR-0148 §2). A popup the
 * person opened over a card that was already there (a race the open gate refuses) is not closed by it: that card's custody is revoked and its
 * evidence reset instead.
 */
export function homeSheetSources(
  controller: Pick<HomeController, 'getSnapshot' | 'subscribe'>,
  native: Pick<NativePromptUi, 'getSnapshot' | 'subscribe'> | undefined,
): PopupSheetSources<'card' | 'native' | 'exitGuard' | 'gateCard'> {
  return {
    present: () => {
      const state = controller.getSnapshot();
      const cards = cardFlagsFrom(state.session?.store.getSnapshot());
      return {
        card: cards.approval || cards.question || cards.checkpoint,
        native: native?.getSnapshot().active === true,
        exitGuard: state.exitGuard !== undefined,
        gateCard: state.screen?.kind === 'gate-card',
      };
    },
    subscribe: (onChange) => watchHomeSources(controller, native, [], onChange),
  };
}

/**
 * Call `onChange` whenever anything that decides a sheet or the hint row on the Home may have changed: the controller, the live chat's store
 * (followed across a new session), the native prompt channel and any other source given. Called once at the start too. The Home's root does not
 * re-render on a chat store's change (the chat region does), so a fact read from the store is followed here, never from a render. Returns the
 * unsubscribe.
 */
export function watchHomeSources(
  controller: Pick<HomeController, 'getSnapshot' | 'subscribe'>,
  native: Pick<NativePromptUi, 'subscribe'> | undefined,
  others: readonly ((listener: () => void) => () => void)[],
  onChange: () => void,
): () => void {
  let watched: ChatStoreController | undefined;
  let unwatchStore: (() => void) | undefined;
  const check = (): void => {
    const store = controller.getSnapshot().session?.store;
    if (store !== watched) {
      unwatchStore?.();
      watched = store;
      unwatchStore = store?.subscribe(check);
    }
    onChange();
  };
  check();
  const stops = [
    controller.subscribe(check),
    ...(native === undefined ? [] : [native.subscribe(check)]),
  ];
  for (const subscribe of others) stops.push(subscribe(check));
  return () => {
    for (const stop of stops) stop();
    unwatchStore?.();
  };
}

/**
 * Whether the Home's notifications are held now: a decision is on screen (a card, a native prompt, the exit guard, a screen in the slot, a
 * popup step that holds a chord or a secret), or the hint row they draw on is not drawn (a block in the flow, below the floor, a chat that has
 * a submode open), or the Home's armed `Ctrl+C` has it. A chat that is busy draws it: the running hint, which a notification replaces.
 */
function notificationHeld(
  state: HomeControllerState,
  prompt: NativePromptSnapshot,
  popup: PopupHostSnapshot,
  flags: OverlayFlags,
  size: { readonly cols: number; readonly rows: number },
): boolean {
  const cards = cardFlagsFrom(state.session?.store.getSnapshot());
  if (cards.approval || cards.review || cards.question || cards.checkpoint) return true;
  if (prompt.active || state.exitGuard !== undefined || state.screen !== undefined) return true;
  if (popup.frame !== undefined && currentStep(popup.frame).spec.holds !== undefined) return true;
  if (flags.replacesBody || state.mode === 'loading' || !homeFitsTerminal(size.cols, size.rows))
    return true;
  // On the Home's pages the armed `Ctrl+C` wins the hint row (`[Ctrl+C] exit (again)`: the next press leaves), and a notification that would
  // hide it waits, unspent, until the armed state ends (MVP-11 unit 7, round 1: CO75).
  if (state.mode === 'home') return state.interruptArmed || landingPromptHidden(flags);
  // A chat that is busy (a turn, a `!` command, a submit in flight) draws its hint row (the running hint), so it does not hold the channel: a
  // refusal raised while it runs is read at once, not after the turn (SE7-1).
  return promptHidden(flags);
}

const emptyPromptSnapshot = (): import('./native-prompt-channel.js').NativePromptSnapshot =>
  emptyPrompt;
const emptyPrompt: import('./native-prompt-channel.js').NativePromptSnapshot = {
  active: false,
  kind: 'idle',
  message: '',
  note: '',
  options: [],
  selected: 0,
  display: '',
  error: '',
  escape: 'cancel',
  details: [],
};
const emptyPromptSubscribe = (): (() => void) => () => {};

type NativeSize = Parameters<typeof nativePromptFits>[0];

/**
 * The rows the chat's FRAME keeps in the alternate screen, which bound its root (the header, the transcript viewport and the prompt block all
 * sit inside it): the terminal's less one with no native card open ({@link chatFrameRows}), what the card leaves of that while one is, and one row
 * when the card does not fit (the card then owns the screen).
 */
function chatViewportRows(
  flags: OverlayFlags,
  prompt: NativePromptSnapshot,
  size: NativeSize,
): number {
  // The frame is one row short of the terminal in every case (ADR-0146 §4), the card's rows come out of that.
  const frame = chatFrameRows(size.rows);
  if (!occupiesRows(flags)) return frame;
  // A popup's block takes the whole live region: the viewport keeps one row.
  if (!nativeCardShown(prompt)) return 1;
  return nativePromptFits(size) ? Math.max(1, frame - promptRows(prompt, size.cols)) : 1;
}

/** The rows the chat region is bounded to while a native card is open (two fewer than the viewport keeps), or `undefined` with none open. */
function chatPromptHeight(
  flags: OverlayFlags,
  prompt: NativePromptSnapshot,
  size: NativeSize,
): number | undefined {
  if (!occupiesRows(flags)) return undefined;
  // A popup's block (inline) is the whole live region, so the region above it keeps no rows: the whole stays at most `rows − 1` (ADR-0148 §4).
  if (!nativeCardShown(prompt)) return 0;
  return nativePromptFits(size) ? Math.max(0, size.rows - promptRows(prompt, size.cols) - 2) : 0;
}

/**
 * How many rows a native card takes at `columns`, never fewer than it draws: the room the chat region leaves it. A chord card's key rows carry
 * the answer key's tag as the legend writes it ({@link keyToken}), so the estimate cannot drift from the words on screen.
 */
export function promptRows(prompt: NativePromptSnapshot, columns: number): number {
  const width = Math.max(1, Number.isFinite(columns) ? Math.trunc(columns) : 80);
  if (prompt.kind === 'picker') {
    const lines = [prompt.note, prompt.message, prompt.error].filter(Boolean);
    return (
      2 +
      Math.max(1, Math.ceil((3 + displayWidth(prompt.display)) / width)) +
      prompt.options.reduce((count, option) => count + 1 + (option.hint === undefined ? 0 : 1), 0) +
      (prompt.picker?.loading === true || (prompt.options.length === 0 && prompt.error === '')
        ? 1
        : 0) +
      lines.reduce((count, value) => count + Math.max(1, Math.ceil(displayWidth(value) / width)), 0)
    );
  }
  const lines = [
    prompt.note,
    prompt.message,
    // A chord card's body sits behind a two-column gutter, and its key rows carry the answer key's tag (`[Ctrl+Y] `, as the legend writes it).
    ...prompt.details.map((line) => `│ ${line}`),
    ...prompt.options.map((option) => {
      const lead = prompt.kind === 'chord' ? `  ${keyToken('Ctrl+Y')} ` : '  ';
      const hint = option.hint ? ` — ${option.hint}` : '';
      return `${lead}${option.label}${hint}`;
    }),
    prompt.display,
    prompt.error,
  ].filter(Boolean);
  return (
    1 + lines.reduce((sum, value) => sum + Math.max(1, Math.ceil(displayWidth(value) / width)), 0)
  );
}
