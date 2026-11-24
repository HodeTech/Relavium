import { isDeepStrictEqual } from 'node:util';

import type { UserCommandOutcome } from '@relavium/core';
import type { ModelCatalogEntry } from '@relavium/llm';
import { secretMaskRanges } from '@relavium/llm/scrub-secrets';
import type { ReasoningEffort } from '@relavium/shared';

import {
  HOME_CHAT_PALETTE_COMMANDS,
  HOME_PALETTE_COMMANDS,
  homeOnlyPointer,
  REPL_COMMANDS_BY_NAME,
  unavailableNotice,
  type ReplCommandContext,
} from '../../commands/repl-commands.js';
import type { RefreshReport } from '../../engine/model-refresh.js';
import { providerDisplayName } from '../../engine/providers.js';
import { ConfigWriteRefusedError } from '../../config/write.js';
import { createActivePoll, type ActivePoll } from '../../history/active-poll.js';
import type { ActiveRead } from '../../history/active-source.js';
import type { ChangeToken } from '../../history/change-probe.js';
import {
  canControlEffort,
  foldEffortPickerKey,
  initialEffortPickerState,
  type EffortPickerState,
} from './effort-picker.js';
import type { PermissionsPort } from '../../permissions/chat-permissions.js';
import { HOME_HELP_COMMANDS } from './help-sheet.js';
import { disarmPermissionsSheet, sheetCanArm } from './permissions-sheet.js';
import { AGENT_UNREADABLE, foldAgentSheetKey } from './agent-sheet.js';
import {
  agentChatSheet,
  permissionsChatSheet,
  permissionsSheetOf,
  type ChatSheetState,
} from './chat-sheet.js';
import type { BoundAgentView } from '../../chat/bound-agent-view.js';
import {
  foldPermissionsSheetThroughPort,
  openPermissionsSheetThroughPort,
  PERMISSIONS_UNREADABLE,
} from './permissions-sheet-port.js';
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
  withDefinedNote,
  withHistoryLoad,
  withHistoryLoadFailure,
  withSessionsNote,
  type TabEntry,
  type TabHostState,
  type TabId,
  type TabMemory,
} from './tab-host.js';
import type { HistoryPort } from './tab-host-history.js';
import type { PinPort } from './tab-host-pin.js';
import { SESSIONS_RESUME_UNAVAILABLE, type SessionsPort } from './tab-host-sessions.js';
import type { DefinedPort } from './tab-host-workflows.js';
import { foldModelPickerKey, partialFailureBanner, type ModelPickerState } from './model-picker.js';
import type { ReseatTarget } from '../../commands/chat.js';
import { effortRowLabel } from '../../chat/effort-notice.js';
import { nextMode, type ChatMode } from '../../chat/chat-mode.js';
import { clearedNotice, modelSwitchNotice } from '../../chat/repl-info.js';
import { formatDoctorReport, runDoctorChecks, type DoctorProbes } from '../../chat/doctor.js';
import {
  agentStartNotice,
  agentStartReasonOf,
  type HomeAgentRequest,
} from '../../home/agent-start.js';
import type { AgentsPort } from '../../home/agents-port.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
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
  buildOutbound,
  commandResultPreview,
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
  type PaletteKey,
  type PaletteList,
  type PaletteState,
} from './palette-reducer.js';
import {
  FORCE_TEARDOWN_MS,
  HOSTED_RUN_EXIT_GRACE_MS,
  HOSTED_RUN_POLL_MS,
} from './tui-constants.js';
import { hostedRunIsLive, type ExitGuardPhase } from './home-projection.js';
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
  focusFor,
  resolveFocus,
  stepFocus,
  stripRows,
  type StripFocus,
  type StripRow,
} from './strip-focus.js';
import type { RunStore } from './run-store.js';
import { runScreenLeg, runScreenPhase } from './run-screen.js';
import { nearestCommandName } from './command-typo.js';
import { hostedEndNotice, type ParkedRunRow } from './home-attention.js';
import { createRunCard, type RunCard, type RunCardSnapshot } from './run-card-model.js';
import { createChordGuard, createChordHistory, type ChordHistory } from './chord-guard.js';
import { resolveApprovalGuard, type ApprovalGuard } from './tool-review-model.js';
import { sanitizeInline, sanitizeUntrusted } from '../sanitize.js';

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
  /** Set the reasoning-effort tier (ADR-0066 §5) — the in-Home `/models` effort sub-step calls it on a SAME-model
   *  pick (a per-turn session override, NO reseat) + the `/effort` command. Absent ⇒ the effort sub-step is not
   *  offered. The current tier is read live from `store` (`ChatStoreSnapshot.reasoningEffort`), not tracked here. */
  readonly onSetEffort?: (effort: ReasoningEffort) => void;
  /** The `/permissions` sheet's port (ADR-0137 §2): a typed or palette-selected bare `/permissions` opens the sheet over this chat.
   *  Absent ⇒ the command is dispatched and says remembered commands are not available. */
  readonly permissions?: PermissionsPort;
  /** The view of the agent this chat is bound to ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   *  §3): a typed or palette-selected bare `/agent` opens the read-only sheet over this chat, from the definition the session holds (a reseat
   *  builds a new session, so it is the provider and model the chat runs on now). Absent ⇒ the command is dispatched and prints a notice. */
  readonly boundAgent?: () => BoundAgentView;
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
   *  in-Home chat (S3b); the command set + the run-on-select path differ by surface (see `handlePaletteKey`). */
  readonly palette: PaletteState | undefined;
  /** The rows the open palette reads: built ONCE when it opens and when its query changes, and read by BOTH the key fold and the view, so
   *  they cannot disagree on the highlighted row (MVP-11 Step 2.2). Stale while the palette is closed; the view reads it only when open. */
  readonly paletteList: PaletteList | undefined;
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
  /** The open `/models` picker (2.5.G S7, ADR-0064 §10) — `undefined` ⇒ closed. HOME-ONLY (a next-session config
   *  action); a keyboard-owning overlay like the palette. Opened from the Home palette's `/models`; on selection it
   *  writes the next session's default (ADR-0063), never rebinding the live session. Mutually exclusive with the palette. */
  readonly modelPicker: ModelPickerState | undefined;
  /** The open standalone `/effort` overlay (ADR-0066 §6) — `undefined` ⇒ closed. CHAT-scoped (a live in-Home chat
   *  with the effort setter wired + a reasoning-capable model); a keyboard-owning overlay like the mention/search
   *  submodes. On accept it pushes the per-turn session override via `active.onSetEffort` (no reseat). */
  readonly effortPicker: EffortPickerState | undefined;
  /** The open docked sheet of a live in-Home chat — `undefined` ⇒ closed. ONE slot for every sheet a chat has, a union by kind
   *  ({@link ChatSheetState}): `/permissions` (ADR-0137 §2, both lists) and `/agent` (ADR-0140 §3, the bound agent, read-only). A
   *  keyboard-owning overlay like `/effort`, opened only at an idle prompt, so no card can arrive while it is open, and one value, so two
   *  sheets cannot be open at once. The bare Home's `/permissions` is not this: it is the Permissions tab of the tab host, a kind of
   *  {@link HomeControllerState.screen} (ADR-0140 §3). */
  readonly chatSheet: ChatSheetState | undefined;
  /** The interrupt keymap is armed (ADR-0115 §1): a second `Ctrl+C` inside the window ends the chat or exits the Home, and the
   *  footer hint says so. Cleared by any other key and by the window running out. */
  readonly interruptArmed: boolean;
  /** The run host's snapshot, as of the last read (ADR-0139 §3): the strip's `▶` row and the exit-guard card show it. `undefined`
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
  /** The Home can open a gate card (a port is wired): the run view of a parked run then offers `Enter`. */
  readonly gateCards: boolean;
}

/**
 * The Home's record of what owns the keyboard, built ONCE from its own state ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): every gate of the controller (the screen slot, the paste gate, the interrupt context, the strip's and the Active tab's pauses) and
 * of its host (`home-app.tsx`) asks `overlay-flags.ts` about this record instead of listing the overlays again. The cards are the live
 * chat store's, read now. `nativePrompt` is `false` here: the prompt channel is the HOST's, which sets it on top of this record.
 */
export function homeOverlayFlags(state: HomeControllerState): OverlayFlags {
  return {
    palette: state.palette !== undefined,
    search: state.search !== undefined,
    mention: state.mention !== undefined,
    modelPicker: state.modelPicker !== undefined,
    effortPicker: state.effortPicker !== undefined,
    chatSheet: state.chatSheet !== undefined,
    screen: state.screen !== undefined,
    exitGuard: state.exitGuard !== undefined,
    nativePrompt: false,
    nativeActionBusy: state.nativeActionBusy,
    ...cardFlagsFrom(state.session?.store.getSnapshot()),
  };
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

/**
 * The landing's `/help` sheet ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3): the commands the Home answers to and the keys of the landing, drawn by `help-sheet.ts`. It has nothing to remember, so the kind
 * carries nothing; `Esc` and `Ctrl+C` close it, every other key does nothing and a paste is dropped.
 */
export interface HelpScreen {
  readonly kind: 'help';
  /** A sheet has no run, no live output and no notice ring: all three read as `undefined`, so a reader of the slot needs no narrowing to ask. */
  readonly runId?: undefined;
  readonly store?: undefined;
  readonly notices?: undefined;
}

/** The slot's contents. */
export type HomeScreen = RunViewScreen | GateCardScreen | TabHostScreen | HelpScreen;

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
  /** User-initiated refresh (Ctrl+R), regardless of TTL. Provider faults are isolated; owned stop can reject. */
  refresh: () => Promise<RefreshReport>;
  /** The current `[preferences].default_model` (the picker's `✓` marker), or `undefined` when none is set. */
  currentDefault: () => string | undefined;
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
  /** Original Home invocation; observe publication before local recovery and retain entered doctor work. */
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
  /** The `/doctor` probes (2.5.C S5) — the Home palette's `/doctor` runs the fast tier over these into `notice`. */
  readonly doctorProbes: DoctorProbes;
  /** The `/models` catalog port (2.5.G S7, ADR-0064) — absent ⇒ `/models` degrades to an honest "unavailable"
   *  notice (a test may omit it). Production (`driveHome`) always wires the real db-backed port. */
  readonly models?: HomeModelsPort;
  /** The bare Home's permissions port (ADR-0137 §3, ADR-0140 §3): the project's remembered commands only, there being no chat, and the
   *  repository's allowlist, read again every time the Permissions tab is entered. Absent ⇒ the Home has no tab to open (a test may omit
   *  it); a live chat's own port, for its docked sheet, is `HomeChatSession.permissions`. */
  readonly permissions?: PermissionsPort;
  readonly openModeSettings?: () => Promise<void>;
  readonly initializeProject?: () => Promise<string>;
  /**
   * Launch a workflow from the Home ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §7): the
   * picker, the form and the confirmation, all on the native prompt channel, then the host's start. It resolves with the notice the
   * Home shows; it holds the native action for as long as the flow is open, so no key reaches the composer meanwhile. A Home command
   * only: a live chat never reaches it (the typed `/run` is routed here only with no session, and the chat palette does not list it).
   * Absent ⇒ `/run` says it is unavailable. With a `slug` the picker is skipped (the Defined tab's `r`), and with the catalog `path` the
   * row was listed from the flow refuses a slug whose file is another one by then.
   */
  readonly launchRun?: (slug?: string, path?: string) => Promise<string>;
  /**
   * The Defined tab's read, over the project's catalog and pins ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §2): read again every time the tab is entered. Absent ⇒ the tab says it cannot list, and a typed `/workflows` at the Home says the
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
   * What `p` pins and unpins through, on the Defined and the History tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §5). Absent ⇒ `p` says pinning is unavailable.
   */
  readonly pins?: PinPort | undefined;
  /**
   * The `/agents` strip's Defined tab: the project's agent catalog, read again every time the tab is entered ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §3). Absent ⇒ a typed `/agents` says the agents are not available here.
   */
  readonly agents?: AgentsPort | undefined;
  /**
   * The `/agents` strip's Sessions tab: this project's saved conversations, the list the `/resume` picker offers, read again every time the
   * tab is entered. `Enter` on a row resumes it through {@link HomeControllerDeps.resumeChat}. Absent ⇒ the tab says it cannot list.
   */
  readonly sessions?: SessionsPort | undefined;
  /**
   * The Defined tab's export card: prepare the export of one catalog workflow, show where it would be written, and write it only on a
   * Yes. It resolves with the sentence the tab shows; it holds the native action while the card is open. Absent ⇒ `x` says export is
   * unavailable.
   */
  readonly exportDefined?: ((slug: string) => Promise<string>) | undefined;
  /**
   * `/import` at the landing ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
   * §9): ask for a path, show what the import would write, and write the file only on a Yes. It resolves with the sentence the landing shows;
   * it holds the native action while the card is open. A Home word: with a chat in front the typed line is the chat's. Absent ⇒ `/import`
   * says import is unavailable in this session.
   */
  readonly importDefined?: (() => Promise<string>) | undefined;
  /**
   * `/pricing` at the landing (ADR-0140 §9): the form that sets or clears the operator's own price for a model, and the card that records it
   * only on a Yes. It resolves with the sentence the landing shows; it holds the native action while the form is open. A Home word, as
   * `/import` is. Absent ⇒ `/pricing` says model pricing is not available here.
   */
  readonly pricing?: (() => Promise<string>) | undefined;
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
   * The one timer the run watch and the exit grace use: call `callback` once after `delayMs` and return the function that cancels it.
   * Default is `setTimeout` with an unreferenced handle; a test injects its own clock so nothing sleeps.
   */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly pickSession?: () => Promise<string | undefined>;
  readonly resumeChat?: (
    sessionId: string,
  ) => Promise<HomeChatSession | { readonly notice: string } | undefined>;
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
  /** The terminal's size, told by the host whenever it changes: the permissions sheet needs it to know whether it can show a
   *  withdrawal's question (ADR-0137 §2), and the strip's idle tick reads nothing below 80×24 (ADR-0140 §6). Until it is told, both
   *  assume a terminal that can. */
  readonly setTerminalSize: (columns: number, rows: number) => void;
  /**
   * Open the tab host on the Permissions tab as the whole job of this run (a bare `relavium permissions` on a terminal, ADR-0137 §3,
   * ADR-0140 §1): the screen opens at once and, when the person closes it, the Home ends with success instead of staying open behind it.
   * If it cannot open (no port, or the port cannot be read) the Home stays, with the reason in its notice, as it does for the typed command.
   */
  readonly openPermissionsAsCommand: () => void;
  /**
   * Put a screen in front of the landing ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1).
   * It replaces whatever the slot held, and returns whether it opened: it refuses while the Home is not the landing (a chat or its
   * build), an overlay is open, the exit-guard card is up or the Home is ending. The screen then owns every key, and no paste reaches
   * the prompt behind it.
   */
  readonly openScreen: {
    (kind: 'run-view', props: RunViewProps): boolean;
    (kind: 'tab-host', props: TabHostProps): boolean;
    (kind: 'help'): boolean;
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
  /** Tear down a live chat session (if any), for the signal handler — idempotent, never the shared db. */
  readonly teardownActive: () => Promise<void>;
}

/**
 * What a draft that looks like a provider key is answered with when there is no key yet (ADR-0146 §6): the draft was cleared, not kept and not
 * recorded, and the key belongs in the setup that has just opened. Fixed text: it never echoes the draft.
 */
export const KEY_SHAPED_DRAFT_NOTICE =
  'That looked like an API key, so it was not kept. Paste it in the setup that just opened; it is stored in your OS keychain.';

/** What `Enter` on a failed or recent run says when the Home has no run history to open it from. */
const RUN_HISTORY_UNAVAILABLE = 'The run history is not available here.';

/** What the landing says when a session resume ends because the person cancelled one of its interactive steps. */
const RESUME_CANCELLED = 'Resume cancelled.';

/** What `Enter` says on a focused row the strip no longer lists: nothing was opened. */
const STRIP_ROW_GONE = 'That row is no longer on the strip. Nothing was opened.';

/** How often the strip looks at the change token while the landing is in front (ADR-0140 §6). */
export const STRIP_REFRESH_MS = 5000;

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
        row.expiresAt === other.expiresAt
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
    paletteList: undefined,
    search: undefined,
    mention: undefined,
    shellBusy: false,
    submitBusy: false,
    shellCommand: undefined,
    attachments: [],
    historyEntries: [],
    notice: undefined,
    noticeRevision: 0,
    modelPicker: undefined,
    effortPicker: undefined,
    chatSheet: undefined,
    interruptArmed: false,
    hostedRun: undefined,
    exitGuard: undefined,
    screen: undefined,
    parkedRuns: readParkedRows(deps.gateCards, NO_PARKED),
    stripFocus: undefined,
    gateCards: deps.gateCards !== undefined,
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
  // Set when the strip's idle refresh drops the focused strip row because another terminal removed it: the first `Enter` after it is ignored
  // once (the person's `Enter` was meant for that row), and any other key, and any screen that opens or closes, ends it. It is a flag of
  // the landing's key handling, not something a screen draws.
  let focusJustDropped = false;
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
  // A monotonic token: a `/doctor` run captures it at start and lands its report only if it is still current —
  // any prompt edit / submit (which bumps it) invalidates a stale in-flight run so an old report can't reappear.
  let doctorRunId = 0;
  // A monotonic submit generation: bumped when the compose buffer is submitted (cleared). An async mention read
  // captures it at accept time and drops its inject if a submit has since happened — so a slow read resolving after
  // Enter can never splice the file into the (now-empty) buffer meant for the NEXT message (the session-identity
  // guard only catches a chat SWAP, not an in-chat submit that stays in the same session/mode).
  let submitEpoch = 0;
  // A monotonic `/models` picker generation (2.5.G S7): bumped on every picker open. An async catalog refresh
  // captures it and lands its result ONLY if the picker is still on the SAME generation — so a slow refresh
  // resolving after the picker was closed AND reopened can never clobber the fresh picker (the `doctorRunId` pattern).
  let pickerEpoch = 0;

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
  const overlayFlags = (): OverlayFlags => homeOverlayFlags(state);
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
  const set = (patch: Partial<HomeControllerState>): void => {
    const noticeRevision = state.noticeRevision + ('notice' in patch ? 1 : 0);
    const before = state;
    state = { ...state, ...patch, noticeRevision };
    // The strip's focus is the identity of a row (`strip-focus.ts`): whenever the rows are replaced it is resolved on the new ones, so it
    // follows its row, moves to the nearest one when the row is gone, and is never left naming nothing.
    if (!('stripFocus' in patch) && ('snapshot' in patch || 'parkedRuns' in patch)) {
      const stripFocus = resolveFocus(
        stripRows(state.parkedRuns, state.snapshot),
        state.stripFocus,
      );
      if (stripFocus !== state.stripFocus) state = { ...state, stripFocus };
    }
    // A screen or a card that opens or closes ends the swallowed `Enter` (see `focusJustDropped`): the first key after the landing comes
    // back is the landing's own.
    if (before.screen !== state.screen) focusJustDropped = false;
    syncActivePoll();
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
    (terminal !== undefined &&
      !sheetCanArm({ columns: terminal.columns, terminalRows: terminal.rows }));
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
  // loading bail-out and a closed `relavium permissions` sheet all call it, and `exitHome` is reached only from here. With no leg
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
    cancelHostedPoll?.();
    cancelHostedPoll = undefined;
    cancelExitGrace?.();
    cancelExitGrace = undefined;
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
    const line = hostedEndNotice({ runId: end.runId, disposition: end.terminal.disposition }, row);
    if (line !== undefined) chat.store.note(line);
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
  const requestExit = (): void => {
    if (exiting || state.exitGuard !== undefined) return;
    const snapshot = deps.hostedRuns?.snapshot();
    if (snapshot === undefined || decideExit(hostedLeg(snapshot)) === 'exit') {
      exitHome();
      return;
    }
    set({
      exitGuard: 'confirm',
      hostedRun: snapshot,
      palette: undefined,
      stripFocus: undefined,
    });
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
  // A bare `relavium permissions` opens the tab host as the run's whole job: closing it ends the run (ADR-0137 §3, ADR-0140 §1).
  let tabHostIsTheCommand = false;
  /** What entering the Active tab starts from: the last read this Home kept, or `undefined` when nothing feeds the tab. */
  const activeEntry = (): { readonly last: ActiveRead | undefined } | undefined =>
    deps.active === undefined ? undefined : { last: lastActiveRead };
  /** What entering a tab reads from, as it is now. */
  const tabEntry = (): TabEntry => ({
    port: deps.permissions,
    defined: deps.defined,
    active: activeEntry(),
    history: deps.history,
    pins: deps.pins,
    agents: deps.agents,
    sessions: deps.sessions,
    now: interruptNow(),
  });
  /** The tab host on `memory`'s tab, every tab read again as it is entered; `undefined` when the Permissions tab cannot be read at all. */
  const tabHostScreen = (memory: TabMemory): TabHostScreen | undefined => {
    const host = enterTab(memory, memory.tab, tabEntry());
    // Permissions that cannot be read opens nothing. The Defined tab that cannot be read still opens, on a line that says so: it is what
    // a typed `/workflows` asked for, and the other tabs are one key away.
    return host.unreadable && host.tab === 'permissions' ? undefined : { kind: 'tab-host', host };
  };
  const openTabHost = (tab: TabId): boolean => {
    if (!slotAdmits() || state.submitBusy || state.nativeActionBusy) return false;
    const screen = tabHostScreen({ ...tabMemory, tab });
    // The port could not be read: nothing opens, and the Home says why where the person who asked is looking.
    if (screen === undefined) {
      set({ notice: PERMISSIONS_UNREADABLE });
      return false;
    }
    tabMemory = tabHostMemory(screen.host);
    putScreen(screen);
    return true;
  };
  /** The tab host back in front after a screen opened from it is left with `Esc`: the tab and the row it came from, read again. */
  const reopenTabHost = (): void => {
    const screen = tabHostScreen(tabMemory);
    if (screen === undefined) {
      // The permissions cannot be read on the way back: the tab host is gone, and the reason is said where the person is looking. As
      // `leaveTabHost` does for a fault with a note, a bare command then keeps the Home open with the note instead of ending silently.
      leaveTabHost(PERMISSIONS_UNREADABLE);
      return;
    }
    putScreen(screen, parkedPatch());
  };
  /** The landing's `/help` sheet (ADR-0140 §3): it opens from the landing only, like the browsers, and tells the screen nothing. */
  const openHelp = (): boolean => {
    // A screen already in the slot is never replaced by the help sheet: a gate card would lose its dispose.
    if (state.screen !== undefined || !slotAdmits() || state.submitBusy || state.nativeActionBusy)
      return false;
    tabMemory = freshTabMemory(); // nothing a tab host remembered is kept for a screen that cannot come back to it
    putScreen({ kind: 'help' });
    return true;
  };
  function openScreen(kind: 'run-view', props: RunViewProps): boolean;
  function openScreen(kind: 'tab-host', props: TabHostProps): boolean;
  function openScreen(kind: 'help'): boolean;
  function openScreen(
    kind: 'run-view' | 'tab-host' | 'help',
    props?: RunViewProps | TabHostProps,
  ): boolean {
    if (kind === 'help') return openHelp();
    if (props === undefined) return false;
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
    tabMemory = freshTabMemory(); // the tab host's life ends with the screen (ADR-0140 §1)
    // A bare `relavium permissions` is the tab host as the command's whole job. A screen that is closed here is the whole chain leaving (the
    // tab host through `leaveTabHost`, which has cleared the flag and asked for the exit itself; or a card's `Ctrl+C`, or a run view's
    // close, opened from the tab host: the one slot closes and the tab host goes with them), so the flag is read before it is cleared and
    // the command ends with the screen by any way out. A flag left set made an `Esc` on a later `/workflows` leave the Home.
    const asCommand = tabHostIsTheCommand;
    tabHostIsTheCommand = false;
    disarmInterrupt();
    if (asCommand) {
      // The exit guard may hold the Home open (a leg is live): the screen is closed behind its card, as `leaveTabHost` closes it.
      requestExit();
      if (exiting) return; // the last frame such a run leaves is the screen's, not a Home prompt
    }
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
        `The Active tab of /workflows shows what the run waits for. Could not read run ${sanitizeInline(runId)}.`,
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
          `No gate to decide here: see what it waits for in /workflows (run ${sanitizeInline(runId)}).`,
          back,
          from,
        );
      return false;
    }
    const card = createRunCard({
      runId: run.runId,
      gates,
      resume: answerGate,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(port.guard === undefined ? {} : { guard: port.guard }),
      history: chordHistory,
      painted: (snapshot) => gateCardVisible?.(snapshot) === true,
    });
    // The Attention rows are read again as the card opens: what put the person here may be a moment old.
    putScreen({ kind: 'gate-card', runId: run.runId, card, back, from }, parkedPatch());
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
      case 'help':
        // The sheet owns every key and answers to `Esc` alone (`Ctrl+C` is the interrupt keymap's, before this): every other key does nothing.
        if (key.escape === true) closeScreen();
        return;
    }
  };
  /**
   * The tab host closes: the screen with it, and the run with it when this tab host is a bare `relavium permissions`. The last frame such
   * a run leaves (the scrollback of the inline renderer) is the screen's, not a Home prompt, so the closed state is never published on
   * the way out; unless the screen closed because of a fault (`note`): then the Home stays with the note, so that it can be read.
   */
  const leaveTabHost = (note?: string): void => {
    const asCommand = tabHostIsTheCommand;
    tabHostIsTheCommand = false; // the command is over either way: a tab host opened later is an ordinary one
    if (asCommand && note === undefined) {
      requestExit();
      // The exit guard may have held the Home open (a leg is live): the screen it was closed from must not stay open behind the card.
      if (!exiting) closeScreen();
      return;
    }
    closeScreen();
    if (note !== undefined) set({ notice: note });
  };
  /** A key at the tab host: its pure model decides, the controller carries a close out and keeps what the tabs remember. */
  const routeTabHostKey = (screen: TabHostScreen, input: string, key: HomeKeyEvent): void => {
    const step = foldTabHostKey(screen.host, input, key, {
      port: deps.permissions,
      defined: deps.defined,
      active: activeEntry(),
      history: deps.history,
      pins: deps.pins,
      agents: deps.agents,
      sessions: deps.sessions,
      canArm:
        terminal === undefined ||
        sheetCanArm({ columns: terminal.columns, terminalRows: terminal.rows }),
      now: interruptNow(),
    });
    if (step.kind === 'close') {
      leaveTabHost(step.note);
      return;
    }
    // `Enter` on a conversation of the Sessions tab: the screen closes and the resume begins in ONE state change (`resumeFromSessions`).
    if (step.kind === 'resume') {
      resumeFromSessions(step.sessionId, step.state);
      return;
    }
    // `c` on an agent's detail: the screen closes and the chat bound to that agent begins in ONE state change (`startAgentChat`).
    if (step.kind === 'chat') {
      startAgentChat(step.agent);
      return;
    }
    tabMemory = tabHostMemory(step.state);
    if (step.state !== screen.host) set({ screen: { kind: 'tab-host', host: step.state } });
    // A request of the Defined tab: the tab is left as the key left it, and the native flow takes the keyboard for the run or the card.
    if (step.kind === 'run') openDefinedRun(step.slug, step.path);
    else if (step.kind === 'export') openDefinedExport(step.slug);
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
  const routeExitGuardKey = (phase: ExitGuardPhase, input: string, key: HomeKeyEvent): void => {
    disarmInterrupt(); // any key at the card ends the armed interrupt state (ADR-0115 §1)
    const stamp = exitGuardChord.stamp();
    if (phase === 'stopping') return; // the wait is bounded and cannot be taken back: no key changes it
    const answer = pressExitGuardKey(input, key);
    if (answer === 'confirm') {
      if (exitGuardChord.decide(stamp, 'allow', homeFrameVisible?.(state) === true) === undefined)
        return; // refused: the card is still open and nothing is decided
      confirmExit();
    } else if (answer === 'stay') set({ exitGuard: undefined });
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
        set({
          session: undefined,
          input: emptyEditor(),
          notice: undefined, // a stale build-failure notice or /doctor report must not leak into the returned Home
          pendingMessage: '',
          snapshot: deps.homeStore.read(), // the just-finished chat now shows in the refreshed strip
          ...parkedPatch(), // and a run it left parked, or one answered meanwhile, in the refreshed Attention rows
          keyless: deps.providerSetup?.readKeyless?.() ?? state.keyless,
          mode: 'home',
          palette: undefined, // a palette left open when /exit ran must not leak into the returned Home
          search: undefined, // ditto a reverse-search submode
          mention: undefined, // ditto an `@`-completion submode
          effortPicker: undefined, // ditto the `/effort` overlay (chat-scoped — closed on return to the bare Home)
          chatSheet: undefined, // and the chat's docked sheet (`/permissions`, `/agent`): it is gone with the chat, and with a reseat or a `/clear`
          modelPicker: undefined, // ditto the `/models` picker (Home-only, so never open here — reset for hygiene)
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
  // one is swapped in, its transcript opening with the clearedNotice naming the prior (resumable) conversation.
  const clearChat = (old: HomeChatSession): void => {
    if (exiting || tearingDown === old) return; // permanent stop or a double-/clear race
    if (old.clear === undefined) {
      old.resumeAfterFailedClear?.();
      old.store.notice('Starting a fresh conversation is unavailable for this bound agent.');
      return;
    }
    const oldId = old.sessionId;
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
        fresh.store.notice(clearedNotice(oldId)); // name the prior (resumable) conversation in the fresh transcript
        set({
          session: fresh,
          mode: 'chat', // STAY in chat (no bare-Home flash) — the defining difference from endChat
          input: emptyEditor(),
          notice: undefined,
          pendingMessage: '',
          palette: undefined,
          search: undefined,
          mention: undefined,
          modelPicker: undefined,
          effortPicker: undefined,
          chatSheet: undefined,
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
    if (reseat === undefined) return; // acceptModel only calls this when a builder IS wired (defensive)
    if (tearingDown === old) return; // already ending this session (mirror clearChat)
    const oldId = old.sessionId;
    set({ modelPicker: undefined, submitBusy: true }); // close the picker + re-gate input for the whole swap
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
          modelSwitchNotice(old.store.getSnapshot().state.model ?? '(unknown)', target.modelId),
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
          modelPicker: undefined,
          effortPicker: undefined,
          chatSheet: undefined,
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
        // The reseat build FAILED — keep the OLD session live + resumable (do NOT tear it down); surface a fully
        // STATIC, secret-free note (no model id interpolated) and un-gate it so the user can keep going or /exit.
        if (state.session === old) {
          old.store.note('/models could not switch the model — keeping this conversation.');
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
   */
  const openNativeAction = (
    operation: () => Promise<void>,
    label: string,
    patch: Partial<HomeControllerState> = {},
  ): void => {
    if (exiting || state.nativeActionBusy) return;
    set({ nativeActionBusy: true, palette: undefined, ...patch });
    void driveNativeAction(operation, label).catch(failHome);
  };

  const openProviderSetup = (options?: {
    readonly note: string;
    readonly patch: Partial<HomeControllerState>;
  }): void => {
    const port = deps.providerSetup;
    if (port === undefined) {
      // Whatever the caller had to change in the same breath (a draft that is a key is cleared) is still changed: nothing is kept for a
      // setup that will not open. Its own reason, which says where to paste the key, would be false here, so the notice is this one.
      set({ ...options?.patch, notice: 'Provider setup is unavailable in this session.' });
      state.session?.store.note('Provider setup is unavailable in this session.');
      return;
    }
    openNativeAction(
      () => port.open(options === undefined ? undefined : { note: options.note }),
      'Provider setup',
      options?.patch,
    );
  };
  const openProjectInit = (): void => {
    const open = deps.initializeProject;
    if (open === undefined) {
      set({ notice: 'Project initialization is unavailable in this session.' });
      state.session?.store.note('Project initialization is unavailable in this session.');
      return;
    }
    openNativeAction(async () => {
      const notice = await open();
      if (!exiting) {
        set({ notice });
        state.session?.store.note(notice);
      }
    }, 'Project initialization');
  };

  /**
   * Whether the launch that has just returned STARTED a run, told by the leg it left behind; `before` is the host's snapshot taken before the
   * launch began. The run this Home hosts is another one than it was before, and the host was not already starting one then: a leg that is
   * still acquiring its run (a resume) has no run id yet, so the id it gets while this launch is refused would read as a run THIS launch
   * started. A refusal (another leg already executes or starts) or a cancel leaves that other leg as it was, and its view is not what the
   * launch asked for. `/run` and `r` on a Defined row both ask here, so the two cannot drift.
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
   * `/run`: the launch flow. A run that started is shown at once (`Esc` leaves it running and `Enter` on the empty prompt comes back); a
   * launch that was refused or left opens no view, and its notice stays on the landing, where the person who typed it is looking: the view of
   * ANOTHER run that executes at the time is not what `/run` asked for ({@link launchStartedRun}).
   */
  const openRunLaunch = (): void => {
    const launch = deps.launchRun;
    if (launch === undefined) {
      set({ notice: 'Running a workflow is unavailable in this session.' });
      return;
    }
    openNativeAction(async () => {
      const before = deps.hostedRuns?.snapshot();
      const notice = await launch();
      if (exiting) return;
      set({ notice, ...parkedPatch() }); // a launch that was refused at a gate, or a run it just parked, changes the rows
      if (launchStartedRun(before)) openRunView();
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
        `Continuing a run is unavailable in this session: see what it waits for in /workflows (run ${sanitizeInline(runId)}).`,
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
   * A sentence for the person who is looking at the Defined tab: the tab's message row, which the next key drops. With another screen in
   * front (or none) it is the landing's notice, which is where such a person would look.
   */
  const noteOnDefinedTab = (text: string): void => {
    const screen = state.screen;
    if (screen?.kind !== 'tab-host' || screen.host.defined === undefined) {
      set({ notice: text });
      return;
    }
    set({ screen: { kind: 'tab-host', host: withDefinedNote(screen.host, text) } });
  };

  /**
   * `r` on a Defined row: the launch flow, started at that workflow (its picker is skipped once; the form, the confirmation that defaults
   * to No and the single start are the flow's own). A run that started is shown at once and `Esc` returns to the tab; a launch that was
   * refused or left says so on the tab. A run STARTED is told by {@link launchStartedRun}, as `/run` tells it: a refusal leaves another
   * leg as it was, and its view is not what `r` asked for, so the refusal is shown on the tab instead.
   */
  const openDefinedRun = (slug: string, path: string): void => {
    const launch = deps.launchRun;
    if (launch === undefined) {
      noteOnDefinedTab('Running a workflow is unavailable in this session.');
      return;
    }
    openNativeAction(async () => {
      const before = deps.hostedRuns?.snapshot();
      const notice = await launch(slug, path);
      if (exiting) return;
      set({ notice, ...parkedPatch() });
      if (!launchStartedRun(before) || !openRunView('tab-host')) noteOnDefinedTab(notice);
    }, 'Run workflow');
  };

  /** `x` on a Defined row: the export card. What it writes, it writes only on a Yes, and the tab says what happened. */
  const openDefinedExport = (slug: string): void => {
    const exportDefined = deps.exportDefined;
    if (exportDefined === undefined) {
      noteOnDefinedTab('Export is unavailable in this session.');
      return;
    }
    openNativeAction(async () => {
      const notice = await exportDefined(slug);
      if (!exiting) noteOnDefinedTab(notice);
    }, 'Export');
  };

  /**
   * `/import` at the landing: the import card. Typed and chosen from the palette it is this one function, so the two cannot drift. What the
   * card writes, it writes only on a Yes; the sentence it resolves with is the landing's notice, which is where the person who typed it looks.
   */
  const openImportCard = (): void => {
    const importDefined = deps.importDefined;
    if (importDefined === undefined) {
      set({ notice: 'Import is unavailable in this session.' });
      return;
    }
    openNativeAction(async () => {
      const notice = await importDefined();
      if (!exiting) set({ notice });
    }, 'Import');
  };

  /** `/pricing` at the landing: the model pricing form and its card, opened as {@link openImportCard} is. */
  const openPricingCard = (): void => {
    const pricing = deps.pricing;
    if (pricing === undefined) {
      set({ notice: 'Model pricing is not available here.' });
      return;
    }
    openNativeAction(async () => {
      const notice = await pricing();
      if (!exiting) set({ notice });
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
          land((host) => withHistoryLoad(host, runId, load));
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
   * a detail opened from a History row is, and `Esc` steps back to the list and then to the landing. No run is written, resumed or
   * cancelled from the strip (`p` on the detail only marks a finished run), so a run of another directory opens as well as this one's. A
   * Home with no history to read says so.
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
   * Resume a saved conversation: the one in `selectedId`, or the one the picker returns. `leaving` is published with the action's first state
   * change (see {@link openNativeAction}); it is used only when the action starts, so a resume that is not available leaves it unpublished.
   */
  const openResume = (selectedId?: string, leaving?: Partial<HomeControllerState>): void => {
    const resume = deps.resumeChat;
    if (resume === undefined || (selectedId === undefined && deps.pickSession === undefined)) {
      const notice = SESSIONS_RESUME_UNAVAILABLE;
      set({ notice });
      state.session?.store.note(notice);
      return;
    }
    const operation = async (): Promise<void> => {
      const old = state.session;
      const id = selectedId ?? (await deps.pickSession?.());
      if (id === undefined || exiting) return;
      if (old?.sessionId === id) {
        old.store.note('This conversation is already open.');
        return;
      }
      const result = await resume(id);
      if (result === undefined) {
        // The person cancelled an interactive step of the restore (the retry question, `Esc` while it restored): the landing says so
        // instead of coming back as if nothing had been asked.
        if (!exiting) {
          set({ notice: RESUME_CANCELLED });
          old?.store.note(RESUME_CANCELLED);
        }
        return;
      }
      if ('notice' in result) {
        if (!exiting) {
          set({ notice: result.notice });
          old?.store.note(result.notice);
        }
        return;
      }
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
        modelPicker: undefined,
        effortPicker: undefined,
        chatSheet: undefined,
        shellBusy: false,
        shellCommand: undefined,
        submitBusy: true,
      });
      activateSession(result, () => set({ submitBusy: false }));
    };
    openNativeAction(operation, 'Session resume', leaving);
  };

  /**
   * `Enter` on a conversation of the `/agents` Sessions tab: the resume the strip's session row makes (`openResume`), and the screen goes in
   * the same state change that starts it, so the chat that opens is never under the tab host and the landing is never drawn between the two.
   * What closing the screen would reset is reset here and published with it: the tab host's memory, the interrupt window and the parked rows.
   * A Home that cannot resume says so on the tab, which stays. A conversation that cannot be resumed leaves the landing with the resume's own
   * notice (the screen is already gone), and a tab host opened again starts at its top.
   */
  const resumeFromSessions = (sessionId: string, host: TabHostState): void => {
    if (deps.resumeChat === undefined) {
      const next = withSessionsNote(host, SESSIONS_RESUME_UNAVAILABLE);
      tabMemory = tabHostMemory(next);
      set({ screen: { kind: 'tab-host', host: next } });
      return;
    }
    // No guard on `exiting` or `nativeActionBusy` here: a key reaches a screen only through `handleKey`, which drops every key in either state,
    // and `openNativeAction` refuses both itself.
    tabMemory = freshTabMemory();
    tabHostIsTheCommand = false; // only a bare `relavium permissions` is the command, and its tab host has no Sessions tab
    disarmInterrupt();
    openResume(sessionId, { screen: undefined, ...parkedPatch() });
  };

  /**
   * A registry word typed at the landing (ADR-0140 §3): answered here, never sent to the model. `/help` opens the sheet; a word of the
   * bare Home's palette runs as the palette runs it (over the Home's own context, with no arguments); any other registry word is a
   * chat's, and the notice says so. The line is cleared first, as every other command's is.
   */
  const answerLandingWord = (word: string, withArguments: boolean): void => {
    set({ input: emptyEditor() });
    const name = word.slice(1);
    if (name === 'help') {
      if (withArguments) set({ notice: '/help accepts no arguments.' });
      else openScreen('help');
      return;
    }
    const command = HOME_PALETTE_COMMANDS.find((entry) => entry.name === name);
    if (command === undefined) {
      set({
        notice: `${word} works in a chat. Start one, then type it. /help lists the commands.`,
      });
    } else if (withArguments) {
      set({ notice: `${word} accepts no arguments here. Start a chat to use them.` });
    } else {
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
    if (REPL_COMMANDS_BY_NAME.has(token.slice(1))) {
      if (!landing) return false; // a chat's own command: the dispatch takes it
      answerLandingWord(token, text.length > token.length);
      return true;
    }
    const nearest = nearestCommandName(
      token,
      (landing ? HOME_HELP_COMMANDS : HOME_CHAT_PALETTE_COMMANDS).map(
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

  const managementCommand = (text: string): boolean => {
    // A word only the Home has, typed in the chat it hosts (`/providers`, `/init`, `/import`, `/pricing`, `/run`, `/agents`): one line that
    // names the Home, and nothing opens (ADR-0145 §7.4, OD-2). `/resume` has a placement here, so it is not one of them.
    if (state.session !== undefined && text.startsWith('/')) {
      const pointer = homeOnlyPointer(text.slice(1).split(/\s/u, 1)[0] ?? '', 'home-chat');
      if (pointer !== undefined) {
        set({ input: emptyEditor() });
        state.session.store.notice(pointer); // the channel the chat's own dispatch answers through (`emitOutput`)
        return true;
      }
    }
    if (state.session === undefined && /^\/mode(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/mode')
        set({ notice: 'No conversation is active. Use /mode to set the startup default.' });
      else if (deps.openModeSettings === undefined)
        set({ notice: 'Startup mode settings are unavailable here.' });
      else openNativeAction(deps.openModeSettings, 'Startup mode settings');
      return true;
    }
    if (/^\/resume(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/resume') {
        set({ notice: '/resume accepts no arguments. Use its picker to select a session.' });
        state.session?.store.note(
          '/resume accepts no arguments. Use its picker to select a session.',
        );
      } else openResume();
      return true;
    }
    if (state.session === undefined && /^\/permissions(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/permissions') set({ notice: '/permissions accepts no arguments.' });
      else if (deps.permissions === undefined)
        set({ notice: 'Remembered commands are not available here.' });
      else openTabHost('permissions');
      return true;
    }
    // `/workflows` at the Home opens the tab host on its Defined tab (ADR-0140 §2, MVP-8 step 4); it no longer starts a chat. With a chat
    // in front it is the chat's own command, which lists what the project holds, and it is not routed here.
    if (state.session === undefined && /^\/workflows(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/workflows') set({ notice: '/workflows accepts no arguments.' });
      else if (deps.defined === undefined)
        set({ notice: 'The project’s workflows are not available here.' });
      else openTabHost('defined');
      return true;
    }
    // `/agents` at the Home opens the tab host on the agents strip's Defined tab (ADR-0140 §3, MVP-8 step 5). It is a Home command only: with a
    // chat in front it is not routed here, so it reaches the chat as the unknown slash it is and starts nothing, as `/run` does.
    if (state.session === undefined && /^\/agents(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/agents') set({ notice: '/agents accepts no arguments.' });
      else if (deps.agents === undefined)
        set({ notice: 'The project’s agents are not available here.' });
      else openTabHost('agents');
      return true;
    }
    // `/run` is a Home command only (ADR-0139 §7): with a chat in front it is not routed here, so it reaches the chat as the unknown
    // slash it is and starts nothing. (The chat palette does not list it either.)
    if (state.session === undefined && /^\/run(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/run')
        set({ notice: '/run accepts no arguments. Use its picker to choose a workflow.' });
      else openRunLaunch();
      return true;
    }
    // `/import` and `/pricing` are Home words too (ADR-0140 §9): a card each, opened only at the landing. With a chat in front they are not
    // routed here, and the chat's own dispatch answers the line as the unknown slash it is, as it answers `/run`.
    if (state.session === undefined && /^\/import(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/import')
        set({ notice: '/import accepts no arguments. It asks for the path.' });
      else openImportCard();
      return true;
    }
    if (state.session === undefined && /^\/pricing(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/pricing') set({ notice: '/pricing accepts no arguments.' });
      else openPricingCard();
      return true;
    }
    if (/^\/init(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/init') {
        set({ notice: '/init accepts no arguments.' });
        state.session?.store.note('/init accepts no arguments.');
      } else openProjectInit();
      return true;
    }
    if (/^\/providers(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor() });
      if (text !== '/providers') {
        set({ notice: '/providers accepts no arguments.' });
        state.session?.store.note('/providers accepts no arguments.');
      } else openProviderSetup();
      return true;
    }
    if (/^\/provider(?:\s|$)/u.test(text)) {
      set({ input: emptyEditor(), notice: 'Use /providers to connect or manage provider keys.' });
      state.session?.store.note('Use /providers to connect or manage provider keys.');
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
   * The exception is a draft that looks like a provider key (what the secret scrubber would mask). It is never kept and never recorded: the
   * history database is unencrypted and cannot be deleted, so a pasted key must not survive there or in the prompt. The editor is cleared
   * in the same state change that opens the setup, and the notice says why and where the key goes.
   */
  const connectProviderKeepingDraft = (): void => {
    if (secretMaskRanges(state.input.text).length === 0) {
      openProviderSetup();
      return;
    }
    openProviderSetup({
      note: KEY_SHAPED_DRAFT_NOTICE,
      patch: { input: emptyEditor(), notice: KEY_SHAPED_DRAFT_NOTICE },
    });
  };

  const submit = (): void => {
    if (exiting) return;
    const trimmed = state.input.text.trim();
    if (trimmed.length === 0) {
      set({ input: emptyEditor() });
      if (openRunView()) return; // the strip's `▶` row: `Enter` brings back the view of the run that is executing
      if (state.keyless) openProviderSetup();
      return;
    }
    if (managementCommand(trimmed)) return;
    if (state.keyless) {
      connectProviderKeepingDraft();
      return;
    }
    // The message as it was typed, before the editor is cleared: a build that fails gives it back (G6).
    const draft = state.input.text;
    history = recordHistory(history, trimmed); // the message that starts the chat is recallable via Up in it
    // `palette: undefined` makes the loading-state invariant explicit (the palette is never open during a build)
    // rather than only implied by the key-routing order — mirroring the `endChat` reset.
    doctorRunId += 1; // a submit invalidates any in-flight /doctor run (its report must not land on the new chat)
    set({
      input: emptyEditor(),
      notice: undefined,
      pendingMessage: trimmed,
      mode: 'loading',
      palette: undefined,
      search: undefined,
      mention: undefined,
      modelPicker: undefined,
      effortPicker: undefined,
      chatSheet: undefined,
      historyEntries: history.entries,
    });
    awaitBuild(
      deps.startChat(),
      (built) => {
        set({ session: built, mode: 'chat', submitBusy: true, exitGuard: undefined });
        activateSession(built, () => sendChatLine(built, trimmed, trimmed));
      },
      (err) => {
        // The message comes back to the prompt and the failure is shown WHOLE, in the notice area that wraps and pages: the one-row line it
        // used to be cut the remedy off at 80 columns (observed). A draft that looks like a key is not given back (ADR-0146 §6).
        const restorable = state.input.text === '' && secretMaskRanges(draft).length === 0;
        set({
          notice: `Couldn’t start the chat: ${sanitizeUntrusted(err instanceof Error ? err.message : String(err))}`,
          ...(restorable ? { input: editorFromText(draft) } : {}),
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
    tabHostIsTheCommand = false; // only a bare `relavium permissions` is the command, and its tab host has no agent detail
    disarmInterrupt();
    doctorRunId += 1; // as a submit does: an in-flight /doctor run must not land its report on the chat that opens
    set({
      screen: undefined,
      ...parkedPatch(),
      notice: undefined,
      pendingMessage: '', // there is no typed message to echo while it builds
      mode: 'loading',
      palette: undefined,
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

  // The `/models` picker (2.5.G S7, ADR-0064 §10) — a keyboard-owning overlay opened from the Home palette. The db
  // read + the merge are synchronous (`port.load()`); a refresh egresses and lands its result ONLY into the SAME
  // picker generation that kicked it — the monotonic `pickerEpoch` (bumped on every open) drops a resolve whose
  // picker has since closed or been REOPENED (the `doctorRunId` pattern; the identity half of loadMentions' guard).
  // Home-only: it can be open only in `mode: 'home'`, so no chat/session race applies. Two status channels are kept
  // SEPARATE — `banner` (async refresh partial-failure) vs `hint` (transient user-action feedback) — so a completing
  // refresh can never silently wipe a "not available"/"could not save" message the user just triggered.
  const applyRefreshResult = (epoch: number, report: RefreshReport | undefined): void => {
    const open = state.modelPicker;
    if (exiting || epoch !== pickerEpoch || open === undefined || deps.models === undefined) return; // stale/closed — drop it
    const failed =
      report?.providers.filter((p) => p.status === 'failed').map((p) => p.provider) ?? [];
    let view: ReturnType<HomeModelsPort['load']>;
    try {
      view = deps.models.load(); // a DB read — never crash the REPL (parity with runDoctor / acceptModel's guard)
    } catch {
      // Keep the last-shown entries; just drop the spinner and surface the refresh status.
      set({ modelPicker: { ...open, loading: false, banner: partialFailureBanner(failed) } });
      return;
    }
    // Keep the user's filter/selection + any transient hint; the view clamps a selection past the (shrunk) end.
    set({
      modelPicker: {
        ...open,
        entries: view.entries,
        refreshedAt: view.refreshedAt,
        loading: false,
        banner: partialFailureBanner(failed),
      },
    });
  };
  const runPickerRefresh = (refresh: () => Promise<RefreshReport | undefined>): void => {
    if (exiting) return;
    const epoch = pickerEpoch; // capture THIS picker generation so a reopened picker never adopts this result
    const open = state.modelPicker;
    if (open === undefined) return;
    set({ modelPicker: { ...open, loading: true } });
    void refresh().then(
      (report) => applyRefreshResult(epoch, report),
      () => {
        // Owner refusal rejects; never publish it after exit or into a later picker generation.
        const cur = state.modelPicker;
        if (!exiting && epoch === pickerEpoch && cur !== undefined)
          set({ modelPicker: { ...cur, loading: false } });
      },
    );
  };
  const openModelPicker = (): void => {
    if (exiting) return;
    const port = deps.models; // capture the narrowed port so the refresh closure needs no non-null assertion
    if (port === undefined) {
      set({ notice: '/models is unavailable here.' }); // defensive — production always wires the port
      return;
    }
    let view: ReturnType<HomeModelsPort['load']>;
    try {
      view = port.load(); // a DB read — a fault must not crash the REPL (the "never crash the REPL" discipline)
    } catch {
      set({ notice: '/models: could not read the model catalog.' });
      return;
    }
    pickerEpoch += 1; // a fresh generation — invalidates any in-flight refresh from a prior (closed) open
    // The `✓` marker: in a LIVE chat (ADR-0059 reseat) it is the session's BOUND model (the "you are here"); at the
    // bare Home it is the effective next-session default. The accept action mirrors this (reseat vs default-write).
    const active = state.session;
    const activeModel = active?.store.getSnapshot().state.model;
    // The effort sub-step (ADR-0066) is offered for a reasoning model on BOTH surfaces: a LIVE in-Home chat (the
    // setter is wired → the pick is a per-turn session override) AND the bare Home (ADR-0066 §6 → the pick writes the
    // NEXT session's effort default alongside the model). `currentEffort` opens the sub-list on the right tier: the
    // LIVE store tier in a chat (so a prior no-reseat `/effort` change is reflected), else the config effort default.
    const effortStep = active !== undefined ? active.onSetEffort !== undefined : true;
    // The effort sub-list's opening tier: absent when the sub-step isn't offered; else the LIVE store tier in a chat
    // (reflecting a prior no-reseat /effort change), else the config effort default in the bare Home.
    let currentEffort: ReasoningEffort | undefined;
    let currentDefault: string | undefined;
    try {
      if (effortStep)
        currentEffort =
          active !== undefined ? active.store.getSnapshot().reasoningEffort : port.currentEffort();
      currentDefault = activeModel ?? port.currentDefault();
    } catch {
      const notice =
        '/models: could not read chat settings. Check the configuration before retrying.';
      set({ notice });
      active?.store.note(notice);
      return;
    }
    set({
      notice: undefined, // opening the picker clears any stale /doctor report behind it
      modelPicker: {
        entries: view.entries,
        filter: '',
        selected: 0,
        loading: false,
        currentDefault,
        refreshedAt: view.refreshedAt,
        banner: undefined,
        hint: undefined,
        phase: 'model',
        effortStep,
        pending: undefined,
        effortTiers: [], // no model pending yet — populated on the model→effort transition
        effortSelected: 0,
        currentEffort,
      },
    });
    // Render the cache immediately (above), then kick a TTL-bounded background refresh (ADR-0064 §5c) — the Home is
    // the long-lived process the S5 background constraint requires. An empty/stale cache repopulates as it resolves.
    runPickerRefresh(() => port.refreshIfStale());
  };
  // The bare-Home config-write notice (ADR-0063): an HONEST re-read of the EFFECTIVE default (project → workspace →
  // global) — success only when the chosen model actually became effective; a higher-layer override says so; and a
  // post-write `undefined` read can only be a re-read fault (the global was just written valid), reported distinctly.
  const defaultWriteNotice = (
    effective: string | undefined,
    modelId: string,
    displayName: string,
    reasoningEffort: ReasoningEffort | undefined,
  ): string => {
    // The effort (ADR-0066 §6) is written to the SAME layer atomically, so it shares the model's effectiveness — the
    // suffix just names what was set (a reasoning model went through the effort sub-step; a non-reasoning one did not).
    // The label reads "on" for a budget model's canonical-on tier, matching the picker (ADR-0066 amendment).
    const effort =
      reasoningEffort === undefined
        ? ''
        : ` at effort ${effortRowLabel(modelId, reasoningEffort).label}`;
    if (effective === modelId)
      return `Default model set to ${displayName}${effort} — applies to your next chat session.`;
    if (effective === undefined) {
      return `Saved ${displayName}${effort} as your global default, but your config could not be re-read to confirm it.`;
    }
    return `Saved ${displayName}${effort} as your global default, but a project or workspace setting overrides it here.`;
  };

  // The BARE-Home next-session-default write (ADR-0063 · ADR-0066 §6). Persists the GLOBAL `[preferences].default_model`
  // and — when the effort sub-step ran for a reasoning model — `[preferences].reasoning_effort` too, in ONE atomic
  // write; a known config refusal keeps the picker open with a secret-free hint. The owned host observes
  // unexpected writer faults before this UI recovery; an ownerless embedding retains its inline recovery.
  const writeNextSessionDefault = (
    modelId: string,
    displayName: string,
    provider: ReseatTarget['provider'],
    reasoningEffort?: ReasoningEffort,
  ): void => {
    const port = deps.models;
    if (port === undefined) return;
    type Result = void | { readonly durability: 'confirmed' | 'unconfirmed' };
    const success = (result: Result): void => {
      if (exiting) return;
      let effective: string | undefined;
      try {
        effective = port.currentDefault();
      } catch {
        // Publication already happened. A strict reread refusal must not relabel it as an unsaved choice.
      }
      const suffix =
        result?.durability === 'unconfirmed' ? ' Crash persistence is unconfirmed.' : '';
      set({
        modelPicker: undefined,
        submitBusy: false,
        notice: defaultWriteNotice(effective, modelId, displayName, reasoningEffort) + suffix,
      });
    };
    const failure = (err: unknown): void => {
      if (exiting) return;
      const hint =
        err instanceof ConfigWriteRefusedError
          ? 'config is a symbolic link — edit it manually or replace it with a regular file.'
          : 'could not save the default model — check your config file.';
      const open = state.modelPicker;
      set({
        submitBusy: false,
        ...(open === undefined ? { notice: hint } : { modelPicker: { ...open, hint } }),
      });
    };
    let result: Result | Promise<Result>;
    try {
      result = port.writeDefault(modelId, provider, reasoningEffort);
    } catch (err) {
      failure(err);
      return;
    }
    if (!(result instanceof Promise)) {
      success(result);
      return;
    }
    set({ submitBusy: true });
    const pending = result;
    const finishWrite = async (): Promise<void> => {
      let work: Promise<Result> | undefined;
      let written: Result;
      try {
        // Enter before the first await so cancellation cannot overtake owner admission.
        work = deps.workOwner === undefined ? pending : deps.workOwner.enter(() => pending);
        written = await work;
      } catch (err) {
        // Admission can refuse an already-started write; its original promise still needs an observer.
        if (work === undefined) void pending.catch(() => undefined);
        deps.workOwner?.failure(err);
        failure(err);
        return;
      }
      success(written);
    };
    void finishWrite().catch(failHome);
  };

  // EFFORT-phase accept on the live session (ADR-0066 §5): a per-turn SESSION override via the setter — NOT a reseat
  // (no teardown/approval-wipe/MCP-reconnect/context-loss). Close + note (the effort sub-list renders no hint, so a
  // no-op must give visible store feedback).
  const applyEffortOnlyUpdate = (
    active: HomeChatSession,
    displayName: string,
    reasoningEffort: ReasoningEffort,
  ): void => {
    const label = effortRowLabel(
      active.store.getSnapshot().state.model ?? '',
      reasoningEffort,
    ).label;
    if (reasoningEffort !== active.store.getSnapshot().reasoningEffort) {
      active.onSetEffort?.(reasoningEffort);
      active.store.note(`Reasoning effort set to ${label} — applies to your next message.`);
    } else {
      active.store.note(`Already on ${displayName} at effort ${label}.`);
    }
    set({ modelPicker: undefined });
  };

  // A pick on a LIVE in-Home chat: a SAME-model model-phase no-op keeps the picker OPEN with a hint (the user can
  // pick another); a SAME-model effort pick is the per-turn setter; a DIFFERENT model is a live reseat (ADR-0059)
  // carrying the chosen effort.
  const applyLiveSessionPick = (
    active: HomeChatSession,
    modelId: string,
    displayName: string,
    provider: ReseatTarget['provider'],
    reasoningEffort: ReasoningEffort | undefined,
  ): void => {
    if (modelId !== active.store.getSnapshot().state.model) {
      reseatChat(active, {
        modelId,
        provider,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      });
      return;
    }
    if (reasoningEffort === undefined) {
      // MODEL-phase no-op (a non-reasoning same-model re-pick — no effort sub-step): keep the picker OPEN with a hint
      // so the user can pick a different model (the model-phase view renders the hint, unchanged ADR-0059).
      const open = state.modelPicker;
      set(
        open === undefined
          ? { modelPicker: undefined }
          : {
              modelPicker: {
                ...open,
                hint: `Already on ${displayName} — pick a different model or Esc.`,
              },
            },
      );
      return;
    }
    applyEffortOnlyUpdate(active, displayName, reasoningEffort);
  };

  // Accept the chosen model. TWO surface-specific actions off the ONE picker (ADR-0059/ADR-0063 · ADR-0066 §6): a LIVE
  // in-Home chat RESEATs / updates effort (the effort setter path is only REACHED with `reseatChat` wired — the
  // in-chat `/models` that opens the effort sub-step is gated on it — so guarding on both never diverts an effort pick
  // to the config write); the BARE Home persists the chosen model AND (when the effort sub-step ran) its effort tier
  // as the NEXT session's defaults.
  const acceptModel = (
    modelId: string,
    displayName: string,
    provider: ReseatTarget['provider'],
    reasoningEffort?: ReasoningEffort,
  ): void => {
    const active = state.session;
    if (active !== undefined && deps.reseatChat !== undefined) {
      applyLiveSessionPick(active, modelId, displayName, provider, reasoningEffort);
      return;
    }
    writeNextSessionDefault(modelId, displayName, provider, reasoningEffort);
  };
  // The open `/models` picker owns every key (2.5.G S7) — parity with routeMentionKey. Returns whether the key was
  // consumed. A DIMMED (unavailable-on-your-key) model is non-selectable (ADR §6): accepting one shows a transient
  // `hint`, never a write. Any navigation/filter keystroke clears that hint (the user has moved on).
  const routeModelPickerKey = (input: string, key: ChatKey): boolean => {
    const open = state.modelPicker;
    if (open === undefined) return false;
    const step = foldModelPickerKey(input, key, open);
    switch (step.kind) {
      case 'close':
        set({ modelPicker: undefined });
        break;
      case 'accept':
        acceptModel(step.modelId, step.displayName, step.provider, step.reasoningEffort);
        break;
      case 'blocked': {
        // An ACTIONABLE hint (2.5.G key-awareness): a keyless provider names the remedy; the pre-existing
        // "not on your key" case keeps its message. Never a write — a blocked model can't become the default.
        // The remedy is the Home's own: `/providers`. With no setup port wired it would answer that setup is unavailable, so no remedy is named.
        const noKeyRemedy =
          deps.providerSetup === undefined ? '' : ' — open /providers to connect a key';
        const hint =
          step.reason === 'no-key'
            ? `${step.displayName}: no key for ${providerDisplayName(step.provider)}${noKeyRemedy}`
            : `${step.displayName} is not available on your key — pick another`;
        set({ modelPicker: { ...open, hint } });
        break;
      }
      case 'refresh':
        runPickerRefresh(() => deps.models?.refresh() ?? Promise.resolve(undefined));
        break;
      case 'state':
        // Clear the transient hint only on a REAL interaction — the fold returns the SAME state ref for an inert key
        // (an unhandled key / backspace on an empty filter), which must not wipe a just-shown hint.
        set({ modelPicker: step.state === open ? open : { ...step.state, hint: undefined } });
        break;
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
    return true;
  };

  // ---- The in-Home chat's docked sheets: `/permissions` (ADR-0137 §2) and `/agent` (ADR-0140 §3) ---------------------------------
  /**
   * Whether a docked sheet may open over this chat now: only at an idle prompt with nothing pending, so a card cannot arrive while it is
   * open (the same gate ChatApp applies). The key gates above already keep a busy chat from reaching here (a running turn, a `!` command
   * and a submit in flight all gate typed input and the palette), so these checks are defence in depth, not a path a test can drive.
   */
  const sheetMayOpen = (active: HomeChatSession): boolean => {
    const snap = active.store.getSnapshot();
    return !(
      snap.state.status === 'running' ||
      state.shellBusy ||
      state.submitBusy ||
      snap.review !== undefined ||
      snap.question !== undefined ||
      snap.checkpoint !== undefined ||
      snap.approval !== undefined
    );
  };
  // `/permissions`: open on the data read NOW, in the chat's current mode. A chat without a port is never offered the sheet; it dispatches
  // and says so. The bare Home has no such sheet: its `/permissions` is the Permissions tab of the tab host (ADR-0140 §3), a screen of the slot.
  const openPermissionsSheet = (active: HomeChatSession): void => {
    const port = active.permissions;
    if (port === undefined || !sheetMayOpen(active)) return;
    // The port promises not to throw, but a defect in it must not take the prompt down with it: the sheet simply does not open.
    const opened = openPermissionsSheetThroughPort(
      port,
      active.store.getSnapshot().mode,
      interruptNow(),
    );
    if (opened.sheet !== undefined) set({ chatSheet: permissionsChatSheet(opened.sheet) });
    else active.store.note(opened.note);
  };
  // `/agent`: the definition THIS session holds, nothing read and nothing written. It goes into the one sheet slot, so it replaces
  // whatever sheet was there (none can be, a sheet owns the keyboard) and no field is added to the state. A chat without the view is never
  // offered the sheet; it dispatches and the chat prints a notice. A defect in the view's builder must not take the prompt down with it either.
  const openAgentSheet = (active: HomeChatSession): void => {
    const view = active.boundAgent;
    if (view === undefined || !sheetMayOpen(active)) return;
    try {
      set({ chatSheet: agentChatSheet(view()) });
    } catch {
      active.store.note(AGENT_UNREADABLE);
    }
  };
  // The open sheet owns every key. A card that arrived wins (ADR-0137 §1): the sheet closes with its question dropped and the key goes on
  // to the card's own handling (the sheet opens only at an idle prompt, so this is a defence for a host that lets one arrive, not a path the
  // product takes). The agent sheet is read-only: `Esc` and `Ctrl+C` close it and every other key is dropped. A permissions withdrawal runs
  // through the port (the store is read again there) and the sheet reloads with the answer; a defect in the port must not leave the keyboard
  // owned by a frozen sheet.
  const routeChatSheetKey = (
    active: HomeChatSession | undefined,
    input: string,
    key: ChatKey,
  ): boolean => {
    const open = state.chatSheet;
    if (open === undefined) return false;
    const pending = active?.store.getSnapshot();
    if (
      pending !== undefined &&
      (pending.review !== undefined ||
        pending.question !== undefined ||
        pending.checkpoint !== undefined ||
        pending.approval !== undefined)
    ) {
      set({ chatSheet: undefined });
      return false;
    }
    if (active === undefined) {
      set({ chatSheet: undefined });
      return true;
    }
    if (open.kind === 'agent') {
      if (foldAgentSheetKey(input, key) === 'close') set({ chatSheet: undefined });
      return true;
    }
    const port = active.permissions;
    if (port === undefined) {
      set({ chatSheet: undefined });
      return true;
    }
    const canArm =
      terminal === undefined ||
      sheetCanArm({ columns: terminal.columns, terminalRows: terminal.rows });
    const result = foldPermissionsSheetThroughPort(
      port,
      open.sheet,
      input,
      key,
      canArm,
      interruptNow(),
    );
    set({ chatSheet: result.sheet === undefined ? undefined : permissionsChatSheet(result.sheet) });
    if (result.note !== undefined) active.store.note(result.note);
    return true;
  };

  // ---- The in-Home `/effort` overlay (ADR-0066 §6) — interactive tier selection (no reseat) -------------------
  // Whether `/effort` should open the overlay: a live chat with the setter wired AND a reasoning-capable bound model.
  // A non-reasoning model returns false, so the surface falls through to the `/effort` notice (parity with ChatApp).
  const canOpenEffortPicker = (active: HomeChatSession): boolean =>
    canControlEffort(active.store.getSnapshot().state.model, active.onSetEffort !== undefined);
  // Open on the LIVE bound model + the LIVE store tier (so it opens on the currently-bound effort). Callers gate on
  // `canOpenEffortPicker`, so the model is present here (the guard is defensive).
  const openEffortPicker = (active: HomeChatSession): void => {
    const snap = active.store.getSnapshot();
    if (snap.state.model === undefined) return;
    set({ effortPicker: initialEffortPickerState(snap.state.model, snap.reasoningEffort) });
  };
  // The open effort overlay owns every key (mirrors routeModelPickerKey). Accept applies the tier via the session's
  // per-turn setter (no reseat); a re-pick of the same tier is a gentle no-op with visible store feedback.
  const routeEffortPickerKey = (active: HomeChatSession, input: string, key: ChatKey): boolean => {
    const open = state.effortPicker;
    if (open === undefined) return false;
    const step = foldEffortPickerKey(input, key, open);
    switch (step.kind) {
      case 'close':
        set({ effortPicker: undefined });
        break;
      case 'accept': {
        set({ effortPicker: undefined });
        const label = effortRowLabel(
          active.store.getSnapshot().state.model ?? '',
          step.effort,
        ).label;
        if (step.effort === open.current) {
          active.store.note(`Already at reasoning effort ${label}.`);
        } else {
          active.onSetEffort?.(step.effort);
          active.store.note(`Reasoning effort set to ${label} — applies to your next message.`);
        }
        break;
      }
      case 'state':
        set({ effortPicker: step.state });
        break;
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
    return true;
  };

  // Drive the open `/` palette (2.5.C S3b): fold the keystroke, then apply — keep open with new state, run the
  // highlighted command by submitting its slash line through the SAME chat dispatch, or close. Ctrl-C closes it
  // (a gentle escape back to the prompt — never trapping the user).
  // The Home's own REPL context (no live session): only `/exit` applies in HOME_PALETTE_COMMANDS, and it ends the
  // Home cleanly; the chat-lifecycle capabilities are unreachable from the Home palette (cancel/export are
  // chat-only) but the context shape requires them, so they are inert here.
  // The Home's REPL context. Capabilities for CHAT-ONLY commands (cancel/export/cost/workflows — `availableIn`
  // excludes the Home) are inert noops, unreachable from HOME_PALETTE_COMMANDS. A genuinely home-applicable command
  // wires a REAL impl: `/doctor` (availableIn ['home','chat']) runs the fast tier into the Home `notice` surface.
  const homeReplCtx: ReplCommandContext = {
    exit: () => requestExit(),
    cancel: () => undefined,
    exportSession: () => undefined,
    // `/help` is on the Home's palette (ADR-0145 §7.3): chosen there it opens the same screen the typed word does.
    help: () => {
      openScreen('help');
    },
    showWorkflows: () => undefined, // the chat's own listing; the Home's `/workflows` opens the Defined tab from the controller (MVP-8 step 4)
    // `/cost` is chat-only in the BARE Home: there is no live session to cost. (The in-Home CHAT reaches the real
    // implementation through `createChatLineHandler`, so it gets the ADR-0070 per-model breakdown like the standalone
    // chat does.) Now that the breakdown reads the DB rather than an in-memory counter, costing a PAST session needs
    // only a sessionId — which is what 2.6.G's session browser will supply.
    showCost: () => undefined,
    managePermissions: () => undefined, // the Home opens its own sheet (ADR-0137 §3) from the controller, not through this context; MVP-8 composes it into a tab
    showAgent: () => undefined, // `/agent` is a chat's (ADR-0140 §3): the landing has no session, so it answers the word itself and never runs this
    openDetails: () => undefined,
    setMode: (argument) => {
      managementCommand(argument.length === 0 ? '/mode' : `/mode ${argument}`);
    },
    setReasoningEffort: () => undefined, // `/effort` is chat-only (ADR-0066); inert in the bare-Home surface
    toggleReasoning: () => undefined, // `/thinking` is chat-only (2.5.H); inert in the bare-Home surface (no live session)
    compactHistory: () => undefined, // `/compact` is chat-only (ADR-0062); inert in the Home surface
    trimHistory: () => undefined, // `/trim` is chat-only (ADR-0062); inert in the Home surface
    // `/clear` (ADR-0062 §7) IS offered in the Home palette (availableIn ['home','chat']), but the BARE Home has no
    // live session to clear — surface an honest notice rather than a silent no-op. An ACTIVE in-Home chat routes
    // `/clear` through the chat handler's REAL clearSession (via sendChatLine → the swap), never through this ctx.
    clearSession: () =>
      set({ notice: 'No active conversation to clear — type a message to start one.' }),

    // `/models` (2.5.G S7, ADR-0064 §10) IS a real Home capability (availableIn ['home']): open the in-tree picker
    // over the merged catalog. Unlike the inert chat-only noops above, this wires the live picker.
    openModels: () => openModelPicker(),

    // `/scrollback` + `/edit` (ADR-0068 §e) are chat-only (`availableIn: ['chat']`), so they never appear in
    // HOME_PALETTE_COMMANDS and are unreachable from the bare Home — there is no transcript to dump or edit. An
    // ACTIVE in-Home chat routes them through the chat handler's REAL capabilities (sendChatLine → the slash
    // dispatch → `createChatLineHandler`'s hatches), never through this ctx. Inert here, like the other chat-only
    // capabilities above.
    dumpScrollback: () => undefined,
    editTranscript: () => undefined,
    copyTranscript: () => undefined,

    runDoctor: (deep) => {
      if (exiting) return Promise.resolve();
      const operation = async (): Promise<void> => {
        const runId = (doctorRunId += 1); // a new run; a prompt edit/submit or a later run bumps this, invalidating us
        set({ notice: 'doctor: checking…' });
        let text: string;
        try {
          text = formatDoctorReport(await runDoctorChecks(deep, deps.doctorProbes));
        } catch (cause) {
          deps.workOwner?.failure(cause);
          text = 'doctor: check failed';
        }
        // Land ONLY if nothing moved on during the await: still THIS run (the prompt wasn't edited/submitted), still
        // a bare idle Home (no chat started, mode still 'home'), and the palette isn't open (it cleared the notice).
        if (
          runId === doctorRunId &&
          !exiting &&
          state.mode === 'home' &&
          state.session === undefined &&
          state.palette === undefined
        ) {
          set({ notice: text });
        }
      };
      // Returning/handling this promise is separate from retaining the actual original operation.
      return deps.workOwner === undefined ? operation() : deps.workOwner.enter(operation);
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
  ): Pick<HomeControllerState, 'palette' | 'paletteList'> => {
    const opened =
      active === undefined
        ? openPalette(
            buildPaletteEntries('home', {
              hasSession: false,
              hasKey: !state.keyless,
              hasSavedSessions: state.snapshot.recentSessions.length > 0,
              turnRunning: false,
            }),
            'down',
          )
        : openPalette(
            buildPaletteEntries('home-chat', {
              hasSession: true,
              hasKey: true,
              turnRunning: active.store.getSnapshot().state.status === 'running',
            }),
            'up',
          );
    return { palette: opened.state, paletteList: opened.list };
  };

  const handlePaletteKey = (input: string, key: PaletteKey): void => {
    const palette = state.palette;
    const list = state.paletteList;
    if (palette === undefined || list === undefined) return;
    // The palette runs in BOTH surfaces: a live chat (a session ⇒ submit the slash through the S3a dispatch) and
    // the bare Home (no session ⇒ run the command over the Home's own context). The rows are the surface's, built when the palette opened.
    const active = state.session;
    const step = foldPaletteKey(input, key, palette, list);
    if (step.kind === 'close') {
      set({ palette: undefined });
      return;
    }
    if (step.kind === 'unavailable') {
      // `Enter` on a dim row: its reason is said and the palette stays open. Never "unknown command", never run.
      const row = list.rows[palette.index];
      const notice = unavailableNotice(row?.command.name ?? '', step.reason);
      if (active === undefined) set({ notice });
      else active.store.note(notice);
      return;
    }
    if (step.kind === 'run') {
      set({ palette: undefined });
      // `Enter` on a query that matches nothing, at the landing: the person typed a line of their own (`/help`, `/cost`, a misspelling, a
      // sentence), and it is answered as the same line pasted is (ADR-0140 §3): by `managementCommand`, which a submitted line goes through
      // first, so `/run extra` says `/run accepts no arguments` here as it does for a paste, not that `/run` is unknown. It starts with a
      // slash, so it is a command line and is always answered: it never starts a chat.
      if (step.command === undefined && active === undefined && palette.query.trim().length > 0)
        managementCommand(`/${palette.query.trim()}`);
      if (step.command !== undefined) {
        if (step.command.name === 'providers') {
          openProviderSetup();
        } else if (step.command.name === 'init') {
          openProjectInit();
        } else if (step.command.name === 'resume') {
          openResume();
        } else if (step.command.name === 'run' && active === undefined) {
          openRunLaunch();
        } else if (step.command.name === 'workflows' && active === undefined) {
          // home: bare `/workflows` opens the tab host on its Defined tab (ADR-0140 §2) — the same as the typed command.
          if (deps.defined === undefined)
            set({ notice: 'The project’s workflows are not available here.' });
          else openTabHost('defined');
        } else if (step.command.name === 'agents' && active === undefined) {
          // home: bare `/agents` opens the tab host on the agents strip's Defined tab (ADR-0140 §3) — the same as the typed command.
          if (deps.agents === undefined)
            set({ notice: 'The project’s agents are not available here.' });
          else openTabHost('agents');
        } else if (step.command.name === 'permissions' && active === undefined) {
          // home: bare `/permissions` opens the tab host on its Permissions tab (ADR-0140 §3).
          if (deps.permissions === undefined)
            set({ notice: 'Remembered commands are not available here.' });
          else openTabHost('permissions');
        } else if (step.command.name === 'import' && active === undefined) {
          // home: bare `/import` opens the import card (ADR-0140 §9) — the same function the typed command calls.
          openImportCard();
        } else if (step.command.name === 'pricing' && active === undefined) {
          // home: bare `/pricing` opens the model pricing form (ADR-0140 §9) — the same function the typed command calls.
          openPricingCard();
        } else if (active === undefined) {
          // home: run over the Home context. The palette captures NO args, so the bare command runs (`/doctor`
          // ⇒ fast tier); `--deep` is a typed-in-chat affordance (repl-commands.ts).
          void Promise.resolve(step.command.run(homeReplCtx, [])).catch(() => undefined);
        } else if (step.command.name === 'models' && deps.reseatChat !== undefined) {
          // chat: `/models` opens the reseat picker (ADR-0059) — parity with the typed-`/models` intercept, so the
          // palette route + the typed route behave identically (never the "interactive terminal" dispatch hint).
          openModelPicker();
        } else if (step.command.name === 'permissions' && active.permissions !== undefined) {
          // chat: bare `/permissions` opens the sheet (ADR-0137 §2) — parity with the typed intercept below.
          openPermissionsSheet(active);
        } else if (step.command.name === 'agent' && active.boundAgent !== undefined) {
          // chat: bare `/agent` opens the bound agent's sheet (ADR-0140 §3) — parity with the typed intercept below.
          openAgentSheet(active);
        } else if (step.command.name === 'effort' && canOpenEffortPicker(active)) {
          // chat: bare `/effort` on a reasoning-capable model opens the interactive overlay (ADR-0066 §6) — parity
          // with the typed-`/effort` intercept; a non-reasoning model falls through to the notice below.
          openEffortPicker(active);
        } else {
          sendChatLine(active, `/${step.command.name}`); // chat: reuse the S3a slash dispatch (createChatLineHandler)
        }
      }
      return;
    }
    set({ palette: step.state, paletteList: step.list });
  };

  // The in-Home chat's `@`-mention completion (2.5.D step 4, ADR-0061) — mirrors ChatApp. ASYNC: opening/descending
  // a dir fires an fs `list()` whose result lands ONLY if the submode is still open on the SAME dir (a stale resolve
  // is dropped). The reader is per-session (`active`); `state.mention` is the live value the guards read.
  const loadMentions = (active: HomeChatSession, dir: string): void => {
    const reader = active.mentionReader;
    if (reader === undefined) return;
    // Apply a resolve ONLY if the SAME session's submode is still open on the SAME dir — a resolve from a
    // since-closed / since-descended submode, or (after a /exit → new chat) a DIFFERENT session, is dropped
    // (mirrors acceptMention's session-identity guard).
    const applyIfCurrent = (candidates: readonly MentionCandidate[]): void => {
      const open = state.mention;
      if (open === undefined || !isCurrentChat(active)) return;
      // A matching directory is insufficient after permanent stop or a chat swap.
      if (open.dir !== dir) return;
      set({ mention: { ...open, candidates, loading: false } });
    };
    void reader.list(dir).then(
      (candidates) => applyIfCurrent(candidates),
      () => applyIfCurrent([]),
    );
  };
  const openMention = (active: HomeChatSession): void => {
    set({ mention: { dir: '', filter: '', candidates: [], selected: 0, loading: true } });
    loadMentions(active, '');
  };
  // Read the accepted file through the fs jail + confidentiality floor + binary/size guards, then inject its content
  // into the buffer as UNTRUSTED, user-position context. Drop a resolve if the chat ended mid-read (a returned Home
  // must not gain injected text). A read rejection surfaces a STATIC, secret-free note (never the raw error/path).
  const acceptMention = (active: HomeChatSession, path: string): void => {
    const reader = active.mentionReader;
    if (reader === undefined) return;
    const epoch = submitEpoch; // capture: a submit since accept ⇒ the buffer moved on (drop the inject)
    // Stale if the chat swapped/ended (session/mode) OR the compose buffer was submitted since accept.
    const stale = (): boolean => !isCurrentChat(active) || submitEpoch !== epoch;
    void reader.read(path).then(
      ({ content, sizeBytes }) => {
        if (stale()) return; // the chat ended or the buffer was submitted mid-read — drop it
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
          active.store.note(
            `pending attachment limit (${MAX_PENDING_ATTACHMENTS}) reached — oldest dropped`,
          );
        }
        const warn = fileAttachmentWarning(path, content, sizeBytes);
        if (warn !== undefined) active.store.note(warn);
      },
      () => {
        if (stale()) return;
        active.store.note('@ mention could not read that file (refused, binary, or too large)');
      },
    );
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
  // was consumed (the overlay was open); mutually exclusive with the palette/search.
  const routeMentionKey = (active: HomeChatSession, input: string, key: ChatKey): boolean => {
    const open = state.mention;
    if (open === undefined) return false;
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
      loadMentions(active, step.dir);
    } else if (step.kind === 'accept') {
      set({ mention: undefined });
      acceptMention(active, step.path);
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
    if (
      !running &&
      input === '@' &&
      key.ctrl !== true &&
      key.meta !== true &&
      active.mentionReader !== undefined &&
      mentionOpensAt(state.input.text, state.input.cursor)
    ) {
      openMention(active);
      return true;
    }
    return false;
  };

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
   * - `/permissions` opens the remembered-commands sheet (ADR-0137 §2), where the session holds a port for it.
   * - `/agent` opens the read-only sheet of the agent this chat is bound to (ADR-0140 §3), where the session holds its view.
   * - `/effort` on a reasoning-capable model opens the interactive tier overlay (ADR-0066 §6) instead of the informational notice; a
   *   non-reasoning model falls through to the slash dispatch (the ctx handler's "no controllable tier" notice).
   */
  const overlayCommandFor = (
    active: HomeChatSession,
    trimmed: string,
  ): (() => void) | undefined => {
    if (trimmed === '/models' && deps.reseatChat !== undefined) return openModelPicker;
    if (trimmed === '/permissions' && active.permissions !== undefined)
      return () => openPermissionsSheet(active);
    if (trimmed === '/agent' && active.boundAgent !== undefined)
      return () => openAgentSheet(active);
    if (trimmed === '/effort' && canOpenEffortPicker(active)) return () => openEffortPicker(active);
    return undefined;
  };

  // Submit `line`: a leading `!command` runs the shell escape (attachments stay pending — they ride the NEXT
  // message); a `/slash` passes through unchanged (attachments stay); otherwise it is a MESSAGE — expand the pending
  // attachments (files whose `@marker` is present + all carried commands) into the outbound frame, show the compact
  // form in the transcript, and clear exactly the consumed attachments.
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
      runShell(active, parsed); // a `!command` → the shell escape (does NOT consume pending attachments)
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
    const { message, display, consumed } = buildOutbound(line, state.attachments);
    if (message.trim().length === 0) {
      set({ input: emptyEditor() }); // nothing to send (empty prose + no consumable attachment)
      return;
    }
    history = recordHistory(history, line); // history recalls the PROSE the user typed, not the framed message
    const remaining = state.attachments.filter((a) => !consumed.includes(a));
    set({ input: emptyEditor(), historyEntries: history.entries, attachments: remaining });
    sendChatLine(active, message, display);
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
    const overlay = interruptContextFrom(overlayFlags(), active !== undefined);
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
    if (screen.kind === 'help') {
      // The sheet is not a run: `Ctrl+C` closes it, arms nothing and cancels nothing, even with a leg executing behind it.
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
    if (routeMentionKey(active, input, key)) return;
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
    applyChatAction(active, reduceChatKey(input, key, state.input.text, running));
  };

  /**
   * What `Enter` does on a focused strip row (ADR-0140 §6): a parked run opens its gate or budget card, a session is resumed, and a failed or
   * recent run opens its detail in History (nothing is resumed or answered from it). The run this Home hosts opens its view instead, as the `▶` row does.
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
    const hosted = deps.hostedRuns?.snapshot().active?.runId === row.id;
    if (hosted && openRunView()) return;
    openRunDetail(row.id);
  };

  /**
   * A key while a strip row is focused on the landing (`↓` at the empty prompt put it there). `↑`/`↓` move along the rows in the order the
   * strip draws them (`↓` past the last stays on it, `↑` before the first returns to the prompt), `Enter` does what the row's kind says and
   * `Esc` returns to the prompt. The focus names a row by its identity: a refresh that takes the row off the strip drops the focus (it never
   * moves it onto another row). Returns whether the key was handled; any other key ends the focus and is then typed as usual.
   */
  const routeStripFocusKey = (focus: StripFocus, key: HomeKey & ChatKey): boolean => {
    const rows = stripRows(state.parkedRuns, state.snapshot);
    const index = focusFor(rows, focus);
    const row = index === undefined ? undefined : rows[index];
    if (row === undefined) {
      // Not reachable while `set` keeps the focus on the rows it is given; a focus that names a row the strip no longer lists opens
      // nothing and says so (ADR-0140 §6), and is dropped. Any other key is typed as usual.
      if (key.return === true) {
        set({ stripFocus: undefined, notice: STRIP_ROW_GONE });
        return true;
      }
      set({ stripFocus: undefined });
      return false;
    }
    if (key.escape === true) {
      set({ stripFocus: undefined });
      return true;
    }
    if (key.return === true) {
      activateStripRow(row);
      return true;
    }
    if (key.upArrow === true || key.downArrow === true) {
      set({ stripFocus: stepFocus(rows, focus, key.upArrow === true ? -1 : 1) });
      return true;
    }
    set({ stripFocus: undefined });
    return false;
  };

  /**
   * The strip's own keys at the landing: a focused row's (`routeStripFocusKey`), and `↓` at the empty prompt, which moves onto the first row
   * the strip draws, across its sections in their order: the parked runs, the failed runs, the sessions, the recent runs. Whether the key
   * was handled; any other key is the prompt's.
   */
  const handleStripKey = (key: HomeKey & ChatKey): boolean => {
    if (state.stripFocus !== undefined) return routeStripFocusKey(state.stripFocus, key);
    if (key.downArrow !== true || state.input.text.length > 0) return false;
    const first = stepFocus(stripRows(state.parkedRuns, state.snapshot), undefined, 1);
    if (first === undefined) return false;
    set({ stripFocus: first });
    return true;
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
    if (handleStripKey(key)) return;
    // Open the `/` palette at an idle, EMPTY Home prompt (the Home has no running turn) — the discovery entry point
    // (2.5.C S3c). The Home palette shows the home-applicable commands; selecting runs over the Home context.
    if (shouldOpenPalette(input, key, false, state.input.text.length)) {
      set({ ...openPaletteState(undefined), notice: undefined }); // running another command clears a stale report
      return;
    }
    switch (action.kind) {
      case 'submit':
        submit();
        return;
      case 'none':
        return;
      default: {
        // Every buffer edit / cursor motion (append / backspace / newline / move / kill) folds via the shared
        // applyEditorAction — the Home prompt is a first-class line editor too (2.5.D step 2). A NO-OP motion (a
        // cursor key at a boundary — applyEditorAction returns the SAME reference) must not bump doctorRunId or
        // clear a visible `/doctor` report; only a real change does (the first real edit means the user has moved
        // on, and the bump stops a slow `--deep` report reappearing over what's now typed).
        const next = applyEditorAction(state.input, action);
        if (next === state.input) return;
        doctorRunId += 1;
        set({ input: next, notice: undefined });
        return;
      }
    }
  };

  /**
   * The key at an open overlay, whether one took it. Each open overlay owns EVERY key while it is open, and only one opens at a time:
   * - the `/` palette, before the mode dispatch, so it overlays Home/chat input;
   * - the `/models` picker (2.5.G S7), opened from the bare-Home palette (next-session default, ADR-0063) OR a live in-Home chat (a typed
   *   or palette `/models` → the reseat picker, ADR-0059), so it is routed before the mode branches;
   * - the `/effort` overlay (ADR-0066 §6), chat-scoped, so it always has a live session; the guard keeps `routeEffortPickerKey`'s `active`
   *   non-null (a stale overlay with no session falls through, never expected);
   * - the docked sheet. `/permissions` (ADR-0137 §2): `Esc` drops a withdrawal's question and then closes, `Ctrl+C` closes, neither
   *   withdraws. `/agent` (ADR-0140 §3): `Esc` and `Ctrl+C` close it, every other key is dropped.
   *
   * The routes are ORDERED handlers, not a list of flags, so a new overlay needs its branch here (or in the chat's own key handler, where the
   * `@`-mention and the reverse search are routed) AND a flag in `overlay-flags.ts`: the record's tests fail until the flag decides its gates.
   */
  const routeOverlayKey = (input: string, key: HomeKeyEvent): boolean => {
    if (state.palette !== undefined) {
      handlePaletteKey(input, key);
      return true;
    }
    if (state.modelPicker !== undefined) {
      if (!state.submitBusy) routeModelPickerKey(input, key);
      return true;
    }
    if (state.effortPicker !== undefined && state.session !== undefined) {
      routeEffortPickerKey(state.session, input, key);
      return true;
    }
    return state.chatSheet !== undefined && routeChatSheetKey(state.session, input, key);
  };

  // The open-overlay + mode key router — extracted from `handleKey` so its bracketed-paste handling stays within the
  // cognitive-complexity budget. Precedence (each open overlay owns EVERY key while open, and only one opens at a
  // time): the `/` palette → the `/models` picker → the `/effort` overlay → the live chat → else the bare Home.
  const dispatchKey = (input: string, key: HomeKeyEvent): void => {
    // Any key ends "the focus was just dropped"; the landing's own handling below is told, once, whether this key was the first after it.
    const focusDropped = focusJustDropped;
    focusJustDropped = false;
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
    if (routeOverlayKey(input, key)) return;
    if (state.mode === 'chat' && state.session !== undefined) {
      handleChatKey(state.session, input, key);
      return;
    }
    handleHomeKey(input, key, focusDropped);
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
      // are worded when the landing is painted from the clock then: a landing nothing repaints keeps the words of its last paint until the
      // next key, read or resize repaints it. That is the contract as written, not a missed tick.
      maxAgeMs: Number.POSITIVE_INFINITY,
      // The strip was read as the Home was built, so the first tick compares with the token taken before that read instead of reading
      // again: a commit that landed in between is read at the first tick. A token that could not be taken makes the poll read at once.
      after: stripSeed,
    });
    stripPoll.start();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    setProviderState(keyless, notice) {
      if (!exiting) {
        set({ keyless, ...(notice === undefined ? {} : { notice }) });
        if (notice !== undefined) state.session?.store.note(notice);
      }
    },
    handleKey(input, key) {
      // Bracketed paste is handled natively by ink 7's `usePaste` → `handlePaste` (a channel separate from
      // `useInput`), so a pasted multi-line block never arrives here char-by-char and a pasted approval token can
      // never reach the approval reducer. Every real keystroke is dispatched by the open-overlay + mode router.
      if (!exiting && !state.nativeActionBusy) dispatchKey(input, key);
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
    },
    openScreen,
    closeScreen,
    bindGateCardFrame(visible) {
      gateCardVisible = visible;
    },
    bindHomeFrame(visible) {
      homeFrameVisible = visible;
    },
    openPermissionsAsCommand() {
      if (exiting || deps.permissions === undefined) return;
      tabHostIsTheCommand = openTabHost('permissions');
      // It did not open (the port could not be read): stay in the Home, whose notice says why.
    },
    handlePaste(text) {
      if (exiting || state.nativeActionBusy) return;
      disarmInterrupt(); // a paste is a key too: it ends the armed state (ADR-0115 §1)
      focusJustDropped = false; // and the one ignored `Enter` after a dropped focus
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
      // ink 7 delivers a whole bracketed paste as ONE native event; CRLF/CR → LF (matching a typed newline).
      // Dropped (not char-inserted) unless the main prompt is the active editable target — `pasteEditable` mirrors
      // the old bracketed-paste gate and additionally refuses a pending approval (the fail-closed floor, ADR-0057)
      // and a card. Type-ahead behind a busy/overlay state is deferred (2.5.B).
      const pasted = text.replace(/\r\n?/g, '\n');
      // A paste while the permissions sheet waits on a withdrawal drops the question: it is input the sheet does not answer to (ADR-0137 §2).
      // The agent sheet has no question to drop, and a paste changes nothing there; `pasteEditable` keeps it out of the composer.
      const pastedOver = permissionsSheetOf(state.chatSheet);
      if (pastedOver !== undefined)
        set({ chatSheet: permissionsChatSheet(disarmPermissionsSheet(pastedOver)) });
      // An open `ask_user` card owns a paste (ADR-0132): it goes into the card's own-answer field or is dropped.
      if (pasted.length > 0 && state.session?.store.pasteIntoQuestion(pasted) === true) return;
      if (pasted.length === 0 || !pasteEditable()) return;
      doctorRunId += 1; // an append clears a stale `/doctor` report + invalidates an in-flight run, like a typed edit
      history = resetHistoryNav(history); // a paste is a real edit ⇒ end history nav (parity with append/backspace/kill)
      set({
        input: insertAtCursor(state.input, pasted),
        notice: undefined,
        stripFocus: undefined,
      });
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
