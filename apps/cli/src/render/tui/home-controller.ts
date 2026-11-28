import { isDeepStrictEqual } from 'node:util';

import type { UserCommandOutcome } from '@relavium/core';
import type { ModelCatalogEntry } from '@relavium/llm';
import type { ReasoningEffort, RunStatus } from '@relavium/shared';

import {
  availabilityOf,
  HOME_CHAT_PALETTE_COMMANDS,
  HOME_PALETTE_COMMANDS,
  homeOnlyPointer,
  REPL_COMMANDS_BY_NAME,
  unavailableNotice,
  type ReplCommand,
  type ReplCommandContext,
} from '../../commands/repl-commands.js';
import type { RefreshReport } from '../../engine/model-refresh.js';
import { providerDisplayName } from '../../engine/providers.js';
import { saveDefaultModel } from '../../chat/default-model-save.js';
import { createActivePoll, type ActivePoll } from '../../history/active-poll.js';
import type { ActiveRead } from '../../history/active-source.js';
import type { ChangeToken } from '../../history/change-probe.js';
import type { PermissionsPort } from '../../permissions/chat-permissions.js';
import {
  disarmTabHost,
  enterHistoryAtDetail,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostMemory,
  withActiveFailure,
  withActiveNote,
  withActiveRead,
  withHistoryLoad,
  withHistoryLoadFailure,
  withHistoryNote,
  type TabEntry,
  type TabHostState,
  type TabId,
  type TabMemory,
} from './tab-host.js';
import type { HistoryPort } from './tab-host-history.js';
import type { PinPort } from './tab-host-pin.js';
import type { DefinedPort } from '../../history/defined-model.js';
import type { ReseatTarget } from '../../commands/chat.js';
import { nextMode, type ChatMode } from '../../chat/chat-mode.js';
import { clearedNotice, modelSwitchNotice } from '../../chat/repl-info.js';
import type { DoctorPort } from '../../popups/doctor-port.js';
import { refusedOpenText, type PopupRefusal } from '../../popups/popup-host.js';
import { popupRefusal } from '../../popups/popup-refusal.js';
import { turnInFlight, type TurnFacts } from '../../popups/turn-in-flight.js';
import type { ParsedReportLine, ReportsPort } from '../../popups/report-port.js';
import {
  MODEL_SWITCH_FAILED,
  type DefaultModelSaveResult,
  type ModelChoice,
  type ModelsSettingsPort,
  type SettingsKind,
  type SettingsPort,
  type StartupDefaultMember,
  type StartupDefaultOutcome,
} from '../../popups/settings-port.js';
import {
  type HomePopupKind,
  type HomePopupsPort,
  type HomeWorkflowRun,
  type WorkflowsAt,
  type WorkflowsStep,
} from '../../popups/home-port.js';
import type { LaunchOptions } from '../../home/run-launch.js';
import type { WorkflowDetail } from '../../home/workflow-detail.js';
import { routePopupLine, type PopupRoute } from '../../popups/popup-route.js';
import {
  agentStartNotice,
  agentStartReasonOf,
  type HomeAgentRequest,
} from '../../home/agent-start.js';
import type { AgentsPort } from '../../home/agents-port.js';
import {
  sameStatusFacts,
  type HomeStatusFacts,
  type HomeStatusReader,
} from '../../home/home-status-facts.js';
import type { HomeSnapshot, HomeStore, HomeUnreadableRun } from '../../home/home-store.js';
import type {
  HostedLaunch,
  HostedLegEnd,
  HostedResumeRequest,
  RunHost,
  RunHostSnapshot,
} from '../../home/run-host.js';
import { cardGatesOf, isMediaOnlyPark, type RunGates } from '../../home/run-gates.js';
import type { RunNotices } from '../../home/run-notices.js';
import type { InvocationWorkOwner } from '../../process/invocation-work-owner.js';
import {
  applyEditorAction,
  draftText,
  editorFromText,
  emptyEditor,
  insertAtCursor,
  pasteIsEditable,
  reduceChatKey,
  type ChatKey,
  type ChatKeyAction,
  type EditorState,
} from './chat-input.js';
import {
  EMPTY_HISTORY,
  INITIAL_REVERSE_SEARCH,
  foldReverseSearchKey,
  historyNext,
  historyPrev,
  recordHistory,
  resetHistoryNav,
  type InputHistory,
  type ReverseSearchState,
} from './input-history.js';
import type { ChatStoreController } from './chat-store.js';
import type { TranscriptEntry } from './session-view-model.js';
import {
  DISARMED,
  INTERRUPT_ARM_WINDOW_MS,
  decideExit,
  isInterruptKey,
  pressExitGuardKey,
  pressInterrupt,
  pressOtherKey,
  pressRunViewInterrupt,
  pressRunViewKey,
  pressTabHostInterrupt,
  type HostedLegState,
  type InterruptContext,
  type InterruptState,
} from './interrupt-keymap.js';
import {
  foldMentionKey,
  mentionOpensAt,
  type MentionCandidate,
  type MentionReader,
  type MentionState,
} from './mention.js';
import {
  appendAttachment,
  attachmentsOfDraft,
  buildOutbound,
  commandResultPreview,
  createPickEnterLock,
  fileAttachmentWarning,
  mentionMarker,
  MAX_PENDING_ATTACHMENTS,
  type PendingAttachment,
} from './attachments.js';
import {
  commandLine,
  isShellLine,
  parseShellLine,
  SHELL_UNTERMINATED_QUOTE_NOTICE,
  shellDenyHint,
  type ShellCommand,
} from './shell.js';
import { reduceHomeKey, type HomeKey } from './home-input.js';
import { buildPaletteEntries } from './palette-entries.js';
import {
  foldPaletteKey,
  openPalette,
  shouldOpenPalette,
  type OpenPalette,
  type PaletteKey,
} from './palette-reducer.js';
import {
  FORCE_TEARDOWN_MS,
  HOSTED_RUN_EXIT_GRACE_MS,
  HOSTED_RUN_POLL_MS,
} from './tui-constants.js';
import {
  HOME_MIN_ROWS,
  homeFitsTerminal,
  hostedRunIsLive,
  homeIsEmpty,
  workRowText,
  type ExitGuardPhase,
} from './home-projection.js';
import { EXAMPLE_PROMPT, exampleIsShown } from './home-layout.js';
import {
  reducePageKey,
  SLIDE_FRAME_MS,
  SLIDE_SETTLE_BOUND_MS,
  slideFrames,
  type HomePage,
  type HomeSlide,
  type PageKey,
} from './home-pages.js';
import { stripRefreshPaused } from './strip-pause.js';
import {
  activePollPausedByOverlay,
  cardFlagsFrom,
  interruptContextFrom,
  pasteFlagsFrom,
  screenSlotBlocked,
  type OverlayFlags,
} from './overlay-flags.js';
import { createStripBackoff } from './strip-backoff.js';
import {
  focusAt,
  focusFor,
  resolveFocus,
  stripRows,
  type StripFocus,
  type StripRow,
} from './strip-focus.js';
import type { RunStore } from './run-store.js';
import { runScreenLeg, runScreenPhase } from './run-screen.js';
import { nearestCommandName } from './command-typo.js';
import { HOME_KEYS } from './help-sheet.js';
import {
  foldKeyLookalikes,
  hostedEndNotice,
  showsRelativeWords,
  type ParkedRunRow,
} from './home-attention.js';
import { withGlyphForm } from './glyphs.js';
import { authorLine, createRunCard, type RunCard, type RunCardSnapshot } from './run-card-model.js';
import {
  chordOf,
  createChordGuard,
  createChordHistory,
  createLockDisplay,
  type ChordHistory,
  type LockDisplay,
} from './chord-guard.js';
import { keyHint, keyToken } from './legend.js';
import { resolveApprovalGuard, type ApprovalGuard } from './tool-review-model.js';
import { looksLikeProviderKey } from '../provider-key-shape.js';
import { sanitizeInline } from '../sanitize.js';

/**
 * The Home session state machine, extracted from the ink view as a plain external store (2.5.B / ADR-0054) so the
 * lifecycle — submit → build → chat → end, the build/turn error paths, the exit/close-race guards, and bracketed
 * paste — is unit-testable without mounting Ink. Installed-RootApp integration tests also use captured native
 * streams. `RootApp` is a thin view that
 * `useSyncExternalStore`s this controller and forwards the single `useInput` to {@link HomeController.handleKey};
 * `driveHome` owns the process lifetime and calls {@link HomeController.teardownActive} from its signal handler so
 * an external SIGINT/SIGTERM reaps a live chat's MCP child + frame loop before the process exits.
 *
 * The prompt buffer lives HERE as a plain field mutated synchronously inside `handleKey`, so a coalesced stdin
 * chunk (ink dispatches every parsed event from one chunk back-to-back) keeps every edit + a same-chunk submit on
 * the latest value with no React-batching race — the ref-shadow the inline view needed is gone.
 */

/** The chat session the Home builds + drives on a submit — the imperative pieces `driveHome` wires + tears down. */
export interface HomeChatSession {
  /** Fresh instance over this exact bound agent/context; never infer a built-in from its id. */
  readonly clear?: () => Promise<HomeChatSession>;
  readonly resumeAfterFailedClear?: () => void;
  /** Called once AFTER active publication; discarded builds must never consume disclosure evidence. */
  readonly onActivated?: (isActive: () => boolean) => void | Promise<void>;
  /** The chat view store the chat region projects (already subscribed to the live stream by `driveHome`). */
  readonly store: ChatStoreController;
  /** Handle one line (a slash command or a message) — the shared `createChatLineHandler` semantics. */
  readonly processLine: (line: string, display?: string) => Promise<void>;
  /** `true` once `/exit`, `/cancel`, or `/clear` has run — the chat ends (or swaps). */
  readonly shouldStop: () => boolean;
  /** The session's durable id (ADR-0062 §7) — named in the `/clear` notice as the prior (still-resumable)
   *  conversation, so it is discoverable after the swap. */
  readonly sessionId: string;
  /**
   * The provider the chat's bound agent runs on: where its messages go, what the `/models` popup's data-leaves line is judged against (the
   * catalog's row of the model in force can name another provider when two list the same id). Absent ⇒ the popup reads the catalog's.
   */
  readonly provider?: string;
  /** Set the reasoning-effort tier (ADR-0066 §5) — the in-Home `/models` effort sub-step calls it on a SAME-model
   *  pick (a per-turn session override, NO reseat) + the `/effort` command. Absent ⇒ the effort sub-step is not
   *  offered. The current tier is read live from `store` (`ChatStoreSnapshot.reasoningEffort`), not tracked here. */
  readonly onSetEffort?: (effort: ReasoningEffort) => void;
  /**
   * What this chat's report popups read ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §10, MVP-11 step 4b): `/agent`, `/cost` (and `/cost --release`), `/workflows` and `/help`. A typed or palette-selected line for a report whose
   * member is present opens the popup over this chat through {@link HomeControllerDeps.openReport}, before the line reaches the chat's dispatch.
   * Absent ⇒ the command is dispatched and prints its text into the transcript, as before.
   */
  readonly reports?: ReportsPort;
  /**
   * What this chat's settings popups read and apply ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §3, §6; MVP-11 step 5): today `/effort` (the tiers of the bound model, the tier in force and the session's setter), and the announcement the
   * line handler routes to the Home's channel. A typed or palette-selected bare command whose member can open opens the popup over this chat
   * through {@link HomeControllerDeps.openSettings}, before the line reaches the chat's dispatch. Absent ⇒ the command is dispatched, as before.
   */
  readonly settings?: SettingsPort;
  /**
   * What this chat's `/doctor` popup reads ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §8): its session's probes, its read-only MCP report and its owner. A typed or palette-selected `/doctor` (or `/doctor --deep`) opens the popup
   * over this chat through {@link HomeControllerDeps.openDoctor}, before the line reaches the chat's dispatch. Absent ⇒ the command is dispatched
   * and prints the text report into the transcript, as before.
   */
  readonly doctor?: DoctorPort | undefined;
  /** WHY `shouldStop()` became true (ADR-0062 §7 · ADR-0059) — `'clear'` (swap in a fresh session, staying in chat)
   *  vs `'exit'` (`/exit`/`/cancel`, return to the bare Home). Shares the widened `ChatLineHandler.stopReason` type,
   *  so it also carries `'reseat'` — but `'reseat'` is unreachable HERE, and not because the in-Home reseat is
   *  missing: it IS live (ADR-0059), driven by the directly-wired `deps.reseatChat` (see `drive-home.tsx`), never
   *  by a `stopReason` signal. Only the STANDALONE chat routes a reseat through `stopReason`, so this Home-side
   *  union member stays unreachable and the consumer's non-`'clear'` branch treats it as an end (a safe default). */
  readonly stopReason: () => 'exit' | 'clear' | 'reseat';
  /** Mid-turn abort (EA7) — abort the in-flight turn, keeping the session alive (Esc). Present once wired. */
  readonly onAbort?: () => void;
  /** Switch the chat mode (Shift+Tab / `/mode`) — re-applies the turn policy on the same session (ADR-0057). */
  readonly onModeChange?: (mode: ChatMode) => void;
  /** The `@`-mention completion reader (2.5.D, ADR-0061) — a READ-ONLY fs jail at the session's fs-scope tier +
   *  workspace, so in-Home `@`-completion browses + injects files through the identical confidentiality floor +
   *  listing-gate as the session's tools. Present once wired; absent ⇒ `@` is a literal char. */
  readonly mentionReader?: MentionReader;
  /** The `!`-shell runner (2.5.D step 5, ADR-0061) — runs a user-typed `!command` through `runUserCommand` (the one
   *  command boundary). Present once wired; absent ⇒ a leading `!` is a literal message. */
  readonly runShellCommand?: (
    command: string,
    args: readonly string[],
  ) => Promise<UserCommandOutcome>;
  /** Best-effort, IDEMPOTENT teardown of THIS chat (persister + frame loop + subscription + MCP), never the shared db. */
  readonly teardown: () => Promise<void>;
}

export type HomeMode = 'home' | 'loading' | 'chat';

/** The immutable view state the {@link HomeController} publishes to `RootApp` (a new object per change). */
export interface HomeControllerState {
  readonly mode: HomeMode;
  readonly keyless: boolean;
  readonly nativeActionBusy: boolean;
  readonly snapshot: HomeSnapshot;
  readonly pendingMessage: string;
  readonly input: EditorState;
  readonly session: HomeChatSession | undefined;
  /** The interactive `/` command palette — `undefined` ⇒ closed. Opens in both the bare Home (2.5.C S3c) and the
   *  in-Home chat (S3b); the command set + the run-on-select path differ by surface (see `handlePaletteKey`). ONE value: the palette's state
   *  and the rows it reads, built ONCE when it opens and when its query changes and read by BOTH the key fold and the view, so they cannot
   *  disagree on the highlighted row (MVP-11 Step 2.2) and cannot be stored apart. */
  readonly palette: OpenPalette | undefined;
  /** The open Ctrl+R reverse-search submode of the in-Home chat (2.5.D step 3) — `undefined` ⇒ closed. Chat-only
   *  (the bare Home has no history); mutually exclusive with the palette, yields to a pending approval. */
  readonly search: ReverseSearchState | undefined;
  /** The open `@`-mention completion submode of the in-Home chat (2.5.D step 4, ADR-0061) — `undefined` ⇒ closed.
   *  Chat-only (its reader is per-session); mutually exclusive with the palette/search, yields to a pending approval. */
  readonly mention: MentionState | undefined;
  /** A `!`-shell command is in flight (2.5.D step 5) — the session is busy (`#status: 'running'`) but emits no
   *  event, so this flag gates input + shows a busy indicator; WITHOUT it a message submitted mid-command reaches
   *  `sendMessage`, throws `SessionStateError`, and crashes the chat. Cleared on settle + on chat end. */
  readonly shellBusy: boolean;
  /** A submit (a message turn or a slash like `/compact`) is in flight (ADR-0062) — gates input + shows the
   *  spinner for the WHOLE submit, INCLUDING after-turn auto-compaction (which runs after the view goes idle,
   *  so the view-status `running` alone leaves a crash/frozen window — the same hazard `shellBusy` closes). */
  readonly submitBusy: boolean;
  /** The in-flight `!`-command line labeling the busy indicator (2.5.D) — `undefined` between commands. A `!`-
   *  command emits no session tokens, so this labels WHAT is running + how to cancel (Esc). */
  readonly shellCommand: string | undefined;
  /** Pending `@`/`!` attachments (2.5.D chip redesign) — an @-mentioned FILE (referenced inline by its `@path`
   *  marker) or a `!`-command's captured OUTPUT (shown read-only when it ran). Rendered as a chip bar; expanded into
   *  the UNTRUSTED nonce-fenced frame at SUBMIT; cleared on send / `Esc` (idle) / chat end. */
  readonly attachments: readonly PendingAttachment[];
  /** A published copy of the history entries (the closure `history` is not in state) so the external render can
   *  compute the reverse-search match; changes only on submit. */
  readonly historyEntries: readonly string[];
  /** Transient command output in the bare Home — the `/doctor` report (2.5.C S5), rendered below the strip and
   *  cleared on the next edit/submit. Multi-line + secret-free (the doctor formatter sanitizes). `undefined` ⇒ none. */
  readonly notice: string | undefined;
  /** Distinguishes fresh reports even when their text is identical or updates are React-batched. */
  readonly noticeRevision: number;
  /** The interrupt keymap is armed (ADR-0115 §1): a second `Ctrl+C` inside the window ends the chat or exits the Home, and the
   *  footer hint says so. Cleared by any other key and by the window running out. */
  readonly interruptArmed: boolean;
  /** The run host's snapshot, as of the last read (ADR-0139 §3): the strip's run row and the exit-guard card show it. `undefined`
   *  with no host wired. It is re-read when a native action ends, while a leg is live, and when the Home is asked to end. */
  readonly hostedRun: RunHostSnapshot | undefined;
  /** The exit-guard card (ADR-0139 §6): `confirm` asks whether to leave with a run executing, `stopping` waits (bounded) for the
   *  confirmed cancel to settle. `undefined` ⇒ closed. While it is open it owns every key and every paste. */
  readonly exitGuard: ExitGuardPhase | undefined;
  /**
   * The one screen in front of the landing, or `undefined` ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §1). One slot, one open function ({@link HomeController.openScreen}), one key route, one interrupt context, one paste gate and one
   * reset ({@link HomeController.closeScreen}): the six overlays above are not moved into it, and are never open while it is.
   */
  readonly screen: HomeScreen | undefined;
  /**
   * This project's parked runs, one row each ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §7): what
   * the landing's Attention rows show. Re-read when the landing is shown again and when the run host's state changes; empty with no
   * {@link HomeControllerDeps.gateCards}.
   */
  readonly parkedRuns: readonly ParkedRunRow[];
  /**
   * The strip row the person has moved onto with `↓` at the empty prompt, or `undefined` for none ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §6). It names the row by its identity (the run id or the session id, `strip-focus.ts`), so a read that moves the row never moves the
   * focus off it; `Enter` does what the row's kind says (a parked run's card, a failed or recent run's detail, a session's resume).
   */
  readonly stripFocus: StripFocus | undefined;
  /**
   * Which of the Home's two pages is in front (MVP-11 unit 7): the landing (`start`) or the work page under it (`work`). On the work page the
   * focus is the row {@link stripFocus} names, else its docked prompt; on the landing it is the landing's prompt and no row is focused. A Home
   * with nothing to continue is always on the landing.
   */
  readonly homePage: HomePage;
  /**
   * The slide between the pages in progress (alternate screen only, `home-pages.ts`), or `undefined` at rest. {@link homePage} is already the
   * page it goes to; every key that arrives while it slides waits in a queue and is applied, in order, once the arrival is on screen.
   */
  readonly slide: HomeSlide | undefined;
  /** The Home can open a gate card (a port is wired): the run view of a parked run then offers `Enter`. */
  readonly gateCards: boolean;
  /**
   * What the landing's status line says (ADR-0146 §2): the facts of the next chat as the controller last read them, or `undefined` when no
   * reader is wired. It changes only when a refresh point reads something different, so a draw repaints nothing for it.
   */
  readonly status?: HomeStatusFacts | undefined;
}

/**
 * The Home's record of what owns the keyboard, built ONCE from its own state ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): every gate of the controller (the screen slot, the paste gate, the interrupt context, the strip's and the Active tab's pauses) and
 * of its host (`home-app.tsx`) asks `overlay-flags.ts` about this record instead of listing the overlays again. The cards are the live
 * chat store's, read now. `nativePrompt`, `popup` and `replacesBody` are `false` here: the prompt channel and the popup host are the HOST's,
 * which sets them on top of this record (the controller's own gates add `popup` from its `popupOpen` port).
 */
export function homeOverlayFlags(state: HomeControllerState): OverlayFlags {
  return {
    palette: state.palette !== undefined,
    search: state.search !== undefined,
    mention: state.mention !== undefined,
    screen: state.screen !== undefined,
    exitGuard: state.exitGuard !== undefined,
    nativePrompt: false,
    popup: false,
    replacesBody: false,
    nativeActionBusy: state.nativeActionBusy,
    ...cardFlagsFrom(state.session?.store.getSnapshot()),
  };
}

/**
 * What is in flight in the Home now ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the live chat's turn, a submit, a `!` command, a native action. The ONE reading of those facts, for the popup host's open gate
 * (`homePopupRefusal`) and for the release step of `/cost` at the moment of its answer, through {@link turnInFlight}.
 */
export function homeTurnFacts(state: HomeControllerState): TurnFacts {
  return {
    running: state.session?.store.getSnapshot().state.status === 'running',
    shellBusy: state.shellBusy,
    submitBusy: state.submitBusy,
    nativeActionBusy: state.nativeActionBusy,
  };
}

/**
 * Why a native action may not open now ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): its flow is drawn as a popup, so it opens on the rules a popup opens on, read off the facts `homePopupRefusal` reads, as the Home would
 * stand once the action's own change (`patch`, with the palette it closes) is published: a popup already open, a chat being built, a card
 * waiting, a sheet (the exit guard, a gate card), a turn, a submit or a `!` command in flight, a two-step armed. The overlay a native action
 * is opened FROM (the palette it closes, the tab host its `r` and `x` run over) is not a refusal: the flow is drawn over it. A native card
 * that is already open is the channel's (`begin` refuses a second flow). Pure, so every fact is tested on its own.
 */
export function homeNativeActionRefusal(
  state: HomeControllerState,
  patch: Partial<HomeControllerState>,
  popupOpen: boolean,
): PopupRefusal | undefined {
  if (popupOpen) return 'popup-open';
  const next: HomeControllerState = { ...state, palette: undefined, ...patch };
  const cards = cardFlagsFrom(next.session?.store.getSnapshot());
  return popupRefusal({
    starting: next.mode === 'loading',
    cards: cards.approval || cards.review || cards.question || cards.checkpoint,
    sheet: next.exitGuard !== undefined || next.screen?.kind === 'gate-card',
    turn: homeTurnFacts(next),
    armed: next.interruptArmed,
    overlay: false,
  });
}

/**
 * What a screen of the slot is told when it opens. `run-view` (MVP-8 step 3), `tab-host` (step 4) and `help` (step 5, the landing's
 * `/help` sheet, which is told nothing) are the kinds so far; each has its own props, and the opener and the readers switch on `kind`.
 */
export interface RunViewProps {
  /** The run the view shows: the run host's snapshot is read for exactly this run, never for whichever one executes. */
  readonly runId: string;
  /** The leg's live output (the `RunApp` projection's store); absent when nothing feeds this Home. */
  readonly store?: RunStore | undefined;
  /**
   * Where `Esc` returns to: `landing` (the default) closes the screen, `tab-host` puts the tab host back on the tab and row it was on
   * (ADR-0140 §1). Only a view opened from the tab host says `tab-host`; `Ctrl+C` closes the whole screen either way.
   */
  readonly from?: ScreenOrigin | undefined;
}

/** What the Home says when it cannot resume a conversation: nothing was opened. */
export const RESUME_UNAVAILABLE = 'Session resume is unavailable here.';

/** Where a screen was opened from, and so where its `Esc` returns to. */
export type ScreenOrigin = 'landing' | 'tab-host';

/** What the tab host is told when it opens: the tab to show. Every tab remembers its own position while the screen lives. */
export interface TabHostProps {
  readonly tab: TabId;
}

/** The run view of one run, with the notice ring as it was last read (re-read while a leg is live). */
export interface RunViewScreen {
  readonly kind: 'run-view';
  readonly runId: string;
  /** Where `Esc` returns to ({@link RunViewProps.from}). */
  readonly from: ScreenOrigin;
  readonly store: RunStore | undefined;
  /** The host's notice ring, then {@link RunViewScreen.note} when there is one: the view shows the newest rows. */
  readonly notices: readonly string[];
  /**
   * What the view itself has to say: why a gate card could not open from it. It is the newest notice row, and it goes with the screen
   * (the view offers `Enter` again, and the key line says it will try again).
   */
  readonly note?: string | undefined;
}

/**
 * The gate or budget card of a parked run, in front of the landing or of the run view it was opened from
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4). `Esc` and `Ctrl+C` close it and decide nothing; the
 * view paints it from `card`'s own snapshots.
 */
export interface GateCardScreen {
  readonly kind: 'gate-card';
  readonly runId: string;
  readonly card: RunCard;
  /** Where closing the card returns to. */
  readonly back: 'landing' | 'run-view';
  /** Where the screen the card came from (a view, or the card itself from a browser) returns to, once the card is closed. */
  readonly from: ScreenOrigin;
  /**
   * Since when the run has waited, on the display clock (wall-clock ms): when it parked (`parkedSince`), else when the card opened. The origin
   * of the sheet's wait clock (ADR-0147 §2): display only, never in the card's snapshot, and read by no guard. Absent: no clock is drawn.
   */
  readonly waitingSinceMs?: number | undefined;
  /** A card has no live output and no notice ring: both read as `undefined`, so a reader of the slot needs no narrowing to ask. */
  readonly store?: undefined;
  readonly notices?: undefined;
}

/**
 * The tab host of the management browsers ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, §3): the strip of tabs and the tab in front, as the pure model of `tab-host.ts` holds them. It owns every key while it is open and
 * drops a paste; closing it (`Esc`, `Ctrl+C`) returns to the landing, or ends a bare `relavium permissions`.
 */
export interface TabHostScreen {
  readonly kind: 'tab-host';
  readonly host: TabHostState;
  /** A tab host has no run, no live output and no notice ring: all three read as `undefined`, so a reader of the slot needs no narrowing to ask. */
  readonly runId?: undefined;
  readonly store?: undefined;
  readonly notices?: undefined;
}

/** The slot's contents. */
export type HomeScreen = RunViewScreen | GateCardScreen | TabHostScreen;

/**
 * What the Active tab reads and is told by ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2): a change token to compare, one asynchronous read of the runs that are not finished, and whether the database is gone. `driveHome`
 * wires the real ones over its own connection; nothing here writes.
 */
export interface HomeActivePort {
  /** The change token now (`PRAGMA data_version` and the in-process generation). May throw for a closed database. */
  readonly token: () => ChangeToken;
  /** One read of the Active tab's runs. Called only while the tab is in front, when the token moved, and never twice at once. */
  readonly read: () => Promise<ActiveRead>;
  /** The database is closed: the poll reads nothing more. Asked before every read. */
  readonly isClosed: () => boolean;
}

/**
 * What the strip's idle refresh asks ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6): the change token to compare, and whether the database is gone. It is the Active tab's own probe, so a tick that finds the token where
 * the last read left it reads nothing; `driveHome` wires the real one over its own connection.
 */
export interface HomeStripPort {
  /** The change token now (`PRAGMA data_version`, the in-process generation and the hosted run). May throw for a closed database. */
  readonly token: () => ChangeToken;
  /** The database is closed: the tick reads nothing more. Asked before every read. */
  readonly isClosed: () => boolean;
}

/**
 * What the Home needs to show and answer the gates of the runs parked in its project: the reads, the answer and the numbers the
 * card's chord guard runs on. `driveHome` wires the real ones (`readParkedRuns`, `readRunGates`, `createGateResumer` over the run host).
 */
export interface HomeGateCardsPort {
  /** The project's parked runs, one row each. May throw; the Home then keeps the rows it has. */
  readonly list: () => readonly ParkedRunRow[];
  /** One run's open gates from its log now, or `undefined` when it is not parked in this project. */
  readonly read: (runId: string) => RunGates | undefined;
  /** Answer one gate: the run host's `resume` with the native flow around it (`createGateResumer`). */
  readonly resume: (request: Omit<HostedResumeRequest, 'secrets'>) => Promise<HostedLaunch>;
  /** The guard's numbers (default the product's own); `0` switches a layer off. A test uses it. */
  readonly guard?: ApprovalGuard | undefined;
}

/**
 * The Home's model-catalog port (2.5.G S7, ADR-0064) — the I/O the `/models` picker needs, injected by `driveHome`
 * (which owns the db handle + the refresh service + the config writer) so the controller stays pure-ish + testable.
 * `load` is a sync db read + the pure merge; the refreshes egress (safe here: the Home is the LONG-LIVED process
 * the S5 background-refresh constraint requires). `writeDefault` persists the NEXT session's default (ADR-0063).
 */
export interface HomeModelsPort {
  /** The merged catalog (all providers) + the newest live-refresh stamp (the freshness badge). Sync read + merge. */
  load: () => {
    readonly entries: readonly ModelCatalogEntry[];
    readonly refreshedAt: number | undefined;
  };
  /** TTL-bounded background refresh (ADR-0064 §5c) — refreshes empty/stale providers; `undefined` when none were. */
  refreshIfStale: () => Promise<RefreshReport | undefined>;
  /** User-initiated refresh (the popup's `Refresh the list` row), regardless of TTL. Provider faults are isolated; owned stop can reject. */
  refresh: () => Promise<RefreshReport>;
  /** The current `[preferences].default_model` (the picker's `✓` marker), or `undefined` when none is set. */
  currentDefault: () => string | undefined;
  /** The provider the default is persisted with (`[chat].default_provider`), when one is set (the chat's `/models` judges "New chats" by it). */
  currentDefaultProvider?: (() => string | undefined) | undefined;
  /** The current resolved default reasoning-effort tier (ADR-0066 §6) — the `✓`/opening highlight of the bare-Home
   *  effort sub-step; `undefined` ⇒ none set (the sub-list opens on a neutral middle tier). */
  currentEffort: () => ReasoningEffort | undefined;
  /** Persist the chosen model as the next session's default — WITH its `provider` (ADR-0059: authoritative at pick
   *  time, so the next chat skips id inference) and (ADR-0066 §6) — when the effort sub-step ran for a reasoning
   *  model — its effort tier too, in ONE atomic write (writeGlobalPreferences). An absent `reasoningEffort` leaves
   *  any prior effort default unchanged. Throws `ConfigError` on a bad write. */
  writeDefault: (
    modelId: string,
    provider: ReseatTarget['provider'],
    reasoningEffort?: ReasoningEffort,
  ) =>
    | void
    | { readonly durability: 'confirmed' | 'unconfirmed' }
    | Promise<void | { readonly durability: 'confirmed' | 'unconfirmed' }>;
}

export interface HomeControllerDeps {
  /**
   * Build + wire + START a fresh chat session (no first message — the controller sends it on transition). May reject.
   *
   * With no argument it binds the built-in agent. With `agent` (the `/agents` detail's `c`, ADR-0140 §3) it binds that agent of the project:
   * `agent.path` is the catalog's own path of the file the detail showed (read through the agents port), never text a person typed, and
   * `agent.listed` is the definition the detail was drawn from. The host reads the file once through the catalog's hardened read, refuses
   * it unless it is still that definition, and binds what it read through the session build `relavium chat --agent` uses, so its tool grant
   * and the consent for the MCP servers it declares are that path's, and every tool call still asks. A rejection is shown as a fixed
   * sentence, never as the error's own words.
   */
  readonly startChat: (agent?: HomeAgentRequest) => Promise<HomeChatSession>;
  /** Reseat the in-Home chat onto a NEW model (ADR-0059) — reload + resume the current session's transcript under the
   *  switched model. Absent ⇒ the in-Home `/models` picker degrades to the next-session-default write (no live reseat).
   *
   *  `carriedTranscript` is the OUTGOING store's RENDERED transcript (2.6.C). The reseat builds a brand-new view
   *  store, and on the full-screen renderer that store IS the scrollback — so without the carry the whole
   *  conversation vanishes from the screen (the alt buffer has none of its own). It is captured at the CALL, before
   *  the old session is torn down. View-only: these are the already-sanitized render projections, never persisted. */
  readonly reseatChat?: (
    sessionId: string,
    target: ReseatTarget,
    carriedTranscript: readonly TranscriptEntry[],
  ) => Promise<HomeChatSession>;
  readonly homeStore: HomeStore;
  /** The monotonic clock the interrupt keymap's arming window runs on (ADR-0115 §1). Default `performance.now`; a test injects its own. */
  readonly now?: () => number;
  /** The wall clock (epoch ms) the management popups tell the age of a run against (`/workflows`). Default `Date.now`; a test injects its own. */
  readonly epochNow?: () => number;
  /** Original Home invocation; observe publication before local recovery and retain entered work (a native action, a write). */
  readonly workOwner?: Pick<InvocationWorkOwner, 'enter' | 'failure'>;
  /** The Home exited cleanly (a second Ctrl+C inside the arming window, or Ctrl+D / EOF on an empty prompt) → `driveHome` resolves with exit 0. */
  readonly onExit: () => void;
  /** An unexpected error escaping a chat turn (a re-thrown turn-core bug) — `driveHome` tears down + propagates. */
  readonly onError: (err: unknown) => void;
  /**
   * Bound a chat teardown for the UI: returns a promise that settles when the teardown finishes OR the
   * force-teardown deadline elapses, whichever first — so a hung MCP graceful close can never freeze the
   * return-to-Home. Default races the teardown against a {@link FORCE_TEARDOWN_MS} timer; a test injects an
   * instant bound so it need not wait real time.
   */
  readonly boundTeardown?: (teardown: Promise<void>) => Promise<void>;
  /**
   * The text the controller writes itself (a hosted run's end, a model switch) carries glyphs of the glyph table, so it is written in their
   * plain forms when colour is off (ADR-0145 §5): `true` ⇒ the plain forms. Absent ⇒ the Unicode glyphs.
   */
  readonly plainGlyphs?: boolean;
  /** The `/models` catalog port (2.5.G S7, ADR-0064) — absent ⇒ `/models` degrades to an honest "unavailable"
   *  notice (a test may omit it). Production (`driveHome`) always wires the real db-backed port. */
  readonly models?: HomeModelsPort;
  /** The bare Home's permissions port (ADR-0137 §3, ADR-0140 §3): the project's remembered commands only, there being no chat, and the
   *  repository's allowlist, read again every time the `/permissions` popup opens. Absent ⇒ the Home has no popup to open (a test may omit
   *  it); a live chat's `/permissions` is a popup over its own port (`HomeChatSession.settings`). */
  readonly permissions?: PermissionsPort;
  /**
   * The `@`-mention reader of the Home's own two prompts (ADR-0061; the maintainer's question of 2026-11-26): the landing and the work page's
   * docked prompt have no session, so this reader is built from the Home's own filesystem policy and the tier the next chat runs at, through
   * the SAME factory a chat's reader comes from (`home/mention-reader.ts`): the jail, the confidentiality floor, the symbolic-link and the
   * binary and size guards are the chat's. Absent ⇒ `@` on the Home is a literal character, as before.
   */
  readonly mentionReader?: MentionReader;
  /**
   * `/mode` at the landing (ADR-0148 §1, §3, §6; MVP-11 unit 8, OD-25): the saved startup default (`read`, what the popup's list marks `startup`
   * and opens on; `undefined` where it could not be read) and the startup-default writer's flow framed as the confirmation popup (`save`: the
   * chord card, the Done step; what it came to as an outcome, never a word for the Home's notice). The controller opens the popup over the Home's
   * own settings port and brackets `save` with the busy mark and the status line read again. Absent ⇒ `/mode` says the startup settings are
   * unavailable.
   */
  readonly startupMode?:
    | {
        readonly read: StartupDefaultMember['startup'];
        readonly save: StartupDefaultMember['saveStartupDefault'];
      }
    | undefined;
  /**
   * `/init` at the landing (ADR-0148 §1, §6): the popup that shows what it would create, asks with `Ctrl+Y` and ends in its Done step. It
   * resolves with the ONE notification the Home shows (a cancel, a folder that is already a project), or `undefined` when the popup said what
   * happened. Absent ⇒ `/init` says initialization is unavailable.
   */
  readonly initializeProject?: () => Promise<string | undefined>;
  /**
   * Launch a workflow from the Home ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §7): the
   * picker, the form and the confirmation, all on the native prompt channel, then the host's start. It resolves with the notice the
   * Home shows; it holds the native action for as long as the flow is open, so no key reaches the composer meanwhile. A Home command
   * only: a live chat never reaches it (the typed `/run` is routed here only with no session, and the chat palette does not list it).
   * Absent ⇒ `/run` says it is unavailable. With a `slug` the picker is skipped (the `/workflows` popup's `[r]`), and with the catalog `path` the
   * row was listed from the flow refuses a slug whose file is another one by then.
   */
  readonly launchRun?: (slug?: string, path?: string, options?: LaunchOptions) => Promise<string>;
  /**
   * The `/workflows` popup's read, over the project's catalog and pins ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §2): read again every time the popup opens. Absent ⇒ the popup says it cannot list, and a typed `/workflows` at the Home says the
   * workflows are not available.
   */
  readonly defined?: DefinedPort | undefined;
  /**
   * The History tab's reads ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §2): the finished runs a page at a time, the pinned runs, each run's cost read lazily, and one run's detail. Read when the tab is
   * entered and as its keys ask; absent ⇒ the tab says it cannot be read.
   */
  readonly history?: HistoryPort | undefined;
  /**
   * What `p` pins and unpins through, in the `/workflows` popup and on the History tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §5). Absent ⇒ `p` says pinning is unavailable.
   */
  readonly pins?: PinPort | undefined;
  /**
   * The `/agents` popup's catalog: the project's agent catalog, read again every time the popup is opened ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §3, MVP-11 unit 8). Absent ⇒ a typed `/agents` says the agents are not available here. The saved conversations are `/resume`'s.
   */
  readonly agents?: AgentsPort | undefined;
  /**
   * The `/workflows` popup's export confirmation: prepare the export of one catalog workflow, show where it would be written, write it only on a Yes and
   * end in its Done step (ADR-0148 §6). It resolves with the ONE notification the Home shows (nothing was written), or `undefined` when the
   * popup said what happened; it holds the native action while the popup is open. Absent ⇒ `[x]` says export is unavailable.
   */
  readonly exportDefined?:
    | ((slug: string, origin?: 'home' | 'workflows') => Promise<string | undefined>)
    | undefined;
  /**
   * What the `/workflows` popup's detail step reads beyond the catalogue (MVP-11 unit 8, OD-24 D1): one workflow's description, inputs and nodes
   * (`describe`, the catalog port's own read of its file) and its last runs for this directory (`lastRuns`, the history reader's summaries by
   * workflow). Both may throw, and either may be absent: the detail then says it cannot be read, or lists no runs.
   */
  readonly workflowReads?:
    | {
        readonly describe?: ((path: string) => WorkflowDetail) | undefined;
        readonly lastRuns?:
          | ((slug: string, limit: number) => readonly HomeWorkflowRun[])
          | undefined;
      }
    | undefined;
  /**
   * Open one of the Home's management popups (`/help`, `/agents`, `/workflows`; [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §10 as amended 2026-11-27, MVP-11 unit 8) on the Home's popup host, with the port the controller built from what it holds. The controller only
   * routes the word and builds the port (the host adds the clipboard); nothing reaches the Home's notice. `at` opens `/workflows` on the detail of one
   * workflow (the flow it handed that workflow to is over). Absent (a test's Home) ⇒ the word says the popup is not available here.
   */
  readonly openHomePopup?:
    | ((request: {
        readonly kind: HomePopupKind;
        readonly port: HomePopupsPort;
        readonly at?: WorkflowsAt | undefined;
      }) => void)
    | undefined;
  /**
   * `/import` at the landing ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §9): ask for a path, show what the import would write, write the file only on a Yes and end in its Done step (ADR-0148 §6). It resolves
   * with the ONE notification the Home shows (nothing was written), or `undefined` when the popup said what happened; it holds the native
   * action while the popup is open. A Home word: with a chat in front the typed line is the chat's. Absent ⇒ `/import` says import is
   * unavailable in this session.
   */
  readonly importDefined?: (() => Promise<string | undefined>) | undefined;
  /**
   * `/pricing` at the landing (ADR-0140 §9): the popup that sets or clears the operator's own price for a model, records it only on a Yes and
   * ends in its Done step (ADR-0148 §6). It resolves with the ONE notification the Home shows (nothing was written), or `undefined` when the
   * popup said what happened; it holds the native action while the popup is open. A Home word, as `/import` is. Absent ⇒ `/pricing` says
   * model pricing is not available here.
   */
  readonly pricing?: (() => Promise<string | undefined>) | undefined;
  /**
   * The Active tab's reads ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §2). The Home polls them only while that tab is in front and no card or exit question is up, every 1.5 seconds and only when the
   * change token moved. Absent ⇒ the tab says it cannot be read.
   */
  readonly active?: HomeActivePort | undefined;
  /**
   * The strip's idle refresh ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §6): every {@link STRIP_REFRESH_MS} the Home looks at the change token, and re-reads the strip's rows only when it moved. The tick is
   * paused while a screen, a card, an overlay or the help sheet is in front, while a chat or its build is, and below 80×24, and it leaves no
   * timer behind when the Home ends. Absent ⇒ the strip is read when the Home opens and when a chat or a screen returns, as it always was.
   */
  readonly strip?: HomeStripPort | undefined;
  /**
   * The Home's workflow-run host, as far as leaving the Home needs it ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
   * §3, §6): `snapshot` says whether a leg is executing or cancelling, `cancel` requests the cooperative stop, and `close` is the Home's
   * teardown of the host. With a leg live, every way to end the Home asks first, and a confirmed exit cancels the leg and waits for it
   * for at most {@link HomeControllerDeps.exitGraceMs}. Absent ⇒ no run can exist and the Home leaves at once, as it always did.
   */
  readonly hostedRuns?: Pick<RunHost, 'snapshot' | 'cancel' | 'close'> & {
    /** The host's notice ring ([ADR-0139] §3): the run view shows its newest rows. Absent ⇒ the view has none. */
    readonly notices?: Pick<RunNotices, 'snapshot'> | undefined;
  };
  /** The live output of a hosted run, for the run view to mount (`RunApp`); absent ⇒ the view says it has none. */
  readonly runStore?: ((runId: string) => RunStore | undefined) | undefined;
  /** The gate and budget cards of this project's parked runs; absent ⇒ no Attention rows and no card. */
  readonly gateCards?: HomeGateCardsPort | undefined;
  /**
   * `Enter` on a parked run that waits on media jobs and nothing else ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
   * §3, the 2026-11-23 amendment note): ask, on the native prompt channel, whether to continue the run here (a Yes/No whose default is No), and
   * on a Yes start the run host's media resume. It resolves with the sentence the Home shows, or `undefined` when nothing happened (a No,
   * `Esc`); it holds the native action for as long as the question is open. Absent ⇒ such a run says it cannot be continued here.
   */
  readonly continueMedia?: ((runId: string) => Promise<string | undefined>) | undefined;
  /** How long a confirmed exit waits for the run to settle before it abandons it (default {@link HOSTED_RUN_EXIT_GRACE_MS}). */
  readonly exitGraceMs?: number;
  /**
   * The Home's one chord history ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4): the gate
   * and budget cards and the exit guard stamp and read the same lockout the MCP consent card does, so a key held down through one answer
   * cannot answer the next card on auto-repeat. Default: one of its own, which the consent card (built elsewhere) then does not share.
   */
  readonly chordHistory?: ChordHistory | undefined;
  /**
   * Whether a popup of the Home's popup host is open ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §2). The popup host is the HOST's; the controller reads only this fact, so its own gates (the screen slot, the strip's and the Active tab's
   * pauses, the interrupt context) derive from the one record with the popup in it. Absent ⇒ no popup is ever open.
   */
  readonly popupOpen?: (() => boolean) | undefined;
  /**
   * Open the `/doctor` popup ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8) on the
   * Home's popup host: the Home's own (no `chat`) or the chat's in front (its {@link HomeChatSession.doctor}), on its confirmation line for a
   * typed `/doctor --deep`. The controller only routes (`popup-route.ts`): it recognises the line where it opens the other popups,
   * clears the editor and calls this, so nothing reaches the Home's notice or the transcript. Production always wires it. Absent (a test's
   * Home) ⇒ `/doctor` at the landing says the doctor is not available here, and a chat's `/doctor` is dispatched to the chat.
   */
  readonly openDoctor?:
    | ((request: { readonly deep: boolean; readonly chat?: DoctorPort | undefined }) => void)
    | undefined;
  /**
   * Open one of the report popups (`/agent`, `/cost`, `/workflows`, `/help`; [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §10, MVP-11 step 4b) over the chat in front, on the Home's popup host, with the chat's {@link HomeChatSession.reports}. The controller only
   * routes (`popup-route.ts`): it recognises the line where it opens the other popups, clears the editor and calls this, so nothing
   * reaches the Home's notice or the transcript. `turnInFlight` is the controller's own reading of the facts its open gate reads, for the release step to ask again
   * at its answer. Absent ⇒ a chat's report lines are dispatched and print their text, as before.
   */
  readonly openReport?:
    | ((request: {
        readonly line: ParsedReportLine;
        readonly chat: ReportsPort;
        readonly turnInFlight: () => boolean;
      }) => void)
    | undefined;
  /**
   * Open one of the settings popups ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §3, §6; MVP-11 step 5: `/mode`, `/effort`, `/models`, `/permissions`) over the chat in front, on the Home's popup host, with the chat's
   * {@link HomeChatSession.settings}.
   * The controller only routes (`popup-route.ts`), clears the editor and calls this, so nothing reaches the Home's notice or the transcript.
   * Absent ⇒ a chat's bare settings lines are dispatched, as before.
   */
  readonly openSettings?:
    | ((request: {
        readonly command: SettingsKind;
        readonly chat: SettingsPort;
        /** Told when the popup closes, however it closed (a bare `relavium permissions` ends with its popup: MVP-11 unit 8). */
        readonly closed?: (() => void) | undefined;
      }) => void)
    | undefined;
  /**
   * Open the read-only card of a run whose log could not be read (MVP-11 unit 7): `Enter` on an `unreadable` row of the work page. The controller
   * finds the run BY ITS ID in the snapshot it holds, never by the row's position, and hands it over; the host opens the popup on the Home's popup
   * host (`popups/unreadable-run-port.ts`). The card changes nothing, starts nothing and reads no log. Absent (a test's Home) ⇒ `Enter` on such a
   * row says the card is not available here.
   */
  readonly openUnreadableRun?: ((request: { readonly run: HomeUnreadableRun }) => void) | undefined;
  /**
   * One transient notification on the Home's own channel (`NotificationChannel.notify`, no popup as its source; ADR-0148 §2, §6): what a
   * setting the bare Home applied says once its popup has closed (`/models`: the default of new chats), and what a chat's model switch that
   * could not be built says. Never the Home's notice, never a transcript. Absent ⇒ the bare Home's `/models` has no popup (a test's Home).
   */
  readonly announce?: ((text: string) => void) | undefined;
  /**
   * Withdraw every notification {@link announce} said that is still showing or waiting (MVP-11 unit 7, round 1: CO76): the Home's words are
   * about the Home, so they go when a chat comes in front (its build starts, or a resumed conversation is adopted), or the chat's hint row reads
   * them in place of its own, its way back included. The chat's own notifications are not the Home's and stay. Absent ⇒ nothing is withdrawn.
   */
  readonly withdrawAnnouncements?: (() => void) | undefined;
  /**
   * The one timer the run watch and the exit grace use: call `callback` once after `delayMs` and return the function that cancels it.
   * Default is `setTimeout` with an unreferenced handle; a test injects its own clock so nothing sleeps.
   */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  /**
   * The one-shot timer the exit guard's `(wait)` display opens on (`setTimeout`-shaped, returning its cancel); default an unref'd `setTimeout`.
   * A seam of its own, apart from {@link schedule}: the display's one timer is no part of the Home's own timers (the run watch, the grace).
   */
  readonly lockSchedule?: (callback: () => void, delayMs: number) => () => void;
  /**
   * A change of the Home's page SLIDES (MVP-11 unit 7): the alternate screen's renderer, where the view draws a window onto the two pages. Its
   * frames are timed by {@link schedule}. Absent or `false` (inline, or a test of the keys alone): the pages swap at once.
   */
  readonly slideTransitions?: boolean | undefined;
  readonly pickSession?: () => Promise<string | undefined>;
  readonly resumeChat?: (
    sessionId: string,
  ) => Promise<HomeChatSession | { readonly notice: string } | undefined>;
  /**
   * The `/resume` popup's ONE frame (ADR-0148 §1; MVP-11 unit 6): run `run` (the picker, the check that the session is not the one open, the
   * restore) inside a popup frame the host opens first and closes after, so nothing closes between the picker and the restore. It resolves
   * only once the frame is closed and the channel idle: the controller adopts the conversation the restore built, and says what the stages
   * had to say, only then. `origin` is the surface the resume was asked on. Absent ⇒ the stages run as they are (a test's Home).
   */
  readonly resumeFrame?: (origin: 'home' | 'chat', run: () => Promise<void>) => Promise<void>;
  /**
   * What the Home's status line says about the next chat (ADR-0146 §2): the provider, the model, the mode, the effort and the directory a chat
   * started now would use. Read ONCE when the controller is built and again only at the events that can change them (a provider run, a
   * `/models` default write, a `/mode` default, a chat ending or a `/clear`), never on a draw: it may read configuration, and a draw touches no
   * keychain and no disk. A read that throws leaves the Home with no facts (its status row is blank) until a read succeeds: the facts it had
   * may no longer be what the next chat uses. Absent ⇒ the Home has no status line (a test's Home) and nothing else changes.
   */
  readonly statusFacts?: HomeStatusReader | undefined;
  readonly providerSetup?: {
    readonly initialKeyless: boolean;
    /** Open the explicit provider setup. `note` is shown in the setup's own card, where a person who is looking at the setup can read it. */
    readonly open: (options?: { readonly note?: string }) => Promise<void>;
    /** Sample once when returning to Home after a chat, never during rendering. */
    readonly readKeyless?: () => boolean;
  };
}

/** A key as the Home's one input owner forwards it: the landing's, the chat's and the palette's flags together. */
export type HomeKeyEvent = HomeKey & ChatKey & PaletteKey;

/** A key or a paste that arrived while the Home's pages slid (MVP-11 unit 7): applied, in order, once the arrival is on screen. */
type QueuedInput =
  | { readonly kind: 'key'; readonly input: string; readonly key: HomeKeyEvent }
  | { readonly kind: 'paste'; readonly text: string };

export interface HomeController {
  // Declared as function PROPERTIES (not methods) so a `useSyncExternalStore(c.subscribe, c.getSnapshot)`
  // unbound reference is sound (no `this`) — matching the chat store's read surface.
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => HomeControllerState;
  readonly setProviderState: (keyless: boolean, notice?: string) => void;
  /** Dispatch one `useInput` event (the single raw-mode owner forwards every key here). */
  readonly handleKey: (input: string, key: HomeKeyEvent) => void;
  /** A key the host consumed before the controller (an open card takes every key): it still ends the armed interrupt state, so
   *  `Ctrl+C`, a key, `Ctrl+C` is two first presses and never an exit (ADR-0115 §1). */
  readonly disarmInterrupt: () => void;
  /** A `Ctrl+C` a card consumed as its own answer without aborting (a checkpoint's "stop"): the interrupt window starts, or the
   *  chat ends if it was already armed (ADR-0115 §1, ADR-0136 §2). */
  readonly interruptAnswered: () => void;
  /** Handle a bracketed paste as ONE native event (ink 7 `usePaste`, a channel separate from `useInput`):
   *  insert it into the prompt buffer, or drop it while a keyboard-owning overlay/submode, a pending approval,
   *  or a mid-turn/build/`!`-shell/submit state is active. Paste never reaches the key reducers. */
  readonly handlePaste: (text: string) => void;
  /** The terminal's size, told by the host whenever it changes: the sheets and the popups need it to know whether they can show their
   *  question (ADR-0147 §1, ADR-0148 §2), and the strip's idle tick reads nothing below 80×24 (ADR-0140 §6). Until it is told, both
   *  assume a terminal that can. */
  readonly setTerminalSize: (columns: number, rows: number) => void;
  /**
   * Open the `/permissions` popup as the whole job of this run (a bare `relavium permissions` on a terminal, ADR-0137 §3,
   * ADR-0140 §1): the popup opens at once and, when the person closes it, the Home ends with success instead of staying open behind it.
   * If it cannot open (no port, or the port cannot be read) the Home stays, with the reason in its notice, as it does for the typed command.
   */
  readonly openPermissionsAsCommand: () => void;
  /**
   * Open `/providers` as the person would from the palette, through the Home's opening gate (a refusal is one notification): the doctor's
   * remedy hands off to it after closing itself (maintainer, 2026-11-25; MVP-11 unit 6).
   */
  readonly openProviderSetup: () => void;
  /**
   * Put a screen in front of the landing ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1).
   * It replaces whatever the slot held, and returns whether it opened: it refuses while the Home is not the landing (a chat or its
   * build), an overlay is open, the exit-guard card is up or the Home is ending. The screen then owns every key, and no paste reaches
   * the prompt behind it.
   */
  readonly openScreen: {
    (kind: 'run-view', props: RunViewProps): boolean;
    (kind: 'tab-host', props: TabHostProps): boolean;
  };
  /**
   * Close the screen, if one is open, and drop the interrupt state it armed and what the tab host remembers of its tabs: the one reset
   * of the slot. Reopening the tab host afterwards starts every tab at its top.
   */
  readonly closeScreen: () => void;
  /**
   * The host's evidence that a gate card's exact snapshot is on screen, measured and flushed at 80×24 (`createGateCardFrame`). A card
   * takes an affirmative chord only while this says so; with none bound, or `undefined`, it never does. `RootApp` binds it on mount.
   */
  readonly bindGateCardFrame: (
    visible: ((snapshot: RunCardSnapshot) => boolean) | undefined,
  ) => void;
  /**
   * The host's evidence that the landing's exact state (the exit-guard card among it) is on screen, measured and flushed at 80×24. The
   * exit guard's `Ctrl+Y` cancels a run for good, so it counts only while this says so; with none bound it never does. `RootApp` binds it
   * on mount.
   */
  readonly bindHomeFrame: (visible: ((state: HomeControllerState) => boolean) | undefined) => void;
  /**
   * What the exit guard DRAWS of its lockout (ADR-0145 §3, unit 8): whether its `Ctrl+Y` is held now, from the card's appearance or the last
   * answer, with one timer at the instant it opens. A display value beside the controller's state, never a field of it.
   */
  readonly exitGuardLock: LockDisplay;
  /**
   * The host's word that a frame of the Home's pages holding `state` was measured and flushed (the same evidence {@link bindHomeFrame} reads):
   * the keys that waited while the pages slid are applied once the arrival is on screen (MVP-11 unit 7). Optional: a host without it gets them
   * after a short bound instead.
   */
  readonly homeFrameShown?: (state: HomeControllerState) => void;
  /** Tear down a live chat session (if any), for the signal handler — idempotent, never the shared db. */
  readonly teardownActive: () => Promise<void>;
}

/**
 * What `Enter` on an empty prompt answers when it has nothing to open (no hosted run to show, no key to connect; ADR-0146 §1): ONE notification
 * on the Home's channel instead of nothing, saying how to start. The key it names is written by the legend's bracket rule.
 */
export const EMPTY_PROMPT_ENTER_NOTICE = keyHint([
  { text: 'Type a message to chat' },
  { keys: '/', verb: 'commands' },
]);

/**
 * What a draft that looks like a provider key is answered with when there is no key yet (ADR-0146 §6): the draft was cleared, not kept and not
 * recorded, and never carried into the setup's key step. ONE notification on the Home's channel (ADR-0148 §6, MVP-11 unit 6), never a Home
 * notice or the setup's note, so it fits the 54 columns a notification has inside a popup. Fixed text: it never echoes the draft.
 */
export const KEY_SHAPED_DRAFT_NOTICE = 'That looked like an API key · it was not kept';

/**
 * What a draft that looks like a provider key is answered with when a key already exists (ADR-0146 §6, round 2 A1): Enter on it would build a
 * chat and send it, and a sent message enters the session TRANSCRIPT, which `history.db` keeps unencrypted. So nothing is sent, built or
 * recorded: the editor is cleared and this fixed sentence says where keys are managed. It never echoes the draft.
 */
export const KEY_SHAPED_SEND_NOTICE =
  'That looked like an API key, so it was not sent. Keys are managed with /providers.';

/**
 * What a slash-led line that looks like a provider key is answered with (a key pasted after a stray `/`): no setup opens for it, so the
 * sentence names where a key goes instead. Fixed text; the line is cleared and never echoed (the unknown-command notice would have shown
 * up to 64 of its characters).
 */
export const KEY_SHAPED_LINE_NOTICE =
  'That looked like an API key, so it was not shown or kept. Use /providers to connect a provider and paste it there.';

/**
 * One word of the Home's own, as the Home opens it ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7). The
 * controller keeps ONE record of these keyed by command name, and a typed line and a palette selection are applied through it alike.
 */
interface HomeWord {
  /** The fixed refusal for `/word extra`: the word takes no arguments, and the sentence says where its input is asked instead. */
  readonly argsNotice: string;
  /** What is said instead of opening when a dependency of the word is not wired here, or `undefined` when the word can open. */
  readonly unavailable?: () => string | undefined;
  /** The word is the Home's in a chat it hosts as well (`/resume`); every other word of the table is the landing's only. */
  readonly inChat?: true;
  /** Open what the word is for. It never throws for a missing dependency that {@link unavailable} names. */
  readonly open: () => void;
}

/**
 * Who an `@`-mention completion is for (ADR-0061): the chat in front, or the Home's own prompts. One completion serves both, so the picker,
 * the read and the queued attachment are one implementation and only these three things differ.
 */
interface MentionOwner {
  /** The reader over the owner's jail (the session's, or the Home's own, built by the same factory). */
  readonly reader: MentionReader;
  /** Whether a listing or a read that resolves now may still land: the owner is the one in front, and the Home is not leaving. */
  readonly current: () => boolean;
  /** Where a word about the pick goes (a limit reached, a large file, a refused read): a chat's transcript note, or the Home's channel. */
  readonly note: (text: string) => void;
}

/** What `Esc` says when it drops the attachments pending on the Home's draft (the chat's own words for it). */
export const ATTACHMENTS_CLEARED = 'cleared pending attachments';

/** The longest a chat build's failure is drawn: it wraps across rows, and no config text or error body may fill the screen. */
const FAILURE_NOTICE_MAX = 300;

/**
 * A chat build's failure as ONE logical line that is safe to draw (ADR-0145 §5): the untrusted-text floor with secrets scrubbed, the line
 * ends collapsed, the host's own glyphs (a `━━ Approval needed ━━` rule, a `✓`) blanked so the text cannot pose as the Home's own rows, and a
 * length bound. The error can carry configuration text (`formatZodError` names raw config keys) and the configuration is read again on every
 * chat build.
 */
function failureLine(error: unknown): string {
  const line = authorLine(error instanceof Error ? error.message : String(error));
  const characters = Array.from(line);
  return characters.length <= FAILURE_NOTICE_MAX
    ? line
    : `${characters.slice(0, FAILURE_NOTICE_MAX).join('')}…`;
}

/**
 * What a chat the Home hosts answers a near miss of `/providers` with: the keys are managed from the Home, and `Ctrl+C` twice is the way back
 * to it. A sentence that names a key writes it by the legend's bracket rule ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3);
 * exported so the legend golden records the sentence the controller shows, not a copy of it.
 */
export const PROVIDER_KEYS_AT_THE_HOME = `Provider keys are managed from the Home: go back to it (${keyToken('Ctrl+C')} twice) and use /providers.`;

/** What `Enter` on a failed or recent run says when the Home has no run history to open it from. */
const RUN_HISTORY_UNAVAILABLE = 'The run history is not available here.';

/** What `/doctor` says on a Home that has no doctor popup to open (only a test's Home: `driveHome` always wires one). */
const DOCTOR_UNAVAILABLE = 'Doctor is not available here.';

/** What a session resume says (one notification) when it ends because the person cancelled one of its interactive steps. */
export const RESUME_CANCELLED = 'Resume cancelled.';
/** What `/resume` says (one notification) when the conversation picked is the one already open: nothing is restored. */
export const RESUME_ALREADY_OPEN = 'This conversation is already open.';

/** What `Enter` says on a focused row the strip no longer lists: nothing was opened. */
const STRIP_ROW_GONE = 'That row is no longer on the strip. Nothing was opened.';

/** What `Enter` says on an unreadable run's row on a Home that has no card to open (only a test's Home: `driveHome` always wires one). */
const UNREADABLE_CARD_UNAVAILABLE = 'That run cannot be shown here. Nothing was opened.';

/** How often the strip looks at the change token while the landing is in front (ADR-0140 §6). */
export const STRIP_REFRESH_MS = 5000;

/**
 * How often the Home repaints for the clock alone while a relative word (`expires in 5m`, `failed 2h ago`, `waiting 3h`) is on screen
 * (ADR-0140 §6, MVP-11 unit 7 round 2): the words are worded from the clock when the frame is painted, and a landing nothing else repaints
 * kept the words of its last paint (`expires in 13s` stood for 45 s, and `expires in 5m` for hours). Half a minute is the finest the words
 * need above the first minute and the coarsest that keeps a minute's words within one minute of the truth.
 */
export const RELATIVE_WORDS_REPAINT_MS = 30_000;

/** What one tick of the strip's refresh reads: the aggregation and the parked rows, taken together. */
interface StripRead {
  readonly snapshot: HomeSnapshot;
  readonly parked: readonly ParkedRunRow[];
}

const NO_NOTICES: readonly string[] = Object.freeze([]);
const NO_PARKED: readonly ParkedRunRow[] = Object.freeze([]);
/**
 * What a slash word is, for the landing (ADR-0140 §3): `/` and lower-case letters and hyphens, as the commands are named. An unknown one
 * is named in the notice as it is; any other line that starts with a slash (`/Users/x/file.txt`, `/Zzzz`) is answered too, and is shown by
 * {@link shownLine} instead.
 */
const LANDING_WORD = /^\/[a-z][a-z-]*$/u;
/** The longest a typed line is shown in a notice that names it: the chat's own bound (`unknown command '...'`). */
const SHOWN_LINE_MAX = 64;
/**
 * `line` as a notice may name it, as the chat names a line it does not know: every character outside printable ASCII is a `?`, so a crafted
 * line cannot smuggle a terminal control sequence into the landing, and no more than {@link SHOWN_LINE_MAX} characters are kept.
 */
const shownLine = (line: string): string =>
  line.replace(/[^\x20-\x7e]/gu, '?').slice(0, SHOWN_LINE_MAX);

/** The statuses of a run that is still going or waiting: the runs the Active tab lists (a finished run is read on the History tab). */
const LIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'pending',
  'running',
  'paused',
]);

/**
 * The workflow the Home's row of `runId` named, when it named one: through the work page's scrub, then with its key lookalikes folded as page 1's
 * hint folds them (`[Enter] Allow` reads as `(Enter) Allow`), because the card draws it beside its own keys (unit 8 fix wave 3, S3-2).
 */
function workflowOfRow(rows: readonly ParkedRunRow[], runId: string): string | undefined {
  const slug = rows.find((row) => row.runId === runId)?.workflow;
  return slug === undefined ? undefined : foldKeyLookalikes(workRowText(slug));
}

/** The project's parked runs from the port, or `previous` when there is no port or the read failed (a strip must not break on it). */
function readParkedRows(
  port: HomeGateCardsPort | undefined,
  previous: readonly ParkedRunRow[],
): readonly ParkedRunRow[] {
  if (port === undefined) return previous;
  try {
    return port.list();
  } catch {
    return previous;
  }
}

/**
 * The strip tick's read of the parked runs: the port's rows, or `previous` with no port. UNLIKE {@link readParkedRows} a failed read
 * throws, so the tick's read fails as a whole: the rows already drawn stay (nothing is applied, and nothing empty replaces them), the
 * poll does not count the read as applied (the next attempt reads again without a token move), and the strip's backoff slows the retries.
 */
function readParkedRowsOrThrow(
  port: HomeGateCardsPort | undefined,
  previous: readonly ParkedRunRow[],
): readonly ParkedRunRow[] {
  return port === undefined ? previous : port.list();
}

/**
 * `rows` without the run a leg is executing now. A resumed leg is read at its start boundary, while the log still says the run is paused:
 * the run is not waiting on anyone while a leg answers it, so its own Attention row must not read as parked (or take the `↓` focus) until
 * that leg ends and the log is read again. Returns `rows` itself when nothing is taken out.
 */
function withoutExecutingRun(
  rows: readonly ParkedRunRow[],
  snapshot: RunHostSnapshot | undefined,
): readonly ParkedRunRow[] {
  const running = snapshot?.active?.runId;
  if (running === undefined || !rows.some((row) => row.runId === running)) return rows;
  return rows.filter((row) => row.runId !== running);
}

function sameParkedRows(a: readonly ParkedRunRow[], b: readonly ParkedRunRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];
      return (
        row.runId === other?.runId &&
        row.kind === other.kind &&
        row.gates === other.gates &&
        row.workflow === other.workflow &&
        row.expiresAt === other.expiresAt &&
        row.parkedSince === other.parkedSince
      );
    })
  );
}

/**
 * What changed in a run host's snapshot, as one string: the controller publishes a new snapshot only when this differs, so the
 * recurring read never repaints an unchanged Home. No leg and no earlier end read as the empty string, the same as no host.
 */
function hostedKey(snapshot: RunHostSnapshot | undefined): string {
  if (snapshot === undefined) return '';
  const active =
    snapshot.active === undefined
      ? ''
      : `${snapshot.active.leg}:${snapshot.active.runId ?? ''}:${snapshot.active.cancelling}`;
  const last =
    snapshot.last === undefined
      ? ''
      : `${snapshot.last.leg}:${snapshot.last.runId}:${snapshot.last.terminal.disposition}`;
  return !snapshot.launching && active === '' && last === ''
    ? ''
    : `${snapshot.launching}|${active}|${last}`;
}

/** Whether a leg started or ended between two reads of the run host: a different liveness, or a different last end (by identity). */
function legBoundary(now: RunHostSnapshot, before: RunHostSnapshot | undefined): boolean {
  return hostedRunIsLive(now) !== hostedRunIsLive(before) || now.last !== before?.last;
}

/**
 * The status facts the reader gives now (ADR-0146 §2), or `previous` when there is no reader. A read that throws (a strict configuration reload
 * that failed) gives NO facts: the line is drawn blank until a read succeeds, because the facts it had are no longer what the next chat would use
 * (that reload revoked the starting mode's authority, and the next chat refuses to start), and the line never claims what the next chat will
 * not do (MVP-11 unit 7, round 1: SE72); the failure itself belongs to whatever builds the next chat. The very object `previous` when nothing
 * changed, so a re-read that finds the same facts publishes nothing and repaints nothing.
 */
function readStatusFacts(
  reader: HomeStatusReader | undefined,
  previous: HomeStatusFacts | undefined,
): HomeStatusFacts | undefined {
  if (reader === undefined) return previous;
  try {
    const next = reader.read();
    return sameStatusFacts(next, previous) ? previous : next;
  } catch {
    return undefined;
  }
}

export function createHomeController(deps: HomeControllerDeps): HomeController {
  const listeners = new Set<() => void>();
  // The strip's change token as it is BEFORE the first read of the strip (the state below reads it), so the idle tick compares with a
  // token that cannot be newer than what the Home shows.
  const stripSeed = ((): ChangeToken | undefined => {
    try {
      return deps.strip?.token();
    } catch {
      return undefined; // a closed database: the poll then reads at once and reports it
    }
  })();
  let state: HomeControllerState = {
    mode: 'home',
    keyless: deps.providerSetup?.initialKeyless ?? false,
    nativeActionBusy: false,
    snapshot: deps.homeStore.read(),
    pendingMessage: '',
    input: emptyEditor(),
    session: undefined,
    palette: undefined,
    search: undefined,
    mention: undefined,
    shellBusy: false,
    submitBusy: false,
    shellCommand: undefined,
    attachments: [],
    historyEntries: [],
    notice: undefined,
    noticeRevision: 0,
    interruptArmed: false,
    hostedRun: undefined,
    exitGuard: undefined,
    screen: undefined,
    parkedRuns: readParkedRows(deps.gateCards, NO_PARKED),
    stripFocus: undefined,
    homePage: 'start',
    slide: undefined,
    gateCards: deps.gateCards !== undefined,
    status: readStatusFacts(deps.statusFacts, undefined),
  };
  // Per-session command history for the in-Home chat (2.5.D step 3) — accumulates submitted lines across the Home
  // process; Up/Down recall, Ctrl+R reverse-searches. Not persisted (a chat-resume starts fresh).
  let history: InputHistory = EMPTY_HISTORY;
  /** The terminal's size as the host last told it ({@link HomeController.setTerminalSize}); `undefined` until it has. */
  let terminal: { readonly columns: number; readonly rows: number } | undefined;
  // The Active tab's poll (ADR-0140 §2): created the first time the tab is in front, started and cancelled by `syncActivePoll` as the
  // screen changes, and cancelled with the Home's other timers when it ends. `lastActiveRead` is what a re-entered tab is shown at once.
  let activePoll: ActivePoll | undefined;
  // The strip's idle refresh (ADR-0140 §6): one poll for the life of the Home, created below once everything it asks about exists.
  let stripPoll: ActivePoll | undefined;
  // The repaint for the clock alone (`RELATIVE_WORDS_REPAINT_MS`): the timer, armed by `syncWordsTick` after every state change while a relative
  // word is on screen on the idle landing or work page, and whether the pause facts it reads exist yet (they are built with the strip, below:
  // a state change before then, the first ones the controller makes, has nothing to ask).
  let cancelWordsTick: (() => void) | undefined;
  let wordsTickReady = false;
  // Set when the strip's idle refresh drops the focused strip row because another terminal removed it: the first `Enter` after it is ignored
  // once (the person's `Enter` was meant for that row), and any other key, and any screen that opens or closes, ends it. It is a flag of
  // the landing's key handling, not something a screen draws.
  let focusJustDropped = false;
  // The two pages' slide (MVP-11 unit 7): the timer of its next frame, the keys and pastes that arrived while it ran (applied in order once
  // the arrival is on screen), whether the arrival is waiting for that frame, and the bound on that wait.
  let cancelSlideFrame: (() => void) | undefined;
  let slideQueue: readonly QueuedInput[] = [];
  let settlingSlide = false;
  let cancelSettleBound: (() => void) | undefined;
  // The Home's draft while a conversation resumed from the Home is in front (MVP-11 unit 7, round 1: SE74): it was not sent, so the chat
  // starts with an empty composer and the Home's prompt has the draft again when the chat ends. Never a draft that looks like a key.
  let keptDraft: EditorState | undefined;
  // The row of the work page a screen in the slot was opened from (its identity and where it stood), until the slot is empty again: the focus
  // goes back to it, or to the row that now stands where it stood when it is gone (MVP-11 unit 7, round 1: OB77; `restoreRowFocus`).
  let screenFromRow: { readonly focus: StripFocus; readonly index: number } | undefined;
  let activePollRunning = false;
  let lastActiveRead: ActiveRead | undefined;
  let cancelFired = false;
  let exiting = false; // permanent stop seals deferred business results as well as database reads
  const isCurrentChat = (active: HomeChatSession): boolean =>
    !exiting && state.session === active && state.mode === 'chat';
  let tearingDown: HomeChatSession | undefined;
  let activeTeardown: Promise<void> | undefined; // the in-flight teardown of `tearingDown`, so a signal can await it
  let buildInFlight: Promise<HomeChatSession> | undefined; // a `loading`-state build, so a signal can reap it
  let nativeInFlight: Promise<void> | undefined;
  const activatedSessions = new WeakSet<HomeChatSession>();
  const activationPending = new WeakMap<HomeChatSession, Promise<void>>();
  const activateSession = (session: HomeChatSession, ready: () => void): void => {
    const isActive = (): boolean =>
      !exiting &&
      state.session === session &&
      state.mode === 'chat' &&
      tearingDown !== session &&
      !session.shouldStop();
    const finish = (): void => {
      if (isActive()) ready();
    };
    const failed = (): void => {
      if (isActive()) {
        try {
          session.store.notice('warning: session effect disclosure could not be completed.');
        } catch {
          // A failed notice sink must not create an unhandled build-resolution rejection.
        }
      }
      finish();
    };
    // Publishing state synchronously notifies subscribers; one may exit or supersede this session.
    if (!isActive()) return;
    if (!activatedSessions.has(session)) {
      activatedSessions.add(session);
      try {
        const pending = session.onActivated?.(isActive);
        if (pending !== undefined) activationPending.set(session, Promise.resolve(pending));
      } catch {
        failed();
        return;
      }
    }
    const pending = activationPending.get(session);
    if (pending === undefined) finish();
    else void pending.then(finish, failed);
  };
  // A monotonic submit generation: bumped when the compose buffer is submitted (cleared). An async mention read
  // captures it at accept time and drops its inject if a submit has since happened — so a slow read resolving after
  // Enter can never splice the file into the (now-empty) buffer meant for the NEXT message (the session-identity
  // guard only catches a chat SWAP, not an in-chat submit that stays in the same session/mode).
  let submitEpoch = 0;
  // A held `Enter` that chose a file in the `@` picker must not go on to send (round 2 sitting #3): the landing's and the chat's
  // `Enter` that would send is held off for the lockout after the choice, unless another key or a paste came since (`PickEnterLock`).
  const pickEnter = createPickEnterLock();

  // Race a chat teardown against the force-teardown deadline so the return-to-Home is bounded even if a hung MCP
  // graceful close never settles; the teardown still runs to completion in the background.
  const boundTeardown =
    deps.boundTeardown ??
    ((teardown: Promise<void>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FORCE_TEARDOWN_MS);
        timer.unref?.();
      });
      return Promise.race([teardown.catch(() => undefined), deadline]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    });

  const notify = (): void => {
    try {
      for (const listener of listeners) listener();
    } catch (cause) {
      // Palette and other advisory callers may recover; the original publication fault comes first.
      deps.workOwner?.failure(cause);
      throw cause;
    }
  };
  /** Whether a chat turn is streaming — paste content (like every other key) is gated mid-turn. */
  const chatRunning = (): boolean =>
    state.mode === 'chat' && state.session?.store.getSnapshot().state.status === 'running';
  /** The record of what owns the keyboard right now (`overlay-flags.ts`): every gate below asks it, never the state's fields one by one. */
  const overlayFlags = (): OverlayFlags => ({
    ...homeOverlayFlags(state),
    popup: deps.popupOpen?.() === true,
  });
  /** Whether a native bracketed paste (ink 7 `usePaste`) may append to the prompt buffer — only when the main
   *  Home/chat prompt is the active editable target: no build/turn/`!`-shell/submit in flight, no keyboard-owning
   *  overlay/submode (palette, reverse-search, `@`-mention, `/models`, `/effort`), and
   *  NO pending approval (a paste must never reach the fail-closed approval floor — ADR-0057). */
  const pasteEditable = (): boolean =>
    state.mode !== 'loading' && // the build window is Home-only; every other gate is the SHARED paste predicate
    pasteIsEditable({
      running: chatRunning(),
      shellBusy: state.shellBusy,
      submitBusy: state.submitBusy,
      ...pasteFlagsFrom(overlayFlags()),
    });
  /** The landing is what the person is looking at: the bare Home, with no screen or card in front of it. */
  const landingInFront = (): boolean => state.mode === 'home' && state.screen === undefined;
  /**
   * The status line's facts read again, as a patch for the state change that goes with it: `{}` when they are what the Home already shows
   * (nothing repaints for them), `{ status }` when they differ (ADR-0146 §2). Called only at the points that can change what the next chat
   * uses, never from a draw.
   */
  const statusPatch = (): Partial<HomeControllerState> => {
    const status = readStatusFacts(deps.statusFacts, state.status);
    return status === state.status ? {} : { status };
  };
  /**
   * The rows were replaced (a read of the strip): the strip's focus is the identity of a row (`strip-focus.ts`), so it follows its row and is
   * dropped when the row is gone, never left naming nothing; and with nothing left to continue there is no work page, so the Home is its landing
   * again (a slide in progress ends on its own, and the view draws the landing meanwhile).
   */
  const followRows = (patch: Partial<HomeControllerState>): void => {
    if (!('stripFocus' in patch)) {
      const stripFocus = resolveFocus(
        stripRows(state.parkedRuns, state.snapshot),
        state.stripFocus,
      );
      if (stripFocus !== state.stripFocus) state = { ...state, stripFocus };
    }
    if (state.homePage === 'work' && homeIsEmpty(state.snapshot, state.parkedRuns))
      state = { ...state, homePage: 'start', stripFocus: undefined };
  };
  /**
   * The slot is empty again after a screen opened from a row of the work page (MVP-11 unit 7, round 1: OB77): the focus is that row's again,
   * by its identity, or, when the screen took it off the list (a gate answered: the run is no longer parked), the row that now stands where it
   * stood (the last one when the list got shorter), never the docked prompt while there is a row to stand on. A focus the closing change set
   * itself, a focus that still names a row, a chat in front and the landing are left as they are.
   */
  const restoreRowFocus = (patch: Partial<HomeControllerState>): void => {
    const origin = screenFromRow;
    screenFromRow = undefined;
    // `'stripFocus' in patch` is a DEFENSIVE guard of the rule stated above (no caller closes a screen with a focus of its own today): a change
    // that does name one keeps it, whatever a later caller writes.
    if (origin === undefined || 'stripFocus' in patch) return;
    if (state.mode !== 'home' || state.homePage !== 'work') return;
    const rows = stripRows(state.parkedRuns, state.snapshot);
    if (focusFor(rows, state.stripFocus) !== undefined) return;
    const stripFocus =
      focusFor(rows, origin.focus) === undefined
        ? focusAt(rows, Math.min(origin.index, rows.length - 1))
        : origin.focus;
    if (stripFocus !== undefined) state = { ...state, stripFocus };
  };
  const set = (patch: Partial<HomeControllerState>): void => {
    const noticeRevision = state.noticeRevision + ('notice' in patch ? 1 : 0);
    const before = state;
    state = { ...state, ...patch, noticeRevision };
    // The attachments pending on the draft are the ones it still names (ADR-0061; round 2 sitting #3): after every change to the draft or to
    // the list, a file whose `@path` marker left the draft is dropped for good (`attachmentsOfDraft`), on the landing, the work page's docked
    // prompt and the chat in front alike, so the chip bar and the next send read the same list and a marker typed later is plain text.
    if (('input' in patch || 'attachments' in patch) && state.attachments.length > 0) {
      const kept = attachmentsOfDraft(state.input.text, state.attachments);
      if (kept !== state.attachments) state = { ...state, attachments: kept };
    }
    if ('snapshot' in patch || 'parkedRuns' in patch) followRows(patch);
    if (before.screen !== undefined && state.screen === undefined) restoreRowFocus(patch);
    // A screen or a card that opens or closes ends the swallowed `Enter` (see `focusJustDropped`): the first key after the landing comes
    // back is the landing's own.
    if (before.screen !== state.screen) focusJustDropped = false;
    syncActivePoll();
    syncWordsTick();
    // A chat comes in front (its build starts, a resumed one is adopted): the Home's own notifications are about the Home, and go (CO76).
    if (before.mode === 'home' && state.mode !== 'home') deps.withdrawAnnouncements?.();
    notify();
    // The landing is back from a screen: the strip is read again now rather than at the next tick (ADR-0140 §6).
    if (before.screen !== undefined && state.screen === undefined) stripPoll?.refresh();
  };
  // ---- The Active tab's poll (ADR-0140 §2) -----------------------------------------------------------------------------------
  // It runs while, and only while, the tab host is in front on the Active tab: a gate card, a run view, the landing and the end of the
  // Home all take the screen away, and `set` (the one place state changes) cancels the poll with it. It is read-only and holds no card.
  function activeTabInFront(): boolean {
    const screen = state.screen;
    return (
      !exiting &&
      deps.active !== undefined &&
      screen?.kind === 'tab-host' &&
      screen.host.active !== undefined
    );
  }
  /**
   * No read while the exit question is up, a native question or form holds the keyboard (a card is open: ADR-0140 §2), or the terminal is below
   * the floor (the tab then shows only its one line).
   */
  const activePollPaused = (): boolean =>
    activePollPausedByOverlay(overlayFlags()) ||
    (terminal !== undefined && !homeFitsTerminal(terminal.columns, terminal.rows));
  const onActiveRead = (read: ActiveRead): void => {
    lastActiveRead = read;
    const screen = state.screen;
    if (exiting || screen?.kind !== 'tab-host') return;
    const host = withActiveRead(screen.host, read);
    if (host === screen.host) return;
    tabMemory = tabHostMemory(host);
    set({ screen: { kind: 'tab-host', host } });
  };
  const onActiveFailure = (): void => {
    const screen = state.screen;
    if (exiting || screen?.kind !== 'tab-host') return;
    const host = withActiveFailure(screen.host);
    if (host !== screen.host) set({ screen: { kind: 'tab-host', host } });
  };
  function syncActivePoll(): void {
    const port = deps.active;
    if (port === undefined) return;
    if (!activeTabInFront()) {
      if (activePollRunning) {
        activePollRunning = false;
        activePoll?.cancel();
      }
      return;
    }
    if (activePollRunning) return;
    activePollRunning = true;
    // A timer or promise callback has no input handler around it to route a listener's failure, so it is routed here.
    activePoll ??= createActivePoll<ActiveRead>({
      schedule: (callback, delayMs) => schedule(callback, delayMs),
      now: () => interruptNow(),
      token: port.token,
      read: port.read,
      apply: (read) => {
        try {
          onActiveRead(read);
        } catch (error) {
          failHome(error);
        }
      },
      paused: activePollPaused,
      isClosed: port.isClosed,
      onError: () => {
        try {
          onActiveFailure();
        } catch (error) {
          failHome(error);
        }
      },
    });
    activePoll.start();
  }

  const exitHome = (): void => {
    if (exiting) return; // idempotent — a second Ctrl+C (or a race) must not settle `driveHome` twice
    exiting = true;
    stopInterruptTimer();
    stopHostedTimers();
    deps.onExit();
  };

  const failHome = (err: unknown): void => {
    if (exiting) return; // an exit/error already settled `driveHome` — drop this late failure
    exiting = true;
    stopInterruptTimer();
    stopHostedTimers();
    deps.onError(err);
  };

  // ---- Leaving the Home while a hosted run executes (ADR-0139 §6) -------------------------------------------------------------
  // `requestExit` is the ONE way the Home ends: `/exit`, the second `Ctrl+C` on the loaded landing, `Ctrl+D` on an empty prompt, the
  // loading bail-out and a closed `relavium permissions` popup all call it, and `exitHome` is reached only from here. With no leg
  // executing or cancelling it leaves as it always did. With one, it opens the exit-guard card: `Ctrl+Y` cancels the run and waits for
  // it to settle for at most the grace window, then abandons it, runs the host's teardown and leaves; `Esc`, `Ctrl+C` and `Ctrl+N`
  // stay (ADR-0122 §7.4: a confirmation treats both interrupt keys as cancel). Cancelling a run cannot be undone, so nothing but an
  // exact `Ctrl+Y` at the open card does it.
  const schedule =
    deps.schedule ??
    ((callback: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const exitGraceMs = deps.exitGraceMs ?? HOSTED_RUN_EXIT_GRACE_MS;
  let cancelHostedPoll: (() => void) | undefined;
  let cancelExitGrace: (() => void) | undefined;
  const stopHostedTimers = (): void => {
    activePollRunning = false;
    activePoll?.cancel(); // the Active tab's poll is a timer too: the Home ending, or a signal, leaves nothing scheduled
    stripPoll?.cancel(); // and so is the strip's idle refresh
    cancelWordsTick?.(); // and the repaint for the clock (every way the Home ends has set `exiting`, so no later state change arms it again)
    cancelWordsTick = undefined;
    cancelHostedPoll?.();
    cancelHostedPoll = undefined;
    cancelExitGrace?.();
    cancelExitGrace = undefined;
    // and the pages' slide: its next frame and the wait for its arrival (the keys it queued die with the Home)
    cancelSlideFrame?.();
    cancelSlideFrame = undefined;
    cancelSettleBound?.();
    cancelSettleBound = undefined;
    slideQueue = [];
    settlingSlide = false;
  };

  // ---- The two pages (MVP-11 unit 7) ---------------------------------------------------------------------------------------------
  // `↓` on the landing goes down to the work page, `↑` from its first row and `Esc` on it come back (`reducePageKey`). In the alternate screen
  // the change SLIDES: the page and the focus are the target's at once (so the keys, the hints and the measured frame are), and `slide` walks
  // the view's window through the frames of `slideFrames`, one every `SLIDE_FRAME_MS`. Every key and paste that arrives meanwhile waits in
  // `slideQueue` and is applied in order once the arrival is on screen (the host's `homeFrameShown`; with no host bound, at once; with a host
  // that never says so, after `SLIDE_SETTLE_BOUND_MS`), each through the very route a live key takes, EXCEPT a key that answers (`Enter` and
  // the answer chords): it is judged when it is pressed, when no frame has shown the page at rest, and dropped (`answersUnseen`). A queue that
  // can no longer be applied as it was pressed (the terminal went below the floor, a popup took the keyboard) is dropped whole. `Ctrl+C` does
  // not wait: it ends the slide where it would arrive, applies what was queued before it, and is then handled at once (a second press there
  // opens the exit guard over the page that has arrived). A resize ends the slide the same way, without the `Ctrl+C`.
  /** The slide's next frame, or its arrival. */
  const stepSlide = (): void => {
    cancelSlideFrame = undefined;
    const slide = state.slide;
    if (slide === undefined) return;
    const frames = slideFrames(terminal?.rows ?? HOME_MIN_ROWS, slide.to).length;
    if (slide.frame + 1 >= frames - 1) {
      arriveSlide(false);
      return;
    }
    set({ slide: { to: slide.to, frame: slide.frame + 1 } });
    cancelSlideFrame = schedule(stepSlide, SLIDE_FRAME_MS);
  };
  /** Turn to `to` with `patch` (the focus it lands on): slid in the alternate screen, at once inline or when there are no frames between. */
  const turnPage = (to: HomePage, patch: Partial<HomeControllerState>): void => {
    const frames = slideFrames(terminal?.rows ?? HOME_MIN_ROWS, to).length;
    if (deps.slideTransitions !== true || frames < 2) {
      set({ ...patch, homePage: to, slide: undefined });
      return;
    }
    set({ ...patch, homePage: to, slide: { to, frame: 0 } });
    cancelSlideFrame = schedule(stepSlide, SLIDE_FRAME_MS);
  };
  /**
   * The slide has arrived (its last frame, a resize or a `Ctrl+C`): there is no slide, and the queue is applied once that frame is on screen, or
   * `now` (the `Ctrl+C` that cannot wait).
   */
  const arriveSlide = (now: boolean): void => {
    cancelSlideFrame?.();
    cancelSlideFrame = undefined;
    if (state.slide !== undefined) set({ slide: undefined });
    if (slideQueue.length === 0) return;
    // At once when it cannot wait or need not: no host measures frames, or the arrival is already the frame on screen.
    if (now || homeFrameVisible === undefined || homeFrameVisible(state)) {
      drainSlideQueue();
      return;
    }
    settlingSlide = true;
    cancelSettleBound?.();
    cancelSettleBound = schedule(() => {
      cancelSettleBound = undefined;
      drainSlideQueue();
    }, SLIDE_SETTLE_BOUND_MS);
  };
  /**
   * Whether the keys that waited may still be applied as they were pressed: not below the Home's 80×24 floor (the host delivers only the way out
   * there, and the page they were pressed at is gone) and not while a popup owns the keyboard (it opened while they waited, and none was meant for
   * it). A native prompt owns the keyboard only while a native action is busy, which {@link routeKey} refuses on its own.
   */
  const queueStillApplies = (): boolean =>
    deps.popupOpen?.() !== true &&
    (terminal === undefined || homeFitsTerminal(terminal.columns, terminal.rows));
  /**
   * Apply the queued keys and pastes in order. A queued key that starts another slide leaves the rest to wait for that one; a queue that can no
   * longer be applied as it was pressed ({@link queueStillApplies}) is dropped, the rest of it with it.
   */
  const drainSlideQueue = (): void => {
    settlingSlide = false;
    cancelSettleBound?.();
    cancelSettleBound = undefined;
    let queued = slideQueue;
    slideQueue = [];
    while (queued.length > 0 && !exiting && queueStillApplies()) {
      if (state.slide !== undefined) {
        slideQueue = [...queued, ...slideQueue];
        return;
      }
      const [entry, ...rest] = queued;
      queued = rest;
      if (entry === undefined) continue;
      if (entry.kind === 'paste') pasteText(entry.text);
      else routeKey(entry.input, entry.key);
    }
  };
  /**
   * A key pressed while the pages slide (or while their arrival waits for its frame) that would ANSWER something: `Enter` (it opens the focused
   * row, sends the draft, runs the palette's command) or an answer chord (`Ctrl+Y`, `Ctrl+N`). It is judged when it is PRESSED, not when it would
   * be applied: no frame had shown the page it acts on at rest then, so it is dropped (the live rule: no unseen row is opened, `home-app.tsx`), and
   * a chord is never replayed onto a card a key before it opened. It is still a key of the Home's chord history: a card that opens soon after
   * sees it in its quiet gap.
   */
  const answersUnseen = (input: QueuedInput): boolean =>
    input.kind === 'key' &&
    (input.key.return === true || chordOf(input.input, input.key) !== undefined);
  /** Whether `input` waits for the slide (or its arrival); a `Ctrl+C` ends the slide and does not wait, and a key that answers is dropped. */
  const queuedForSlide = (input: QueuedInput): boolean => {
    if (state.slide === undefined && !settlingSlide) return false;
    if (input.kind === 'key' && isInterruptKey(input.input, input.key)) {
      arriveSlide(true);
      return false;
    }
    if (answersUnseen(input)) {
      landingKeys.stamp();
      return true;
    }
    slideQueue = [...slideQueue, input];
    return true;
  };
  const hostedLeg = (snapshot: RunHostSnapshot): HostedLegState => {
    if (snapshot.active !== undefined)
      return snapshot.active.cancelling ? 'cancelling' : 'executing';
    return hostedRunIsLive(snapshot) ? 'executing' : 'none';
  };
  /** Leave for good: the grace ran out (`abandoned`) or the run settled. An abandoned leg is torn down by the host's own close. */
  const finishExit = (abandoned: boolean): void => {
    stopHostedTimers();
    if (abandoned) {
      try {
        void deps.hostedRuns?.close().catch(() => undefined);
      } catch {
        // The Home's own teardown joins the very same close; a host that cannot start it must not keep the Home open.
      }
    }
    exitHome();
  };
  /** The run host's notice ring as it is now (oldest first); empty with no host or no ring. */
  const readNotices = (): readonly string[] => deps.hostedRuns?.notices?.snapshot() ?? NO_NOTICES;
  /** The ring as it is now, with the view's own note last (the newest row). */
  const noticesWith = (note: string | undefined): readonly string[] => {
    const ring = readNotices();
    return note === undefined ? ring : [...ring, note];
  };
  /** `screen` with the notice ring as it is now: the same object when nothing changed, so an idle read never repaints. */
  const withFreshNotices = (screen: HomeScreen): HomeScreen => {
    if (screen.kind !== 'run-view') return screen; // a card has no notice ring
    const notices = noticesWith(screen.note);
    return notices.length === screen.notices.length &&
      notices.every((line, index) => line === screen.notices[index])
      ? screen
      : { ...screen, notices };
  };
  /**
   * The parked runs as the log says now, as a patch for `set`: empty when nothing changed (so an unchanged strip is never repainted).
   * Read when the landing is shown again and when the run host's state changes.
   * The run a leg is executing is never one of them. With `reread` false the rows already held are only filtered again (no database page):
   * the engine naming a leg's run is not a change of the log, but it is when the run stops being parked.
   */
  const parkedPatch = (
    reread = true,
    hosted: RunHostSnapshot | undefined = deps.hostedRuns?.snapshot(),
  ): Partial<HomeControllerState> => {
    if (deps.gateCards === undefined) return {};
    const read = withoutExecutingRun(
      reread ? readParkedRows(deps.gateCards, state.parkedRuns) : state.parkedRuns,
      hosted,
    );
    const parkedRuns = sameParkedRows(read, state.parkedRuns) ? state.parkedRuns : read;
    // The focus is resolved on the new rows by `set`: it follows its row, and moves to the nearest one when the run is no longer parked.
    return parkedRuns === state.parkedRuns ? {} : { parkedRuns };
  };
  // The leg end this Home has already looked at, by identity: the one place that tells a chat about a leg's end reads it once, whoever read
  // the host first (a card, a screen, the exit guard), and a chat that opens after an end is told nothing about it (the strip is its news).
  let seenLegEnd: HostedLegEnd | undefined = deps.hostedRuns?.snapshot().last;
  /**
   * A leg ended (parked, finished or failed) while a chat is in front: the chat's transcript says so once, since no card and no strip row
   * can take the keyboard from it (ADR-0139 §3, ADR-0140 §8). The run view is on the landing and never open behind a chat, and when it is
   * showing that very run the view is the news; a chat being torn down is told nothing.
   */
  const announceLegEnd = (end: HostedLegEnd): void => {
    const chat = state.mode === 'chat' ? state.session : undefined;
    if (chat === undefined || tearingDown === chat) return;
    if (state.screen?.kind === 'run-view' && state.screen.runId === end.runId) return;
    const row = state.parkedRuns.find((parked) => parked.runId === end.runId);
    const line = withGlyphForm(deps.plainGlyphs === true, () =>
      hostedEndNotice({ runId: end.runId, disposition: end.terminal.disposition }, row),
    );
    // A fact about the session's world, not an answer to a gesture: it stays until `/clear` or the chat ends, and the next message does not
    // consume it (MVP-11 unit 7, round 1: SE73), or a run waiting for the person loses its one sign in the chat.
    if (line !== undefined) chat.store.note(line, 'session');
  };
  /** Read the run host again: publish what changed, keep watching while a leg is live, and end a confirmed exit once none is left. */
  const refreshHostedRun = (): void => {
    const host = deps.hostedRuns;
    if (exiting || host === undefined) return;
    const snapshot = host.snapshot();
    const hostedChanged = hostedKey(snapshot) !== hostedKey(state.hostedRun);
    const screen = state.screen === undefined ? undefined : withFreshNotices(state.screen);
    const screenChanged = screen !== state.screen;
    // A leg that started or ended changes which runs are parked: the Attention rows follow it. A cancel request, the run's id arriving or the
    // launch latch flipping change nothing in the log, so they read nothing (the read is a database page per project).
    const parked = hostedChanged
      ? parkedPatch(legBoundary(snapshot, state.hostedRun), snapshot)
      : {};
    if (hostedChanged && screenChanged) set({ hostedRun: snapshot, screen, ...parked });
    else if (hostedChanged) set({ hostedRun: snapshot, ...parked });
    else if (screenChanged) set({ screen });
    if (snapshot.last !== undefined && snapshot.last !== seenLegEnd) {
      seenLegEnd = snapshot.last;
      announceLegEnd(snapshot.last);
    }
    if (hostedLeg(snapshot) !== 'none') watchHostedRun();
    else if (state.exitGuard === 'stopping') finishExit(false);
  };
  const watchHostedRun = (): void => {
    if (exiting || cancelHostedPoll !== undefined) return;
    cancelHostedPoll = schedule(() => {
      cancelHostedPoll = undefined;
      // A timer callback has no input handler around it to route a listener's failure, so it is routed here.
      try {
        refreshHostedRun();
      } catch (error) {
        failHome(error);
      }
    }, HOSTED_RUN_POLL_MS);
  };
  // When the exit guard appeared, on its guard's clock: its lockout runs from here too, so a key held down as it opened cannot stop the run with
  // its first auto-repeat (the rule of every chord surface since unit 7: the card's APPEARANCE counts as an answer just before the first key).
  let exitGuardOpenedAt = Number.NEGATIVE_INFINITY;
  const requestExit = (): void => {
    if (exiting || state.exitGuard !== undefined) return;
    const snapshot = deps.hostedRuns?.snapshot();
    if (snapshot === undefined || decideExit(hostedLeg(snapshot)) === 'exit') {
      exitHome();
      return;
    }
    exitGuardOpenedAt = (deps.now ?? ((): number => performance.now()))();
    set({
      exitGuard: 'confirm',
      hostedRun: snapshot,
      palette: undefined,
      stripFocus: undefined,
    });
    exitGuardLock.sync(); // the card's appearance starts its lockout: its `Ctrl+Y` says `(wait)` until it opens
    watchHostedRun(); // the card names the run's state, so it follows it until the card is closed
  };
  const confirmExit = (): void => {
    set({ exitGuard: 'stopping' });
    try {
      deps.hostedRuns?.cancel();
    } catch (cause) {
      deps.workOwner?.failure(cause);
      finishExit(true);
      return;
    }
    cancelExitGrace = schedule(() => {
      cancelExitGrace = undefined;
      finishExit(true);
    }, exitGraceMs);
    refreshHostedRun(); // nothing live ⇒ the exit ends here, before the grace could matter
  };
  // ---- The screen slot (ADR-0140 §1) and the run view's ladder (ADR-0139 §5) -------------------------------------------------
  // One slot holds the screen in front of the landing. It is opened in one place and closed in one place, and each takes the
  // interrupt state with it: a window a screen armed must not carry over to whatever replaces it or to the landing behind it.
  /** Whether the slot may take a screen now: the Home is the landing, with no overlay, no exit-guard card and no ending. */
  const slotAdmits = (): boolean =>
    !exiting && state.mode === 'home' && !screenSlotBlocked(overlayFlags());
  /** The ONE place a screen enters the slot: the interrupt state is dropped, and the strip and the screen read one host snapshot. */
  const putScreen = (screen: HomeScreen, extra: Partial<HomeControllerState> = {}): void => {
    disarmInterrupt();
    const snapshot = deps.hostedRuns?.snapshot();
    const hosted =
      snapshot !== undefined && hostedKey(snapshot) !== hostedKey(state.hostedRun)
        ? { hostedRun: snapshot }
        : {};
    // A focus on a run stays through the screen it opened (the way back lands on the row), a focus on a session does not.
    set({
      screen,
      ...(state.stripFocus?.kind === 'session' ? { stripFocus: undefined } : {}),
      ...hosted,
      ...extra,
    });
    // While a leg is live the view follows it (its state, its notices): the same poll as the strip's, started if it is not running.
    if (snapshot !== undefined && hostedLeg(snapshot) !== 'none') watchHostedRun();
  };
  const runViewScreen = (
    runId: string,
    store: RunStore | undefined,
    from: ScreenOrigin,
  ): RunViewScreen => ({
    kind: 'run-view',
    runId,
    from,
    store,
    notices: readNotices(),
  });
  // What the tab host remembers of its tabs (ADR-0140 §1): the tab it is on and where each tab's cursor stands. It outlives the tab host's
  // screen object, because a run view opened from the tab host replaces that screen in the one slot and `Esc` must bring it back as it was;
  // and it dies with the screen, in `closeScreen`, so a tab host opened again starts every tab at its top.
  let tabMemory: TabMemory = freshTabMemory();
  /** What entering the Active tab starts from: the last read this Home kept, or `undefined` when nothing feeds the tab. */
  const activeEntry = (): { readonly last: ActiveRead | undefined } | undefined =>
    deps.active === undefined ? undefined : { last: lastActiveRead };
  /** What entering a tab reads from, as it is now. */
  const tabEntry = (): TabEntry => ({
    defined: deps.defined,
    active: activeEntry(),
    history: deps.history,
    pins: deps.pins,
    now: interruptNow(),
  });
  /** The Runs screen on `memory`'s tab, each tab read again as it is entered. */
  const tabHostScreen = (memory: TabMemory): TabHostScreen => ({
    kind: 'tab-host',
    host: enterTab(memory, memory.tab, tabEntry()),
  });
  const openTabHost = (tab: TabId): boolean => {
    if (!slotAdmits() || state.submitBusy || state.nativeActionBusy) return false;
    const screen = tabHostScreen({ ...tabMemory, tab });
    tabMemory = tabHostMemory(screen.host);
    putScreen(screen);
    return true;
  };
  /** The Runs screen on the Active tab with the cursor on `runId` (a row it lists, when its read lists the run). */
  const openActiveTabOn = (runId: string): boolean => {
    if (!slotAdmits() || state.submitBusy || state.nativeActionBusy) return false;
    tabMemory = { ...freshTabMemory('active'), activeFocus: runId };
    return openTabHost('active');
  };
  /** The Runs screen back in front after a screen opened from it is left with `Esc`: the tab and the row it came from, read again. */
  const reopenTabHost = (): void => {
    putScreen(tabHostScreen(tabMemory), parkedPatch());
  };
  function openScreen(kind: 'run-view', props: RunViewProps): boolean;
  function openScreen(kind: 'tab-host', props: TabHostProps): boolean;
  function openScreen(kind: 'run-view' | 'tab-host', props: RunViewProps | TabHostProps): boolean {
    if (kind === 'tab-host') return 'tab' in props && openTabHost(props.tab);
    if (!('runId' in props) || !slotAdmits()) return false;
    const from = props.from ?? 'landing';
    // What a tab host remembers is only kept for a screen that can come back to it.
    if (from !== 'tab-host') tabMemory = freshTabMemory();
    putScreen(runViewScreen(props.runId, props.store, from));
    return true;
  }
  const closeScreen = (): void => {
    const screen = state.screen;
    if (screen === undefined) return;
    if (screen.kind === 'gate-card') screen.card.dispose();
    tabMemory = freshTabMemory(); // the Runs screen's life ends with the screen (ADR-0140 §1)
    disarmInterrupt();
    // Back at the landing the Attention rows are read again: what the screen did may have changed which runs are parked.
    set({ screen: undefined, ...parkedPatch() });
  };
  /** The run view's second `Ctrl+C`: ask the host for the cooperative cancel and publish that the leg is now cancelling. */
  const cancelHostedRun = (): void => {
    try {
      deps.hostedRuns?.cancel();
    } catch (cause) {
      deps.workOwner?.failure(cause);
    }
    refreshHostedRun();
  };
  /**
   * Put the run view of the leg that is executing in front (a leg the person just started, or came back to); `false` when none is. A
   * view opened from the tab host returns to it with `Esc`, on the tab and the row it came from.
   */
  const openRunView = (from: ScreenOrigin = 'landing'): boolean => {
    const runId = deps.hostedRuns?.snapshot().active?.runId;
    if (runId === undefined) return false;
    return openScreen('run-view', { runId, store: deps.runStore?.(runId), from });
  };
  /** `Esc` on a run view: back to the tab host it was opened from, else out of the screen. */
  const leaveRunView = (screen: RunViewScreen): void => {
    if (screen.from === 'tab-host') reopenTabHost();
    else closeScreen();
  };

  // ---- The gate and budget cards (ADR-0139 §4) -------------------------------------------------------------------------------
  // A card is a screen of the slot, opened from an Attention row (`Enter` on the row `↓` moved onto) or from the run view of a run that
  // ended parked (`Enter`). It reads the run's gates from its log at that moment and holds them; it never re-reads them, because a
  // re-read after an answer would find the gate still pending (the next leg has not claimed it yet) and offer it a second time. An answer
  // that arrives after another process decided the gate is answered by the host with what the log holds, and the card says so.
  let gateCardVisible: ((snapshot: RunCardSnapshot) => boolean) | undefined;
  /** The one chord history of every card this controller opens and of the exit guard (see {@link HomeControllerDeps.chordHistory}). */
  const chordHistory = deps.chordHistory ?? createChordHistory();
  let homeFrameVisible: ((state: HomeControllerState) => boolean) | undefined;
  /** One refresh after an answer went out: the strip shows the leg it started, and the rows follow the run's state. */
  const afterAnswer = (): void => {
    if (exiting) return;
    try {
      refreshHostedRun();
    } catch (error) {
      failHome(error);
    }
  };
  const answerGate = (request: Omit<HostedResumeRequest, 'secrets'>): Promise<HostedLaunch> => {
    const port = deps.gateCards;
    if (port === undefined) return Promise.reject(new Error('no gate cards are wired'));
    const reply = port.resume(request);
    afterAnswer(); // the host latched its launch synchronously: the strip shows `starting` from here
    return reply.finally(afterAnswer);
  };
  /**
   * A card could not open, and `text` says why. From the run view the reason is the view's own note row (the landing's notice is not on
   * screen there), and from the landing it is the landing's notice: either way it is where the person who pressed `Enter` is looking. The
   * row is one line that a narrow terminal clips, so every sentence puts the reason and the remedy first and the run id last: a clip then
   * takes the tail of an id, never the remedy.
   */
  const notParked = (
    runId: string,
    text: string,
    back: GateCardScreen['back'],
    from: ScreenOrigin = 'landing',
  ): void => {
    const screen = state.screen;
    if (back === 'run-view' && screen?.kind === 'run-view' && screen.runId === runId) {
      set({ screen: { ...screen, notices: noticesWith(text), note: text }, ...parkedPatch() });
      return;
    }
    // Asked for from the Active tab: the tab's own message row is where the person who pressed `Enter` is looking.
    if (from === 'tab-host' && screen?.kind === 'tab-host' && screen.host.active !== undefined) {
      const host = withActiveNote(screen.host, text);
      tabMemory = tabHostMemory(host);
      set({ screen: { kind: 'tab-host', host }, ...parkedPatch() });
      return;
    }
    set({ notice: text, ...parkedPatch() });
  };
  const openGateCard = (
    runId: string,
    back: GateCardScreen['back'],
    from: ScreenOrigin = 'landing',
  ): boolean => {
    const port = deps.gateCards;
    if (port === undefined || !slotAdmits()) return false;
    let run: RunGates | undefined;
    try {
      run = port.read(runId);
    } catch {
      notParked(
        runId,
        `The Active tab of /workflows, then [h], shows what the run waits for. Could not read run ${sanitizeInline(runId)}.`,
        back,
        from,
      );
      return false;
    }
    if (run === undefined) {
      notParked(
        runId,
        `Not parked in this directory any more: run ${sanitizeInline(runId)}.`,
        back,
        from,
      );
      return false;
    }
    const gates = cardGatesOf(run);
    if (gates.length === 0) {
      // A run parked on media jobs alone has nothing to decide, and something to continue: it is asked about, never opened as a card.
      if (isMediaOnlyPark(run)) askToContinueMedia(run.runId, back, from);
      else
        notParked(
          runId,
          `No gate to decide here: see what it waits for in /workflows, then [h] (run ${sanitizeInline(runId)}).`,
          back,
          from,
        );
      return false;
    }
    const card = createRunCard({
      runId: run.runId,
      // The title names the workflow by the slug the Home's row showed (the gate read knows only its record's id), scrubbed as that row draws it.
      workflow: workflowOfRow(state.parkedRuns, run.runId),
      gates,
      resume: answerGate,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(port.guard === undefined ? {} : { guard: port.guard }),
      history: chordHistory,
      painted: (snapshot) => gateCardVisible?.(snapshot) === true,
    });
    // The Attention rows are read again as the card opens: what put the person here may be a moment old.
    // The wait clock's origin (display only, ADR-0147 §2): when the run parked, else now.
    const parked = run.parkedSince === undefined ? Number.NaN : Date.parse(run.parkedSince);
    const waitingSinceMs = Number.isFinite(parked) ? parked : Date.now();
    putScreen(
      { kind: 'gate-card', runId: run.runId, card, back, from, waitingSinceMs },
      parkedPatch(),
    );
    return true;
  };
  /** `Esc` and `Ctrl+C` on a card: it closes and decides nothing; the run view it came from, if any, is back in front. */
  const closeGateCard = (screen: GateCardScreen): void => {
    screen.card.dispose();
    disarmInterrupt();
    if (screen.back === 'run-view') {
      set({
        screen: runViewScreen(screen.runId, deps.runStore?.(screen.runId), screen.from),
        ...parkedPatch(),
      });
      return;
    }
    if (screen.from === 'tab-host') {
      reopenTabHost();
      return;
    }
    set({ screen: undefined, ...parkedPatch() });
  };
  /** Whether the run view of `runId` shows a run that ended parked, and a card can open for it. */
  const viewOffersGate = (runId: string): boolean => {
    if (deps.gateCards === undefined) return false;
    const snapshot = deps.hostedRuns?.snapshot() ?? state.hostedRun;
    return (
      runScreenPhase(runId, snapshot) === 'settled' &&
      snapshot?.last?.terminal.disposition === 'paused'
    );
  };
  /** A key at a screen. `Esc` closes a run view and a card, and decides nothing; a card takes only its chords and `↑`/`↓`. */
  const routeScreenKey = (screen: HomeScreen, input: string, key: HomeKeyEvent): void => {
    switch (screen.kind) {
      case 'run-view':
        if (pressRunViewKey(key) === 'leave') leaveRunView(screen);
        else if (key.return === true && viewOffersGate(screen.runId))
          openGateCard(screen.runId, 'run-view', screen.from);
        return;
      case 'gate-card':
        if (key.escape === true) closeGateCard(screen);
        else screen.card.input(input, key);
        return;
      case 'tab-host':
        routeTabHostKey(screen, input, key);
        return;
    }
  };
  /** The Runs screen closes: the screen with it, and the Home is as it was (with `note`, when it closed because of a fault, so that it can be read). */
  const leaveTabHost = (note?: string): void => {
    closeScreen();
    if (note !== undefined) set({ notice: note });
  };
  /**
   * The plain character that opens a native flow, left on the Home's shared key history for the flow to read when it begins (round 2, security
   * F2: `r` held down on a run's detail sends the launch form's first text field its auto-repeats; the channel drops them, `held-opener.ts`).
   * A chord, a named key and a chunk of text are no key a person holds into a field, so they leave nothing.
   */
  const noteOpeningKey = (input: string, key: HomeKeyEvent): void => {
    if (key.ctrl === true || key.meta === true || Array.from(input).length !== 1) return;
    chordHistory.openedBy = { input, at: (deps.now ?? ((): number => performance.now()))() };
  };
  /**
   * The key that opened a launch is the flow's to take when it begins ({@link noteOpeningKey}). Whatever settles WITHOUT beginning one (no port, an
   * open the Home refused, a launch refused before anything was asked) must not leave it on the shared history: the next flow would take a fast `rr`
   * typed at its start for that key held down (round 2 sitting #2, F5). The one function both launches (`r` on a run's detail, `[r]` in `/workflows`) call.
   */
  const forgetOpeningKey = (): void => {
    chordHistory.openedBy = undefined;
  };
  /** A key at the tab host: its pure model decides, the controller carries a close out and keeps what the tabs remember. */
  const routeTabHostKey = (screen: TabHostScreen, input: string, key: HomeKeyEvent): void => {
    const step = foldTabHostKey(screen.host, input, key, tabEntry());
    if (step.kind === 'close') {
      leaveTabHost(step.note);
      return;
    }
    tabMemory = tabHostMemory(step.state);
    if (step.state !== screen.host) set({ screen: { kind: 'tab-host', host: step.state } });
    // `r` on a History detail: the tab is left as the key left it, and the native flow takes the keyboard for the form and its confirmation.
    if (step.kind === 'run') {
      noteOpeningKey(input, key);
      openDefinedRun(step.slug, step.path);
    }
    // A request of the Active tab: the tab is left as the key left it (and remembered, so `Esc` comes back to the same run).
    else if (step.kind === 'open-view') openActiveView(step.runId);
    else if (step.kind === 'open-gate') openGateCard(step.runId, 'landing', 'tab-host');
    // A request of the History tab: its detail waits on the load (the tab says so), which lands only if the person is still waiting for it.
    else if (step.kind === 'open-detail') openHistoryDetail(step.runId);
  };

  // `Ctrl+Y` here cancels a run, and a cancelled run cannot be resumed: it counts only for the exact frame of the card on screen, and not
  // while a card the person just answered still holds the lockout (a key held down through that answer repeats onto this one). Dwell,
  // quiet gap and typeahead are the answer cards' layers for text that may be typed; this card is opened by a key and read before it is
  // answered, so the two that tell a held or unseen key from a deliberate one are the whole guard.
  const exitGuardChord = createChordGuard({
    now: deps.now ?? ((): number => performance.now()),
    guard: {
      ...resolveApprovalGuard(deps.gateCards?.guard),
      settleMs: 0,
      quietMs: 0,
      typeaheadMs: 0,
    },
    history: chordHistory,
  });
  // The exit guard's lockout as its legend draws it (`(wait)`): the same origin the answer is held to, the later of the last answer and the
  // card's appearance; nothing once the card no longer asks. Its timer is its own (`lockSchedule`), never the Home's `schedule`.
  const exitGuardLock = createLockDisplay({
    now: deps.now ?? ((): number => performance.now()),
    schedule:
      deps.lockSchedule ??
      ((callback: () => void, delayMs: number): (() => void) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      }),
    until: () =>
      state.exitGuard === 'confirm'
        ? Math.max(
            exitGuardChord.lockedUntil(),
            exitGuardChord.lockedUntil({ lastResolvedAt: exitGuardOpenedAt }),
          )
        : Number.NEGATIVE_INFINITY,
  });
  /**
   * The keys the landing takes (its composer, and the lists and sheets that open over it), stamped on the Home's one key history as KEYS,
   * never as resolutions, as a chat's store stamps every key of a chat. A popup that opens on its confirmation line (`/doctor --deep` typed
   * here) is armed against the last key before it (ADR-0148 §3, `popup-host.ts`): unstamped, the landing's keys left that line no lockout to
   * meet, so a `Ctrl+Y` held through the popup's code load could answer it. The cards that read the same history (a gate card, the MCP consent
   * card) see the landing's keys in their quiet gap too, as a chat's cards see a chat's.
   */
  const landingKeys = createChordGuard({
    now: deps.now ?? ((): number => performance.now()),
    history: chordHistory,
  });
  const routeExitGuardKey = (phase: ExitGuardPhase, input: string, key: HomeKeyEvent): void => {
    disarmInterrupt(); // any key at the card ends the armed interrupt state (ADR-0115 §1)
    const stamp = exitGuardChord.stamp();
    if (phase === 'stopping') return; // the wait is bounded and cannot be taken back: no key changes it
    const answer = pressExitGuardKey(input, key);
    if (answer === 'confirm') {
      // The lockout runs from the last answer or the card's appearance, whichever came later.
      const fromOpening = {
        ...stamp,
        lastResolvedAt: Math.max(stamp.lastResolvedAt, exitGuardOpenedAt),
      };
      if (
        exitGuardChord.decide(fromOpening, 'allow', homeFrameVisible?.(state) === true) ===
        undefined
      )
        return; // refused: the card is still open and nothing is decided
      confirmExit();
    } else if (answer === 'stay') set({ exitGuard: undefined });
    exitGuardLock.sync(); // a card that no longer asks holds no key
  };

  const endChat = (ended: HomeChatSession): void => {
    if (tearingDown === ended) return; // already ending this session (the two-pending-promise race)
    tearingDown = ended;
    const td = ended.teardown();
    activeTeardown = td; // a concurrent signal awaits THIS graceful close rather than hard-killing the MCP child
    // BOUND the return-to-Home: a hung MCP graceful close must not freeze the Home (mirrors the signal path). The
    // teardown still completes in the background; only the UI return is bounded by the force-teardown deadline.
    void boundTeardown(td)
      .finally(() => {
        if (activeTeardown === td) activeTeardown = undefined;
        tearingDown = undefined;
        cancelFired = false;
        if (exiting) return; // an error/exit closed the db while we awaited teardown — do not read it
        // The draft a conversation resumed from the Home kept is the returned Home's prompt again (SE74); any other chat leaves it empty.
        const input = keptDraft ?? emptyEditor();
        keptDraft = undefined;
        set({
          session: undefined,
          input,
          notice: undefined, // a stale notice (a build failure, a refusal) must not leak into the returned Home
          pendingMessage: '',
          snapshot: deps.homeStore.read(), // the just-finished chat now shows in the refreshed strip
          ...parkedPatch(), // and a run it left parked, or one answered meanwhile, in the refreshed Attention rows
          keyless: deps.providerSetup?.readKeyless?.() ?? state.keyless,
          ...statusPatch(), // a `/models` or `/mode` default saved from the chat is what the returned Home's status line says
          mode: 'home',
          // a chat that ends returns to the landing, whichever page it was started from (MVP-11 unit 7)
          homePage: 'start',
          slide: undefined,
          stripFocus: undefined,
          palette: undefined, // a palette left open when /exit ran must not leak into the returned Home
          search: undefined, // ditto a reverse-search submode
          mention: undefined, // ditto an `@`-completion submode
          shellBusy: false, // a `!`-command in flight when the chat ended must not leave the returned Home gated
          submitBusy: false, // ditto a submit/compaction in flight — the returned Home must not be left gated
          shellCommand: undefined,
          attachments: [], // pending `@`/`!` attachments must not leak into the next chat
        });
      })
      .catch(failHome); // Escaping snapshot/continuation faults belong to the actual Home lifetime.
  };

  // `/clear` (ADR-0062 §7) — swap the current in-Home chat for a FRESH session, STAYING in chat (the defining
  // difference from endChat, which returns to the bare Home). BUILD-FIRST: the old session stays live + rendered
  // while the fresh one builds, so a build failure leaves the user in a working, resumable conversation rather than
  // a dead screen. Input is re-gated (submitBusy) for the whole swap so a message typed mid-swap can't land on the
  // about-to-be-cleared session. On success the old session is torn down (bounded, mirroring endChat) and the fresh
  // one is swapped in, its transcript opening with the clearedNotice saying the prior (resumable) conversation is saved.
  const clearChat = (old: HomeChatSession): void => {
    if (exiting || tearingDown === old) return; // permanent stop or a double-/clear race
    if (old.clear === undefined) {
      old.resumeAfterFailedClear?.();
      old.store.notice('Starting a fresh conversation is unavailable for this bound agent.');
      return;
    }
    set({ submitBusy: true }); // re-gate input for the whole swap (the old chat is still live underneath)
    const build = old.clear();
    buildInFlight = build;
    void build.then(
      (fresh) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) {
          void fresh.teardown().catch(() => undefined); // exited mid-build ⇒ reap the just-built fresh session
          return;
        }
        // Guard a SUPERSEDING /clear: a mid-build second Ctrl+C → /cancel re-routes to a SECOND clearChat(old) (the old
        // handler's stopReason is sticky-'clear'), starting a second build. If an earlier build already swapped a
        // fresh session in (state.session !== old), reap THIS now-superseded build instead of swapping it in and
        // leaking the earlier fresh session's MCP child. Mirrors the failure arm's `state.session === old` guard.
        if (state.session !== old) {
          void fresh.teardown().catch(() => undefined);
          return;
        }
        // Tear the OLD session down (bounded, like endChat) — its terminal marks the row 'ended' (still resumable).
        tearingDown = old;
        const td = old.teardown();
        activeTeardown = td;
        void boundTeardown(td)
          .finally(() => {
            if (activeTeardown === td) activeTeardown = undefined;
            tearingDown = undefined;
          })
          .catch(() => undefined);
        cancelFired = false; // the fresh session starts with a clean cancel latch (parity with endChat)
        fresh.store.notice(clearedNotice()); // say in the fresh transcript that the prior (resumable) conversation is saved
        set({
          session: fresh,
          mode: 'chat', // STAY in chat (no bare-Home flash) — the defining difference from endChat
          input: emptyEditor(),
          notice: undefined,
          pendingMessage: '',
          palette: undefined,
          search: undefined,
          mention: undefined,
          shellBusy: false,
          submitBusy: true, // keep input gated until disclosure rendering is acknowledged
          shellCommand: undefined,
          attachments: [], // pending `@`/`!` attachments must not leak into the fresh conversation
        });
        activateSession(fresh, () => set({ submitBusy: false }));
      },
      () => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) return;
        // The fresh build FAILED — keep the OLD session live + resumable (do NOT tear it down); surface a static,
        // secret-free note in the old chat and un-gate it so the user can keep going or /exit.
        if (state.session === old) {
          old.resumeAfterFailedClear?.();
          old.store.note('/clear could not start a fresh session — keeping this conversation.');
          set({ submitBusy: false });
        }
      },
    );
  };

  // Reseat the in-Home chat onto a NEW model (ADR-0059) — the counterpart of the standalone `/models` reseat, built
  // like clearChat (BUILD-FIRST: the old session stays live + rendered while the reseated one builds, so a build
  // failure leaves the user in a working, resumable conversation rather than a dead screen). On success the old
  // session is torn down (bounded) and the reseated session — the SAME sessionId, resumed under the switched model
  // with the carried transcript + cost/turns — is swapped in, its transcript opening with the modelSwitchNotice.
  const reseatChat = (old: HomeChatSession, target: ReseatTarget): void => {
    if (exiting) return;
    const reseat = deps.reseatChat;
    if (reseat === undefined) return; // the chat's `/models` member is built only when a builder IS wired (defensive)
    if (tearingDown === old) return; // already ending this session (mirror clearChat)
    const oldId = old.sessionId;
    set({ submitBusy: true }); // re-gate input for the whole swap
    // Captured HERE, before the build resolves and the old session is torn down (the teardown below only closes the
    // persister/MCP — it never clears the view store — but capturing at the call makes the ordering explicit rather
    // than incidental). This is the conversation the reseated store will open with (2.6.C / F1).
    const carriedTranscript = old.store.getSnapshot().state.transcript;
    const build = reseat(oldId, target, carriedTranscript);
    buildInFlight = build;
    void build.then(
      (next) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) {
          void next.teardown().catch(() => undefined); // exited mid-build ⇒ reap the just-built reseated session
          return;
        }
        // A superseding swap already replaced `old` (a mid-build /clear or another reseat) ⇒ reap this superseded
        // build rather than swapping it in and leaking its MCP child (mirrors clearChat's guard).
        if (state.session !== old) {
          void next.teardown().catch(() => undefined);
          return;
        }
        // Tear the OLD session down (bounded, like clearChat) — its terminal marks the row 'ended'; the reseated
        // session continues the SAME sessionId (its persister adopted the row at build time).
        tearingDown = old;
        const td = old.teardown();
        activeTeardown = td;
        void boundTeardown(td)
          .finally(() => {
            if (activeTeardown === td) activeTeardown = undefined;
            tearingDown = undefined;
          })
          .catch(() => undefined);
        cancelFired = false; // the reseated session starts with a clean cancel latch (parity with clearChat)
        next.store.notice(
          withGlyphForm(deps.plainGlyphs === true, () =>
            modelSwitchNotice(old.store.getSnapshot().state.model ?? '(unknown)', target.modelId),
          ),
          'modelSwitch', // the sentence leads with the host's own `⇄`
        );
        set({
          session: next,
          mode: 'chat', // STAY in chat — the model switched underneath, the conversation continues
          input: emptyEditor(),
          notice: undefined,
          pendingMessage: '',
          palette: undefined,
          search: undefined,
          mention: undefined,
          shellBusy: false,
          submitBusy: true, // keep input gated until disclosure rendering is acknowledged
          shellCommand: undefined,
          attachments: [], // pending `@`/`!` attachments must not leak into the reseated conversation
        });
        activateSession(next, () => set({ submitBusy: false }));
      },
      () => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) return;
        // The reseat build FAILED — keep the OLD session live + resumable (do NOT tear it down); say so in a fully STATIC, secret-free
        // sentence (no model id interpolated) on the Home's channel, never the transcript (ADR-0148 §6), and un-gate it so the user can keep
        // going or /exit.
        if (state.session === old) {
          (deps.announce ?? old.settings?.announce)?.(MODEL_SWITCH_FAILED);
          set({ submitBusy: false });
        }
      },
    );
  };

  // Drive one chat turn; on success end the chat if `/exit`/`/cancel` ran, on an escaping error tear the session
  // down BEFORE propagating so its MCP child / frame loop / row are never orphaned.
  const sendChatLine = (active: HomeChatSession, line: string, display?: string): void => {
    // Gate input for the WHOLE submit — streaming AND any after-turn auto-compaction (ADR-0062), which runs
    // inside processLine AFTER session:turn_completed flipped the view idle. Without this a message typed then
    // would reach sendMessage → SessionStateError → crash (the same hazard `shellBusy` fixes for `!`-shell).
    if (!isCurrentChat(active)) return;
    set({ submitBusy: true });
    void active.processLine(line, display).then(
      () => {
        if (!exiting && state.session === active) set({ submitBusy: false });
        if (!isCurrentChat(active)) return;
        if (active.shouldStop()) {
          // `/clear` (ADR-0062 §7) swaps in a FRESH session, staying in chat; `/exit`/`/cancel` end to the bare Home.
          if (active.stopReason() === 'clear') clearChat(active);
          else endChat(active);
        }
      },
      (err: unknown) => {
        if (!exiting && state.session === active) set({ submitBusy: false });
        tearingDown = active; // align with endChat's single-shot guard (the session closure is idempotent)
        const td = active.teardown();
        activeTeardown = td; // a concurrent signal awaits this teardown too
        void td
          .finally(() => {
            if (activeTeardown === td) activeTeardown = undefined;
            tearingDown = undefined; // clear for symmetry with endChat (failHome is terminal, but stay consistent)
            failHome(err);
          })
          .catch(() => undefined); // a rejecting teardown must not surface as an unhandled rejection
      },
    );
  };

  const driveNativeAction = async (
    operation: () => Promise<void>,
    label: string,
  ): Promise<void> => {
    let work: Promise<void> | undefined;
    try {
      // Admission stays synchronous; teardown joins the actual operation, not this UI driver.
      work = deps.workOwner === undefined ? operation() : deps.workOwner.enter(operation);
      nativeInFlight = work;
      await work;
    } catch (err) {
      if (work !== undefined && nativeInFlight === work) nativeInFlight = undefined;
      deps.workOwner?.failure(err);
      if (!exiting) {
        set({
          nativeActionBusy: false,
          notice: `${label} could not be ${work === undefined ? 'opened' : 'completed'}.`,
        });
        refreshHostedRun(); // an action that failed late may still have started a leg
      }
      return;
    }
    if (nativeInFlight === work) nativeInFlight = undefined;
    if (!exiting) {
      set({ nativeActionBusy: false });
      refreshHostedRun(); // the action may have started a leg: the strip shows it from here
    }
  };

  /**
   * Start a native action: the keyboard is the flow's from here on. `patch` is published in the SAME state change as the busy mark, for a
   * caller whose own change must not be seen on its own (the Sessions tab's resume: the screen leaves as the resume begins).
   *
   * Refused when a popup could not open now ({@link homeNativeActionRefusal}): one notification on the Home's channel says so, in the words a
   * refused popup uses, and nothing is written to the Home's notice or to a transcript. Of the caller's change only a cleared editor is kept
   * (a draft that looks like a provider key is never left in the prompt); the rest belongs to an action that did not start.
   *
   * `after` runs once the action is over and the keyboard is the Home's again (the busy mark cleared), however it ended and only while the Home is
   * not leaving: the `/workflows` popup brings itself back on a workflow once the flow it handed that workflow to is over (MVP-11 unit 8). A popup
   * cannot open before then: the host's gate refuses one while a native action holds the keyboard.
   */
  const openNativeAction = (
    operation: () => Promise<void>,
    label: string,
    patch: Partial<HomeControllerState> = {},
    after?: () => void,
  ): void => {
    if (exiting || state.nativeActionBusy) return;
    const refusal = homeNativeActionRefusal(state, patch, deps.popupOpen?.() === true);
    if (refusal !== undefined) {
      if (patch.input !== undefined) set({ input: patch.input });
      deps.announce?.(refusedOpenText(label, refusal));
      return;
    }
    set({ nativeActionBusy: true, palette: undefined, ...patch });
    void driveNativeAction(operation, label)
      .then(() => {
        if (!exiting) after?.();
      })
      .catch(failHome);
  };

  /**
   * Open `/providers` (the setup popup, ADR-0146 §6) through the Home's opening gate. What it says is never written to the Home's notice or a
   * transcript (ADR-0148 §6): a setup this session cannot open, and the reason a key-shaped draft was not kept, are each ONE notification.
   */
  const openProviderSetup = (options?: {
    readonly patch: Partial<HomeControllerState>;
    readonly announce?: string;
  }): void => {
    const port = deps.providerSetup;
    if (port === undefined) {
      // Whatever the caller had to change in the same breath (a draft that is a key is cleared) is still changed: nothing is kept for a
      // setup that will not open. Its own reason, which says where to paste the key, would be false here, so the notification is this one.
      if (options !== undefined) set(options.patch);
      deps.announce?.('Provider setup is unavailable in this session.');
      return;
    }
    const opening = !state.nativeActionBusy;
    openNativeAction(() => port.open(), 'Provider setup', options?.patch);
    // The reason a key-shaped draft was cleared is said only when the setup opened: a refused open says its refusal, and only that.
    if (options?.announce !== undefined && opening && state.nativeActionBusy)
      deps.announce?.(options.announce);
  };
  /**
   * What a Home flow that writes (`/init`, `/import`, `/pricing`, the `/workflows` popup's export) resolved with: the ONE notification it asks for (a
   * cancel, nothing written), on the Home's channel, or nothing when its popup said what happened (its Done step, a refusal). Never the Home's
   * notice and never a transcript (ADR-0148 §6): the flows leave no residue.
   */
  const announceFlowResult = (notification: string | undefined): void => {
    if (!exiting && notification !== undefined) deps.announce?.(notification);
  };
  // The key that opens a Home flow (the composer's `Enter` of `/init`, `/import` or `/pricing`, `[x]` or `[r]` in the `/workflows` popup) is NOT stamped as an
  // answer: a chord card's lockout runs from the moment the card opened (`createChordCardGuard`, `native-prompt-guards.ts`), so a flow whose
  // first prompt is its `Ctrl+Y` card (`/init`, the `/workflows` export, `/run` on a workflow with no inputs) is armed against a held key by the card
  // itself, and so is a card that appears after a wait (the MCP consent card a start raises).
  const openProjectInit = (): void => {
    const open = deps.initializeProject;
    if (open === undefined) {
      set({ notice: 'Project initialization is unavailable in this session.' });
      state.session?.store.note('Project initialization is unavailable in this session.');
      return;
    }
    openNativeAction(async () => {
      // The popup's Done step said what was created; a cancel or a folder that is already a project is one notification (ADR-0148 §6).
      announceFlowResult(await open());
    }, 'Project initialization');
  };

  /**
   * Whether the launch that has just returned STARTED a run, told by the leg it left behind; `before` is the host's snapshot taken before the
   * launch began. The run this Home hosts is another one than it was before, and the host was not already starting one then: a leg that is
   * still acquiring its run (a resume) has no run id yet, so the id it gets while this launch is refused would read as a run THIS launch
   * started. A refusal (another leg already executes or starts) or a cancel leaves that other leg as it was, and its view is not what the
   * launch asked for. `/run` and `[r]` in the `/workflows` popup both ask here, so the two cannot drift.
   */
  const launchStartedRun = (before: RunHostSnapshot | undefined): boolean => {
    const hostedAfter = deps.hostedRuns?.snapshot().active?.runId;
    return (
      before?.launching !== true &&
      hostedAfter !== undefined &&
      hostedAfter !== before?.active?.runId
    );
  };

  /**
   * `/run`: the launch flow, the `/run` popup (ADR-0148 §1; MVP-11 unit 6). A run that started is shown at once (`Esc` leaves it running and
   * `Enter` on the empty prompt comes back); a launch that was refused or left opens no view: the view of ANOTHER run that executes at the time
   * is not what `/run` asked for ({@link launchStartedRun}). What the launch says is one notification on the Home's channel, never the Home's
   * notice (§6): a run that started, a cancel, a refusal found before the popup opened; a start that failed after it opened was said in the
   * popup itself, and the launch then has nothing more to say (`''`: no notification).
   */
  const openRunLaunch = (): void => {
    const launch = deps.launchRun;
    if (launch === undefined) {
      deps.announce?.('Running a workflow is unavailable in this session.');
      return;
    }
    openNativeAction(async () => {
      const before = deps.hostedRuns?.snapshot();
      const said = await launch();
      if (exiting) return;
      set({ ...parkedPatch() }); // a launch that was refused at a gate, or a run it just parked, changes the rows
      if (launchStartedRun(before)) openRunView();
      if (said !== '') deps.announce?.(said);
    }, 'Run workflow');
  };

  /**
   * `Enter` on a run parked on media jobs alone, from a strip row, the Active tab or the run view of a leg that ended parked
   * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, the 2026-11-23 amendment note): the native
   * question whether to continue it here. It is a question, never an action: a No or `Esc` leaves the run parked and says nothing, and only
   * a Yes asks the host for the media resume. The sentence the question resolves with (a leg that started, or the host's own refusal, such
   * as another leg already executing) is shown where the person who pressed `Enter` is looking ({@link notParked}), and a leg that started
   * is shown at once, as `/run` shows one ({@link launchStartedRun}); `Esc` then returns to where the key was pressed.
   *
   * A run this Home executes right now is never offered: its leg has parked but not finished stopping, so there is nothing to continue and
   * its view is the answer. With no port wired the run says so instead of a dead end.
   */
  const askToContinueMedia = (
    runId: string,
    back: GateCardScreen['back'],
    from: ScreenOrigin,
  ): void => {
    const ask = deps.continueMedia;
    if (ask === undefined) {
      notParked(
        runId,
        `Continuing a run is unavailable in this session: see what it waits for in /workflows, then [h] (run ${sanitizeInline(runId)}).`,
        back,
        from,
      );
      return;
    }
    if (deps.hostedRuns?.snapshot().active?.runId === runId) {
      if (back === 'run-view' || !openRunView(from))
        notParked(runId, `This Home is still running run ${sanitizeInline(runId)}.`, back, from);
      return;
    }
    openNativeAction(async () => {
      const before = deps.hostedRuns?.snapshot();
      const notice = await ask(runId);
      if (exiting) return;
      if (notice !== undefined) notParked(runId, notice, back, from);
      if (launchStartedRun(before)) openRunView(from);
    }, 'Continue run');
  };

  /**
   * A sentence for the person who asked for a run from a run's detail (`r`): the History tab's message row, which the next key drops. With another
   * screen in front (or none) it is the landing's notice, which is where such a person would look.
   */
  const noteOnRunTab = (text: string): void => {
    const screen = state.screen;
    if (screen?.kind !== 'tab-host' || screen.host.history === undefined) {
      set({ notice: text });
      return;
    }
    const host = withHistoryNote(screen.host, text);
    tabMemory = tabHostMemory(host);
    set({ screen: { kind: 'tab-host', host } });
  };

  /**
   * `r` on a History run's detail (the same request: the catalog's slug and path of the run's workflow): the launch
   * flow, started at that workflow (its picker is skipped once; the form, the `Ctrl+Y` confirmation and the single start are the flow's own, and
   * the form asks the inputs again: a run's own are never read). A run that started is shown at once, `Esc` returns to the tab, and the start is
   * one notification; a launch that was refused or left says so on the tab's own message row (the detail's), never in
   * the Home's notice (ADR-0148 §6), and one whose failure the popup has already said (`''`) adds nothing. A run STARTED is told by
   * {@link launchStartedRun}, as `/run` tells it: a refusal leaves another leg as it was, and its view is not what `r` asked for, so the
   * refusal is shown on the tab instead.
   */
  const openDefinedRun = (slug: string, path: string): void => {
    const launch = deps.launchRun;
    if (launch === undefined) {
      forgetOpeningKey();
      noteOnRunTab('Running a workflow is unavailable in this session.');
      return;
    }
    const opening = !state.nativeActionBusy;
    openNativeAction(async () => {
      const before = deps.hostedRuns?.snapshot();
      // `Esc` at the first thing asked leaves to the tab the key came from, not to a picker the person never saw (the same rule as `[r]` in `/workflows`).
      const said = await launch(slug, path, { leaveOnBack: true }).finally(forgetOpeningKey);
      if (exiting) return;
      set({ ...parkedPatch() });
      if (launchStartedRun(before) && openRunView('tab-host')) deps.announce?.(said);
      else if (said !== '') noteOnRunTab(said);
    }, 'Run workflow');
    if (!opening || !state.nativeActionBusy) forgetOpeningKey();
  };

  // ---- The management popups: `/help`, `/agents`, `/workflows` (ADR-0148 §10 as amended 2026-11-27; MVP-11 unit 8, OD-24) -------------------------
  // The popups' code is `popups/home-session.ts`, loaded by the host the first time one opens. The controller routes the word, builds the port the
  // popup reads and asks through, and carries out what the popup asks for AFTER the popup has closed itself: a chat, a run, an export, the Runs
  // screen. A popup never opens another surface; it hands the host the request, and the request is the one the old tab did make.

  /** The Home's popup port: what the three popups read from this controller's dependencies, and the requests they make of it. Built when asked. */
  const homePopupsPort = (): HomePopupsPort => ({
    ...(deps.workOwner === undefined ? {} : { workOwner: deps.workOwner }),
    ...(deps.plainGlyphs === undefined ? {} : { plainGlyphs: deps.plainGlyphs }),
    help: { keys: Object.values(HOME_KEYS).map((key) => ({ keys: key.keys, verb: key.short })) },
    ...(deps.agents === undefined
      ? {}
      : { agents: { read: deps.agents.read, chat: (request) => startAgentChat(request) } }),
    ...(deps.defined === undefined
      ? {}
      : {
          workflows: {
            read: deps.defined.read,
            describe: deps.workflowReads?.describe,
            lastRuns: deps.workflowReads?.lastRuns,
            pins: deps.pins,
            now: deps.epochNow ?? ((): number => Date.now()),
            run: (slug, path, from, row) => openWorkflowRun(slug, path, from, row),
            export: (slug, from, row) => openWorkflowExport(slug, from, row),
            openRuns: (runId, status) => openRunsScreen(runId, status),
          },
        }),
  });

  /** Open the popup `kind` over the Home through the host's one adapter; a Home that wired none says so, in the notice a word with no port uses. */
  const openManagePopup = (kind: HomePopupKind, at?: WorkflowsAt): void => {
    const open = deps.openHomePopup;
    if (open === undefined) {
      set({ notice: `/${kind} is not available here.` });
      return;
    }
    open({ kind, port: homePopupsPort(), at });
  };

  /**
   * `/workflows` brought back where the flow was started (the catalogue's row of `slug`, or its detail), once the flow it handed that workflow to is over.
   * What the flow said (`said`) is handed to the reopened popup as ITS OWN first word, not announced on the Home's channel: the popup's next word
   * (`Pinned x.`) then replaces it at once, where a Home word would be read for three seconds before it (review round 3, S3-1 and O3-1).
   */
  const reopenWorkflows = (
    slug: string,
    step: WorkflowsStep,
    said?: string,
    row?: string,
  ): void => {
    if (!exiting)
      openManagePopup('workflows', {
        slug,
        step,
        ...(said === undefined ? {} : { said }),
        // The line of an overflowing detail the key was pressed on comes back with it (review round 3, O3-4).
        ...(row === undefined || step !== 'detail' ? {} : { row }),
      });
  };

  /**
   * `[r]` in the `/workflows` popup (the popup is already closed): the `/run` popup started at that workflow, saying it came from `/workflows`
   * (its picker is skipped once; the form, the `Ctrl+Y` confirmation and the single start are the flow's own). A run that STARTED closes everything, as
   * it does for a plain `/run`: its notification, and its view when it is still executing; it is told by the launch's own fact (`onStarted`), so a run that parks or
   * finishes before the host is looked at is no different. A flow that ends without one (`Esc` at its first step, a No, a refusal) brings the popup
   * back on the step `from` names, the catalogue's row or the detail the key was pressed on; only `Ctrl+C` closes the whole stack. What the launch
   * says is one notification, as it is anywhere. The `r` that opened it is the flow's to take: a held key's repeats are dropped there
   * (`noteOpeningKey`).
   */
  const openWorkflowRun = (slug: string, path: string, from: WorkflowsStep, row?: string): void => {
    const launch = deps.launchRun;
    if (launch === undefined) {
      reopenWorkflows(slug, from, 'Running a workflow is unavailable in this session.', row);
      return;
    }
    noteOpeningKey('r', {});
    let closedAll = false;
    let started = false;
    let said = '';
    const opening = !state.nativeActionBusy;
    openNativeAction(
      async () => {
        const before = deps.hostedRuns?.snapshot();
        said = await launch(slug, path, {
          opener: { origin: 'workflows' },
          onLeave: () => {
            closedAll = true;
          },
          // The launch's own fact, not its words: a refusal's sentence may begin with anything.
          onStarted: () => {
            started = true;
          },
        }).finally(forgetOpeningKey);
        if (exiting) return;
        set({ ...parkedPatch() });
        // A run that started closes everything, and is shown while it executes; one that parked or finished already says so in its notification.
        if (started || launchStartedRun(before)) {
          closedAll = true;
          if (launchStartedRun(before)) openRunView();
        }
        // What the launch says is the Home's word when the popup does not come back (a run started, or `Ctrl+C`), and the reopened popup's own first
        // word when it does (a refusal, a No, an `Esc`).
        if (closedAll && said !== '') deps.announce?.(said);
      },
      'Run workflow',
      {},
      () => {
        if (!closedAll) reopenWorkflows(slug, from, said === '' ? undefined : said, row);
      },
    );
    if (!opening || !state.nativeActionBusy) forgetOpeningKey();
  };

  /** `[x]` in the `/workflows` popup (already closed): the export confirmation, from `/workflows`; the popup comes back on the workflow when it ends. */
  const openWorkflowExport = (slug: string, from: WorkflowsStep, row?: string): void => {
    const exportDefined = deps.exportDefined;
    if (exportDefined === undefined) {
      reopenWorkflows(slug, from, 'Export is unavailable in this session.', row);
      return;
    }
    let said: string | undefined;
    openNativeAction(
      async () => {
        said = await exportDefined(slug, 'workflows');
      },
      'Export',
      {},
      () => {
        reopenWorkflows(slug, from, said, row);
      },
    );
  };

  /**
   * `[h]` and `Enter` on a last run in the `/workflows` popup (already closed): the Runs screen. With a run named it opens where the run lives (review
   * round 3, O3-9): a run that is still going or waiting is a row of the Active tab (the cursor on it, and `Enter` there answers its gate or
   * shows it), a finished one is on the History tab, on its detail.
   */
  const openRunsScreen = (runId?: string, status?: RunStatus): void => {
    const opened =
      runId === undefined
        ? openTabHost('history')
        : status !== undefined && LIVE_RUN_STATUSES.has(status)
          ? openActiveTabOn(runId)
          : openRunDetail(runId);
    if (!opened && !exiting) deps.announce?.('The Runs screen could not be opened now.');
  };

  /**
   * `/import` at the landing: the import popup. Typed and chosen from the palette it is this one function, so the two cannot drift. What the
   * popup writes, it writes only on a Yes; its Done step says what happened, and a No is one notification (ADR-0148 §6).
   */
  const openImportCard = (): void => {
    const importDefined = deps.importDefined;
    if (importDefined === undefined) {
      set({ notice: 'Import is unavailable in this session.' });
      return;
    }
    openNativeAction(async () => {
      announceFlowResult(await importDefined());
    }, 'Import');
  };

  /** `/pricing` at the landing: the model pricing popup, opened as {@link openImportCard} is. */
  const openPricingCard = (): void => {
    const pricing = deps.pricing;
    if (pricing === undefined) {
      set({ notice: 'Model pricing is not available here.' });
      return;
    }
    openNativeAction(async () => {
      announceFlowResult(await pricing());
    }, 'Model pricing');
  };

  /** A sentence for the person who is looking at the Active tab: its message row, which the next key drops. */
  const noteOnActiveTab = (text: string): void => {
    const screen = state.screen;
    if (screen?.kind !== 'tab-host' || screen.host.active === undefined) {
      set({ notice: text });
      return;
    }
    const host = withActiveNote(screen.host, text);
    tabMemory = tabHostMemory(host);
    set({ screen: { kind: 'tab-host', host } });
  };

  /**
   * `Enter` on the run this Home hosts: its view, with `Esc` returning to the Active tab on the row it came from. The view is for the run
   * the row named, never for whichever leg executes now, so a leg that ended since the read shows what it left.
   */
  const openActiveView = (runId: string): void => {
    if (!openScreen('run-view', { runId, store: deps.runStore?.(runId), from: 'tab-host' }))
      noteOnActiveTab('The run view could not be opened now.');
  };

  /**
   * `Enter` on a History row: the run's detail, loaded asynchronously (the terminal outbox is a file). The result is handed to the tab only
   * if the tab host is still in front and still waiting for this run; a fault that is not about the run's rows leaves the list, with a
   * sentence, instead of ending the Home.
   */
  const openHistoryDetail = (runId: string): void => {
    const history = deps.history;
    if (history === undefined) return;
    const land = (change: (host: TabHostState) => TabHostState): void => {
      const screen = state.screen;
      if (exiting || screen?.kind !== 'tab-host') return;
      const host = change(screen.host);
      if (host === screen.host) return;
      tabMemory = tabHostMemory(host);
      set({ screen: { kind: 'tab-host', host } });
    };
    void history.loadDetail(runId).then(
      (load) => {
        try {
          land((host) => withHistoryLoad(host, runId, load, deps.defined));
        } catch (error) {
          failHome(error);
        }
      },
      () => {
        try {
          land((host) => withHistoryLoadFailure(host, runId));
        } catch (error) {
          failHome(error);
        }
      },
    );
  };

  /**
   * `Enter` on a failed or recent run of the strip (ADR-0140 §6): the tab host opens on the History tab at that run's detail, loaded as
   * a detail opened from a History row is, and `Esc` steps back to the list and then to the landing. The strip lists THIS directory's runs
   * only (the Home reads no other), so the run opened is one this directory recorded. Nothing is resumed or cancelled from the detail and `p`
   * only marks a finished run; `r` starts a NEW run, and only through the run form (its inputs asked again, its confirmation card the
   * consent: ADR-0113), never straight from here. A Home with no history to read says so.
   */
  const openRunDetail = (runId: string): boolean => {
    if (deps.history === undefined) {
      set({ notice: RUN_HISTORY_UNAVAILABLE });
      return false;
    }
    if (!slotAdmits() || state.submitBusy || state.nativeActionBusy) return false;
    const host = enterHistoryAtDetail(freshTabMemory('history'), tabEntry(), runId);
    tabMemory = tabHostMemory(host);
    putScreen({ kind: 'tab-host', host });
    openHistoryDetail(runId);
    return true;
  };

  /**
   * Resume a saved conversation: the one in `selectedId`, or the one the picker returns, as the `/resume` popup (ADR-0148 §1; MVP-11 unit 6).
   * The stages ({@link resumeStages}: the picker, the check that the session is not the one open, the restore) run inside the ONE frame the
   * host holds open ({@link HomeControllerDeps.resumeFrame}), so nothing closes between the picker and the restore; what they come to is acted
   * on only once that frame has closed ({@link resumeStagesFramed}). What it has to say (the conversation is already open, a cancelled restore,
   * a session that cannot be resumed here, a Home that cannot resume) is one notification on the Home's channel, never the Home's notice and
   * never a line in the conversation (§6); a resume that opens its conversation says nothing, the conversation is the result. `leaving` is
   * published with the action's first state change (see {@link openNativeAction}); it is used only when the action starts, so a resume that is
   * not available leaves it unpublished.
   */
  const openResume = (selectedId?: string, leaving?: Partial<HomeControllerState>): void => {
    const resume = deps.resumeChat;
    if (resume === undefined || (selectedId === undefined && deps.pickSession === undefined)) {
      deps.announce?.(RESUME_UNAVAILABLE);
      return;
    }
    const operation = async (): Promise<void> => {
      const old = state.session;
      const outcome = await resumeStagesFramed(old, () => resumeStages(old, resume, selectedId));
      if (outcome === undefined) return;
      if ('adopt' in outcome) await adoptResumed(old, outcome.adopt);
      else if (!exiting) deps.announce?.(outcome.say);
    };
    openNativeAction(operation, 'Session resume', leaving);
  };

  /** What the `/resume` stages came to: a restored conversation to adopt, the one notification to say, or nothing (the picker was left). */
  type ResumeOutcome = { readonly adopt: HomeChatSession } | { readonly say: string } | undefined;

  /** The `/resume` stages: the session (`selectedId`, or the picker's answer), the check that it is not the one open (`old`), its restore. */
  const resumeStages = async (
    old: HomeChatSession | undefined,
    resume: NonNullable<HomeControllerDeps['resumeChat']>,
    selectedId: string | undefined,
  ): Promise<ResumeOutcome> => {
    const id = selectedId ?? (await deps.pickSession?.());
    if (id === undefined || exiting) return undefined;
    if (old?.sessionId === id) return { say: RESUME_ALREADY_OPEN };
    const result = await resume(id);
    // The person cancelled an interactive step of the restore (the retry question, `Esc` while it restored): the Home says so instead of
    // coming back as if nothing had been asked.
    if (result === undefined) return { say: RESUME_CANCELLED };
    if ('notice' in result) return { say: result.notice };
    return { adopt: result };
  };

  /**
   * Run the `/resume` stages inside the host's frame and hand back what they came to only once the frame has CLOSED and the Home's prompt
   * channel is idle (MVP-11 unit 6, round 1). A conversation adopted while the frame was still open was activated under it: its effect
   * disclosure waits until the frame that shows it is flushed (`useVisibleRenderFlush`), the frame's close aborted that wait, and a
   * disclosure that cannot be delivered ends the CLI (`effect-retention.ts`, exit 9). A conversation the restore built is torn down, and never
   * adopted, when the frame fails to close.
   */
  const resumeStagesFramed = async (
    old: HomeChatSession | undefined,
    stages: () => Promise<ResumeOutcome>,
  ): Promise<ResumeOutcome> => {
    const frame = deps.resumeFrame;
    if (frame === undefined) return stages();
    const came: { outcome?: ResumeOutcome } = {};
    try {
      await frame(old === undefined ? 'home' : 'chat', async () => {
        came.outcome = await stages();
      });
    } catch (cause) {
      const built = came.outcome;
      if (built !== undefined && 'adopt' in built)
        await built.adopt.teardown().catch(() => undefined);
      throw cause;
    }
    return came.outcome;
  };

  /** The Home's draft as a resume from the Home keeps it for the chat's end: nothing when empty, and never a draft that looks like a key. */
  const draftToKeep = (draft: EditorState): EditorState | undefined =>
    draft.text.length === 0 || looksLikeProviderKey(draft.text) ? undefined : draft;
  /**
   * The resumed conversation takes the place of the one open (`old`, if any), unless the Home left or another took it meanwhile (both read
   * here, after the `/resume` frame closed, and again after `old`'s teardown). Called with the frame closed: its activation may wait on a
   * flushed frame, and an open popup's close would abort that wait. A conversation resumed from the Home keeps the Home's draft for its end.
   */
  const adoptResumed = async (
    old: HomeChatSession | undefined,
    result: HomeChatSession,
  ): Promise<void> => {
    if (exiting || state.session !== old) {
      await result.teardown();
      return;
    }
    if (old !== undefined) {
      const td = old.teardown();
      activeTeardown = td;
      await boundTeardown(td).catch(() => undefined);
      if (activeTeardown === td) activeTeardown = undefined;
    }
    if (exiting) {
      await result.teardown();
      return;
    }
    cancelFired = false;
    history = EMPTY_HISTORY;
    // Resumed from the Home (no chat was open): its draft was not sent, so it waits for the chat's end (`endChat`), unless it looks like a key.
    if (old === undefined) keptDraft = draftToKeep(state.input);
    set({
      session: result,
      mode: 'chat',
      input: emptyEditor(),
      pendingMessage: '',
      notice: undefined,
      stripFocus: undefined,
      attachments: [],
      historyEntries: [],
      search: undefined,
      mention: undefined,
      shellBusy: false,
      shellCommand: undefined,
      submitBusy: true,
    });
    activateSession(result, () => set({ submitBusy: false }));
  };

  /**
   * The Home's own words, ONE record keyed by command name ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7:
   * the real open bindings of the commands the registry marks `opener: 'home'`, and of the Home's `/workflows`, `/permissions` and `/mode`).
   * Both ways to name a word, a line typed at the prompt ({@link managementCommand}) and a row chosen in the `/` palette
   * ({@link chooseCommand}), look the word up HERE and apply the same preamble ({@link runHomeWord}), so they cannot differ. A new Home
   * command is a placement in the registry and one entry below. The words of the bare Home that run over the Home's own context instead
   * (`/help`, `/exit`, `/doctor`, `/clear`, `/models`) are answered by {@link answerLandingWord}; `home-registry-dispatch.test.ts` holds the
   * two sets to the registry's Home placements, and a word of a chat to its chat.
   */
  const homeWords: ReadonlyMap<string, HomeWord> = new Map<string, HomeWord>([
    [
      'providers',
      { argsNotice: '/providers accepts no arguments.', open: () => openProviderSetup() },
    ],
    ['init', { argsNotice: '/init accepts no arguments.', open: openProjectInit }],
    [
      'import',
      { argsNotice: '/import accepts no arguments. It asks for the path.', open: openImportCard },
    ],
    ['pricing', { argsNotice: '/pricing accepts no arguments.', open: openPricingCard }],
    [
      'run',
      {
        argsNotice: '/run accepts no arguments. Use its picker to choose a workflow.',
        open: openRunLaunch,
      },
    ],
    [
      'agents',
      {
        argsNotice: '/agents accepts no arguments.',
        unavailable: () =>
          deps.agents === undefined || deps.openHomePopup === undefined
            ? 'The project’s agents are not available here.'
            : undefined,
        open: () => {
          openManagePopup('agents');
        },
      },
    ],
    [
      'workflows',
      {
        argsNotice: '/workflows accepts no arguments.',
        unavailable: () =>
          deps.defined === undefined || deps.openHomePopup === undefined
            ? 'The project’s workflows are not available here.'
            : undefined,
        open: () => {
          openManagePopup('workflows');
        },
      },
    ],
    [
      'permissions',
      {
        argsNotice: '/permissions accepts no arguments.',
        unavailable: () =>
          deps.permissions === undefined || homeSettings() === undefined
            ? 'Remembered commands are not available here.'
            : undefined,
        open: () => {
          openLandingSetting('/permissions');
        },
      },
    ],
    [
      'mode',
      {
        argsNotice: 'No conversation is active. Use /mode to set the startup default.',
        unavailable: () =>
          deps.startupMode === undefined || deps.announce === undefined
            ? 'Startup mode settings are unavailable here.'
            : undefined,
        // The popup host's list over the Home's own settings port (ADR-0148 §3): never a native action, which a popup may not open over.
        open: () => {
          if (!openLandingSetting('/mode'))
            set({ notice: 'Startup mode settings are unavailable here.' });
        },
      },
    ],
    [
      'resume',
      {
        argsNotice: '/resume accepts no arguments. Use its picker to select a session.',
        inChat: true,
        open: () => openResume(),
      },
    ],
  ]);

  /** The table's entry for a word, where the person is: the landing's own words at the landing, and in a chat only the one the chat hosts (`/resume`). */
  const homeWordFor = (name: string): HomeWord | undefined => {
    const word = homeWords.get(name);
    return word !== undefined && (state.session === undefined || word.inChat === true)
      ? word
      : undefined;
  };

  /**
   * The one preamble of a word of the table, whichever way it was named: the line leaves the editor; arguments are refused with the word's
   * own sentence (on the landing, and in the chat in front when there is one); a dependency that is not wired is said, and nothing opens;
   * otherwise the word opens.
   */
  const runHomeWord = (word: HomeWord, withArguments: boolean): void => {
    set({ input: emptyEditor() });
    if (withArguments) {
      set({ notice: word.argsNotice });
      state.session?.store.note(word.argsNotice);
      return;
    }
    const missing = word.unavailable?.();
    if (missing === undefined) word.open();
    else set({ notice: missing });
  };

  /**
   * A registry word of the bare Home that is not in {@link homeWords}, answered at the landing (ADR-0140 §3): never sent to the model.
   * `/help` opens its popup; a word of the bare Home's palette runs as the palette runs it (over the Home's own context, with no arguments);
   * any other registry word is a chat's, and the notice says so. The line is cleared first, as every other command's is. A typed line and a
   * palette selection come here alike.
   */
  const answerLandingWord = (word: string, withArguments: boolean): void => {
    set({ input: emptyEditor() });
    const name = word.slice(1);
    if (name === 'help') {
      if (withArguments) set({ notice: '/help accepts no arguments.' });
      else openManagePopup('help');
      return;
    }
    const command = HOME_PALETTE_COMMANDS.find((entry) => entry.name === name);
    if (command === undefined) {
      set({
        notice: `${word} works in a chat. Start one, then type it. /help lists the commands.`,
      });
    } else if (withArguments) {
      set({ notice: `${word} accepts no arguments here. Start a chat to use them.` });
    } else if (!openLandingSetting(word)) {
      void Promise.resolve(command.run(homeReplCtx, [])).catch(() => undefined);
    }
  };
  /**
   * A line that starts with a slash, answered at the landing (ADR-0140 §3): such a line is a command line and is NEVER a message, because a
   * chat reads every line that starts with `/` as a slash command (its unknown ones are answered `unknown command`, never sent to the model),
   * so a chat started for it would only answer that. What the first word is decides the notice: a registry word is answered by
   * {@link answerLandingWord} whatever follows it (a Home word with text after it is told it takes none, a chat's word is told it works in a
   * chat); a near miss of a command gets its suggestion, which never invokes the command it names; any other lower-case word is said to be
   * unknown, by itself; and any other line (a path such as `/Users/x/file.txt`, an upper-case word) is said to be unknown as the chat says
   * it, shown by {@link shownLine}. A line that does not start with a slash is a message, and `false`. In a chat only the suggestion is
   * local: the chat's own dispatch answers the rest.
   */
  const answerTypedWord = (text: string): boolean => {
    const word = text.split(/\s/u, 1)[0] ?? '';
    if (!word.startsWith('/')) return false;
    const token = word.slice(0, 65); // the word as it is shown: a longer one is cut, and still answered
    const landing = state.session === undefined;
    if (landing && looksLikeProviderKey(text)) {
      // A key typed after a stray `/` (`/sk-ant-...`, or `/Foo` and the key on the next line): the unknown-command notice below would show up
      // to 64 characters of it. It is cleared, not echoed, and nothing records it (the caller returns before the history).
      set({ input: emptyEditor(), notice: KEY_SHAPED_LINE_NOTICE });
      return true;
    }
    if (REPL_COMMANDS_BY_NAME.has(token.slice(1))) {
      if (!landing) return false; // a chat's own command: the dispatch takes it
      answerLandingWord(token, text.length > token.length);
      return true;
    }
    const nearest = nearestCommandName(
      token,
      (landing ? HOME_PALETTE_COMMANDS : HOME_CHAT_PALETTE_COMMANDS).map(
        (command) => `/${command.name}`,
      ),
    );
    if (nearest !== undefined) {
      const notice = `Unknown command. Did you mean ${nearest}?`;
      set({ input: emptyEditor(), notice });
      state.session?.store.note(notice);
      return true;
    }
    if (!landing) return false;
    set({
      input: emptyEditor(),
      notice: `Unknown command: ${LANDING_WORD.test(token) ? token : shownLine(text)}. /help lists the commands.`,
    });
    return true;
  };

  /**
   * A word only the Home has, typed in the chat it hosts (`/providers`, `/init`, `/import`, `/pricing`, `/run`, `/agents`): one line that
   * names the Home, and nothing opens (ADR-0145 §7.4, OD-2). `/resume` has a placement here, so it is not one of them. Whether the word was
   * answered.
   */
  const pointToHome = (name: string): boolean => {
    const session = state.session;
    const pointer = session === undefined ? undefined : homeOnlyPointer(name, 'home-chat');
    if (session === undefined || pointer === undefined) return false;
    set({ input: emptyEditor() });
    session.store.notice(pointer); // the channel the chat's own dispatch answers through (`emitOutput`)
    return true;
  };

  /**
   * A near miss of `/providers`. At the landing the word is the one to type; in a chat the Home hosts, `/providers` itself answers with a
   * pointer only, so the line points at the Home (and `Ctrl+C` twice is the way back to it).
   */
  const answerProviderTypo = (): void => {
    set({ input: emptyEditor() });
    if (state.session === undefined)
      set({ notice: 'Use /providers to connect or manage provider keys.' });
    else state.session.store.notice(PROVIDER_KEYS_AT_THE_HOME); // the channel the chat's own dispatch answers through, as the pointer above
  };

  /**
   * `/doctor` and `/doctor --deep` typed at the landing (ADR-0148 §8): the popup opens, on its confirmation line for `--deep` (new on the Home:
   * it ran only the quick tier). Any other argument is refused in one line that names the one it takes. `false` when the popup is not wired here (the
   * line then goes on to the landing's own answer, which says the doctor is not available here) or a chat is in front (its own routing opens it).
   */
  const answerDoctorOnTheLanding = (text: string): boolean => {
    const open = deps.openDoctor;
    if (open === undefined || state.session !== undefined) return false;
    set({ input: emptyEditor() });
    const route = routePopupLine(text, { doctor: true });
    if (route?.kind !== 'doctor') {
      set({ notice: '/doctor accepts only --deep.' });
      return true;
    }
    open({ deep: route.deep });
    return true;
  };

  /**
   * A line typed at the prompt, answered by the Home when it is the Home's: whether it was. The first word decides, in this order: a word only
   * the Home has, said in a chat ({@link pointToHome}); a word of {@link homeWords}; the near miss of `/providers`; any other slash line
   * ({@link answerTypedWord}). A line that does not start with a slash is a message, and `false`.
   */
  const managementCommand = (text: string): boolean => {
    const word = text.split(/\s/u, 1)[0] ?? '';
    if (!word.startsWith('/')) return false;
    const name = word.slice(1);
    if (pointToHome(name)) return true;
    const homeWord = homeWordFor(name);
    if (homeWord !== undefined) {
      runHomeWord(homeWord, text !== word);
      return true;
    }
    if (name === 'doctor' && answerDoctorOnTheLanding(text)) return true;
    if (name === 'provider') {
      answerProviderTypo();
      return true;
    }
    return answerTypedWord(text);
  };

  /**
   * Track the build of a fresh chat in the `loading` state, so a signal (or a mid-build exit) can reclaim its just-spawned session (its MCP
   * child, its frame loop) rather than orphan it (see `teardownActive`), and hand the built session to `ready` or the rejection to `failed`.
   * A build that finishes after the Home is leaving, or while the exit guard stops the run, is torn down at once and neither runs.
   */
  const awaitBuild = (
    build: Promise<HomeChatSession>,
    ready: (built: HomeChatSession) => void,
    failed: (error: unknown) => void,
  ): void => {
    buildInFlight = build;
    void build.then(
      (built) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting || state.exitGuard === 'stopping') {
          void built.teardown().catch(() => undefined); // exited (or leaving, the run being stopped) mid-build ⇒ reclaim the just-built session
          return;
        }
        ready(built);
      },
      (err: unknown) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) return;
        failed(err);
      },
    );
  };

  /**
   * `Enter` on a message while there is no provider key (ADR-0146 §6, MVP-11 OD-19): a chat that cannot start is never built. The explicit
   * provider setup opens and the message STAYS in the prompt, exactly as typed; when the setup closes in any way it is still there and was
   * not sent (sending it on success would send it to a model the person did not look at). Nothing is recorded in the input history: the
   * message was not sent.
   *
   * The exception is a draft that looks like a provider key ({@link looksLikeProviderKey}). It is never kept and never recorded, so a pasted
   * key does not stay in the prompt or reach the input history's Up and `Ctrl+R` recall (which is in memory only; it is kept clean for the next
   * person at the keyboard), and never carried into the setup's key step. The editor is cleared in the same state change that opens the setup,
   * and one notification says why (never a Home notice). The keyed landing refuses the same draft before a chat is built ({@link submit}).
   */
  const connectProviderKeepingDraft = (): void => {
    if (!looksLikeProviderKey(state.input.text)) {
      openProviderSetup();
      return;
    }
    dropLandingAttachments();
    openProviderSetup({ patch: { input: emptyEditor() }, announce: KEY_SHAPED_DRAFT_NOTICE });
  };

  /**
   * The attachments pending on the Home's draft go with it (ADR-0061): a draft that is cleared, refused or replaced by a command takes them
   * along, and a `@` read still on its way is dropped (the epoch moves), so nothing pending ever rides into a chat the draft did not start.
   */
  const dropLandingAttachments = (): void => {
    submitEpoch += 1;
    if (state.attachments.length > 0) set({ attachments: [] });
  };

  /**
   * The Home's own prompt keys a draft answers first (ADR-0061, the chat's rules on the Home's two prompts): an `@` at a word boundary opens
   * the file picker over the Home's reader, and `Esc` on the landing with attachments pending drops them (the chat's "clear" affordance), with
   * one notification. Whether the key was taken.
   */
  const handleLandingDraftKey = (input: string, key: HomeKey & ChatKey): boolean => {
    if (key.escape === true && state.attachments.length > 0) {
      dropLandingAttachments();
      deps.announce?.(ATTACHMENTS_CLEARED);
      return true;
    }
    const owner = landingMentions();
    if (owner === undefined || !mentionKeyOpens(input, key)) return false;
    openMention(owner, { notice: undefined, stripFocus: undefined });
    return true;
  };

  const submit = (): void => {
    if (exiting) return;
    const trimmed = state.input.text.trim();
    if (trimmed.length === 0) {
      set({ input: emptyEditor() });
      if (openRunView()) return; // the strip's run row: `Enter` brings back the view of the run that is executing
      if (state.keyless) openProviderSetup();
      else deps.announce?.(EMPTY_PROMPT_ENTER_NOTICE); // nothing to open: say how to start, never nothing (ADR-0146 §1)
      return;
    }
    // A command line is no message: the draft it replaced takes its pending attachments along.
    if (trimmed.startsWith('/')) dropLandingAttachments();
    if (managementCommand(trimmed)) return;
    if (state.keyless) {
      connectProviderKeepingDraft();
      return;
    }
    // The message as it was typed, before the editor is cleared: a build that fails gives it back (G6).
    const draft = state.input.text;
    // A draft that looks like a provider key is not a message, with a key or without one (ADR-0146 §6, round 2 A1). It is refused BEFORE a chat
    // is built: sent, it would show as the pending message, reach the model and enter the session transcript (`history.db`, unencrypted and
    // not deletable from). Nothing is built, sent or recorded; the editor is cleared and a fixed sentence says where keys go.
    if (looksLikeProviderKey(draft)) {
      dropLandingAttachments();
      set({ input: emptyEditor(), notice: KEY_SHAPED_SEND_NOTICE });
      return;
    }
    startChatWith(trimmed, draft);
  };

  /**
   * Build the chat the landing's message starts, and send the message as its FIRST turn through the chat's own path: the attachments pending
   * on the draft are expanded into their UNTRUSTED frames by the chat's submit rule ({@link outboundOf}: only a file whose `@path` marker is
   * still in the line), and the pending message and the transcript show the compact form. The draft and its attachments are taken now; a build
   * that fails gives both back when the prompt is still empty.
   */
  const startChatWith = (trimmed: string, draft: string): void => {
    const taken = state.attachments;
    const { message, display } = outboundOf(trimmed);
    submitEpoch += 1; // the draft is consumed: a `@` read still on its way must not splice its marker into the empty prompt
    // The message that starts the chat is recallable via Up in it (the input history is in memory only).
    history = recordHistory(history, trimmed);
    // `palette: undefined` makes the loading-state invariant explicit (the palette is never open during a build)
    // rather than only implied by the key-routing order — mirroring the `endChat` reset.
    set({
      input: emptyEditor(),
      notice: undefined,
      pendingMessage: display,
      mode: 'loading',
      palette: undefined,
      search: undefined,
      mention: undefined,
      attachments: [],
      historyEntries: history.entries,
    });
    awaitBuild(
      deps.startChat(),
      (built) => {
        set({ session: built, mode: 'chat', submitBusy: true, exitGuard: undefined });
        activateSession(built, () => sendChatLine(built, message, display));
      },
      (err) => {
        // The message comes back to the prompt and the failure is shown WHOLE, in the notice area that wraps and pages: the one-row line it
        // used to be cut the remedy off at 80 columns (observed). A draft that looks like a key never gets here: it was refused above.
        const restorable = state.input.text === '';
        set({
          notice: `Couldn’t start the chat: ${failureLine(err)}`,
          ...(restorable ? { input: editorFromText(draft), attachments: taken } : {}),
          pendingMessage: '',
          mode: 'home', // route a build failure back to Home
        });
      },
    );
  };

  /**
   * `c` on an agent's detail (ADR-0140 §3): the screen closes and the build of a chat bound to that agent begins in ONE state change, as a
   * resume's does (`resumeFromSessions`), so the chat that opens is never under the tab host and the landing is never drawn between the two.
   * `agent` is the catalog's path of the file the detail showed and the definition the detail was drawn from. The chat opens idle (there is no
   * first message to send), and the person types the first one. A build that fails leaves the landing with ONE fixed sentence and nothing
   * half-open: the loading state is gone, no session is held, and what the error said is never shown. The host decides why: the file vanished
   * or is refused by the hardened read, it no longer parses, it is no longer the definition the detail showed (the sentence then says the list
   * is out of date), its provider has no key, or a server it declares was not approved. A Home that is leaving, or a chat already in front,
   * starts nothing.
   */
  const startAgentChat = (agent: HomeAgentRequest): void => {
    // No guard on `nativeActionBusy` here: a key reaches a screen only through `handleKey`, which drops every key while one is set. A chat
    // in front or one already building has no agent detail to come from, and is not disturbed all the same.
    if (exiting || state.session !== undefined || state.mode !== 'home') return;
    tabMemory = freshTabMemory();
    disarmInterrupt();
    // The Home's pending `@` attachments are its draft's: they never ride into a chat the draft did not start (a read on its way is dropped).
    submitEpoch += 1;
    set({
      screen: undefined,
      ...parkedPatch(),
      notice: undefined,
      pendingMessage: '', // there is no typed message to echo while it builds
      mode: 'loading',
      palette: undefined,
      mention: undefined,
      attachments: [],
    });
    awaitBuild(
      deps.startChat(agent),
      (built) => {
        set({ session: built, mode: 'chat', submitBusy: true, exitGuard: undefined });
        activateSession(built, () => set({ submitBusy: false }));
      },
      (err) => {
        set({
          notice: agentStartNotice(agentStartReasonOf(err)),
          pendingMessage: '',
          mode: 'home',
        });
      },
    );
  };

  // ---- `/models` (2.5.G S7, ADR-0064 §10; ADR-0148 §3, §6) -----------------------------------------------------------------------------
  // The popup (`popups/models-session.ts`) reads the catalog and applies through the Home's writers, which stay here: the default of new
  // chats ({@link saveNextSessionDefault}) and the reseat of the chat in front ({@link reseatChat}). Nothing it does writes the Home's notice or a
  // transcript: what applied is said on the Home's channel (`deps.announce`, or the chat's own announcement, which the host binds to it).

  /**
   * The BARE-Home next-session-default write (ADR-0063 · ADR-0066 §6), the writer of the popup's default (the bare Home's `Enter`, and a hosted
   * chat's `New chats`): the global `[preferences].default_model` with its provider and, when the model takes a tier, `reasoning_effort`, in
   * ONE atomic write through the Home's port (its config-rewrite disclosure on the native card). Input is gated for the whole write; what it
   * came to is the effective default read again (project → workspace → global), so a project override is said and never reported as applied.
   * The owned host observes a writer fault before it is told as a failed save (`saveDefaultModel`).
   */
  const saveNextSessionDefault = async (choice: ModelChoice): Promise<DefaultModelSaveResult> => {
    const port = deps.models;
    if (port === undefined || exiting) return { kind: 'refused', reason: 'closing' };
    // A listener that throws while the Home draws the write's start or end is the Home's own fault: its fatal path, as every other
    // presentation failure of the controller (the write itself is the adapter's, which never rejects).
    const present = (patch: Partial<HomeControllerState>): boolean => {
      try {
        set(patch);
        return true;
      } catch (cause) {
        failHome(cause);
        return false;
      }
    };
    if (!present({ submitBusy: true })) return { kind: 'refused', reason: 'closing' };
    const result = await saveDefaultModel(
      {
        write: port.writeDefault,
        readEffective: port.currentDefault,
        closing: () => exiting,
        failure: (cause) => deps.workOwner?.failure(cause),
      },
      choice,
    );
    // What the next chat uses may have just changed (the model and its provider, the effort tier): the status line is read again, on the bare Home only.
    if (!exiting) present({ submitBusy: false, ...(state.mode === 'home' ? statusPatch() : {}) });
    return result;
  };

  /**
   * The bare Home's `/mode` hand-off (ADR-0148 §3, §6; MVP-11 unit 8): the startup-default writer's flow, started as the popup's work once its
   * list has closed. The composer is busy for as long as the flow is open (its keys are the flow's), and the status line is read again however
   * it ended: the startup default is what the bare Home's status line names. What it came to is the outcome the popup settles, never a word for
   * the Home's notice. Never rejects (the adapter reports its own faults).
   */
  const saveStartupMode: StartupDefaultMember['saveStartupDefault'] = async (
    mode,
  ): Promise<StartupDefaultOutcome> => {
    const port = deps.startupMode;
    if (port === undefined || exiting) return { kind: 'closed' };
    const present = (patch: Partial<HomeControllerState>): boolean => {
      try {
        set(patch);
        return true;
      } catch (cause) {
        failHome(cause);
        return false;
      }
    };
    if (!present({ submitBusy: true })) return { kind: 'closed' };
    try {
      return await port.save(mode);
    } finally {
      if (!exiting) present({ submitBusy: false, ...(state.mode === 'home' ? statusPatch() : {}) });
    }
  };

  /** The catalog half of a `/models` member: the Home's one catalog port (the chats the Home hosts read the same catalog). */
  const catalogOf = (
    port: HomeModelsPort,
  ): Pick<ModelsSettingsPort, 'load' | 'refreshIfStale' | 'refresh' | 'providerName'> => ({
    load: port.load,
    refreshIfStale: port.refreshIfStale,
    refresh: port.refresh,
    providerName: providerDisplayName,
  });

  /**
   * The bare Home's settings port: `/models` sets the default of new chats (there is no live chat), opened on the effective default and its
   * tier. `undefined` without a catalog port or a channel to say what applied on.
   */
  const homeSettings = (): SettingsPort | undefined => {
    const port = deps.models;
    const announce = deps.announce;
    if (announce === undefined) return undefined;
    const startupMode = deps.startupMode;
    const members: Pick<SettingsPort, 'models' | 'mode' | 'permissions'> = {
      // `/permissions` on the bare Home (MVP-11 unit 8, OD-24): the project's remembered commands and the repository's allowlist, over the
      // project's port (no session, so no mode: the popup draws the Home's lists).
      ...(deps.permissions === undefined ? {} : { permissions: { port: deps.permissions } }),
      ...(port === undefined
        ? {}
        : {
            models: {
              scope: 'home',
              ...catalogOf(port),
              current: port.currentDefault,
              // The provider of the effective default is its catalog row's (the popup reads it there).
              currentProvider: () => undefined,
              currentEffort: port.currentEffort,
              saveDefault: saveNextSessionDefault,
            },
          }),
      ...(startupMode === undefined
        ? {}
        : {
            mode: {
              scope: 'home',
              startup: startupMode.read,
              saveStartupDefault: saveStartupMode,
            },
          }),
    };
    if (
      members.models === undefined &&
      members.mode === undefined &&
      members.permissions === undefined
    )
      return undefined;
    return {
      surface: 'home',
      announce,
      ...(deps.workOwner === undefined ? {} : { workOwner: deps.workOwner }),
      ...members,
    };
  };

  /**
   * The chat in front's settings port with its `/models` member: the Home's catalog, the chat's own model and tier (read from its store), its
   * tier setter, the Home's reseat of THIS chat (`This chat`) and the Home's default write (`New chats`). Without a catalog port or a reseat
   * builder the chat has no `/models` popup (its own member, if it had one, is withdrawn: a switch it could not make is never offered).
   */
  const chatSettings = (active: HomeChatSession): SettingsPort | undefined => {
    const settings = active.settings;
    if (settings === undefined) return undefined;
    const port = deps.models;
    if (port === undefined || deps.reseatChat === undefined || active.onSetEffort === undefined)
      return settings.models === undefined ? settings : { ...settings, models: undefined };
    return {
      ...settings,
      models: {
        scope: 'chat',
        ...catalogOf(port),
        current: () => active.store.getSnapshot().state.model,
        currentProvider: () => active.provider,
        defaultModel: port.currentDefault,
        defaultProvider: port.currentDefaultProvider,
        defaultEffort: port.currentEffort,
        currentEffort: () => active.store.getSnapshot().reasoningEffort,
        setEffort: active.onSetEffort,
        switchModel: (choice) => {
          reseatChat(active, choice);
        },
        saveDefault: saveNextSessionDefault,
      },
    };
  };

  /**
   * A setting the bare Home answers with a popup (`/models`; ADR-0148 §3), routed by the one routing over the Home's own settings port: whether
   * it opened one. A setting it has no popup for (or a Home that wires none) goes on to the word's own answer.
   */
  const openLandingSetting = (word: string, closed?: () => void): boolean => {
    const port = homeSettings();
    const open = deps.openSettings;
    if (port === undefined || open === undefined) return false;
    const route = routePopupLine(word, { doctor: false, settings: port });
    if (route?.kind !== 'settings') return false;
    open({ command: route.command, chat: port, ...(closed === undefined ? {} : { closed }) });
    return true;
  };

  // The Home's REPL context (no live session), the one the bare Home's typed registry words and its palette rows run over
  // ({@link answerLandingWord}). Capabilities for the commands that have NO `home` placement (cancel, export, cost, effort, thinking, details,
  // compact, trim, scrollback, edit, copy: a chat's) are inert noops, unreachable from the bare Home's list, which the context's shape
  // requires. A command with a `home` placement is either run over this context (`/exit`, `/help`, `/doctor`, `/models`; `/clear` answers its
  // unavailable notice) or opened by {@link homeWords}, the controller's one record (`/providers`, `/init`, `/run`, `/workflows`, `/agents`,
  // `/permissions`, `/import`, `/pricing`, `/resume`, `/mode`); the commands of that second kind have no `run` in the registry, or a
  // chat's, which this context does not call.
  const homeReplCtx: ReplCommandContext = {
    exit: () => requestExit(),
    cancel: () => undefined,
    exportSession: () => undefined,
    // `/help` is on the Home's palette (ADR-0145 §7.3): chosen there it opens the same screen the typed word does.
    help: () => {
      openManagePopup('help');
    },
    showWorkflows: () => undefined, // the chat's own listing; the Home's `/workflows` opens its popup from the controller (MVP-11 unit 8)
    // `/cost` is chat-only in the BARE Home: there is no live session to cost. (The in-Home CHAT reaches the real
    // implementation through `createChatLineHandler`, so it gets the ADR-0070 per-model breakdown like the standalone
    // chat does.) Now that the breakdown reads the DB rather than an in-memory counter, costing a PAST session needs
    // only a sessionId — which is what 2.6.G's session browser will supply.
    showCost: () => undefined,
    managePermissions: () => undefined, // the Home opens its own `/permissions` popup (ADR-0148 §10) from the controller, not through this context
    showAgent: () => undefined, // `/agent` is a chat's (ADR-0140 §3): the landing has no session, so it answers the word itself and never runs this
    openDetails: () => undefined,
    setMode: () => undefined, // `/mode` is a chat's here; the bare Home's own opens its startup settings from `homeWords`
    setReasoningEffort: () => undefined, // `/effort` is chat-only (ADR-0066); inert in the bare-Home surface
    toggleReasoning: () => undefined, // `/thinking` is chat-only (2.5.H); inert in the bare-Home surface (no live session)
    compactHistory: () => undefined, // `/compact` is chat-only (ADR-0062); inert in the Home surface
    trimHistory: () => undefined, // `/trim` is chat-only (ADR-0062); inert in the Home surface
    // `/clear` (ADR-0062 §7) has a `home` placement, where it is DIM (there is no conversation to clear), and a typed `/clear` at the bare
    // Home answers with the very words `Enter` on that dim row does (`unavailableNotice` over the registry's own reason), not a second
    // wording of one fact. An ACTIVE in-Home chat routes `/clear` through the chat handler's REAL clearSession (via sendChatLine → the
    // swap), never through this ctx.
    clearSession: () => {
      const clear = availabilityOf('clear', 'home', { hasSession: false });
      set({ notice: clear.enabled ? undefined : unavailableNotice('clear', clear.reason) });
    },

    // `/models` (2.5.G S7, ADR-0064 §10) IS a real Home capability (it is placed on the Home and in both chats): its popup is opened by
    // {@link answerLandingWord} through the one routing, before this context runs. Reached only where the Home has no popup to open (a test's
    // Home without the catalog or the popup host's opener), and says so.
    openModels: () => {
      set({ notice: '/models is unavailable here.' });
    },

    // `/scrollback` + `/edit` (ADR-0068 §e) are chat-only (no `home` placement), so they never appear in the bare Home's palette and are
    // unreachable from it — there is no transcript to dump or edit. An
    // ACTIVE in-Home chat routes them through the chat handler's REAL capabilities (sendChatLine → the slash
    // dispatch → `createChatLineHandler`'s hatches), never through this ctx. Inert here, like the other chat-only
    // capabilities above.
    dumpScrollback: () => undefined,
    editTranscript: () => undefined,
    copyTranscript: () => undefined,

    runDoctor: (deep) => {
      if (exiting) return Promise.resolve();
      // The popup (ADR-0148 §8): the palette's `/doctor` opens it, and nothing is written into the notice. A Home that does not wire it (only a
      // test's: `driveHome` always does) has no doctor to show, and says so in one line, as the other words with no port do.
      const open = deps.openDoctor;
      if (open === undefined) {
        set({ notice: DOCTOR_UNAVAILABLE });
        return Promise.resolve();
      }
      set({ input: emptyEditor() });
      open({ deep });
      return Promise.resolve();
    },
  };

  /**
   * Open the palette over the rows this surface offers (MVP-11 Step 2.2, ADR-0145 §7): the bare Home lists its own commands under the prompt
   * and the chat it hosts lists a chat's above it. Availability is read from CACHED state only: never a port, the keychain or the disk. At
   * the bare Home that is the key flag and the snapshot's recent sessions (the snapshot is read when the Home opens, so "nothing to resume"
   * is as fresh as the strip); in the chat, the chat itself and its turn (a saved conversation is unknown there, so `/resume` reads as
   * enabled: the snapshot may predate the chats of this Home).
   */
  const openPaletteState = (
    active: HomeChatSession | undefined,
  ): Pick<HomeControllerState, 'palette'> => ({
    palette:
      active === undefined
        ? openPalette(
            buildPaletteEntries('home', {
              hasSession: false,
              hasKey: !state.keyless,
              hasSavedSessions: state.snapshot.recentSessions.length > 0,
              turnRunning: false,
            }),
            // under the landing's prompt; above the work page's docked prompt, as a chat's runs (MVP-11 unit 7)
            state.homePage === 'work' ? 'up' : 'down',
          )
        : openPalette(
            buildPaletteEntries('home-chat', {
              hasSession: true,
              hasKey: true,
              // Filled for the context's contract (ADR-0145 §7): declared ahead of use, read by tests until the popup step. No availability
              // function reads it yet, and the palette cannot open while a turn runs (`shouldOpenPalette`), so it is false in practice.
              turnRunning: active.store.getSnapshot().state.status === 'running',
            }),
            'up',
          ),
  });

  /**
   * A row chosen in the palette (`Enter` on a row that can act). The word is looked up where a typed line looks it up, so the two routes
   * cannot differ: a word of {@link homeWords} (where the person is: the landing's, or `/resume` in a chat) goes through {@link runHomeWord};
   * any other word of the bare Home is {@link answerLandingWord}; in a chat the overlay commands open as the typed line opens them
   * ({@link overlayCommandFor}) and every other row is submitted as the slash line through the chat's own dispatch (S3a).
   */
  const chooseCommand = (command: ReplCommand, active: HomeChatSession | undefined): void => {
    const homeWord = homeWordFor(command.name);
    if (homeWord !== undefined) {
      runHomeWord(homeWord, false); // the palette captures NO args: the bare command runs
      return;
    }
    const line = `/${command.name}`;
    if (active === undefined) {
      answerLandingWord(line, false);
      return;
    }
    const open = overlayCommandFor(active, line);
    if (open === undefined) sendChatLine(active, line);
    else open();
  };

  // Drive the open `/` palette (2.5.C S3b): fold the keystroke, then apply — keep open with new state, run the
  // highlighted command ({@link chooseCommand}), say why a dim row cannot run, or close. Ctrl-C closes it (a gentle escape back to the prompt
  // — never trapping the user).
  const handlePaletteKey = (input: string, key: PaletteKey): void => {
    const open = state.palette;
    if (open === undefined) return;
    // The palette runs in BOTH surfaces: a live chat (a session ⇒ submit the slash through the S3a dispatch) and
    // the bare Home (no session ⇒ run the command over the Home's own context). The rows are the surface's, built when the palette opened.
    const active = state.session;
    const step = foldPaletteKey(input, key, open);
    switch (step.kind) {
      case 'close':
        set({ palette: undefined });
        return;
      case 'unavailable': {
        // `Enter` on a dim row: its reason is said and the palette stays open. Never "unknown command", never run.
        const row = open.list.rows[open.state.index];
        const notice = unavailableNotice(row?.command.name ?? '', step.reason);
        if (active === undefined) set({ notice });
        else active.store.note(notice);
        return;
      }
      case 'run':
        set({ palette: undefined });
        if (step.command !== undefined) {
          chooseCommand(step.command, active);
        } else if (open.state.query.trim().length > 0) {
          // `Enter` on a query that matches no row, or on which no row is highlighted (A2): the person typed a line of their own (`/help`, a
          // misspelling, `/doctor --deep`, `/trim 20`, a sentence), and it is answered as the same line pasted is (ADR-0140 §3): by
          // `managementCommand`, which a submitted line goes through first, so `/run extra` says `/run accepts no arguments` here as it does
          // for a paste, not that `/run` is unknown. It starts with a slash, so it is a command line and is always answered: it never starts
          // a chat. In a chat the Home does not answer is the chat's own: the line goes down to its dispatch, which validates the tokens and
          // answers an unknown word (round 2, U1), instead of the text being dropped when the palette closes.
          const line = `/${open.state.query.trim()}`;
          if (!managementCommand(line) && active !== undefined) {
            // A line the chat opens a surface for (`/doctor --deep`, ADR-0148 §8) opens it here too, as the same line typed at the prompt does,
            // and never reaches the chat's dispatch (which would print its text into the transcript).
            const overlay = overlayCommandFor(active, line);
            if (overlay === undefined) sendChatLine(active, line, line);
            else overlay();
          }
        }
        return;
      case 'state':
        set({ palette: step.palette });
        return;
    }
  };

  // The `@`-mention completion (2.5.D step 4, ADR-0061) of the chat in front AND of the Home's own two prompts (the landing and the work
  // page's docked prompt: the maintainer's question of 2026-11-26), one implementation over a {@link MentionOwner}: the reader, whether a
  // resolve may still land, and where a word about the pick goes. ASYNC: opening/descending a dir fires an fs `list()` whose result lands
  // ONLY if the submode is still open on the SAME dir for the SAME owner (a stale resolve is dropped); `state.mention` is the live value the
  // guards read.
  const loadMentions = (owner: MentionOwner, dir: string): void => {
    // Apply a resolve ONLY if the SAME owner's submode is still open on the SAME dir — a resolve from a since-closed / since-descended
    // submode, or (after a /exit → new chat, or a chat that started from the landing) another owner, is dropped (mirrors acceptMention).
    const applyIfCurrent = (candidates: readonly MentionCandidate[]): void => {
      const open = state.mention;
      if (open === undefined || !owner.current()) return;
      // A matching directory is insufficient after permanent stop or a chat swap.
      if (open.dir !== dir) return;
      set({ mention: { ...open, candidates, loading: false } });
    };
    void owner.reader.list(dir).then(
      (candidates) => applyIfCurrent(candidates),
      () => applyIfCurrent([]),
    );
  };
  const openMention = (owner: MentionOwner, patch: Partial<HomeControllerState> = {}): void => {
    set({ ...patch, mention: { dir: '', filter: '', candidates: [], selected: 0, loading: true } });
    loadMentions(owner, '');
  };
  // Read the accepted file through the fs jail + confidentiality floor + binary/size guards, then queue it for the draft as UNTRUSTED,
  // user-position context. Drop a resolve if the owner is no longer in front (a returned Home, a chat that started, must not gain injected
  // text) or the draft was submitted or dropped since. A read rejection surfaces a STATIC, secret-free word (never the raw error/path).
  const acceptMention = (owner: MentionOwner, path: string): void => {
    const epoch = submitEpoch; // capture: a submit since accept ⇒ the buffer moved on (drop the inject)
    const stale = (): boolean => !owner.current() || submitEpoch !== epoch;
    void owner.reader.read(path).then(
      ({ content, sizeBytes }) => {
        if (stale()) return; // the owner left or the buffer was submitted mid-read — drop it
        history = resetHistoryNav(history); // a real edit ends history navigation
        // Insert the compact `@path` marker (the inline reference) + queue the file as a pending attachment (its
        // bytes are expanded into the UNTRUSTED frame at SUBMIT, only if the marker is still present). The shared
        // `appendAttachment` dedups by path + caps the list; the marker is inserted regardless (a dup is a no-op add).
        const { list, dropped } = appendAttachment(state.attachments, {
          kind: 'file',
          path,
          content,
          sizeBytes,
        });
        set({ input: insertAtCursor(state.input, `${mentionMarker(path)} `), attachments: list });
        if (dropped > 0) {
          owner.note(
            `pending attachment limit (${MAX_PENDING_ATTACHMENTS}) reached — oldest dropped`,
          );
        }
        const warn = fileAttachmentWarning(path, content, sizeBytes);
        if (warn !== undefined) owner.note(warn);
      },
      () => {
        if (stale()) return;
        owner.note('@ mention could not read that file (refused, binary, or too large)');
      },
    );
  };
  /** The chat in front as a mention owner: its session's reader, its own currency, its transcript's note. `undefined` without a reader. */
  const chatMentions = (active: HomeChatSession): MentionOwner | undefined => {
    const reader = active.mentionReader;
    return reader === undefined
      ? undefined
      : { reader, current: () => isCurrentChat(active), note: (text) => active.store.note(text) };
  };
  /**
   * The Home's own prompts as a mention owner: the Home's reader (no session), current while the bare Home is in front (a chat that started
   * or a Home that is leaving drops a resolve), and its words one notification on the Home's channel (never its notice, never a transcript).
   */
  const landingMentions = (): MentionOwner | undefined => {
    const reader = deps.mentionReader;
    return reader === undefined
      ? undefined
      : {
          reader,
          current: () => !exiting && state.session === undefined && state.mode === 'home',
          note: (text) => deps.announce?.(text),
        };
  };

  // The in-Home chat's `!`-shell escape (2.5.D step 5, ADR-0061) — mirrors ChatApp. Render the classified outcome:
  // inject the (nonce-fenced, bounded) output as UNTRUSTED context into the CLEARED buffer, or note the actionable
  // deny / failure. The epoch + session/mode guard drops a stale resolve (a submit / chat-swap since the run).
  const handleShellOutcome = (
    active: HomeChatSession,
    parsed: ShellCommand,
    outcome: UserCommandOutcome,
    mode: ChatMode,
    epoch: number,
  ): void => {
    if (!isCurrentChat(active) || submitEpoch !== epoch) return;
    if (outcome.kind === 'ran') {
      // SHOW the output read-only (a transcript notice) + queue it as a pending COMMAND attachment that rides the
      // next message (the FULL output is expanded into the UNTRUSTED frame at submit; the preview is bounded).
      const { list, dropped } = appendAttachment(state.attachments, {
        kind: 'command',
        cmd: parsed,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      });
      set({ attachments: list });
      if (dropped > 0) {
        active.store.note(
          `pending attachment limit (${MAX_PENDING_ATTACHMENTS}) reached — oldest dropped`,
        );
      }
      active.store.notice(
        commandResultPreview(parsed, outcome.exitCode, outcome.stdout, outcome.stderr),
      );
      return;
    }
    if (outcome.kind === 'denied') {
      active.store.note(shellDenyHint(parsed, outcome.allowlist, mode));
      return;
    }
    active.store.note(
      outcome.kind === 'cancelled' ? '! command cancelled' : `! ${commandLine(parsed)} failed`,
    );
  };
  const runShell = (active: HomeChatSession, parsed: ShellCommand): void => {
    if (!isCurrentChat(active)) return;
    const runner = active.runShellCommand;
    if (runner === undefined) return;
    const epoch = submitEpoch;
    const mode = active.store.getSnapshot().mode; // captured for a mode-aware deny hint
    // Gate input + show a LABELED busy indicator (the command line) until it settles (else a submit crashes the chat).
    set({ shellBusy: true, shellCommand: commandLine(parsed) });
    // Clear the busy flag only if THIS session is still current (a swap's endChat already reset it — never un-gate
    // a new session's own in-flight command).
    const clearBusy = (): void => {
      if (state.session === active) set({ shellBusy: false, shellCommand: undefined });
    };
    void runner(parsed.command, parsed.args).then(
      (outcome) => {
        clearBusy();
        handleShellOutcome(active, parsed, outcome, mode, epoch);
      },
      () => {
        clearBusy();
        if (isCurrentChat(active) && submitEpoch === epoch) {
          active.store.note('! shell command failed unexpectedly');
        }
      },
    );
  };

  // The open `@`-mention completion owns every key (2.5.D step 4) — parity with ChatApp. Returns whether the key
  // was consumed (the overlay was open); mutually exclusive with the palette/search. The chat's and the Home's alike (`owner`); an owner that
  // is gone (its reader withdrawn) closes the completion, and the key is spent.
  const routeMentionKey = (
    owner: MentionOwner | undefined,
    input: string,
    key: ChatKey,
  ): boolean => {
    const open = state.mention;
    if (open === undefined) return false;
    if (owner === undefined) {
      set({ mention: undefined });
      return true;
    }
    const step = foldMentionKey(input, key, open);
    if (step.kind === 'close') {
      // Restore the literal keystrokes (`@` + filter on cancel; `''` on backspace-past) so nothing typed is lost.
      if (step.restore.length > 0) {
        history = resetHistoryNav(history); // a restore is a real edit ⇒ end history navigation
        set({ mention: undefined, input: insertAtCursor(state.input, step.restore) });
      } else {
        set({ mention: undefined });
      }
    } else if (step.kind === 'descend') {
      set({ mention: { dir: step.dir, filter: '', candidates: [], selected: 0, loading: true } });
      loadMentions(owner, step.dir);
    } else if (step.kind === 'accept') {
      set({ mention: undefined });
      // The `Enter` that chose: its auto-repeats must not send the draft the file lands in.
      if (key.return === true) pickEnter.chosen(interruptNow());
      acceptMention(owner, step.path);
    } else {
      set({ mention: step.state });
    }
    return true;
  };

  // The open Ctrl+R reverse-search owns every key (Esc/Ctrl-C cancels; Enter accepts the match; Ctrl+R steps
  // older). Returns whether the key was consumed. Mutually exclusive with the palette.
  const routeSearchKey = (input: string, key: ChatKey): boolean => {
    const open = state.search;
    if (open === undefined) return false;
    const step = foldReverseSearchKey(input, key, open, history.entries);
    if (step.kind === 'close') {
      set({ search: undefined });
    } else if (step.kind === 'accept') {
      history = resetHistoryNav(history); // the accepted entry is the live buffer, not a nav result (Down mustn't clobber it)
      set({ search: undefined, input: editorFromText(step.text) }); // load the matched entry
    } else {
      set({ search: step.state });
    }
    return true;
  };

  // Open a keyboard-owning overlay from an idle prompt (not mid-approval): the `/` palette, `Ctrl+R` reverse-search,
  // or the `@`-completion (at a word boundary, reader wired). Returns whether one opened.
  const tryOpenOverlay = (
    active: HomeChatSession,
    input: string,
    key: ChatKey,
    running: boolean,
    approvalPending: boolean,
  ): boolean => {
    if (approvalPending) return false; // a pending approval OWNS the keyboard — never opens an overlay
    if (shouldOpenPalette(input, key, running, state.input.text.length)) {
      set(openPaletteState(active));
      return true;
    }
    if (!running && key.ctrl === true && input === 'r') {
      set({ search: INITIAL_REVERSE_SEARCH });
      return true;
    }
    // A mid-word `@` (an email/handle) or an absent reader falls through as a literal (parity with ChatApp).
    const owner = chatMentions(active);
    if (!running && owner !== undefined && mentionKeyOpens(input, key)) {
      openMention(owner);
      return true;
    }
    return false;
  };

  /** Whether `key` is an `@` that opens the completion where the cursor is: at a word boundary only (a mid-word `@`, an email, is a literal). */
  const mentionKeyOpens = (input: string, key: ChatKey): boolean =>
    input === '@' &&
    key.ctrl !== true &&
    key.meta !== true &&
    mentionOpensAt(state.input.text, state.input.cursor);

  // A vertical Up/Down move within a multi-line buffer; at the top/bottom edge (a no-op) recall history.
  const applyMoveAction = (action: Extract<ChatKeyAction, { kind: 'move' }>): void => {
    const moved = applyEditorAction(state.input, action);
    if (moved !== state.input) {
      set({ input: moved }); // a real move (vertical mid-buffer, or any horizontal/word/line motion)
      return;
    }
    if (action.motion !== 'up' && action.motion !== 'down') return; // a no-op horizontal motion
    const recall =
      action.motion === 'up' ? historyPrev(history, state.input.text) : historyNext(history);
    if (recall !== null) {
      history = recall.history;
      set({ input: editorFromText(recall.text) });
    }
  };

  /**
   * The bare chat commands that open an overlay of the Home instead of dispatching to the session, as the open call or `undefined`. Each is
   * an exact match, so `/models <arg>` and the like are not intercepted: they dispatch and are rejected as the command that takes no
   * argument, like the standalone chat.
   * - `/models` opens the reseat picker (ADR-0059), parity with the standalone ChatApp's submit-intercept, only when a reseat builder is
   *   wired (always, in production); else it falls through to the normal slash dispatch (which surfaces the "interactive terminal" hint).
   * - `/doctor` (and `/doctor --deep`, ADR-0148 §8), `/agent`, `/cost` (and `/cost --release`), `/workflows` and `/help` (§10) and the bare
   *   settings (`/effort` on a model that has a tier to choose: §3, §6; `/permissions`, ADR-0137 §2 as a popup) open their popup, where the
   *   session holds its port, as the one routing
   *   says (`popup-route.ts`): the popup is opened before the line is a submit, so the open gate never takes the line for a turn in flight. These
   *   are not exact matches: white space around the words is ignored. A setting with an argument (`/effort high`) is not a popup: it goes to
   *   the chat's dispatch, which applies it.
   */
  const overlayCommandFor = (
    active: HomeChatSession,
    trimmed: string,
  ): (() => void) | undefined => {
    // `/doctor` (and `--deep`) and the reports open their popup over this chat (ADR-0148 §8, §10) before the line is a submit, so the open gate
    // never sees it as a turn; any other form goes to the chat's dispatch, which says what is wrong with it.
    const route = routePopupLine(trimmed, {
      doctor: deps.openDoctor !== undefined && active.doctor !== undefined,
      reports: deps.openReport === undefined ? undefined : active.reports,
      settings: deps.openSettings === undefined ? undefined : chatSettings(active),
    });
    return route === undefined ? undefined : () => openPopupOverChat(active, route);
  };

  /**
   * The controller's one open adapter (ADR-0148 §2): the popup a routed line names, over the chat in front, through the host's open ports with
   * the chat's own. Reached only for a route {@link routePopupLine} gave for this chat, so the port it names is wired.
   */
  const openPopupOverChat = (active: HomeChatSession, route: PopupRoute): void => {
    if (route.kind === 'doctor') {
      if (active.doctor !== undefined) deps.openDoctor?.({ deep: route.deep, chat: active.doctor });
      return;
    }
    if (route.kind === 'settings') {
      const settings = chatSettings(active);
      if (settings !== undefined) deps.openSettings?.({ command: route.command, chat: settings });
      return;
    }
    if (active.reports !== undefined)
      deps.openReport?.({
        line: route.line,
        chat: active.reports,
        // The facts `homePopupRefusal` reads, read again by the release at the moment of its answer.
        turnInFlight: () => turnInFlight(homeTurnFacts(state)),
      });
  };

  // Submit `line`: a leading `!command` runs the shell escape (carried command outputs stay pending — they ride the NEXT
  // message); a `/slash` passes through unchanged; otherwise it is a MESSAGE — expand the pending attachments (files
  // whose `@marker` is present + all carried commands) into the outbound frame, show the compact form in the
  // transcript, and clear exactly the consumed attachments. The line leaves the editor on every path, and a FILE goes
  // with it (`set` keeps only the attachments the draft still names).
  const applySubmitAction = (active: HomeChatSession, line: string): void => {
    const trimmed = line.trim();
    const shellLine =
      active.runShellCommand !== undefined && isShellLine(trimmed)
        ? parseShellLine(trimmed.slice(1))
        : undefined;
    if (shellLine?.kind === 'unterminated_quote') {
      // An open quote is refused, never run to the end of the line (ADR-0118 §3); the line stays in the editor and, since
      // the buffer is NOT cleared, a pending mention read is left alone (the epoch is bumped only where it is consumed).
      active.store.note(SHELL_UNTERMINATED_QUOTE_NOTICE);
      return;
    }
    submitEpoch += 1; // the buffer is cleared → a pending mention read / shell run must not re-inject
    if (managementCommand(trimmed)) return;
    const parsed = shellLine?.kind === 'command' ? shellLine.cmd : undefined;
    if (parsed !== undefined) {
      history = recordHistory(history, line);
      set({ input: emptyEditor(), historyEntries: history.entries });
      runShell(active, parsed); // a `!command` → the shell escape (carried outputs stay pending; a file goes with the line)
      return;
    }
    const open = overlayCommandFor(active, trimmed);
    if (open !== undefined) {
      history = recordHistory(history, line);
      set({ input: emptyEditor(), historyEntries: history.entries });
      open();
      return;
    }
    if (trimmed.startsWith('/') || state.attachments.length === 0) {
      // a slash command, or a plain message with no attachments — the simple path
      history = recordHistory(history, line);
      set({ input: emptyEditor(), historyEntries: history.entries });
      sendChatLine(active, line, line);
      return;
    }
    // a message WITH attachments → expand into the outbound frame; the transcript shows the compact display.
    const { message, display, remaining } = outboundOf(line);
    if (message.trim().length === 0) {
      set({ input: emptyEditor() }); // nothing to send (empty prose + no consumable attachment)
      return;
    }
    history = recordHistory(history, line); // history recalls the PROSE the user typed, not the framed message
    set({ input: emptyEditor(), historyEntries: history.entries, attachments: remaining });
    sendChatLine(active, message, display);
  };

  /**
   * What a submitted line sends with the attachments pending on the draft (ADR-0061): the ONE path of the chat's submit and of the landing's
   * first message ({@link startChatWith}). Each file whose `@path` marker is still in the line, and every carried command, is expanded into
   * its UNTRUSTED, nonce-fenced user-position frame after the prose (`buildOutbound`); the compact form is what the transcript and the pending
   * message show; `remaining` are the attachments the line did not take.
   */
  const outboundOf = (
    line: string,
  ): {
    readonly message: string;
    readonly display: string;
    readonly remaining: readonly PendingAttachment[];
  } => {
    const { message, display, consumed } = buildOutbound(line, state.attachments);
    return { message, display, remaining: state.attachments.filter((a) => !consumed.includes(a)) };
  };

  // --- The one interrupt keymap (ADR-0115 §1) -------------------------------------------------------------------------
  // `interrupt` is its whole state on the injected monotonic clock; `interruptArmed` (in the snapshot) only drives the footer
  // hint, and the timer takes the hint down when the window runs out.
  const interruptNow = deps.now ?? ((): number => performance.now());
  let interrupt: InterruptState = DISARMED;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  const stopInterruptTimer = (): void => {
    if (interruptTimer !== undefined) clearTimeout(interruptTimer);
    interruptTimer = undefined;
  };
  const showInterruptHint = (armed: boolean): void => {
    stopInterruptTimer();
    if (armed && !exiting) {
      interruptTimer = setTimeout(() => {
        interruptTimer = undefined;
        if (exiting || !state.interruptArmed) return;
        // A timer callback has no input handler around it to route a listener's failure, so it is routed here.
        try {
          set({ interruptArmed: false });
        } catch (error) {
          failHome(error);
        }
      }, INTERRUPT_ARM_WINDOW_MS);
      interruptTimer.unref();
    }
    if (state.interruptArmed !== armed && !exiting) set({ interruptArmed: armed });
  };
  const disarmInterrupt = (): void => {
    if (interrupt.armedAt === undefined) return;
    interrupt = pressOtherKey();
    showInterruptHint(false);
  };
  // What `Esc` does mid-turn: abort the turn and keep the session. A session wired without `onAbort` still must not leave a pending
  // approval hanging, so it is rejected directly: the stop key is never dead at a decision.
  const abortActive = (active: HomeChatSession): void => {
    if (active.onAbort !== undefined) {
      active.onAbort();
    } else if (active.store.getSnapshot().approval !== undefined) {
      active.store.answerApproval({ outcome: 'reject' });
    }
  };
  // `/cancel` ends the (resumable) session and returns to the Home; at most once, so a held key cannot fire redundant turns.
  const cancelActive = (active: HomeChatSession): void => {
    if (cancelFired) return;
    cancelFired = true;
    sendChatLine(active, '/cancel');
  };
  // Where the person is. An open card is not a context of its own here: it implies a running turn, and the host settles it (an
  // approval as a rejection, before the abort) in the store before the key reaches the controller.
  const interruptContext = (active: HomeChatSession | undefined): InterruptContext => {
    const overlay = interruptContextFrom(overlayFlags());
    if (overlay !== undefined) return overlay;
    if (active === undefined) return { kind: 'home', loading: state.mode === 'loading' };
    const busy =
      active.store.getSnapshot().state.status === 'running' || state.shellBusy || state.submitBusy;
    return busy ? { kind: 'work' } : { kind: 'prompt', hasText: state.input.text.length > 0 };
  };
  // The run view's ladder (ADR-0139 §5). It asks the host about THE VIEW'S run now, not the poll's last read: a press that arrives a
  // moment after the leg ended must not cancel anything. The first press only arms; nothing is cancelled until the second.
  const handleScreenInterrupt = (screen: HomeScreen): void => {
    if (screen.kind === 'tab-host') {
      // A browser is not a run: `Ctrl+C` closes the whole screen from any tab, arms nothing and cancels nothing, even with a leg executing
      // behind it (ADR-0140 §1). A run view opened from it is the run view's: its second press is what cancels.
      interrupt = pressTabHostInterrupt().state;
      showInterruptHint(false);
      leaveTabHost();
      return;
    }
    if (screen.kind === 'gate-card') {
      // `Ctrl+C` on a card closes the card AND the view it was opened from (ADR-0139 §5): it never answers, and it arms nothing (a card
      // is not a run to cancel). `Esc` is the one step back, to the view.
      showInterruptHint(false);
      closeScreen();
      return;
    }
    const leg = runScreenLeg(screen.runId, deps.hostedRuns?.snapshot() ?? state.hostedRun);
    const decision = pressRunViewInterrupt(interrupt, leg, interruptNow());
    interrupt = decision.state;
    switch (decision.action) {
      case 'arm-run-cancel':
        showInterruptHint(true);
        return;
      case 'cancel-run':
        showInterruptHint(false);
        cancelHostedRun();
        return;
      case 'wait-for-stop':
        showInterruptHint(false); // a hint only: it arms nothing, and the view already says it is waiting
        return;
      case 'close-screen':
        showInterruptHint(false);
        closeScreen();
        return;
    }
  };
  // Returns whether the key was consumed; `false` leaves an open overlay to close itself on `Ctrl+C`, arming nothing.
  const handleInterrupt = (): boolean => {
    if (state.screen !== undefined) {
      handleScreenInterrupt(state.screen);
      return true;
    }
    const active = state.mode === 'chat' ? state.session : undefined;
    if (active !== undefined && tearingDown === active) return true; // a key arriving mid-teardown drives nothing
    const decision = pressInterrupt(interrupt, interruptContext(active), interruptNow());
    interrupt = decision.state;
    switch (decision.action) {
      case 'end-session':
        showInterruptHint(false);
        if (active === undefined) {
          requestExit();
        } else {
          abortActive(active);
          cancelActive(active);
        }
        return true;
      case 'stop-and-arm':
        if (active !== undefined) abortActive(active);
        showInterruptHint(true);
        return true;
      case 'clear-text':
        submitEpoch += 1; // the buffer is consumed: a pending `@` mention read must not splice its marker into the empty draft
        history = resetHistoryNav(history);
        set({ input: emptyEditor() });
        return true;
      case 'arm-hint':
        showInterruptHint(true);
        return true;
      case 'close-overlay':
        showInterruptHint(false);
        return false;
      case 'exit-now':
        requestExit();
        return true;
    }
  };

  // Apply one reduced chat-key action: edits/motions fold the buffer, submit runs a `!`-command or sends a message,
  // and the surface actions (cycle-mode / abort / toggle-reasoning) drive the session.
  const applyChatAction = (active: HomeChatSession, action: ChatKeyAction): void => {
    switch (action.kind) {
      case 'append':
      case 'backspace':
      case 'newline':
      case 'kill': {
        const next = applyEditorAction(state.input, action);
        if (next === state.input) return; // a no-op edit must not reset the history draft or re-render
        history = resetHistoryNav(history); // a real text edit ends history navigation
        set({ input: next });
        return;
      }
      case 'move':
        applyMoveAction(action);
        return;
      case 'submit':
        applySubmitAction(active, action.line);
        return;
      case 'cycle-mode':
        // A swap (a model reseat or `/clear`) is building the chat that will replace this one: a mode change now would write its record
        // into the session the swap already read to seed the new chat's sequence, and the new chat's first turn would collide with it
        // (the UNIQUE index) and latch. The chat in front is about to be replaced, so the key waits for the chat that stays (MVP-11 step 5,
        // security round 1). `submitBusy` is not the gate: it also covers a running turn, whose refusal is the mode control's own notice.
        if (buildInFlight !== undefined) return;
        // Shift+Tab: advance the chat mode on the SAME session (ADR-0057; no reseat) — parity with `relavium chat`.
        active.onModeChange?.(nextMode(active.store.getSnapshot().mode));
        return;
      case 'toggle-reasoning':
        // Ctrl+T: flip the "thinking" panel (2.5.H) — a pure store-view toggle, no session effect. Parity with `relavium chat`.
        active.store.toggleReasoning();
        return;
      case 'abort':
        // Esc — the mid-turn abort: it stops the turn and keeps the session, and never arms (ADR-0115 §2).
        abortActive(active);
        return;
      case 'none':
        return;
    }
  };

  const handleChatKey = (active: HomeChatSession, input: string, key: ChatKey): void => {
    if (tearingDown === active) return; // a key arriving mid-teardown must not drive sendMessage on a cancelled session
    // Busy = a streaming turn OR a `!`-shell command in flight (`state.shellBusy` — the session has no store status
    // for it). A gated keystroke can't reach `sendMessage` → no `SessionStateError` crash.
    const running =
      active.store.getSnapshot().state.status === 'running' || state.shellBusy || state.submitBusy;
    if (routeMentionKey(chatMentions(active), input, key)) return;
    if (routeSearchKey(input, key)) return;
    const approvalPending = active.store.getSnapshot().approval !== undefined;
    if (tryOpenOverlay(active, input, key, running, approvalPending)) return;
    // Esc at an IDLE prompt with pending `@`/`!` attachments discards them (a clean cancel affordance — otherwise
    // Esc idle is a no-op; when a turn is running Esc is the mid-turn abort, handled below).
    if (key.escape === true && !running && !approvalPending && state.attachments.length > 0) {
      set({ attachments: [] });
      active.store.note('cleared pending attachments');
      return;
    }
    const action = reduceChatKey(input, key, state.input.text, running);
    // A repeat of the `Enter` that chose a file sends nothing.
    if (action.kind === 'submit' && pickEnter.holds(interruptNow())) return;
    applyChatAction(active, action);
  };

  /**
   * `Enter` on an unreadable run's row: its read-only card, over the run the snapshot holds under that id (never the run at the row's position:
   * a refresh may have moved it). A run the snapshot no longer lists says so, as every row that is gone does, and nothing is opened.
   */
  const openUnreadableCard = (runId: string): void => {
    const run = state.snapshot.unreadableRuns.find((candidate) => candidate.runId === runId);
    if (run === undefined) {
      set({ stripFocus: undefined, notice: STRIP_ROW_GONE });
      return;
    }
    if (deps.openUnreadableRun === undefined) {
      set({ notice: UNREADABLE_CARD_UNAVAILABLE });
      return;
    }
    deps.openUnreadableRun({ run });
  };

  /**
   * What `Enter` does on a focused strip row (ADR-0140 §6): a parked run opens its gate or budget card, a session is resumed, and a failed or
   * recent run opens its detail in History (nothing is resumed or answered from it). The run this Home hosts opens its view instead, as the run row does.
   */
  const activateStripRow = (row: StripRow): void => {
    if (row.role === 'session') {
      openResume(row.id);
      return;
    }
    if (row.role === 'parked') {
      openGateCard(row.id, 'landing');
      return;
    }
    if (row.role === 'unreadable') {
      openUnreadableCard(row.id);
      return;
    }
    const hosted = deps.hostedRuns?.snapshot().active?.runId === row.id;
    if (hosted && openRunView()) return;
    openRunDetail(row.id);
  };

  /** A key as the pages read it ({@link reducePageKey}): the two arrows, `Esc`, `Enter`, a key that types, or any other key. */
  const pageKeyOf = (input: string, key: HomeKey & ChatKey): PageKey => {
    if (key.downArrow === true) return 'down';
    if (key.upArrow === true) return 'up';
    if (key.escape === true) return 'escape';
    if (key.return === true) return 'return';
    return input.length > 0 && key.ctrl !== true && key.meta !== true ? 'types' : 'other';
  };

  /**
   * The pages' own keys (MVP-11 unit 7, `reducePageKey`): `↓` from the landing down to the work page (its first row, or its docked prompt when
   * no row can be focused), `↑` from the first row and `Esc` anywhere on the work page back up (the draft kept), the arrows along the rows and
   * off their ends (past the last row onto the docked prompt; from the docked prompt's first line back onto the last row), `Enter` on a row
   * what the row's kind says, and a key that types on a row moves to the docked prompt and is typed there. The focus names a row by its
   * identity: a refresh that takes the row off the list drops the focus (it never moves it onto another row), and `Enter` on a focus whose row
   * is gone opens nothing and says so (ADR-0140 §6). Whether the key was handled; any other key is the prompt's.
   */
  const handlePageKey = (input: string, key: HomeKey & ChatKey): boolean => {
    const rows = stripRows(state.parkedRuns, state.snapshot);
    const rowIndex = focusFor(rows, state.stripFocus);
    if (state.stripFocus !== undefined && rowIndex === undefined) {
      // Not reachable while `set` keeps the focus on the rows it is given: a focus that names a row the list no longer has is dropped.
      if (key.return === true) {
        set({ stripFocus: undefined, notice: STRIP_ROW_GONE });
        return true;
      }
      set({ stripFocus: undefined });
    }
    const outcome = reducePageKey(pageKeyOf(input, key), {
      page: state.homePage,
      rowIndex,
      rowCount: rows.length,
      draft: state.input,
      paletteOpen: state.palette !== undefined,
      canContinue: !homeIsEmpty(state.snapshot, state.parkedRuns),
    });
    switch (outcome.kind) {
      case 'pass':
        return false;
      case 'to-work':
        turnPage('work', { stripFocus: outcome.focus === 'rows' ? focusAt(rows, 0) : undefined });
        return true;
      case 'to-start':
        turnPage('start', { stripFocus: undefined });
        return true;
      case 'step-row':
        set({ stripFocus: focusAt(rows, (rowIndex ?? 0) + outcome.delta) });
        return true;
      case 'to-last-row':
        set({ stripFocus: focusAt(rows, rows.length - 1) });
        return true;
      case 'to-docked':
        set({ stripFocus: undefined });
        // `↓` past the last row is spent; a key that types is then the docked prompt's (typed, or `/` opening the palette over it).
        return outcome.afterwards === 'none';
      case 'open-row': {
        const row = rows[rowIndex ?? -1];
        if (row === undefined || rowIndex === undefined) return true;
        activateStripRow(row);
        // A screen it opened gives the focus back to this row when it closes (OB77, `restoreRowFocus`).
        if (state.screen !== undefined)
          screenFromRow = { focus: { kind: row.kind, id: row.id }, index: rowIndex };
        return true;
      }
    }
  };

  const handleHomeKey = (input: string, key: HomeKey & ChatKey, focusDropped: boolean): void => {
    // Ctrl-D (EOF) on an EMPTY prompt exits cleanly, the REPL convention (a non-empty buffer keeps it — no data loss).
    if (key.ctrl === true && input === 'd' && state.input.text.length === 0) {
      requestExit();
      return;
    }
    // The `Enter` that follows a refresh dropping the focused row was meant for that row, not for the empty prompt (which would show the
    // run view, or open provider setup when keyless): it is ignored once, with no notice, and the next one is the prompt's own.
    if (focusDropped && key.return === true && state.stripFocus === undefined) return;
    const action = reduceHomeKey(input, key);
    if (state.mode === 'loading') return; // ignore edits/submit while a session builds (Ctrl+C bails, in `handleInterrupt`)
    if (handlePageKey(input, key)) return;
    // `Tab` at the landing's empty prompt fills the example in (ADR-0146 §1), where the example is on screen (the landing, nothing typed): the
    // editor then holds the fixed example with the cursor at its end, and `Enter` sends it as any typed line. Any other `Tab` is what it was:
    // nothing (the work page's docked prompt shows no example).
    if (
      key.tab === true &&
      key.shift !== true &&
      key.ctrl !== true &&
      key.meta !== true &&
      exampleIsShown(state.homePage === 'start', state.input.text)
    ) {
      set({ input: editorFromText(EXAMPLE_PROMPT), notice: undefined });
      return;
    }
    // Open the `/` palette at an idle, EMPTY Home prompt (the Home has no running turn) — the discovery entry point
    // (2.5.C S3c). The Home palette shows the home-applicable commands; selecting runs over the Home context.
    if (shouldOpenPalette(input, key, false, state.input.text.length)) {
      set({ ...openPaletteState(undefined), notice: undefined }); // running another command clears a stale notice
      return;
    }
    if (handleLandingDraftKey(input, key)) return;
    switch (action.kind) {
      case 'submit':
        // A repeat of the `Enter` that chose a file starts no chat (and, on an empty draft, opens nothing).
        if (pickEnter.holds(interruptNow())) return;
        submit();
        return;
      case 'none':
        return;
      default: {
        // Every buffer edit / cursor motion (append / backspace / newline / move / kill) folds via the shared
        // applyEditorAction — the Home prompt is a first-class line editor too (2.5.D step 2). A NO-OP motion (a
        // cursor key at a boundary — applyEditorAction returns the SAME reference) must not clear a visible notice
        // the person is reading; only a real change does (the first real edit means the user has moved on).
        const next = applyEditorAction(state.input, action);
        if (next === state.input) return;
        set({ input: next, notice: undefined });
        return;
      }
    }
  };

  /**
   * The key at an open overlay, whether one took it. Each open overlay owns EVERY key while it is open, and only one opens at a time:
   * - the `/` palette, before the mode dispatch, so it overlays Home/chat input;
   * - the `/models` picker (2.5.G S7), opened from the bare-Home palette (next-session default, ADR-0063) OR a live in-Home chat (a typed
   *   or palette `/models` → the reseat picker, ADR-0059), so it is routed before the mode branches.
   *
   * The routes are ORDERED handlers, not a list of flags, so a new overlay needs its branch here (or in the chat's own key handler, where the
   * `@`-mention and the reverse search are routed) AND a flag in `overlay-flags.ts`: the record's tests fail until the flag decides its gates.
   */
  const routeOverlayKey = (input: string, key: HomeKeyEvent): boolean => {
    if (state.palette !== undefined) {
      handlePaletteKey(input, key);
      return true;
    }
    // The Home's own `@`-completion (its prompts have no session) owns every key while it is open; a chat's is routed by the chat's handler.
    if (state.mention !== undefined && state.session === undefined)
      return routeMentionKey(landingMentions(), input, key);
    return false;
  };

  // The open-overlay + mode key router — extracted from `handleKey` so its bracketed-paste handling stays within the
  // cognitive-complexity budget. Precedence (each open overlay owns EVERY key while open, and only one opens at a
  // time): the `/` palette → the `/models` picker → the live chat → else the bare Home.
  const dispatchKey = (input: string, key: HomeKeyEvent): void => {
    // Any key ends "the focus was just dropped"; the landing's own handling below is told, once, whether this key was the first after it.
    const focusDropped = focusJustDropped;
    focusJustDropped = false;
    // Any key but `Enter` is the person typing: an `Enter` after it is theirs, never a repeat of the one that chose a file.
    if (key.return !== true) pickEnter.typed();
    // The exit-guard card (ADR-0139 §6) owns every key while it is open, `Ctrl+C` included: there it is a cancel, not the keymap's.
    if (state.exitGuard !== undefined) {
      routeExitGuardKey(state.exitGuard, input, key);
      return;
    }
    // `Ctrl+C` is the interrupt keymap's before anything else (ADR-0115 §1); any other key ends the armed state.
    if (isInterruptKey(input, key)) {
      if (handleInterrupt()) return;
    } else {
      disarmInterrupt();
    }
    // The screen in front (ADR-0140 §1) owns every key that is left: no overlay is open while it is, and the prompt is not offered.
    if (state.screen !== undefined) {
      routeScreenKey(state.screen, input, key);
      return;
    }
    // In a chat its store stamps the keys (the line its palette sends included); every other key from here on is the landing's, or a list's
    // over it.
    if (state.mode !== 'chat' || state.session === undefined) landingKeys.stamp();
    if (routeOverlayKey(input, key)) return;
    if (state.mode === 'chat' && state.session !== undefined) {
      handleChatKey(state.session, input, key);
      return;
    }
    handleHomeKey(input, key, focusDropped);
  };

  /** A key through the Home's gates (see {@link HomeController.handleKey}): the live route, and the route a key the slide queued takes. */
  const routeKey = (input: string, key: HomeKeyEvent): void => {
    if (!exiting && !state.nativeActionBusy) dispatchKey(input, key);
  };
  /** A bracketed paste through the Home's gates (see {@link HomeController.handlePaste}). */
  const pasteText = (text: string): void => {
    if (exiting || state.nativeActionBusy) return;
    disarmInterrupt(); // a paste is a key too: it ends the armed state (ADR-0115 §1)
    focusJustDropped = false; // and the one ignored `Enter` after a dropped focus
    pickEnter.typed(); // and the `Enter` held off after a file was chosen: the next `Enter` is the person's
    if (state.exitGuard !== undefined) return; // the exit-guard card answers to keys only, never to a paste
    if (state.screen !== undefined) {
      // A screen answers to keys only: a paste reaches neither it nor the prompt behind it. A card counts it as typing, so a chord
      // soon after it is refused.
      if (state.screen.kind === 'gate-card') state.screen.card.paste(text);
      // The tab host drops it too, and a withdrawal's question that was waiting is dropped with it: a paste is typing (ADR-0137 §2).
      else if (state.screen.kind === 'tab-host') {
        const host = disarmTabHost(state.screen.host);
        if (host !== state.screen.host) set({ screen: { kind: 'tab-host', host } });
      }
      return;
    }
    // ink 7 delivers a whole bracketed paste as ONE native event; CRLF/CR → LF (matching a typed newline), and every C0, DEL and C1 control
    // but TAB and LF dropped, as a typed chunk's are (`draftText`, MVP-11 unit 7 round 2: F6).
    // Dropped (not char-inserted) unless the main prompt is the active editable target — `pasteEditable` mirrors
    // the old bracketed-paste gate and additionally refuses a pending approval (the fail-closed floor, ADR-0057)
    // and a card. Type-ahead behind a busy/overlay state is deferred (2.5.B).
    const pasted = draftText(text);
    // An open `ask_user` card owns a paste (ADR-0132): it goes into the card's own-answer field or is dropped.
    if (pasted.length > 0 && state.session?.store.pasteIntoQuestion(pasted) === true) return;
    if (pasted.length === 0 || !pasteEditable()) return;
    // An append clears a stale notice, like a typed edit.
    history = resetHistoryNav(history); // a paste is a real edit ⇒ end history nav (parity with append/backspace/kill)
    set({
      input: insertAtCursor(state.input, pasted),
      notice: undefined,
      stripFocus: undefined,
    });
  };

  // ---- The strip's idle refresh (ADR-0140 §6) --------------------------------------------------------------------------------
  // The strip is read when the Home opens and when a chat or a screen returns; between those, a person looking at the landing sees what
  // another terminal does only through this tick. It uses the Active tab's poll (`createActivePoll`): every five seconds it asks the change
  // token (`PRAGMA data_version`, the in-process generation, the hosted run) and reads the strip only when that moved. It is paused, not
  // stopped, while anything else has the keyboard or the screen, and it is cancelled with the Home's other timers when the Home ends.
  const stripPollPaused = (): boolean =>
    stripRefreshPaused({ mode: state.mode, ...overlayFlags(), terminal });
  /** A newer read of the strip: published only when it differs from what the landing shows, so an idle tick never repaints. */
  const applyStripRead = (read: StripRead): void => {
    const parked = withoutExecutingRun(read.parked, deps.hostedRuns?.snapshot());
    const snapshotMoved = !isDeepStrictEqual(read.snapshot, state.snapshot);
    const parkedMoved = !sameParkedRows(parked, state.parkedRuns);
    if (!snapshotMoved && !parkedMoved) return;
    const focused = state.stripFocus;
    set({
      ...(snapshotMoved ? { snapshot: read.snapshot } : {}),
      ...(parkedMoved ? { parkedRuns: parked } : {}),
    });
    // A read of what ANOTHER terminal changed took the focused row off the strip under a person who was looking at it: an `Enter` they aimed
    // at it must not fall through to the empty prompt's own (the run view, or provider setup when keyless), so the first `Enter` after the
    // drop is ignored once (`focusJustDropped`). Not when the row left because this Home started a leg on that run (the person answered its
    // gate: they know it has gone), and it is set here and nowhere else: the other reads of the rows follow the person's own act (a leg that
    // started or ended, a screen that closed). Only the landing counts: behind a screen, a card or a chat the person is not looking at the strip.
    const ownLeg =
      focused?.kind === 'run' && deps.hostedRuns?.snapshot().active?.runId === focused.id;
    if (focused !== undefined && state.stripFocus === undefined && !ownLeg && landingInFront())
      focusJustDropped = true;
  };
  const strip = deps.strip;
  if (strip !== undefined) {
    // The strip's own schedule (not the generic poll's, which the Active tab shares): while its reads keep failing the next attempt waits
    // twice as long (5, 10, 20, 40, then 60 s at most), and it is one interval again after a read that was applied or a token that moved.
    const backoff = createStripBackoff(
      (callback, delayMs) => schedule(callback, delayMs),
      stripSeed,
    );
    stripPoll = createActivePoll<StripRead>({
      schedule: backoff.schedule,
      now: () => interruptNow(),
      token: () => backoff.observe(strip.token()),
      // Both reads of the strip are SQLite on the Home's own connection, taken in one synchronous stretch: the rows of one read describe
      // one moment, and the poll applies them in the same turn, so a card cannot open between the read and its paint. A parked-rows read
      // that throws fails the whole read (`readParkedRowsOrThrow`): it is never counted as applied with the old rows under it.
      read: () =>
        Promise.resolve({
          snapshot: deps.homeStore.read(),
          parked: readParkedRowsOrThrow(deps.gateCards, state.parkedRuns),
        }),
      apply: (read) => {
        backoff.succeeded();
        // A timer or promise callback has no input handler around it to route a listener's failure, so it is routed here.
        try {
          applyStripRead(read);
        } catch (error) {
          failHome(error);
        }
      },
      paused: stripPollPaused,
      isClosed: strip.isClosed,
      // A failed read keeps the rows the strip has, and the next attempt comes later each time.
      onError: backoff.failed,
      intervalMs: STRIP_REFRESH_MS,
      // What the strip READS does not depend on the clock alone (ADR-0140 §6: it reads when the change token moved, and a read that matches what
      // is shown repaints nothing), so a token that has not moved is never a reason to read. Its relative words (`5m ago`, `expires in 5m`)
      // are worded when the landing is painted from the clock then, and what repaints it for the clock alone is not this poll but its own
      // timer ({@link RELATIVE_WORDS_REPAINT_MS}, below), which repaints with no read.
      maxAgeMs: Number.POSITIVE_INFINITY,
      // The strip was read as the Home was built, so the first tick compares with the token taken before that read instead of reading
      // again: a commit that landed in between is read at the first tick. A token that could not be taken makes the poll read at once.
      after: stripSeed,
    });
    stripPoll.start();
  }

  // ---- The repaint for the clock (ADR-0140 §6, MVP-11 unit 7 round 2: F8) ---------------------------------------------------
  // The relative words of the landing and the work page (`expires in 5m`, `failed 2h ago`, `waiting 3h`) are worded from the clock when a
  // frame is painted, so a Home nothing touches kept the words of its last paint (`expires in 13s` stood for 45 s; `expires in 5m`, for hours,
  // past the deadline). While such a word is on the idle landing or the work page, ONE timer repaints it every RELATIVE_WORDS_REPAINT_MS: a
  // new state with the same rows, and no read. It is armed and cancelled by `syncWordsTick`, which `set` runs after every change, so it
  // exists only while a word is on screen and the strip's own pause facts (not the landing: a chat, a screen, a card, a popup, a palette, a
  // terminal under the floor) do not hold; and it is cancelled with the Home's other timers when the Home ends.
  //
  // A POPUP pauses it without ending it (round 2: F4). The popup host's open state is no state of this controller, so the popup's close calls
  // no `set` here: a chain ended under a popup would never be armed again until a key. So the timer stays armed while a popup alone covers the
  // landing (`wordsTickArmed`), and a tick under it repaints nothing (`wordsTickWanted`) and arms the next: the first tick after the close
  // repaints the words with no key pressed.
  function wordsTickArmed(): boolean {
    return (
      wordsTickReady &&
      !exiting &&
      !stripRefreshPaused({ mode: state.mode, ...overlayFlags(), popup: false, terminal }) &&
      showsRelativeWords({
        page: state.homePage,
        snapshot: state.snapshot,
        parked: state.parkedRuns,
      })
    );
  }
  function wordsTickWanted(): boolean {
    return wordsTickArmed() && !stripPollPaused();
  }
  function syncWordsTick(): void {
    const armed = wordsTickArmed();
    if (armed && cancelWordsTick === undefined)
      cancelWordsTick = schedule(onWordsTick, RELATIVE_WORDS_REPAINT_MS);
    else if (!armed && cancelWordsTick !== undefined) {
      cancelWordsTick();
      cancelWordsTick = undefined;
    }
  }
  function onWordsTick(): void {
    cancelWordsTick = undefined;
    // `set` arms the next tick while a relative word is still on screen; a tick that finds none repaints nothing and ends the chain, and a tick
    // under a popup repaints nothing and arms the next (see above). A timer callback has no input handler around it to route a listener's
    // failure, so it is routed here, as the strip's tick routes its own.
    if (!wordsTickWanted()) {
      syncWordsTick();
      return;
    }
    try {
      set({});
    } catch (error) {
      failHome(error);
    }
  }
  wordsTickReady = true;
  syncWordsTick();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    setProviderState(keyless, notice) {
      // The provider setup tells only whether a key exists now (what it did is its Done step or one notification, ADR-0148 §6); a host's other
      // notice (`noteEffectAttention`) still lands in the Home's notice area. Nothing is written into a conversation's transcript.
      if (!exiting)
        set({
          keyless,
          ...(notice === undefined ? {} : { notice }),
          ...(state.mode === 'home' ? statusPatch() : {}),
        });
    },
    openProviderSetup() {
      if (!exiting) openProviderSetup();
    },
    handleKey(input, key) {
      // Bracketed paste is handled natively by ink 7's `usePaste` → `handlePaste` (a channel separate from
      // `useInput`), so a pasted multi-line block never arrives here char-by-char and a pasted approval token can
      // never reach the approval reducer. Every real keystroke is dispatched by the open-overlay + mode router; while the
      // pages slide it waits in order (a `Ctrl+C` ends the slide and does not wait: MVP-11 unit 7).
      if (exiting || state.nativeActionBusy || queuedForSlide({ kind: 'key', input, key })) return;
      routeKey(input, key);
    },
    disarmInterrupt,
    interruptAnswered() {
      const active = state.mode === 'chat' ? state.session : undefined;
      if (exiting || state.nativeActionBusy || active === undefined || tearingDown === active)
        return;
      const decision = pressInterrupt(interrupt, { kind: 'card' }, interruptNow());
      interrupt = decision.state;
      if (decision.action === 'end-session') {
        showInterruptHint(false);
        cancelActive(active);
      } else {
        showInterruptHint(true);
      }
    },
    setTerminalSize(columns, rows) {
      terminal = { columns, rows };
      syncWordsTick(); // a terminal below the floor pauses the repaint for the clock, one big enough again arms it
      // A resize while the pages slide ends the slide where it would arrive (MVP-11 unit 7).
      if (state.slide !== undefined) arriveSlide(false);
    },
    openScreen,
    closeScreen,
    bindGateCardFrame(visible) {
      gateCardVisible = visible;
    },
    bindHomeFrame(visible) {
      homeFrameVisible = visible;
    },
    exitGuardLock,
    homeFrameShown(shown) {
      // The arrival of a slide is on screen: what waited for it is applied now (MVP-11 unit 7).
      if (settlingSlide && shown === state && !exiting) drainSlideQueue();
    },
    openPermissionsAsCommand() {
      if (exiting || deps.permissions === undefined) return;
      // The popup is the run's whole job: it ends with it, whichever way it closes. A popup that could not open leaves the Home as it is, with the
      // reason on its own channel (the host's gate says one sentence).
      if (!openLandingSetting('/permissions', () => requestExit()))
        set({ notice: 'Remembered commands are not available here.' });
    },
    handlePaste(text) {
      // While the pages slide the paste waits its turn behind the keys that came before it (MVP-11 unit 7).
      if (exiting || state.nativeActionBusy || queuedForSlide({ kind: 'paste', text })) return;
      pasteText(text);
    },
    async teardownActive() {
      exiting = true; // terminating: a deferred endChat/clearChat skips the (about-to-close) db; an in-flight build reclaims itself
      stopHostedTimers(); // a signal ends the Home on its own bound: the exit guard's wait must not fire after it
      // During a `/clear` swap (ADR-0062 §7) BOTH are live at once — the OLD session (`state.session`, still
      // rendered) AND the fresh build (`buildInFlight`) — so reap BOTH; a signal mid-swap must orphan neither MCP
      // child. Outside a swap exactly one is set (a live chat ⇒ session only; a first-message `loading` build ⇒
      // build only). Both teardowns are idempotent, so an overlap with clearChat's/submit's own exiting-arm reap
      // is harmless.
      const active = state.session;
      if (active !== undefined) {
        if (tearingDown === active) {
          // A teardown is ALREADY in flight (an endChat/clearChat / error-arm) — await THAT graceful close rather
          // than returning early, so the bounded signal race waits for the MCP handshake instead of hard-killing it.
          // `.catch` so a rejecting teardown can't make this (signal-path) call reject.
          await (activeTeardown ?? Promise.resolve()).catch(() => undefined);
        } else {
          tearingDown = active;
          const td = active.teardown();
          activeTeardown = td;
          await td.catch(() => undefined);
        }
      }
      // The in-flight build: a signal during the `loading` first-message build window OR the `/clear` swap build.
      // Await + reap it so its spawned MCP child / frame loop is never orphaned (bounded by driveHome's
      // force-teardown race). submit's/clearChat's exiting-arm may also reap it once it resolves; both call the
      // SAME idempotent teardown, so the overlap is harmless — awaiting here guarantees the reap within the bound.
      const pending = buildInFlight;
      if (pending !== undefined) {
        const built = await pending.catch(() => undefined);
        if (built !== undefined) await built.teardown().catch(() => undefined);
      }
      await nativeInFlight?.catch(() => undefined);
    },
  };
}
