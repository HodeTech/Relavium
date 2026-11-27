import type { ToolDisplay } from './tool-display.js';
import { ToolReviewHost } from './tool-review-view.js';
import { QuestionCardHost } from './question-card-view.js';
import { CheckpointCardHost } from './checkpoint-card-view.js';
import { waitClockForm } from './wait-clock.js';
import { NativePromptHost } from './native-prompt-host.js';
import { ownSessionSubscriber } from '../../chat/session-presentation.js';
import {
  Box,
  Static,
  render,
  useApp,
  useInput,
  usePaste,
  useStdout,
  useWindowSize,
  type Key,
} from 'ink';
import { BackdropDim, Text, type TextProps } from './text.js';
import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { SuspendPort } from '../suspend.js';
import { createSuspendPort } from '../suspend.js';
import { SessionInkMount } from '../../chat/session-ink-mount.js';
import { SessionInkInput } from '../../chat/session-ink-input.js';
import { CliError } from '../../process/cli-error.js';
import type { NoticeFlush } from '../../engine/effect-retention.js';
import { useVisibleRenderFlush } from './render-acknowledgement.js';
import {
  createTranscriptAcknowledgement,
  type TranscriptAcknowledgement,
} from './transcript-acknowledgement.js';
import {
  driveJson,
  drivePlain,
  chatIsInteractive,
  type ChatDriveContext,
  type ChatDriveOutcome,
  type ChatDriver,
  type ReseatTarget,
} from '../../commands/chat.js';
import { unavailableNotice } from '../../commands/repl-commands.js';
import { EXIT_CODES } from '../../process/exit-codes.js';
import { detectOutputMode, isCiEnv } from '../../process/output-mode.js';
import { resolveRenderMode } from '../render-mode.js';
import { colorProps, dimProps } from './projection.js';
import { COPIED_TOAST_MS, FORCE_TEARDOWN_MS, FRAME_MS } from './tui-constants.js';
import {
  applyEditorAction,
  draftText,
  editorFromText,
  emptyEditor,
  insertAtCursor,
  pasteIsEditable,
  reduceChatKey,
  type EditorState,
} from './chat-input.js';
import { pressesOnly } from './chord-guard.js';
import {
  DISARMED,
  INTERRUPT_ARM_WINDOW_MS,
  isInterruptKey,
  pressInterrupt,
  pressOtherKey,
  type InterruptContext,
  type InterruptState,
} from './interrupt-keymap.js';
import {
  cardFlagsFrom,
  holdsCustody,
  interruptContextFrom,
  occupiesRows,
  overlayOwnsKeyboard,
  pasteFlagsFrom,
  pointerBlocked,
  promptHidden,
  type OverlayFlags,
} from './overlay-flags.js';
import { createNativePromptAcknowledgement } from './native-prompt-acknowledgement.js';
import type { NativePromptSnapshot, NativePromptUi } from './native-prompt-channel.js';
import { openDoctor, type DoctorPort } from '../../popups/doctor-port.js';
import { turnInFlight, type TurnFacts } from '../../popups/turn-in-flight.js';
import { openReport, type ReportsPort } from '../../popups/report-port.js';
import { bindModelSwitch, openSettings, type SettingsPort } from '../../popups/settings-port.js';
import { bindPopupHost, type PopupSheetSources } from '../../popups/popup-bind.js';
import { popupRefusal } from '../../popups/popup-refusal.js';
import { routePopupLine, type PopupRoute } from '../../popups/popup-route.js';
import type { PopupPlacement } from '../../popups/geometry.js';
import { nativeFramed } from '../../popups/native-popup-body.js';
import {
  createNotificationChannel,
  type Announce,
  type NotificationChannel,
  type NotificationSnapshot,
} from '../../popups/notifications.js';
import { createPopupAcknowledgement } from '../../popups/popup-acknowledgement.js';
import {
  createPopupHost,
  type PopupHost,
  type PopupHostSnapshot,
  type PopupRefusal,
} from '../../popups/popup-host.js';
import { currentStep } from '../../popups/popup-reducer.js';
import {
  dimsBackdrop,
  PopupSlot,
  slotDrawing,
  type PopupSlotProps,
  type SlotDrawing,
} from '../../popups/popup-slot.js';
import {
  foldMentionKey,
  mentionOpensAt,
  type MentionReader,
  type MentionState,
} from './mention.js';
import { MentionView } from './mention-view.js';
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
import { AttachmentBar } from './attachment-bar.js';
import {
  commandLine,
  isShellLine,
  parseShellLine,
  SHELL_UNTERMINATED_QUOTE_NOTICE,
  shellDenyHint,
  type ShellCommand,
} from './shell.js';
import type { UserCommandOutcome } from '@relavium/core';
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
import { EmphText } from './emphasis-view.js';
import { PaletteAbovePrompt } from './palette-block.js';
import { chatPaletteRows } from './palette-view.js';
import { PromptEditor } from './prompt-view.js';
import {
  CHAT_HEADER_ROWS,
  chatEditorRows,
  chatFrameRows,
  chatSessionTitle,
  firstUserLine,
  hasConversation,
  headerRow,
} from './chat-layout.js';
import { WORDMARK, thinRule } from './home-layout.js';
import {
  chatGrid,
  marginCell,
  startsWithMarginWord,
  type ChatGrid,
  type MarginForm,
} from './chat-grid.js';
import { screenText } from './screen-text.js';
import { MarginRow, marginFormFor } from './margin-row.js';
import type { Surface } from '../surface.js';
import { layoutColumns } from './layout-columns.js';
import { ReverseSearchView } from './reverse-search-view.js';
import { buildPaletteEntries } from './palette-entries.js';
import {
  foldPaletteKey,
  openPalette,
  shouldOpenPalette,
  type OpenPalette,
  type PaletteList,
  type PaletteState,
} from './palette-reducer.js';
import { spinnerFrame } from './format.js';
import { GLYPHS, glyphOf, withGlyphForm } from './glyphs.js';
import { chatStatusLine } from './chat-status.js';
import { emphasize } from './emphasis.js';
import {
  dockedTurnRows,
  entryDrawsRows,
  formatBusyLine,
  formatReasoningPanel,
  toolCallText,
  screenStreamRow,
  reasoningLabelActive,
  STOP_THE_TURN,
  streamingAbortHint,
  stripTerminalControls,
  transcriptRows,
  transcriptScrollGeometry,
  transcriptSelectionText,
  liveAnswerRowBudget,
  type DockedTurnRow,
  type ReasoningPanel,
} from './chat-projection.js';
import { sheetTranscriptRows } from './tool-review-card.js';
import { exitKey, legend, type LegendExit } from './legend.js';
import { TranscriptViewport } from './transcript-viewport.js';
import { wrapText, wrapWords } from './viewport.js';
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
import type { ReasoningEffort } from '@relavium/shared';

import { nextMode, type ChatMode } from '../../chat/chat-mode.js';
import { attemptClipboardWrite, type ClipboardWriter } from '../clipboard.js';
import { MarkdownText } from './markdown-text.js';
import { TranscriptRow } from './transcript-row.js';
import type { MarkdownStream } from '../markdown/index.js';
import type { ChatStoreController } from './chat-store.js';
import { assertRenderStoreAgree } from './session-view-model.js';
import type { SessionViewState, TranscriptEntry } from './session-view-model.js';

/**
 * The `ink` TTY driver + `ChatApp` for `relavium chat` (2.M) — the session counterpart of the 2.E run TUI
 * (`ink-renderer.ts` + `RunApp.tsx`). The component is a thin projection of the ink-free
 * {@link ChatStoreController} (all logic is the unit-tested reducer/store/formatters); here we only own the
 * `ink` lifecycle + the raw-mode text input. The plain (non-TTY) driver lives in `commands/chat.ts`; this is
 * the ONLY place `ink`/React are imported on the chat path, so the command core stays framework-free.
 *
 * RAW-MODE NOTE: unlike `RunApp`, `ChatApp` uses `useInput`, so `ink` puts the terminal in RAW mode and the
 * kernel no longer translates Ctrl+C → SIGINT. The command's SIGINT handler therefore can't see it — the
 * ChatApp handles Ctrl+C itself, through the one interrupt keymap (ADR-0115): the first press interrupts, clears or arms, and
 * only a second inside the window ends the session (`/cancel`). (Re-verify on a real TTY when changing the input.)
 */

/**
 * One entry of the inline renderer's scrollback, printed once by `<Static>` on the chat's grid (MVP-11 unit 9, §3.3): each row is the margin in
 * its WORD form (`you`, `agent`, `tool`, `note`: the closed set of `MARGIN_WORDS`, which a screen reader reads where it would skip a glyph) and
 * the content, with the same rows as the full-screen viewport ({@link transcriptRows}): a row of a reply or a notice that starts with one of the
 * words carries its own entry's word, so it is never read as the person's turn. `previous` is the entry printed before it, so the blank row
 * between turns is the same here as there.
 */
function TranscriptLine(
  props: Readonly<{
    entry: TranscriptEntry;
    previous: TranscriptEntry | undefined;
    displays?: ReadonlyMap<string, ToolDisplay> | undefined;
    color: boolean;
    columns?: number | undefined;
    acknowledgement?: TranscriptAcknowledgement | undefined;
  }>,
): ReactElement {
  const { entry, color } = props;
  const grid = chatGrid(props.columns ?? 80);
  const lines = transcriptRows([entry], grid, color, props.displays, props.previous);
  useLayoutEffect(() => {
    if (entry.role === 'notice' && lines.length > 0) props.acknowledgement?.inlineNotice(entry);
  }, [entry, props.acknowledgement, lines.length]);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <TranscriptRow key={index} line={line} grid={grid} color={color} form="word" />
      ))}
    </Box>
  );
}

interface ChatAppProps {
  readonly modePrompt?: ChatDriveContext['modePrompt'];
  /** Synchronous invocation seal; the tree stays mounted until entered native work joins. */
  readonly inputEnabled?: () => boolean;
  readonly store: ChatStoreController;
  /** Successful terminal setup and a flushed frame make this transcript eligible for disclosure. */
  readonly onActivated?: (flushNotice: NoticeFlush) => void | Promise<void>;
  /** `true` ⇒ mounted on ink 7's alternate screen (2.6.F Step 4b, ADR-0068 §c) — the transcript renders through the
   *  scroll {@link TranscriptViewport} (constrained to the terminal size) instead of `<Static>`. Resolved by
   *  `driveInk` (`resolveRenderMode`); absent/false ⇒ the inline renderer. */
  readonly alternateScreen?: boolean;
  /** Handle a submitted turn; resolves when it settles. `message` is the full framed text sent to the model +
   *  persisted; the optional `display` is the compact transcript form (prose + a `[📎 …]` note for carried
   *  command outputs). When `display` is absent the two are identical. */
  readonly onSubmit: (message: string, display?: string) => Promise<void>;
  /** `true` once the session should end — the app unmounts via {@link onExit}. */
  readonly shouldStop: () => boolean;
  /** Called once the session has ended (clean exit) so the driver can unmount + finalize. */
  readonly onExit: () => void;
  /** Called when a turn rejects UNEXPECTEDLY (a re-thrown turn-core bug) — the driver tears down + propagates. */
  readonly onError: (err: unknown) => void;
  /** Mid-turn abort (EA7) — Esc aborts the in-flight turn, keeping the session alive. OPTIONAL: a driver/test
   *  wired without it degrades gracefully (Esc at a pending approval rejects it directly, so it is never a dead
   *  key — parity with home-controller.ts), rather than a no-op that would hang the decision. `| undefined` so
   *  the passthrough at the createElement site (exactOptionalPropertyTypes) can forward an absent `ctx.onAbort`. */
  readonly onAbort?: (() => void) | undefined;
  /** Switch the chat mode (Shift+Tab cycle) — re-applies the turn policy on the same session (ADR-0057). */
  readonly onModeChange: (mode: ChatMode) => void;
  /** Set the reasoning-effort tier (ADR-0066 §5): a per-turn session override, NO reseat. `| undefined` for the createElement passthrough. */
  readonly onSetEffort?: ((effort: ReasoningEffort) => void) | undefined;
  /**
   * Request a mid-session model switch (ADR-0059): the `/models` popup's `This chat` calls it, through this chat's switch
   * (`bindModelSwitch`), which then ends the driver so the loop rebuilds on the new model. Absent (a driver or a test wired without it) ⇒
   * the session's `/models` member is not offered here, and a typed `/models` is dispatched. `| undefined` for the passthrough.
   */
  readonly onReseat?: ((target: ReseatTarget) => void) | undefined;
  /**
   * What this chat's report popups read ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §10, MVP-11 step 4b): `/agent`, `/cost` (and `/cost --release`), `/workflows` and `/help`. For each report whose member is present, a typed
   * or palette-selected line opens the popup instead of dispatching, as `/doctor` does: before the line is counted as a submit. Absent ⇒ the
   * command is dispatched and prints its text into the transcript as before. `| undefined` so the createElement passthrough forwards an absent
   * `ctx.reports`.
   */
  readonly reports?: ReportsPort | undefined;
  /**
   * What this chat's settings popups read and apply ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §3, §6; MVP-11 step 5): today `/effort`. A typed or palette-selected bare command whose member can open opens the popup instead of
   * dispatching, before the line is counted as a submit; a command with its value (`/effort high`) dispatches and applies it. Absent ⇒ the
   * command is dispatched, as before. `| undefined` so the createElement passthrough forwards an absent `ctx.settings`.
   */
  readonly settings?: SettingsPort | undefined;
  /**
   * Bind the session's announcements (its typed settings, its mode control and its settings popups) to THIS chat's notification channel while
   * it is mounted, and unbind them when it unmounts (`ChatLineHandler.setAnnouncer`): a notification with no popup as its source, so it
   * outlives the popup that applied a setting. Absent ⇒ nothing is bound (a driver or a test without a session handler).
   */
  readonly setAnnouncer?: ((announce: Announce | undefined) => void) | undefined;
  /** The `@`-mention completion reader (2.5.D, ADR-0061) — a READ-ONLY fs jail at the session's fs-scope tier +
   *  workspace. When present, `@` at a word boundary opens dir-navigable file completion whose accepted file is
   *  injected as UNTRUSTED, user-position context. Absent (a driver/test wired without it) ⇒ `@` is a literal char.
   *  `| undefined` so the createElement passthrough can forward an absent `ctx.mentionReader` (exactOptionalPropertyTypes). */
  readonly mentionReader?: MentionReader | undefined;
  /** The `!`-shell runner (2.5.D step 5, ADR-0061) — runs a user-typed `!command` through `runUserCommand` (the one
   *  command boundary). When present, a submitted line starting with `!` is tokenized + run (its output injected as
   *  UNTRUSTED context) instead of sent to the model. Absent ⇒ a leading `!` is a literal message. `| undefined` so
   *  the createElement passthrough forwards an absent `ctx.runShellCommand`. */
  readonly runShellCommand?:
    | ((command: string, args: readonly string[]) => Promise<UserCommandOutcome>)
    | undefined;
  /** The ADR-0068 §e suspend port (2.6.F Step 5d). `ChatApp` attaches ink's `useApp().suspendTerminal` to it while
   *  mounted, which is the ONLY way the non-React slash dispatch can reach `/scrollback` and `/edit`. Absent ⇒ the
   *  hatches surface an honest "needs an interactive terminal" notice. */
  readonly suspendPort?: SuspendPort | undefined;
  /** Request the shared POSIX job-control flow. Ink raw mode delivers Ctrl-Z as input, not SIGTSTP. */
  readonly onSuspend?: (() => void) | undefined;
  /** Write the mouse selection to the system clipboard (OSC 52, 2.6.F Step 6). Absent ⇒ selection still highlights
   *  but copy-on-select is inert (a driver/test that wires no terminal). */
  readonly clipboard?: ClipboardWriter | undefined;
  /** Explicit masked review copy; independent of mouse selection preferences. */
  readonly reviewClipboard?: ClipboardWriter | undefined;
  /**
   * The chat's popup host ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2): this
   * root routes keys and pastes to it while a popup is open and draws it in the one overlay slot. Absent ⇒ the chat builds its own, on the
   * store's key history (one key history per host).
   */
  readonly popups?: PopupHost | undefined;
  /** The chat's one notification channel, drawn on the hint row. Absent ⇒ the chat builds its own. */
  readonly notifications?: NotificationChannel | undefined;
  /**
   * What this chat's `/doctor` popup reads ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §8). When present, a typed or palette-selected `/doctor` (or `/doctor --deep`) opens the popup instead of dispatching, as the reports and
   * the settings do: before the line is counted as a submit, so the popup's open gate never takes the command's own line for a turn in flight.
   * Absent ⇒ the command is dispatched and prints the text report into the transcript.
   */
  readonly doctor?: DoctorPort | undefined;
  /** The lowercase provider id of the bound agent, first on the status line (ADR-0146 §2). Absent ⇒ the line starts at the model. */
  readonly provider?: string | undefined;
  /**
   * The inline renderer wrote an intro (a resume banner, the `/clear` notice, the model switch) above this chat before it mounted ({@link emitIntro}):
   * the first entry it prints follows it with the blank row between turns ({@link ChatViewProps.printedAbove}). Absent ⇒ nothing was written.
   */
  readonly introPrinted?: boolean | undefined;
}

interface ChatViewProps {
  readonly toolDisplays?: ReadonlyMap<string, ToolDisplay> | undefined;
  readonly hidden?: boolean;
  readonly markdown?:
    | Pick<MarkdownStream, 'tail' | 'plainTail' | 'sourceTail' | 'elided'>
    | undefined;
  readonly displaySuspended?: boolean | undefined;
  readonly acknowledgement?: TranscriptAcknowledgement | undefined;
  readonly state: SessionViewState;
  readonly tick: number;
  /** Wall-clock ms at render, for the live in-flight turn timer ("thinking…/working… {elapsed} · Esc stops the turn",
   *  2.5.H). Render-only + cosmetic (no engine-purity concern); the
   *  owner (`ChatApp` / the Home's `RootApp`) passes `Date.now()` so it advances with the frame loop. */
  readonly nowMs: number;
  readonly color: boolean;
  /** The current prompt editor — text + cursor (owned by the input owner — `ChatApp` or the Home's `RootApp`). */
  readonly editor: EditorState;
  /**
   * Whether the composer draws its cursor cell (ADR-0148 §2, one owner of the keys): `false` while the slot draws a popup, whose keys they are, so a
   * lit cursor beside it does not say the composer takes keys it does not. Absent ⇒ drawn. The text stays as it is; the cursor is back where it
   * was once the popup closes.
   */
  readonly composerCursor?: boolean | undefined;
  readonly running: boolean;
  /** The active chat mode (ADR-0057) — shown on the status line so `auto` is never a hidden state. */
  readonly mode: ChatMode;
  /** The active reasoning-effort tier (ADR-0066) — shown on the status line (parity with `mode`) so the tier is never a
   *  hidden state; absent ⇒ not shown (a non-reasoning model / no tier). */
  readonly reasoningEffort?: ReasoningEffort | undefined;
  /**
   * Which host draws this chat ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
   * §4): `home-chat` (the Home is behind it, so the second `Ctrl+C` goes back to it and the hints say so) or `standalone-chat` (nothing is behind
   * it, so the second `Ctrl+C` ends it). Absent ⇒ stand-alone.
   */
  readonly surface?: ChatHost | undefined;
  /** The lowercase provider id of the bound agent, first on the status line. Absent ⇒ the line starts at the model. */
  readonly provider?: string | undefined;
  /**
   * The open `/` palette, drawn ABOVE the prompt in the order the chat reads (its first row beside the prompt: ADR-0145 §7.1): the list ends on the
   * row above the prompt, the prompt row shows the typed `/query`, and the hint row carries the palette's legend; no status line is drawn while
   * it is open. `maxRows` is the budget of the palette with its prompt row, rule and hint row ({@link chatPaletteRows}). Absent ⇒ no palette.
   */
  readonly palette?:
    | { readonly list: PaletteList; readonly state: PaletteState; readonly maxRows: number }
    | undefined;
  /**
   * Inline renderer only: print the chat's header (the wordmark and a blank row) once, as the first item of the scrollback it writes. The Home's
   * chat region sets it for a chat's first mount and not for a reseat or a `/clear`; the stand-alone chat prints its header before it mounts
   * (`driveInk`), once per process. Ignored by the full-screen renderer, whose header is its first child.
   */
  readonly introduction?: boolean | undefined;
  /**
   * Inline renderer only: rows were written above this chat before it mounted that are not part of its transcript (the stand-alone chat's intro: a
   * resume banner, the `/clear` notice, the model switch: {@link emitIntro}), so the first entry it prints is not the first thing on the screen and has
   * the blank row between turns above it. The header's own blank row is the gap of a chat with no intro, which is why this is not set for one.
   */
  readonly printedAbove?: boolean | undefined;
  /** Whether the collapsible "thinking" panel is EXPANDED (2.5.H — `/thinking` / Ctrl+T). Only affects the render
   *  when the turn streamed reasoning (`state.liveReasoning` non-empty). */
  readonly reasoningVisible: boolean;
  /** When the `/` palette is open it owns the bottom of the view, so the idle prompt + footer are suppressed (2.5.C S3b). */
  readonly paletteOpen?: boolean;
  /** `true` for ~2s after a copy-on-select (2.6.F Step 6i) — renders a transient "Sent to terminal clipboard" toast above the footer,
   *  confirming the copy WITHOUT appending to the transcript (which would re-wrap the lines just selected). */
  readonly copied?: boolean;
  /** Pending `@`/`!` attachments (2.5.D chip redesign) — rendered as a compact chip bar above the idle prompt. */
  readonly attachments?: readonly PendingAttachment[];
  /** The in-flight `!`-shell command line (2.5.D) — when set, the busy indicator labels WHAT is running (a `!`-
   *  command emits no session tokens, so without this the spinner would be bare) + how to cancel (Esc). */
  readonly busyCommand?: string | undefined;
  /** Live terminal width, to bound the EXPANDED reasoning panel to the last N rendered rows (2.5.H) so a full
   *  4000-char buffer cannot wrap into a flickering, screen-filling panel on a short terminal. Render-only +
   *  cosmetic (parity with `nowMs`); the owner passes `process.stdout.columns` (ChatApp) or its resize-tracked
   *  width (the Home). Absent ⇒ the formatter's 80-col fallback. `| undefined` for the createElement passthrough. */
  readonly columns?: number | undefined;
  /** The interrupt keymap is armed (ADR-0115 §1): a second `Ctrl+C` inside the window ends the session, and the idle hint says so. */
  readonly interruptArmed?: boolean | undefined;
  /**
   * The terminal's height in rows, which bounds the prompt editor ({@link promptEditorRows}) so a long draft cannot push the cursor, the rule, the
   * status line and the hint out of the frame (OB7-M3). The full-screen frame's own `viewport.rows` is read first; this is what the inline renderer
   * has. Absent ⇒ the editor is unbounded, as it always was.
   */
  readonly terminalRows?: number | undefined;
  /**
   * A sheet is docked below this view (an approval or command card, the agent's question, the continue checkpoint: {@link dockedCardOpen}). The
   * sheet takes the prompt block's place ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
   * §1): its key lines are the legend and its rule the label, so the block (the leading row, the prompt or the in-flight turn, the rule, the status
   * line and the hint) is not drawn while it is open, and the rows it took go to the conversation.
   */
  readonly cardDocked?: boolean | undefined;
  /**
   * The one notification of the host's channel (`popups/notifications.ts`), drawn on the hint row in place of the idle hint for its few seconds
   * (ADR-0148 §2). Never appended to the transcript: a notification leaves nothing behind.
   */
  readonly notification?: string | undefined;
  /** PRESENT ⇒ the full-screen **alt-screen** renderer (2.6.F Step 4b, ADR-0068 §c): the tree is constrained to
   *  `rows` and the transcript renders through the scroll {@link TranscriptViewport} (wrapped at `cols`) instead of
   *  ink's `<Static>` (the alt buffer has no scrollback). ABSENT ⇒ the default inline renderer (`<Static>` + native
   *  scrollback). The owner (ChatApp / the Home's RootApp) passes it only when the resolved render mode is `alt`,
   *  carrying the owner-held `scroll` state (4b-2) + the `onMeasure` geometry-lift the scroll keymap reduces against. */
  readonly viewport?:
    | {
        readonly rows: number;
        /** The active mouse selection in WRAPPED-transcript coordinates (Step 6), already document-ordered. */
        readonly selection?: SelectionRange | undefined;
        readonly cols: number;
        readonly scroll: ScrollState;
        readonly onMeasure: (geom: ViewportGeometry) => void;
      }
    | undefined;
}

/**
 * The transient "Sent to terminal clipboard" toast state (2.6.F Step 6i). Copy-on-select was silent on success because the only notice
 * channel — `store.note` — appends a TRANSCRIPT entry, which re-wraps and shifts the very lines the user just selected
 * (whole-phase review). This flag drives a toast rendered OUTSIDE the transcript, so it confirms the copy without
 * touching the selection. Shared by both surfaces (`ChatApp` and the Home's `RootApp`), each of which calls
 * `flashCopied()` on a `written` outcome.
 */
export function useCopiedToast(): { readonly copied: boolean; readonly flashCopied: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Clear a pending timer on unmount so a late `setCopied(false)` never fires into an unmounted tree.
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );
  const flashCopied = useCallback(() => {
    setCopied(true);
    if (timer.current !== undefined) clearTimeout(timer.current); // a re-copy RESTARTS the 2s, never stacks timers
    timer.current = setTimeout(() => setCopied(false), COPIED_TOAST_MS);
  }, []);
  return { copied, flashCopied };
}

/**
 * The chat's two hosts, the only two places a chat is drawn ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7):
 * the Home's (`home-chat`: the second `Ctrl+C` goes back to the Home, which is behind it) and a stand-alone `relavium chat` (`standalone-chat`:
 * nothing is behind it, so the second `Ctrl+C` ends the session). A hint names the destination, so it is the one thing a host changes in the words.
 */
export type ChatHost = Extract<Surface, 'home-chat' | 'standalone-chat'>;

/**
 * The second `Ctrl+C` of the interrupt keymap ends the session ([ADR-0115](../../../../../docs/decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md)):
 * what the armed idle hint and the `Interrupting` line say, as one legend exit.
 */
export const END_THE_SESSION_AGAIN = exitKey.leave('end the session (again)', 'Ctrl+C');

/** The first `Ctrl+C` of an idle prompt with nothing typed: it arms, and the second one ends the session, so it is the key that LEAVES. */
export const END_THE_SESSION_TWICE = exitKey.leave('end (twice)', 'Ctrl+C');

/** The same second `Ctrl+C` in a chat the Home hosts (ADR-0146 §4): it goes back to the Home, and the word names where. */
const BACK_TO_HOME_AGAIN = exitKey.leave('back to Home (again)', 'Ctrl+C');

/** The first `Ctrl+C` of an idle, empty prompt in a chat the Home hosts: it arms, and the second one goes back to the Home. */
const BACK_TO_HOME_TWICE = exitKey.leave('back to Home (twice)', 'Ctrl+C');

/** The second `Ctrl+C` of the armed state, in the words of `host`: the destination is the Home where there is one, and the end where there is not. */
const leavesAgain = (host: ChatHost): LegendExit =>
  host === 'home-chat' ? BACK_TO_HOME_AGAIN : END_THE_SESSION_AGAIN;

/** The unarmed first `Ctrl+C` of an empty prompt, in the words of `host` ({@link leavesAgain}). */
const leavesTwice = (host: ChatHost): LegendExit =>
  host === 'home-chat' ? BACK_TO_HOME_TWICE : END_THE_SESSION_TWICE;

/**
 * The idle prompt's hint bar (2.5.C S6, ADR-0146 §4): the second `Ctrl+C` while the first is armed, the `/` palette at an empty prompt with the
 * key that leaves and where it leads (the Home, or the end of a stand-alone chat), else the draft's own keys. With a draft the first `Ctrl+C`
 * only clears it, so a hint that said `back to Home (twice)` there would be false.
 */
export function idleHint(
  interruptArmed: boolean,
  emptyDraft: boolean,
  host: ChatHost = 'standalone-chat',
): string {
  if (interruptArmed) return legend([], leavesAgain(host));
  return emptyDraft
    ? legend([{ keys: '/', verb: 'commands' }], leavesTwice(host))
    : legend(
        [
          { keys: 'Enter', verb: 'send' },
          { keys: 'Ctrl+J', verb: 'newline' },
        ],
        // Not a leaving key: with a draft the first `Ctrl+C` only clears it, so this stays the `close` class (the legend needs an exit key).
        exitKey.close('Ctrl+C', 'clear the draft'),
      );
}

/**
 * The hint row while a turn runs (the prompt row is the busy line then): there is no prompt to type in and no palette to open, so the only key it
 * has to name is `Ctrl+C`, whose first press stops the turn and arms and whose second ends the chat (or goes back to the Home): the same two
 * states as the idle hint's, in the same words.
 */
export function runningHint(interruptArmed: boolean, host: ChatHost = 'standalone-chat'): string {
  return legend([], interruptArmed ? leavesAgain(host) : leavesTwice(host));
}

/** What is in flight behind a chat, as the host knows it. */
export interface ChatWork {
  /** A turn is streaming (the store's `status` is `running`). */
  readonly turnRunning: boolean;
  /** A `!`-shell command is running. */
  readonly shellBusy: boolean;
  /** A submit is in flight: a turn, a compaction, or a slash command that has not returned yet. */
  readonly submitBusy: boolean;
  /** A card of the native prompt channel (`/mode`, `/export`, `/resume`, ...) is on screen and answers every key. */
  readonly nativePrompt: boolean;
  /** An approval card (or the agent's question card) is open (the store's `approvalSinceMs`): it owns the keyboard and answers `Esc` itself. */
  readonly approvalCard: boolean;
}

/**
 * Whether the chat draws its busy line (`Working… · Esc stops the turn`). A slash command that is only waiting on its own card is a submit in
 * flight too, but no turn runs and the card answers `Esc` (it closes the card and stops nothing): the busy line would say a key does what it
 * does not, so it is not drawn while a card holds the screen and nothing else is running. A `!` shell command that waits on its own approval
 * card is the same case: it has not started, the card's `Esc` denies it, and "running · Esc cancels it" above that card would put two `Esc`
 * effects on one screen. A turn that is running keeps its line while its approval card is open (the line then says it waits for the person,
 * and the card's `Esc` does stop the turn). The input gate is not this: it keeps reading `submitBusy`, so a key still never reaches the
 * composer behind a card.
 */
export function chatIsBusy(work: ChatWork): boolean {
  return (
    work.turnRunning ||
    (work.shellBusy && !work.approvalCard) ||
    (work.submitBusy && !work.nativePrompt && !work.approvalCard)
  );
}

/**
 * The grid the chat's chrome (the header, the prompt block, the live region, the rows under the prompt) is drawn on for a host that reports `columns`:
 * {@link chatGrid} of the width with the 80-column fallback a width that is not usable gets ({@link layoutColumns}: a suspended terminal reports 0, NaN or
 * Infinity), so the chrome is never asked for a width it cannot draw. The one place the fallback is applied.
 */
export function chromeGridFor(columns: number): ChatGrid {
  return chatGrid(layoutColumns(columns));
}

/**
 * A column of the chat's chrome BELOW the prompt block (the history search, the `@` completion list) for a host that reports `columns`: a
 * {@link ContentColumn} on {@link chromeGridFor} of that width. Both hosts draw them through it, so they stand where the prompt block above them does.
 */
export function ChromeColumn(
  props: Readonly<{ columns: number; children?: ReactNode }>,
): ReactElement {
  return <ContentColumn grid={chromeGridFor(props.columns)}>{props.children}</ContentColumn>;
}

/**
 * The chat's header ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §4): the wordmark (bold, in the accent when it is the full-screen frame's first row, bold alone inline) with the session title right-aligned to the
 * content column's last column, then one blank row: {@link CHAT_HEADER_ROWS} rows. It stands ON THE GRID (unit 9, {@link chatGrid}): the box starts
 * at the content column, where the Home's wordmark starts, and is exactly the content column wide, so the title ends where the rail ends.
 * The title is already scrubbed and bounded by {@link headerRow}; with none (before the first message, inline) the wordmark stands alone.
 */
function ChatHeaderView(
  props: Readonly<{ title: string; columns: number; color: boolean; accent: boolean }>,
): ReactElement {
  const grid = chromeGridFor(props.columns);
  const row = headerRow(props.title, grid.content);
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={CHAT_HEADER_ROWS}
      marginLeft={grid.margin}
      width={grid.content}
    >
      <Box>
        {/* The accent is the full-screen frame's first row. The inline header scrolls into the terminal's own history among the transcript, and it
            is bold only there in both hosts: the stand-alone chat writes it before it mounts (`emitChatHeader`, bold), so the Home's hosted chat
            must not print the same header in a colour the stand-alone one has not (OB7-L8). */}
        <EmphText
          emphasis="bold"
          {...(props.accent ? colorProps(props.color, 'cyan') : {})}
          wrap="truncate-end"
        >
          {row.wordmark}
        </EmphText>
        {row.title !== '' && (
          <Text {...dimProps(props.color)} wrap="truncate-end">
            {`${row.gap}${row.title}`}
          </Text>
        )}
      </Box>
      <Text> </Text>
    </Box>
  );
}

/** One item of the inline scrollback: a transcript entry, or the header printed once as the introduction of the chat. */
type ScrollbackItem = TranscriptEntry | { readonly role: 'introduction' };

/**
 * What stands above the first entry of a chat whose intro was written before it mounted: a notice (it hugs what is above it, a turn or a reply gets
 * the separator, as after any entry), never drawn itself. The text only has to be a row, so that the entry above is not a row-less one.
 */
const PRINTED_ABOVE: TranscriptEntry = { role: 'notice', text: 'printed above' };

/**
 * The transcript entry printed just before `items[index]` (`<Static>` passes the absolute index), or none: the first entry, or after the header (the
 * header's own blank row is its gap). `printedAbove` says the first entry follows rows written before the chat mounted ({@link ChatViewProps.printedAbove}).
 * An entry that printed no row (`draws` says no: a reply with neither words nor a summary) is passed over, as the full-screen transcript passes over
 * it, so the entry after it gets the separator of what is really above it (review round 2, C2-4).
 */
function entryBefore(
  items: readonly ScrollbackItem[],
  index: number,
  printedAbove: boolean,
  draws: (entry: TranscriptEntry) => boolean,
): TranscriptEntry | undefined {
  for (let at = index - 1; at >= 0; at -= 1) {
    const before = items[at];
    if (before === undefined || before.role === 'introduction') return undefined;
    if (draws(before)) return before;
  }
  return printedAbove ? PRINTED_ABOVE : undefined;
}

/**
 * The inline renderer's scrollback: ink `<Static>` prints each item once into the terminal's own history. The header, when asked for, is its
 * FIRST item, so it is written once with the first frame of the chat and never again (Static tracks what it printed by the array's length).
 */
function InlineScrollback(
  props: Readonly<{
    entries: readonly TranscriptEntry[];
    introduction: boolean;
    printedAbove: boolean;
    displays: ReadonlyMap<string, ToolDisplay> | undefined;
    color: boolean;
    columns: number | undefined;
    acknowledgement: TranscriptAcknowledgement | undefined;
  }>,
): ReactElement {
  const items: readonly ScrollbackItem[] = props.introduction
    ? [{ role: 'introduction' }, ...props.entries]
    : props.entries;
  const grid = chatGrid(props.columns ?? 80);
  const draws = (entry: TranscriptEntry): boolean =>
    entryDrawsRows(entry, grid, props.color, props.displays);
  return (
    <Static items={[...items]}>
      {(item, index) =>
        item.role === 'introduction' ? (
          <ChatHeaderView
            key={index}
            title=""
            columns={props.columns ?? 80}
            color={props.color}
            accent={false}
          />
        ) : (
          <TranscriptLine
            key={index}
            entry={item}
            previous={entryBefore(items, index, props.printedAbove, draws)}
            displays={props.displays}
            color={props.color}
            columns={props.columns}
            acknowledgement={props.acknowledgement}
          />
        )
      }
    </Static>
  );
}

/**
 * What the empty prompt invites: a conversation has something to reply to ({@link hasConversation}: a user or an assistant entry, or the turns a
 * reseat or a resume carried in), a new one has nothing yet. A notice is not a conversation. Never part of the draft, never sent.
 */
const PLACEHOLDER_REPLY = 'reply to continue';
const PLACEHOLDER_FIRST = 'type a message';

/**
 * The leading row of the prompt block: the copy confirmation while it shows (it is the answer to the person's own gesture), else the latest
 * warning with the earlier ones after it as far as the row has room, else the blank row that separates the block from the conversation.
 * One row whichever it is, so the block never grows (ADR-0146 §4).
 */
function LeadRow(
  props: Readonly<{ copied: boolean; warnings: readonly string[]; color: boolean }>,
): ReactElement {
  const { color } = props;
  if (props.copied) {
    // A green pill when colour is on; a plain `[Sent to terminal clipboard]` under `NO_COLOR` / `--no-color` (colour is never the only carrier, ADR-0145 §5).
    return color ? (
      <EmphText backgroundColor="green" color="black" emphasis="bold">
        {' Sent to terminal clipboard '}
      </EmphText>
    ) : (
      <Text>[Sent to terminal clipboard]</Text>
    );
  }
  if (props.warnings.length === 0) return <Text> </Text>;
  // The newest first: a row too narrow for all of them cuts the oldest, never the one that just happened.
  return (
    <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
      {[...props.warnings]
        .reverse()
        .map((warning) => `${glyphOf('warning', !color)} ${stripTerminalControls(warning)}`)
        .join('  ')}
    </Text>
  );
}

/**
 * A column of the chat's chrome that stands in the content column ({@link chatGrid}, unit 9): it starts where the content starts and is as wide as
 * the row budget it is given, `content` (the rail: the transcript's, the editor's, the live stream's) or `text` (what the terminal leaves right of
 * the margin: a one-line row such as the status line or the hint). The margin on its left is blank: nothing a person or a model wrote can stand in it.
 */
function ContentColumn(
  props: Readonly<{ grid: ChatGrid; budget?: 'content' | 'text'; children?: ReactNode }>,
): ReactElement {
  const { grid } = props;
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginLeft={grid.margin}
      width={props.budget === 'content' ? grid.content : grid.text}
    >
      {props.children}
    </Box>
  );
}

interface PromptBlockProps {
  readonly state: SessionViewState;
  readonly color: boolean;
  readonly host: ChatHost;
  readonly mode: ChatMode;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly provider: string | undefined;
  /** The chat's grid: the content column the editor and the rule are laid for, and the terminal width the status line is fitted to. */
  readonly grid: ChatGrid;
  readonly running: boolean;
  readonly interruptArmed: boolean;
  readonly editor: EditorState;
  readonly cursor: boolean;
  readonly attachments: readonly PendingAttachment[];
  /** The idle prompt is drawn: nothing is running and no submode owns the bottom of the view. */
  readonly promptShown: boolean;
  readonly palette: ChatViewProps['palette'];
  readonly notification: string | undefined;
  readonly copied: boolean;
  /** The most rows the idle prompt's editor may take ({@link promptEditorRows}); `undefined` ⇒ unbounded. */
  readonly editorRows: number | undefined;
  /** The in-flight turn, drawn where the prompt row would be while one runs. */
  readonly live: ReactElement | undefined;
}

/** The hint row's words: a notification in place of the hint, else the hint of the state (running or idle); the open palette's block draws its own legend there. */
function hintFor(props: PromptBlockProps): string {
  if (props.notification !== undefined) return props.notification;
  return props.running
    ? runningHint(props.interruptArmed, props.host)
    : idleHint(props.interruptArmed, props.editor.text.length === 0, props.host);
}

/**
 * The prompt block, in the Home's order ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §4): a leading row, the prompt, a thin rule, the status line and the hint (5 rows at rest). While a turn runs the in-flight turn stands where the
 * prompt row would be. While the `/` palette is open the list is drawn above the prompt, the prompt row shows the typed query, and the hint row
 * carries the palette's legend; the leading row and the status line give their rows up (a list ends directly above the prompt). While another
 * submode (the history search, an `@` completion) owns the bottom of the view its own lines come below, so the block keeps its rule and its
 * status line and draws neither a prompt nor a hint that would name keys it does not take.
 */
function PromptBlock(props: Readonly<PromptBlockProps>): ReactElement {
  const { color, palette, grid } = props;
  const rule = (
    <Text {...dimProps(color)} wrap="truncate-end">
      {thinRule(grid.content, !color)}
    </Text>
  );
  const prefix = glyphOf('yourTurn', !color);
  if (palette !== undefined) {
    // The in-flight turn stands above the palette's list with its own margin (its tool rows mark it); the palette is the content column's.
    return (
      <Box flexDirection="column" flexShrink={0}>
        {props.live}
        <ContentColumn grid={grid}>
          <PaletteAbovePrompt
            palette={palette}
            maxRows={palette.maxRows}
            ruleColumns={grid.content}
            contentColumns={grid.content}
            color={color}
          />
        </ContentColumn>
      </Box>
    );
  }
  // The status line is fitted to what the terminal leaves right of the margin (the Home's budget: `W` would drop `used` and the turns at 80 columns).
  const status = chatStatusLine(
    props.state,
    { mode: props.mode, reasoningEffort: props.reasoningEffort, provider: props.provider },
    grid.columns,
    grid.margin,
  );
  const showsHint = props.promptShown || props.running;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <ContentColumn grid={grid}>
        <LeadRow copied={props.copied} warnings={props.state.warnings} color={color} />
      </ContentColumn>
      {props.live}
      <ContentColumn grid={grid}>
        {/* The pending `@`/`!` attachment chip bar (2.5.D) — shown above the idle prompt so the queued file/command
          context is always visible without flooding the editor. */}
        {props.promptShown && props.attachments.length > 0 && (
          <AttachmentBar attachments={props.attachments} color={color} columns={grid.content} />
        )}
        {/* The multi-line input prompt (idle) with the cursor at its position, in a box of EXACTLY the content column: the editor's own hard wrap
          (`columns`, its windowed draft) and Ink's wrap of an unbounded draft are then the same width. Every segment is sanitized inside
          PromptEditor so a pasted/typed control sequence cannot corrupt the display or inject ANSI/OSC. Shared
          with the Home's prompt so both surfaces render the editor identically. */}
        {props.promptShown && (
          <Box flexDirection="column" flexShrink={0} width={grid.content}>
            <PromptEditor
              editor={props.editor}
              color={color}
              glyph={prefix}
              cursor={props.cursor}
              placeholder={hasConversation(props.state) ? PLACEHOLDER_REPLY : PLACEHOLDER_FIRST}
              maxRows={props.editorRows}
              columns={grid.content}
            />
          </Box>
        )}
        {rule}
        {/* Not `truncate-end`: the model fits its line to the width whenever the mode and the effort can (`statusLine`'s last resort), so a row that
          fits is drawn whole, and below the supported 80 columns, where even those words do not fit, the row WRAPS between words rather than being
          cut by Ink inside the cost (SE7-2: a cut row drew `$12…`, an amount without its qualifier). */}
        <Text {...colorProps(color, 'gray')}>{status.text}</Text>
        {/* The context-aware hint (2.5.C S6): at an EMPTY idle prompt the `/` palette is the command-discovery entry point and the key that
          leaves says where it leads; with a draft it is the draft's own keys; while a turn runs it is the key that ends the chat. */}
        {showsHint && (
          <Text {...dimProps(color)} wrap="truncate-end">
            {hintFor(props)}
          </Text>
        )}
      </ContentColumn>
    </Box>
  );
}

/**
 * The PURE chat render — transcript / in-flight turn / prompt echo / warnings / footer — with no `useInput`,
 * no state, and no store subscription. Extracted from `ChatApp` so the 2.5.B Home can render the chat region
 * inside its OWN single-`useInput` tree (one raw-mode owner) without duplicating this JSX. The live input echo
 * and every model/transcript string are sanitized at this display boundary so a pasted/streamed control
 * sequence cannot corrupt the terminal or inject ANSI/OSC.
 */
export function ChatView(props: Readonly<ChatViewProps>): ReactElement {
  const {
    state,
    tick,
    color,
    editor,
    running,
    mode,
    reasoningEffort,
    reasoningVisible,
    paletteOpen,
  } = props;
  const attachments = props.attachments ?? [];
  // The chat's grid (unit 9, `chat-grid.ts`): a margin the host owns and a content column that holds every word a person or a model wrote. Computed
  // ONCE here and read by every part of the frame, so the transcript, the live region and the prompt block cannot disagree about where the content is.
  // `grid` is the width as the host reports it (a suspended terminal, whose width is not a number, has no grid and so no transcript rows); `chromeGrid`
  // is the same grid with the 80-column fallback a width that is not usable gets ({@link chromeGridFor}), so the chrome is never asked for a width it cannot draw.
  const hostColumns = props.viewport?.cols ?? props.columns ?? 80;
  const grid = chatGrid(hostColumns);
  const chromeGrid = chromeGridFor(hostColumns);
  // The form of the margin a row of the live region is drawn with: the glyph (ASCII without colour) full-screen, the role word inline.
  const marginForm = marginFormFor(props.viewport !== undefined, color);
  // The turn streamed reasoning ⇒ render the collapsible "thinking" panel (2.5.H). Its body is the model's words in the content column, so its row
  // tail is estimated at the content column's width.
  const hasReasoning = state.liveReasoning.length > 0;
  const reasoningPanel = hasReasoning
    ? formatReasoningPanel({
        liveReasoning: state.liveReasoning,
        liveReasoningTruncated: state.liveReasoningTruncated,
        visible: reasoningVisible,
        columns: chromeGrid.content,
      })
    : undefined;
  // The pre-token busy line reads "Thinking…" ONLY while the model is plausibly reasoning (reasoning streamed AND no
  // tool call is currently executing) — the derivation is the pure, unit-tested {@link reasoningLabelActive}.
  const reasoningActive = reasoningLabelActive(hasReasoning, state.liveToolCalls);
  // When the palette is open it renders its own query line + hint below, so suppress the idle prompt + footer to
  // avoid two competing prompts (the palette owns the input focus until it closes).
  const showIdlePrompt = !running && paletteOpen !== true;
  // The whole-second live-turn elapsed (2.5.H) — `undefined` before a turn starts (no `turnStartedAtMs`), so the
  // pre-first-token status shows only when a turn is actually in flight.
  // An open approval card is the person's time, not the turn's: the timer excludes it (the sheet's own rule shows the wait, ADR-0147 §2).
  const awaitingApprovalMs =
    state.approvalSinceMs === undefined
      ? undefined
      : Math.max(0, props.nowMs - state.approvalSinceMs);
  const elapsedMs =
    state.turnStartedAtMs === undefined
      ? undefined
      : Math.max(
          0,
          props.nowMs - state.turnStartedAtMs - state.approvalWaitMs - (awaitingApprovalMs ?? 0),
        );
  // The in-flight busy line — the labeled compaction moment (ADR-0062 §7), the `!`-shell command line, the
  // pre-token live-turn status ("Working… {elapsed} · Esc stops the turn"), or the streaming token line (with the
  // elision marker). The branch matrix lives in the pure, unit-tested {@link formatBusyLine}; here we only map
  // its `dim` flag to `<Text>`. Only rendered while `running`.
  const renderBusyLine = (): ReactElement => {
    if (props.displaySuspended)
      return (
        <ContentColumn grid={chromeGrid} budget="content">
          <Text {...dimProps(color)} wrap="truncate-end">
            {legend([{ text: 'Display paused for an oversized control sequence' }], STOP_THE_TURN)}
          </Text>
        </ContentColumn>
      );
    if (
      props.markdown !== undefined &&
      !state.compacting &&
      props.busyCommand === undefined &&
      awaitingApprovalMs === undefined &&
      state.liveTokens.length > 0
    ) {
      const maxRows = props.viewport === undefined ? 24 : liveAnswerRowBudget(props.viewport.rows);
      const answerRows = Math.max(0, maxRows - 1);
      // The live tail is the model's words, laid out in the content column at its width: the finished reply is laid out at the same width
      // (`transcriptRows`), so the stream never reflows when the turn completes. Its rows go through the screen's filter and have the marker glyphs
      // blanked, as the finished reply's do (`screenStreamRow`; ADR-0145 §6, OQ4 as revised after review round 1 of unit 9).
      const answerColumns = chromeGrid.content;
      const lines = (
        color
          ? props.markdown.tail(answerColumns, answerRows)
          : props.markdown.plainTail(answerColumns, answerRows)
      ).map(screenStreamRow);
      // Each row stands on the grid with the reply's own role: `agent` on the first row of the stream and on a row that starts with a margin
      // word, drawn only as the inline renderer's word (the full-screen margin of a reply is blank), so a streamed `you   …` row is read as the
      // agent's WHILE it streams, as the finished reply's row will be (review round 2, S2-3).
      return (
        <Box flexDirection="column">
          {lines.map((line, index) => (
            <MarginRow
              key={index}
              role={index === 0 || startsWithMarginWord(line.text) ? 'agent' : undefined}
              grid={chromeGrid}
              form={marginForm}
            >
              <Text>
                <MarkdownText
                  spans={line.text === '' ? [{ text: ' ' }] : (line.spans ?? [{ text: line.text }])}
                  color={color}
                />
              </Text>
            </MarginRow>
          ))}
          <ContentColumn grid={chromeGrid} budget="content">
            <Text {...dimProps(color)} wrap="truncate-end">
              {spinnerFrame(tick)} {props.markdown.elided ? '… ' : ''}
              {legend([], STOP_THE_TURN)}
            </Text>
          </ContentColumn>
        </Box>
      );
    }
    const line = formatBusyLine({
      spinner: spinnerFrame(tick),
      compacting: state.compacting,
      busyCommand: props.busyCommand,
      liveTokens: props.markdown?.sourceTail() ?? state.liveTokens,
      liveTokensTruncated: state.liveTokensTruncated,
      elapsedMs,
      reasoningActive,
      // `props.viewport` is present exactly on the ALT screen, and it carries the terminal's size. Only that surface
      // has a FIXED-HEIGHT frame to overflow; the inline renderer's live region grows and the terminal scrolls it, so
      // it passes no bound and its output stays byte-identical.
      ...(props.viewport === undefined
        ? {}
        : { columns: chromeGrid.content, maxRows: liveAnswerRowBudget(props.viewport.rows) }),
    });
    // A STATUS line (compaction / shell / pre-token) already carries its inline "· Esc …" hint; a streaming
    // CONTENT line has no room for it, so surface the abort affordance on a compact dim line beneath it — `Esc`
    // aborts the whole turn (EA7), so the hint must persist for the ENTIRE turn, not just the pre-token wait.
    const abortHint = streamingAbortHint(line);
    return (
      <ContentColumn grid={chromeGrid} budget="content">
        {line.dim ? (
          <Text {...dimProps(color)} wrap="truncate-end">
            {line.text}
          </Text>
        ) : (
          <Text>{line.text}</Text>
        )}
        {abortHint !== undefined && (
          <Text {...dimProps(color)} wrap="truncate-end">
            {abortHint}
          </Text>
        )}
      </ContentColumn>
    );
  };
  // The full-screen alt-screen renderer (ADR-0068 §c, 2.6.F Step 4b) renders the transcript through the scroll
  // VIEWPORT (the alt buffer has no scrollback for `<Static>` to use); the inline renderer (default) keeps `<Static>`
  // + native scrollback. In alt mode this Box FLEX-GROWS to fill the leftover height its OWNER (ChatApp / the Home's
  // ChatRegion) leaves below any keyboard-owning overlay, inside their terminal-`rows`-bounded container — so the
  // TranscriptViewport inside has a bound to flex-grow into, and the overlays are never pushed off-screen.
  const viewport = props.viewport;
  const host = props.surface ?? 'standalone-chat';
  // Alt-screen only: flatten + width-wrap the transcript to display lines, MEMOIZED on (transcript, cols) so a
  // streaming turn (which re-renders each frame with the SAME completed-transcript reference) reuses the prior wrap
  // instead of re-wrapping all history every frame. `state.transcript` is a stable reference until an entry is
  // appended (immutable session-view-model), so the memo hits across ticks and busts on a real append or a resize.
  // The rows are the grid's (`transcriptRows`, at the content column's width): the scroll, the copy and the acknowledgement read the same rows.
  const fullScreen = viewport !== undefined;
  const wrappedTranscript = useMemo(
    () =>
      fullScreen ? transcriptRows(state.transcript, grid, color, props.toolDisplays) : undefined,
    // `grid` is rebuilt every render; its content width is what the rows depend on.
    [fullScreen, grid.content, state.transcript, color, props.toolDisplays],
  );
  // Static advances its cursor even when a child paints no rows. Retain its
  // admitted prefix during width suspension, then deliver pending entries once
  // geometry is valid. Passing [] would reset Ink's cursor and reprint history.
  const inlineWidthReady =
    props.columns === undefined || (Number.isFinite(props.columns) && props.columns >= 1);
  const admittedInlineCount = useRef(0);
  useLayoutEffect(() => {
    if (viewport === undefined && inlineWidthReady)
      admittedInlineCount.current = state.transcript.length;
  }, [viewport, inlineWidthReady, state.transcript]);
  const inlineTranscript = inlineWidthReady
    ? state.transcript
    : state.transcript.slice(0, admittedInlineCount.current);
  // The header's title: the first user line, derived again only when that line changes (a pasted log dump is not scanned on every frame).
  const firstLine = firstUserLine(state.transcript);
  const title = useMemo(() => chatSessionTitle(firstLine), [firstLine]);
  // The in-flight turn: tool annotations + the streaming assistant text + a spinner. A `!`-shell command in
  // flight (busyCommand set) emits no session tokens, so it shows a distinct LABELED line — what is running +
  // the honest Esc-to-cancel affordance (Esc or the first Ctrl+C aborts the command, keeping the session; a second Ctrl+C
  // within two seconds ends it). It stands where the prompt row would, in the prompt block.
  // On the grid (unit 9, `LiveTurn`): a tool call's row has the host's mark in the margin and the call's words in the content column; every other
  // row of the turn is the content column's, and the margin beside it is blank, so nothing the model wrote can stand where a mark does.
  const liveTurn = running ? (
    <LiveTurn
      state={state}
      color={color}
      grid={chromeGrid}
      marginForm={marginForm}
      toolDisplays={props.toolDisplays}
      reasoning={reasoningPanel}
      busyLine={renderBusyLine()}
      interruptArmed={props.interruptArmed === true}
      host={host}
    />
  ) : undefined;
  return (
    <Box
      display={props.hidden === true ? 'none' : 'flex'}
      flexDirection="column"
      {...(viewport === undefined ? {} : { flexGrow: 1 })}
    >
      {/* The header (ADR-0146 §4): the wordmark and the session title, then a blank row. Full-screen it is the first child; inline it is the
          first item of the scrollback (below), because inline has no fixed top row. */}
      {viewport !== undefined && (
        <ChatHeaderView title={title} columns={viewport.cols} color={color} accent />
      )}
      {/* Completed transcript. Inline: ink `<Static>` prints each entry once → native scrollback. Alt-screen: the
          {@link TranscriptViewport} flex-grows to the leftover height and renders only the visible window (tail-
          following at Step 4b-1), since the alt buffer has no scrollback for `<Static>` to use. */}
      {viewport === undefined || wrappedTranscript === undefined ? (
        <InlineScrollback
          entries={inlineTranscript}
          introduction={props.introduction === true}
          printedAbove={props.printedAbove === true}
          displays={props.toolDisplays}
          color={color}
          columns={props.columns}
          acknowledgement={props.acknowledgement}
        />
      ) : (
        <TranscriptViewport
          lines={wrappedTranscript}
          grid={grid}
          color={color}
          scroll={viewport.scroll}
          selection={viewport.selection}
          onMeasure={viewport.onMeasure}
          terminalRows={viewport.rows}
          onDisplay={(firstRow, endRow, measuredWidth) =>
            props.acknowledgement?.viewport(
              state.transcript,
              viewport.cols,
              firstRow,
              endRow,
              measuredWidth,
              props.toolDisplays,
            )
          }
        />
      )}

      {/* The prompt block (ADR-0146 §4): a blank row, the prompt, a thin rule, the status line, the hint. While a turn runs the in-flight turn
          stands where the prompt would (below), and the rule, the status line and the hint stay. A docked sheet takes the block's place
          (ADR-0147 §1): the prompt, its rule, the status line and the hint are not drawn, and the in-flight turn stays above the sheet. */}
      {props.cardDocked === true ? (
        <DockedTurn
          state={state}
          color={color}
          running={running}
          toolDisplays={props.toolDisplays}
          reasoning={reasoningPanel}
          interruptArmed={props.interruptArmed === true}
          host={host}
          grid={chromeGrid}
          marginForm={marginForm}
          viewportRows={viewport?.rows}
          terminalRows={props.terminalRows}
        />
      ) : (
        <PromptBlock
          state={state}
          color={color}
          host={host}
          mode={mode}
          reasoningEffort={reasoningEffort}
          provider={props.provider}
          grid={chromeGrid}
          running={running}
          interruptArmed={props.interruptArmed === true}
          editor={editor}
          cursor={props.composerCursor !== false}
          attachments={attachments}
          promptShown={showIdlePrompt}
          palette={props.palette}
          notification={props.notification}
          copied={props.copied === true}
          editorRows={chatEditorRows(viewport?.rows, props.terminalRows)}
          live={liveTurn}
        />
      )}
    </Box>
  );
}

/**
 * The in-flight turn of a chat that is not waiting on a sheet, on the grid (unit 9): a tool call's row through {@link MarginRow} (the host's mark in the
 * margin, the call's words in the content column), then the collapsible "thinking" panel (2.5.H, a dim header with the Ctrl+T toggle hint and the
 * reasoning body only when expanded: {@link ReasoningRows}), the busy line or the streamed answer (`busyLine`, drawn by the view that owns the timer;
 * it places its own rows on the grid, a streamed row with its margin), and the interrupt note in the content column: the first Ctrl+C on a running
 * turn interrupts it and arms, and a turn that is slow to stop (a hung tool) would otherwise show nothing at all (at an idle prompt the hint row
 * carries the same words).
 */
function LiveTurn(
  props: Readonly<{
    state: SessionViewState;
    color: boolean;
    grid: ChatGrid;
    marginForm: MarginForm;
    toolDisplays: ChatViewProps['toolDisplays'];
    reasoning: ReasoningPanel | undefined;
    busyLine: ReactElement;
    interruptArmed: boolean;
    host: ChatHost;
  }>,
): ReactElement {
  const { state, color, reasoning } = props;
  const calls = state.liveToolCalls.filter((call) => state.liveObserver !== true || !call.resolved);
  return (
    <Box flexDirection="column">
      {calls.map((call) => (
        <MarginRow
          key={call.id}
          role="toolCall"
          grid={props.grid}
          form={props.marginForm}
          mark={colorProps(color, 'yellow')}
        >
          <Text {...colorProps(color, 'yellow')}>
            {withGlyphForm(!color, () =>
              screenText(toolCallText(call, props.toolDisplays?.get(call.id))),
            )}
          </Text>
        </MarginRow>
      ))}
      {reasoning !== undefined && (
        <ReasoningRows
          reasoning={reasoning}
          grid={props.grid}
          form={props.marginForm}
          color={color}
        />
      )}
      {/* The busy line places itself on the grid: the streamed answer's rows each with their margin, a status line in the content column. */}
      {props.busyLine}
      {props.interruptArmed && (
        <ContentColumn grid={props.grid} budget="content">
          <Text {...dimProps(color)} wrap="truncate-end">
            {legend([{ text: 'Interrupting' }], leavesAgain(props.host))}
          </Text>
        </ContentColumn>
      )}
    </Box>
  );
}

/**
 * The live reasoning panel on the grid: its header in the content column, and its body there too, one Ink-wrapped text, full-screen. In the
 * inline renderer (the margin's WORD form) the body is laid out in rows at the content column's width so that a row that starts with a margin word
 * carries the reply's `agent` while it streams (review round 2, S2-3), as a reply's row does.
 */
function ReasoningRows(
  props: Readonly<{ reasoning: ReasoningPanel; grid: ChatGrid; form: MarginForm; color: boolean }>,
): ReactElement {
  const { reasoning, grid, color } = props;
  const header = (
    <ContentColumn grid={grid} budget="content">
      <Text {...dimProps(color)} wrap="truncate-end">
        {reasoning.header}
      </Text>
      {reasoning.body !== undefined && props.form !== 'word' && (
        <Text {...dimProps(color)}>{reasoning.body}</Text>
      )}
    </ContentColumn>
  );
  if (reasoning.body === undefined || props.form !== 'word') return header;
  return (
    <Box flexDirection="column">
      {header}
      {wrapText(reasoning.body, Math.max(1, grid.content), true).map((row, index) => (
        <MarginRow
          key={index}
          role={startsWithMarginWord(row) ? 'agent' : undefined}
          grid={grid}
          form={props.form}
        >
          <Text {...dimProps(color)}>{row === '' ? ' ' : row}</Text>
        </MarginRow>
      ))}
    </Box>
  );
}

/** The colour of a row of the in-flight turn above a docked sheet: the prompt block's own for the same row (warnings and tool lines amber). */
function dockedTone(tone: DockedTurnRow['tone'], color: boolean): Partial<TextProps> {
  return tone === 'warning' || tone === 'tool' ? colorProps(color, 'yellow') : dimProps(color);
}

/**
 * The in-flight turn while a sheet is docked ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
 * §1, ADR-0129 "the conversation visible above it"): the lead row's warnings, and while the turn runs its tool-call lines with their outcomes,
 * the reasoning panel and the interrupt note ({@link dockedTurnRows}), never the busy line. Bounded by the rows the conversation keeps above the
 * largest sheet ({@link sheetTranscriptRows}), the newest kept, so the sheet keeps its rows; in the full-screen frame it stands at the bottom of
 * the conversation's flex region, and the transcript above it takes what is left. It stands on the grid (unit 9) as the live region does: a tool
 * call's row has the host's mark in the margin and the call's words in the content column ({@link MarginRow}), every other row is the content
 * column's, and the rows are cut at the content column's width; the row budget is the sheet's and does not move.
 */
function DockedTurn(
  props: Readonly<{
    state: SessionViewState;
    color: boolean;
    running: boolean;
    toolDisplays: ChatViewProps['toolDisplays'];
    reasoning: ReasoningPanel | undefined;
    interruptArmed: boolean;
    host: ChatHost;
    grid: ChatGrid;
    /** The margin's form: the glyph full-screen, the role word inline ({@link marginFormFor}). */
    marginForm: MarginForm;
    /** The alternate screen's viewport rows (the terminal's less the one its frame keeps free), absent inline. */
    viewportRows: number | undefined;
    /** The terminal's rows as the host reports them (inline), absent when it does not. */
    terminalRows: number | undefined;
  }>,
): ReactElement | null {
  const { state, running } = props;
  const terminalRows =
    props.viewportRows === undefined ? props.terminalRows : props.viewportRows + 1;
  const calls = running
    ? state.liveToolCalls.filter((call) => state.liveObserver !== true || !call.resolved)
    : [];
  const rows = withGlyphForm(!props.color, () =>
    dockedTurnRows({
      warnings: state.warnings,
      toolLines: calls.map((call) =>
        screenText(toolCallText(call, props.toolDisplays?.get(call.id))),
      ),
      reasoning: running ? props.reasoning : undefined,
      interrupt:
        running && props.interruptArmed
          ? legend([{ text: 'Interrupting' }], leavesAgain(props.host))
          : undefined,
      columns: props.grid.content,
      maxRows: sheetTranscriptRows(terminalRows ?? DOCKED_FALLBACK_ROWS),
    }),
  );
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, index) => (
        <DockedRow
          key={index}
          row={row}
          color={props.color}
          grid={props.grid}
          marginForm={props.marginForm}
        />
      ))}
    </Box>
  );
}

/** One row of the in-flight turn above a docked sheet: a tool call's through {@link MarginRow} (the mark in the margin), every other in the content column. */
function DockedRow(
  props: Readonly<{ row: DockedTurnRow; color: boolean; grid: ChatGrid; marginForm: MarginForm }>,
): ReactElement {
  const tone = dockedTone(props.row.tone, props.color);
  const text = (
    <Text wrap="truncate-end" {...tone}>
      {props.row.text}
    </Text>
  );
  if (props.row.tone === 'tool')
    return (
      <MarginRow role="toolCall" grid={props.grid} form={props.marginForm} mark={tone}>
        {text}
      </MarginRow>
    );
  return (
    <ContentColumn grid={props.grid} budget="content">
      {text}
    </ContentColumn>
  );
}

/** The terminal height the docked turn is bounded for when a host does not say (the product's floor). */
const DOCKED_FALLBACK_ROWS = 24;

/** Preserve explicit native widths that Ink's fallback would normalize to 80. */
function useRawTerminalColumns(): number | undefined {
  const { stdout } = useStdout();
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      stdout.on('resize', listener);
      return () => {
        stdout.off('resize', listener);
      };
    },
    [stdout],
  );
  const read = useCallback((): number | undefined => stdout.columns, [stdout]);
  return useSyncExternalStore(subscribe, read, read);
}

const subscribeNoPrompt = (): (() => void) => () => undefined;
const NO_PROMPT: NativePromptSnapshot = {
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
const noPrompt = (): NativePromptSnapshot => NO_PROMPT;
const CLOSED_POPUPS: PopupHostSnapshot = {
  open: false,
  depth: 0,
  placement: 'overlay',
  frame: undefined,
};
const closedPopupsSnapshot = (): PopupHostSnapshot => CLOSED_POPUPS;
const NO_NOTIFICATION: NotificationSnapshot = { current: undefined, queued: 0, held: false };
const noNotificationSnapshot = (): NotificationSnapshot => NO_NOTIFICATION;

/**
 * The composer as a host hands it to its view (ADR-0148 §2, one owner of the keys): while the slot draws a popup the keys are the popup's, so
 * the composer's cursor block is not drawn (a lit cursor beside a popup says the composer takes keys it does not), and its text stays as it is;
 * once the popup closes the cursor is back where it was. `promptRows` places the cursor only on a row whose span holds its offset, so an offset
 * before the text places it on none. The Home's body takes its composer this way; the chat says the same thing with `ChatView`'s `composerCursor`.
 */
export function composerEditor(editor: EditorState, drawing: SlotDrawing | undefined): EditorState {
  return drawing === undefined ? editor : { text: editor.text, cursor: -1 };
}

/**
 * Whether a sheet docked below the chat is open (OB7-L2, ADR-0147 §1): an approval or command card, the agent's question, or the continue
 * checkpoint. Each draws its own legend and owns the keyboard, and it takes the prompt block's place (`ChatViewProps.cardDocked`): the two legends
 * disagreed about what `Esc` and `Ctrl+C` do. The card's full view and the details screen take the whole screen (the view is hidden then), and a
 * popup is drawn over the view with its own legend row, so neither is among them.
 */
export function dockedCardOpen(
  flags: Pick<OverlayFlags, 'approval' | 'question' | 'checkpoint'>,
): boolean {
  return flags.approval || flags.question || flags.checkpoint;
}

/**
 * The notification a host's hint row draws (ADR-0148 §2 "Notifications"): none while the slot draws an overlay popup, which draws it in its own
 * legend row (the hint row around the box would otherwise repeat it, dimmed, at the popup's edges); otherwise the channel's current one. An
 * inline popup replaces the body, hint row included, so it needs no exception here; once the popup closes the hint row shows the notification as
 * before.
 */
export function hintRowNotification(
  current: string | undefined,
  drawing: SlotDrawing | undefined,
): string | undefined {
  // A notification can name what a person or a project wrote (a path, a name): it goes through the screen's filter like every other row.
  return drawing?.placement === 'overlay' || current === undefined
    ? undefined
    : screenText(current);
}

/**
 * The kinds of sheet a stand-alone chat has (its store's cards, its native prompt channel) and how to follow them, for {@link bindPopupHost}:
 * a sheet of either kind that ARRIVES over a popup closes it unanswered (ADR-0148 §2: the sheet wins, nothing is restored). A card that was
 * already there when a popup opened (a race the open gate refuses) does not close it: its custody is revoked and its evidence reset instead.
 */
export function chatSheetSources(
  store: Pick<ChatStoreController, 'getSnapshot' | 'subscribe'>,
  native: Pick<NativePromptUi, 'getSnapshot' | 'subscribe'> | undefined,
): PopupSheetSources<'card' | 'native'> {
  return {
    present: () => {
      const cards = cardFlagsFrom(store.getSnapshot());
      return {
        card: cards.approval || cards.question || cards.checkpoint,
        native: native?.getSnapshot().active === true,
      };
    },
    subscribe: (onChange) => {
      const stopStore = store.subscribe(onChange);
      const stopNative = native?.subscribe(onChange);
      return () => {
        stopStore();
        stopNative?.();
      };
    },
  };
}

/**
 * Why a popup may not open in a stand-alone chat now (ADR-0148 §2), or `undefined`: the one refusal (`popup-refusal.ts`) over this chat's facts.
 * A card is open (an approval or its review, a question, a checkpoint), a native card is, a turn, a submit or a `!` command runs, the interrupt
 * keymap is armed, or another overlay owns the keyboard. A stand-alone chat is never starting and has no native action.
 */
export function chatPopupRefusal(facts: {
  readonly overlays: OverlayFlags;
  readonly turn: TurnFacts;
  readonly interruptArmed: boolean;
}): PopupRefusal | undefined {
  const { overlays } = facts;
  return popupRefusal({
    cards: overlays.approval || overlays.review || overlays.question || overlays.checkpoint,
    sheet: overlays.nativePrompt,
    turn: facts.turn,
    armed: facts.interruptArmed,
    overlay: overlayOwnsKeyboard(overlays),
  });
}
export function ChatApp(props: Readonly<ChatAppProps>): ReactElement {
  const clipboardFeedbackMounted = useRef(true);
  useLayoutEffect(() => {
    clipboardFeedbackMounted.current = true;
    return () => {
      clipboardFeedbackMounted.current = false;
    };
  }, []);
  const nativeSnapshot = useSyncExternalStore(
    props.modePrompt?.ui.subscribe ?? subscribeNoPrompt,
    props.modePrompt?.ui.getSnapshot ?? noPrompt,
  );
  const nativeActive = nativeSnapshot.active;
  /** Where a popup is drawn on this renderer: over the chat in the alternate screen, in its place inline (ADR-0148 §4). */
  const placement: PopupPlacement = props.alternateScreen === true ? 'overlay' : 'replace';
  // One notification channel and one popup host per chat, on the store's key history (ADR-0148 §2), unless the driver gave them.
  const [ownNotifications] = useState<NotificationChannel | undefined>(() =>
    props.notifications === undefined ? createNotificationChannel() : undefined,
  );
  const notifications = props.notifications ?? ownNotifications;
  const [ownPopups] = useState<PopupHost | undefined>(() =>
    props.popups === undefined
      ? createPopupHost({ history: props.store.keyHistory, notifications, placement })
      : undefined,
  );
  const popups: PopupHost | undefined = props.popups ?? ownPopups;
  useEffect(
    () => () => {
      ownPopups?.dispose();
      ownNotifications?.dispose();
    },
    [ownPopups, ownNotifications],
  );
  // The session's announcements (its typed settings, its mode control and its settings popups) are THIS chat's own notifications while it is
  // mounted (ADR-0148 §2, §6): raised with no popup as their source, so a setting's word outlives the popup that applied it, and never written
  // into the transcript. Unbound when the chat unmounts (a `/clear` or a reseat mounts the next chat, which binds its own).
  const setAnnouncer = props.setAnnouncer;
  useLayoutEffect(() => {
    if (setAnnouncer === undefined || notifications === undefined) return;
    setAnnouncer((text, topic) => {
      notifications.notify(text, undefined, topic);
    });
    return () => {
      setAnnouncer(undefined);
    };
  }, [setAnnouncer, notifications]);
  const popupSnapshot = useSyncExternalStore(
    popups?.subscribe ?? subscribeNoPrompt,
    popups?.getSnapshot ?? closedPopupsSnapshot,
  );
  const notification = useSyncExternalStore(
    notifications?.subscribe ?? subscribeNoPrompt,
    notifications?.getSnapshot ?? noNotificationSnapshot,
  );
  /** A popup is open and no native prompt is over it: this root's reader routes its keys (the native prompt has its own reader). */
  const popupReads = (): boolean =>
    props.inputEnabled?.() !== false &&
    popups?.getSnapshot().open === true &&
    props.modePrompt?.ui.getSnapshot().active !== true;
  const acceptsInput = (): boolean =>
    props.inputEnabled?.() !== false && holdsCustody(liveOverlays());
  const storeRef = useRef(props.store);
  storeRef.current = props.store;
  const [acknowledgement] = useState(() => createTranscriptAcknowledgement(() => storeRef.current));
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
  } = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const activationReady = useRef(props.onActivated === undefined);
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  // A ref SHADOW of the editor is the SOURCE OF TRUTH for edits: in a coalesced stdin chunk ink dispatches every
  // event synchronously with no render flush, so React's queued-updater `prev` is stale for the 2nd+ event of the
  // burst (only the first dispatch runs eagerly). `applyEditor` therefore folds against `editorRef.current` (the
  // synchronous latest — updated the INSTANT it is called, matching the palette/search/mention/shellBusy ref-
  // shadows) and mirrors the result into React state for render, so a same-chunk edit→edit→Return reads the fully
  // folded buffer, never a stale capture.
  const editorRef = useRef<EditorState>(emptyEditor());
  const applyEditor = (next: (current: EditorState) => EditorState): void => {
    const value = next(editorRef.current);
    editorRef.current = value;
    setEditor(value);
    keepNamedAttachments(value.text);
  };
  const cancelFired = useRef(false);
  // The one interrupt keymap (ADR-0115 §1). `interruptRef` is its whole state (when it was armed, on the monotonic clock);
  // `interruptArmed` only drives the footer hint, and the timer takes the hint down when the window runs out.
  const interruptRef = useRef<InterruptState>(DISARMED);
  const [interruptArmed, setInterruptArmed] = useState(false);
  const interruptTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showInterruptHint = (armed: boolean): void => {
    if (interruptTimer.current !== undefined) clearTimeout(interruptTimer.current);
    interruptTimer.current = undefined;
    setInterruptArmed(armed);
    if (!armed) return;
    interruptTimer.current = setTimeout(() => {
      interruptTimer.current = undefined;
      setInterruptArmed(false);
    }, INTERRUPT_ARM_WINDOW_MS);
    interruptTimer.current.unref();
  };
  // Any key but `Ctrl+C` ends the armed state at once (ADR-0115 §1): a key a card swallows, a scroll key and a paste included.
  const disarmInterrupt = (): void => {
    if (interruptRef.current.armedAt === undefined) return;
    interruptRef.current = pressOtherKey();
    showInterruptHint(false);
  };
  useEffect(
    () => () => {
      if (interruptTimer.current !== undefined) clearTimeout(interruptTimer.current);
    },
    [],
  );
  // The copy-on-select confirmation toast (2.6.F Step 6i) — `flashCopied` on a `written` outcome, rendered as a
  // transient pill by `ChatView` (not a transcript entry, so the selection never shifts).
  const { copied, flashCopied } = useCopiedToast();
  // The alt-screen transcript SCROLL state (2.6.F Step 4b-2) — React-local here (the Home keeps it in the
  // controller), ref-shadowed like the editor so a coalesced stdin chunk reduces off the latest. The live geometry
  // (total wrapped lines + measured viewport rows) is lifted from `TranscriptViewport.onMeasure` into `scrollGeomRef`
  // so a scroll key reduces against the SAME geometry the viewport windows with. Inert in the inline renderer.
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
  // The mouse selection (2.6.F Step 6), held exactly like `scroll`: React state for the render, a ref so a coalesced
  // stdin chunk (a drag burst arrives as several reports in ONE read) reduces off the latest, not the render closure.
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
  // NOTE (ADR-0068 §c force-scroll override): a per-tool approval prompt / human gate must never be HIDDEN by a
  // paused scroll. In this layout it inherently cannot be — the Ctrl+Y/Ctrl+G/Ctrl+N prompt renders in the FIXED live region
  // BELOW the scrollable transcript viewport, so it is always on-screen regardless of the transcript scroll offset.
  // A transcript force-follow would only yank the user off history they are reading, so it is deliberately NOT wired.
  const running = state.status === 'running';
  // The interactive `/` palette (2.5.C S3b) — `undefined` ⇒ closed. React-local here (the external-store Home
  // keeps it in HomeControllerState); both surfaces drive the SAME foldPaletteKey + render the SAME PaletteView.
  // A ref SHADOW (like `editorRef`) keeps the latest value across a COALESCED stdin chunk — ink fires every event
  // in one chunk synchronously with no render flush, so reading the render-closure `palette` would be stale (a
  // close/select in event A would not be seen by a same-chunk event B, re-opening the palette). `applyPalette` keeps the ref in
  // lockstep with state; the input handler reads `paletteRef.current`, the render reads `palette`. The palette is ONE value, its state and the
  // rows that state reads (MVP-11 Step 2.2: built once per change, shared by the key fold and the view), so the two cannot be stored apart.
  const [palette, setPalette] = useState<OpenPalette | undefined>(undefined);
  const paletteRef = useRef<OpenPalette | undefined>(undefined);
  const applyPalette = (next: OpenPalette | undefined): void => {
    paletteRef.current = next;
    setPalette(next);
  };
  // Per-session command history (2.5.D step 3): Up/Down recall, Ctrl+R reverse-searches. History is a ref (not
  // rendered directly); the reverse-search submode is React-local + ref-shadowed like the palette (it renders a
  // search line and must survive a coalesced stdin chunk).
  const historyRef = useRef<InputHistory>(EMPTY_HISTORY);
  const [search, setSearch] = useState<ReverseSearchState | undefined>(undefined);
  const searchRef = useRef<ReverseSearchState | undefined>(undefined);
  const applySearch = (next: ReverseSearchState | undefined): void => {
    searchRef.current = next;
    setSearch(next);
  };
  // The `@`-mention completion submode (2.5.D step 4, ADR-0061) — dir-navigable file completion whose accepted file
  // is injected into the buffer as UNTRUSTED, user-position context. React-local + ref-shadowed (survives a
  // coalesced stdin chunk, like the palette/search). ASYNC: opening/descending a dir fires an fs `list()` whose
  // result lands via `applyMention` only if the submode is still open on the SAME dir (a stale resolve is dropped).
  // Present only when a `mentionReader` was wired (an interactive session); absent ⇒ `@` is a literal char.
  const [mention, setMention] = useState<MentionState | undefined>(undefined);
  const mentionRef = useRef<MentionState | undefined>(undefined);
  const applyMention = (next: MentionState | undefined): void => {
    mentionRef.current = next;
    setMention(next);
  };
  // What owns the keyboard (`overlay-flags.ts`), built in ONE place from the values given: the refs in a handler (a coalesced stdin chunk
  // sees what an earlier key of the same chunk just opened) and React's state at a render. A stand-alone chat has no screen, no exit-guard
  // card and no native action, so those three are written out as `false` (never defaulted: a flag added to the record must be decided here
  // too); the cards are the store's, read now, and the native prompt is the channel's.
  const overlayFlagsFrom = (
    open: Readonly<{
      palette: unknown;
      search: unknown;
      mention: unknown;
    }>,
    prompt: NativePromptSnapshot,
    popup: PopupHostSnapshot,
  ): OverlayFlags => ({
    palette: open.palette !== undefined,
    search: open.search !== undefined,
    mention: open.mention !== undefined,
    screen: false,
    exitGuard: false,
    nativePrompt: prompt.active,
    popup: popup.open,
    // A native card takes the chat's rows (it is drawn in its place); a prompt drawn as a popup, and a popup, only as a block in the flow.
    replacesBody:
      (prompt.active && (!nativeFramed(prompt) || placement === 'replace')) ||
      (popup.open && popup.placement === 'replace'),
    nativeActionBusy: false,
    ...cardFlagsFrom(props.store.getSnapshot()),
  });
  const liveOverlays = (): OverlayFlags =>
    overlayFlagsFrom(
      {
        palette: paletteRef.current,
        search: searchRef.current,
        mention: mentionRef.current,
      },
      props.modePrompt?.ui.getSnapshot() ?? NO_PROMPT,
      popups?.getSnapshot() ?? closedPopupsSnapshot(),
    );
  /** What is in flight in this chat now, read from the store and the refs (a coalesced chunk sees what an earlier key of it just started). */
  const liveTurnFacts = (): TurnFacts => ({
    running: props.store.getSnapshot().state.status === 'running',
    shellBusy: shellBusyRef.current,
    submitBusy: submitBusyRef.current,
  });
  const renderedOverlays = overlayFlagsFrom(
    { palette, search, mention },
    nativeSnapshot,
    popupSnapshot,
  );
  // ---- The popup (ADR-0148 §2) ----------------------------------------------------------------------------------------------------
  const { stdout } = useStdout();
  const terminalSize = (): { cols: number; rows: number } => ({
    cols: stdout.columns,
    rows: stdout.rows,
  });
  const terminalOwned = (): boolean =>
    props.inputEnabled?.() !== false &&
    props.suspendPort?.isSuspended() !== true &&
    stdout.writable !== false &&
    !stdout.destroyed &&
    !stdout.writableEnded;
  // The native prompt's acknowledgement, held here so the card (its own reader's view) and a prompt drawn as a popup (the slot) share it.
  const [nativeAcknowledgement] = useState(() =>
    props.modePrompt === undefined
      ? undefined
      : createNativePromptAcknowledgement(props.modePrompt.ui, terminalSize, terminalOwned),
  );
  // The popup's evidence: its content node, exactly the geometry's, measured and flushed while no native prompt is over it.
  const [popupAcknowledgement] = useState(() =>
    popups === undefined
      ? undefined
      : createPopupAcknowledgement<PopupHostSnapshot>({
          current: popups.getSnapshot,
          getSize: terminalSize,
          hasCustody: () => terminalOwned() && props.modePrompt?.ui.getSnapshot().active !== true,
          shown: (snapshot) => popups.shown(snapshot),
        }),
  );
  useEffect(() => {
    if (popups === undefined || popupAcknowledgement === undefined) return;
    return bindPopupHost({
      popups,
      acknowledgement: popupAcknowledgement,
      // The opening rules (ADR-0148 §2), read now: no card, no native card, no turn or submit, nothing armed, no other overlay.
      gate: () =>
        chatPopupRefusal({
          overlays: liveOverlays(),
          turn: liveTurnFacts(),
          interruptArmed: interruptRef.current.armedAt !== undefined,
        }),
      // A popup that opens over a card (a race) resets the card's acknowledgement and dwell origin, synchronously.
      onRevoke: () => {
        props.store.invalidateToolReview();
        nativeAcknowledgement?.invalidate();
      },
      // A sheet that ARRIVES over a popup wins: the popup closes unanswered.
      watchSheets: chatSheetSources(props.store, props.modePrompt?.ui),
    });
    // `liveOverlays` reads refs and the store at the call; the subscriptions are bound once per host.
  }, [popups, popupAcknowledgement, nativeAcknowledgement, props.store, props.modePrompt]);
  useEffect(() => () => nativeAcknowledgement?.dispose(), [nativeAcknowledgement]);
  // A monotonic submit generation: bumped every time the compose buffer is submitted (cleared). An async mention
  // read captures it at accept time and DROPS its inject if a submit has since happened — so a slow read that
  // resolves after Enter can never splice the file into the (now-empty) buffer meant for the NEXT message.
  const submitGenRef = useRef(0);
  // A `!`-shell command in flight (2.5.D step 5). `runUserCommand` makes the session busy (`#status: 'running'`)
  // but emits NO session event, so the store's `state.status` stays idle — WITHOUT this flag a plain message typed
  // during a slow `!npm test` would reach `sendMessage`, throw `SessionStateError`, and crash the whole session.
  // The REF gates keystrokes (coalesced-chunk safe, like `editorRef`); the state drives a busy indicator. Cleared
  // in EVERY settle branch (ran/denied/failed/cancelled + the reject arm).
  const [shellBusy, setShellBusy] = useState(false);
  const shellBusyRef = useRef(false);
  // The command line labeling the busy indicator (2.5.D) — `undefined` between commands. Set alongside the busy
  // flag so a slow `!`-command shows WHAT is running (it emits no session tokens); cleared in every settle branch.
  const [busyCommand, setBusyCommand] = useState<string | undefined>(undefined);
  const applyShellBusy = (busy: boolean, command?: string): void => {
    shellBusyRef.current = busy;
    setShellBusy(busy);
    setBusyCommand(busy ? command : undefined);
  };
  // A submit (a message turn OR a slash like `/compact`) in flight (ADR-0062). A turn's view `status:'running'`
  // covers only the STREAMING phase; **auto-compaction runs INSIDE `sendMessage` AFTER `session:turn_completed`
  // already flipped the view to idle**, leaving a multi-second window where the engine is busy but the view looks
  // idle — a message typed then would reach `sendMessage` → `SessionStateError` → crash (the exact hazard
  // `shellBusy` fixes for `!`-shell). This ref-shadowed flag gates input + drives the spinner for the WHOLE
  // submit (streaming + any compaction), so `Esc` still aborts and no keystroke can crash the session.
  const [submitBusy, setSubmitBusy] = useState(false);
  const submitBusyRef = useRef(false);
  const applySubmitBusy = (busy: boolean): void => {
    submitBusyRef.current = busy;
    setSubmitBusy(busy);
  };
  // Pending `@`/`!` attachments (2.5.D chip redesign) — an @-mentioned FILE (referenced inline by its `@path`
  // marker) or a `!`-command's captured OUTPUT. Ref-shadowed for coalesced-chunk-safe submit reads + state for the
  // chip bar; expanded into the UNTRUSTED frame at submit; cleared on send / Esc (idle) / unmount (chat end). One
  // file entry per path (dedup).
  const [attachments, setAttachments] = useState<readonly PendingAttachment[]>([]);
  const attachmentsRef = useRef<readonly PendingAttachment[]>([]);
  // The list is the attachments the draft still names (`attachmentsOfDraft`, the Home's own rule; round 2 sitting #3): pruned on every
  // change to the list here and on every edit of the draft (`applyEditor`), so a file whose marker left the draft is gone for good, the chip
  // bar shows what the next send carries, and a marker typed or pasted later is plain text.
  const applyAttachments = (next: readonly PendingAttachment[]): void => {
    const kept = attachmentsOfDraft(editorRef.current.text, next);
    attachmentsRef.current = kept;
    setAttachments(kept);
  };
  const keepNamedAttachments = (draft: string): void => {
    const pending = attachmentsRef.current;
    if (pending.length === 0) return;
    const kept = attachmentsOfDraft(draft, pending);
    if (kept !== pending) applyAttachments(kept);
  };
  // A held `Enter` that chose a file in the `@` picker sends nothing (`PickEnterLock`, shared with the Home's controller).
  const [pickEnter] = useState(createPickEnterLock);
  const addAttachment = (a: PendingAttachment): void => {
    const { list, dropped } = appendAttachment(attachmentsRef.current, a);
    applyAttachments(list);
    if (dropped > 0) {
      props.store.note(
        `pending attachment limit (${MAX_PENDING_ATTACHMENTS}) reached — oldest dropped`,
      );
    }
  };
  // List `dir`'s entries through the fs jail (listing-gate + noise filter enforced by the reader), applying them
  // ONLY if the submode is still open on that dir — a resolve from a since-closed or since-descended submode is
  // dropped. A `list()` rejection (the dir vanished) leaves the submode open with an empty, not-loading list.
  const loadMentions = (dir: string): void => {
    const reader = props.mentionReader;
    if (reader === undefined) return;
    void reader.list(dir).then(
      (candidates) => {
        if (!acceptsInput()) return;
        const open = mentionRef.current;
        if (open !== undefined && open.dir === dir)
          applyMention({ ...open, candidates, loading: false });
      },
      () => {
        if (!acceptsInput()) return;
        const open = mentionRef.current;
        if (open !== undefined && open.dir === dir)
          applyMention({ ...open, candidates: [], loading: false });
      },
    );
  };
  // Open the completion at the workspace root (the caller has already decided `@` opens — word boundary + reader).
  const openMention = (): void => {
    applyMention({ dir: '', filter: '', candidates: [], selected: 0, loading: true });
    loadMentions('');
  };
  // Read the accepted file through the fs jail + confidentiality floor + binary/size guards, then queue it as a
  // pending FILE attachment and insert a compact `@path` marker at the cursor (the chip bar shows it; it expands
  // into the UNTRUSTED frame only at submit, and only if the marker is still present). A read rejection (a floor
  // refusal, a binary file, oversize, since-deleted) surfaces a STATIC, secret-free note — never the raw error. A
  // large/truncated file adds an honest soft size note (the fs 8 MiB cap is the hard ceiling).
  const acceptMention = (path: string): void => {
    if (!acceptsInput()) return;
    const reader = props.mentionReader;
    if (reader === undefined) return;
    const gen = submitGenRef.current; // capture: a submit since accept ⇒ the buffer moved on (drop the marker/attachment)
    void reader.read(path).then(
      ({ content, sizeBytes }) => {
        if (!acceptsInput() || submitGenRef.current !== gen) return; // a sealed mount cannot publish late input
        applyEditor((current) => {
          historyRef.current = resetHistoryNav(historyRef.current); // a real edit ends history navigation
          return insertAtCursor(current, `${mentionMarker(path)} `);
        });
        addAttachment({ kind: 'file', path, content, sizeBytes });
        const warn = fileAttachmentWarning(path, content, sizeBytes);
        if (warn !== undefined) props.store.note(warn);
      },
      () => {
        if (!acceptsInput() || submitGenRef.current !== gen) return;
        props.store.note('@ mention could not read that file (refused, binary, or too large)');
      },
    );
  };

  // Render a `!`-shell outcome: on `ran`, queue the (full) output as a pending COMMAND attachment (it rides the
  // next message) and show a compact, read-only preview via the store; otherwise surface the actionable deny /
  // failure note. `gen` guards a stale resolve (a submit since the run) so a slow command never re-queues.
  const handleShellOutcome = (
    parsed: ShellCommand,
    outcome: UserCommandOutcome,
    mode: ChatMode,
    gen: number,
  ): void => {
    if (!acceptsInput() || submitGenRef.current !== gen) return;
    if (outcome.kind === 'ran') {
      addAttachment({
        kind: 'command',
        cmd: parsed,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      });
      props.store.notice(
        commandResultPreview(parsed, outcome.exitCode, outcome.stdout, outcome.stderr),
      );
      return;
    }
    if (outcome.kind === 'denied') {
      props.store.note(shellDenyHint(parsed, outcome.allowlist, mode));
      return;
    }
    props.store.note(
      outcome.kind === 'cancelled' ? '! command cancelled' : `! ${commandLine(parsed)} failed`,
    );
  };
  // Run a tokenized `!`-shell command through the session boundary (runUserCommand). The buffer is already cleared
  // by the submit case; the outcome injects/notes below. A truly unexpected rejection (e.g. a state guard) notes.
  const runShell = (parsed: ShellCommand): void => {
    if (!acceptsInput()) return;
    const runner = props.runShellCommand;
    if (runner === undefined) return;
    const gen = submitGenRef.current;
    const mode = props.store.getSnapshot().mode; // captured for a mode-aware deny hint
    // Gate input + show a LABELED busy indicator (the command line) until it settles (else a submit crashes).
    applyShellBusy(true, commandLine(parsed));
    void runner(parsed.command, parsed.args).then(
      (outcome) => {
        applyShellBusy(false);
        handleShellOutcome(parsed, outcome, mode, gen);
      },
      () => {
        applyShellBusy(false);
        if (acceptsInput() && submitGenRef.current === gen)
          props.store.note('! shell command failed unexpectedly');
      },
    );
  };

  // ---- `/models` (ADR-0148 §3, §6; ADR-0059) -------------------------------------------------------------------------------------------
  // The session's `/models` member with THIS chat's switch bound (the one binding, `bindModelSwitch`): `This chat` with another model asks
  // for the reseat (`onReseat` records the target and the stop state) and ends the driver, so `runReplLoop` rebuilds on the new model with
  // the model-switch marker as its first entry. Nothing is switched once input is sealed (the chat is closing). With no `onReseat` the
  // member is withdrawn, and a typed `/models` is dispatched.
  const reseatHere =
    props.onReseat === undefined
      ? undefined
      : (target: ReseatTarget): void => {
          if (!acceptsInput()) return;
          props.onReseat?.(target);
          props.onExit(); // the reseat set the stop state; end the loop so runReplLoop swaps in the new-model session
        };
  const settingsPort = bindModelSwitch(props.settings, reseatHere);

  // Attach ink's `suspendTerminal` to the ADR-0068 §e port while this tree is mounted (2.6.F Step 5d). `useApp()` is
  // the only place it exists, and the slash dispatch that runs `/scrollback` / `/edit` lives outside React — so the
  // port is the bridge. Detaching on unmount is what makes the hatches report "needs an interactive terminal" between
  // a `/clear`-swap's unmount and the next mount, rather than calling into a dead ink instance.
  // Invoked as a METHOD (`app.suspendTerminal(cb)`), never a bare destructured reference: ink 7 hands it out unbound
  // off the prototype, so this form is immune to how the context object is shaped.
  const app = useApp();
  const suspendPort = props.suspendPort;
  // Bumped once a suspension is over: one render then commits an open popup's frame again (see below).
  const [, setReclaimed] = useState(0);
  useEffect(() => {
    if (suspendPort === undefined) return;
    suspendPort.attach(async (callback) => {
      props.store.invalidateToolReview();
      popupAcknowledgement?.invalidate();
      try {
        await app.suspendTerminal(callback);
      } finally {
        // Reclaim requires new measured, flushed evidence; pre-suspend reveal never survives.
        props.store.invalidateToolReview();
        // The renderer redraws its last output on resume but commits nothing, so an open popup's frame would never be measured again and every
        // key but `Esc` and `Ctrl+C` would stay dropped as unseen: one render commits it anew, and its acknowledgement (flushed after the
        // terminal is ours again) is new evidence, its dwell counted from it.
        popupAcknowledgement?.invalidate();
        setReclaimed((count) => count + 1);
      }
    });
    return () => suspendPort.attach(undefined);
  }, [app, suspendPort, props.store, popupAcknowledgement]);

  /**
   * The chat's one open adapter (ADR-0148 §2): the popup `route` names, on this chat's popup host with this chat's port. The popup's code is
   * loaded on first use, and a load that fails is a fault of the chat (`onError`), never swallowed.
   */
  const openPopupRoute = (host: PopupHost, route: PopupRoute): void => {
    let opening: Promise<void> | undefined;
    if (route.kind === 'doctor') {
      if (props.doctor !== undefined)
        opening = openDoctor({ host, port: props.doctor, deep: route.deep, origin: 'chat' });
    } else if (route.kind === 'settings') {
      if (settingsPort !== undefined)
        opening = openSettings({
          host,
          port: settingsPort,
          command: route.command,
          origin: 'chat',
        });
    } else if (props.reports !== undefined) {
      opening = openReport({
        host,
        port: props.reports,
        line: route.line,
        origin: 'chat',
        // The facts the open gate read, read again by the release at the moment of its answer: the one predicate over the same facts.
        turnInFlight: () => turnInFlight(liveTurnFacts()),
      });
    }
    void opening?.catch((cause: unknown) => {
      props.onError(cause);
    });
  };

  const submit = (message: string, display?: string): void => {
    if (!acceptsInput()) return;
    if (!activationReady.current && message !== '/cancel' && message !== '/exit') return;
    // `/doctor` (and `--deep`, ADR-0148 §8), `/agent`, `/cost` (and `--release`), `/workflows` and `/help` (§10) and the bare settings (`/effort`
    // on a model with a tier to choose, `/models` where this chat can switch, §3 and §6) open their popup here, BEFORE the submit is marked in flight: the popup host's open gate reads
    // a submit in flight as a turn, and this line is not one. Any other form (`/doctor now`, `/cost --force`) dispatches and is rejected there,
    // and a setting with its value (`/effort high`) dispatches and applies it.
    const route =
      popups === undefined
        ? undefined
        : routePopupLine(message, {
            doctor: props.doctor !== undefined,
            reports: props.reports,
            settings: settingsPort,
          });
    if (route !== undefined && popups !== undefined) {
      openPopupRoute(popups, route);
      return;
    }
    // Mark the submit in flight so input is gated + the spinner runs for the WHOLE operation (streaming AND any
    // after-turn auto-compaction, ADR-0062) — cleared in EVERY settle branch (success / reject / defensive catch).
    applySubmitBusy(true);
    // Two-arm: a settled turn checks for exit; an UNEXPECTED rejection (the turn core's loud re-throw) goes to
    // onError so the driver always unblocks + tears down (else `exited` never settles and the REPL hangs). The
    // trailing .catch is defensive: a throw inside either callback still routes to onError, never silently lost.
    void props
      .onSubmit(message, display)
      .then(
        () => {
          applySubmitBusy(false);
          if (props.shouldStop()) props.onExit();
        },
        (err: unknown) => {
          applySubmitBusy(false);
          props.onError(err);
        },
      )
      .catch((err: unknown) => {
        applySubmitBusy(false);
        props.onError(err);
      });
  };

  // Bracketed paste on ink 7's native `usePaste` channel (separate from `useInput`, ADR-0068) — the whole paste is
  // ONE `text` event, so a multi-line block appends verbatim and a pasted approval token can never answer
  // the fail-closed floor (ADR-0057). Dropped unless the compose buffer is the active
  // editable target (mirrors the keystroke gate + the Home's `pasteEditable`): no running turn / `!`-shell / submit
  // in flight, no keyboard-owning overlay/submode, and NO pending approval (read FRESH from the store). This also
  // closes the standalone-chat paste gap — it never enabled DECSET 2004 before; usePaste enables it natively now.
  usePaste((text) => {
    // A paste goes into a popup's text field or nowhere: never to the composer behind it.
    if (popupReads()) {
      popups?.paste(text);
      return;
    }
    if (!acceptsInput()) return;
    if (!activationReady.current) return;
    // Line breaks normalised and control characters dropped, as a typed chunk is (`draftText`, MVP-11 unit 7 round 2: F6).
    const pasted = draftText(text);
    if (text.length === 0) return;
    disarmInterrupt();
    pickEnter.typed(); // a paste is typing: the next `Enter` is the person's
    if (pasted.length === 0) return; // nothing but controls: a key that edits nothing
    const snap = props.store.getSnapshot();
    // An open `ask_user` card owns a paste (ADR-0132): it goes into the card's own-answer field or is dropped — never the composer.
    if (snap.question !== undefined) {
      props.store.pasteIntoQuestion(pasted);
      return;
    }
    const editable = pasteIsEditable({
      running: snap.state.status === 'running',
      shellBusy: shellBusyRef.current,
      submitBusy: submitBusyRef.current,
      ...pasteFlagsFrom(liveOverlays()),
    });
    if (!editable) return;
    applyEditor((cur) => insertAtCursor(cur, pasted));
  });

  /**
   * Reduce one non-wheel mouse report into the selection (2.6.F Step 6). The viewport facts come from the measured
   * geometry (`top`/`left` — where the box sits in ink's frame) plus the LIVE wrap (`totalLines`/`height`), so a
   * drag during a streaming turn reduces against the transcript as it is now, not as it was at the last commit.
   */
  const chatLiveGeom = (): ScrollGeometry =>
    transcriptScrollGeometry(
      props.store.getSnapshot().state.transcript,
      chatGrid(windowSize.columns), // the grid `ChatView` draws with: its viewport's columns are these
      scrollGeomRef.current.height,
      props.store.getSnapshot().color,
      props.store.getSnapshot().toolDisplays,
    );

  const routeSelection = (event: TerminalMouseEvent): void => {
    routeMouseSelection(event, {
      geometry: () => {
        const measured = scrollGeomRef.current;
        const live = chatLiveGeom();
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
        applyScroll(reduceScroll(scrollRef.current, motion, chatLiveGeom())),
      pauseFollow: () => {
        const scroll = scrollRef.current;
        followedBeforeSelectionRef.current = scroll.following;
        if (!scroll.following) return;
        applyScroll({ offset: effectiveOffset(scroll, chatLiveGeom()), following: false });
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

  /**
   * Copy the selection to the system clipboard on release. SILENT on success: `store.notice` appends a transcript
   * entry, which would re-wrap and SHIFT the very lines the user just selected — the highlight would jump out from
   * under their pointer. Only a refusal (a selection past the terminal's OSC 52 length floor) is worth a notice.
   */
  const copySelection = (state: SelectionState): void => {
    const clipboard = props.clipboard;
    if (clipboard === undefined) return;
    // The content a person sees, without the margin (OQ9): the one copy path of both chat hosts.
    const selected = transcriptSelectionText(
      props.store.getSnapshot().state.transcript,
      chatGrid(windowSize.columns),
      normalizeSelection(state),
      props.store.getSnapshot().color,
      props.store.getSnapshot().toolDisplays,
    );
    const store = props.store;
    void attemptClipboardWrite(clipboard, selected)
      .then((outcome) => {
        if (
          !clipboardFeedbackMounted.current ||
          storeRef.current !== store ||
          !acceptsInput() ||
          props.shouldStop()
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
      .catch(props.onError);
  };

  // `/cancel` at most once: a held `Ctrl+C` would otherwise fire redundant turns.
  const cancelOnce = (): void => {
    if (cancelFired.current) return;
    cancelFired.current = true;
    submit('/cancel');
  };
  // What `Esc` does mid-turn: abort the turn and keep the session. A host wired without `onAbort` still must not leave a
  // pending approval hanging, so it rejects it directly: the stop key is never dead at a decision.
  const abortTurn = (): void => {
    if (props.onAbort !== undefined) props.onAbort();
    else if (props.store.getSnapshot().approval !== undefined)
      props.store.answerApproval({ outcome: 'reject' });
  };
  // Where the person is when they press `Ctrl+C`, read from the refs and the store so a coalesced chunk sees what an earlier key
  // of the same chunk just changed. An open card is `card`; the details view closes inside the store and never reaches here.
  const interruptContext = (cardStopped: boolean): InterruptContext => {
    if (cardStopped) return { kind: 'card' };
    const overlay = interruptContextFrom(liveOverlays());
    if (overlay !== undefined) return overlay;
    const busy =
      props.store.getSnapshot().state.status === 'running' ||
      shellBusyRef.current ||
      submitBusyRef.current;
    return busy ? { kind: 'work' } : { kind: 'prompt', hasText: editorRef.current.text.length > 0 };
  };
  const applyInterrupt = (
    cardResult: 'abort' | 'stop-answered' | undefined,
  ): 'consumed' | 'overlay' => {
    const decision = pressInterrupt(
      interruptRef.current,
      interruptContext(cardResult !== undefined),
      performance.now(),
    );
    interruptRef.current = decision.state;
    switch (decision.action) {
      case 'end-session':
        if (cardResult === 'abort') abortTurn();
        showInterruptHint(false);
        cancelOnce();
        return 'consumed';
      case 'stop-and-arm':
        if (cardResult !== 'stop-answered') abortTurn();
        showInterruptHint(true);
        return 'consumed';
      case 'clear-text':
        // The buffer is being consumed: a pending `@` mention read must not splice its marker into the now-empty draft.
        submitGenRef.current += 1;
        applyEditor((current) => {
          if (current.text.length === 0) return current;
          historyRef.current = resetHistoryNav(historyRef.current);
          return emptyEditor();
        });
        return 'consumed';
      case 'arm-hint':
        showInterruptHint(true);
        return 'consumed';
      case 'close-overlay':
        return 'overlay';
      case 'exit-now':
        // The Home's loading state; a chat has none, but the rule is the same: nothing to lose, leave.
        cancelOnce();
        return 'consumed';
    }
  };

  /**
   * One key while a popup is open (ADR-0148 §2): this root is the chat's one reader and routes it to the popup host, as it routes a key to a card.
   * Job control still wins, and a mouse report is consumed so its bytes never type into the popup.
   */
  const routePopupKey = (
    char: string,
    key: Parameters<NonNullable<PopupHost['input']>>[1],
  ): void => {
    if (char === '\x1a' || (key.ctrl === true && key.meta !== true && char.toLowerCase() === 'z')) {
      props.store.invalidateToolReview();
      popupAcknowledgement?.invalidate();
      props.onSuspend?.();
      return;
    }
    if (props.alternateScreen === true && mouseReaderRef.current.read(char).kind !== 'none') return;
    popups?.input(char, key);
  };

  const readChatKey = (char: string, key: Key): void => {
    if (popupReads()) {
      routePopupKey(char, key);
      return;
    }
    if (!acceptsInput()) return;
    // Raw Ink input represents Ctrl-Z as Ctrl+`z` (and a few test streams retain the literal SUB byte). It must win
    // over mouse parsing, overlays, and approval routing: job control is never prompt text and never consent.
    if (char === '\x1a' || (key.ctrl === true && key.meta !== true && char.toLowerCase() === 'z')) {
      props.store.invalidateToolReview();
      props.onSuspend?.();
      return;
    }
    const interrupt = isInterruptKey(char, key);
    // Before activation only the interrupt is live, and it ends the session: nothing is on screen yet that could be lost.
    if (!activationReady.current) {
      if (interrupt) cancelOnce();
      return;
    }
    // Mouse reports (Step 5): the alt screen enables mouse reporting, so a wheel/click arrives in EVERY state —
    // including while an overlay owns the keyboard. CONSUME every report HERE, ahead of the overlay routing below,
    // so its raw bytes can never type into the prompt, the `/` palette filter, or a card. The wheel
    // only SCROLLS when no overlay owns the keyboard (parity with the Home + the Step-4b-2 overlay gate).
    if (props.alternateScreen === true) {
      const read = mouseReaderRef.current.read(char);
      if (read.kind !== 'none') {
        const mouse = read.kind === 'event' ? read.event : undefined;
        if (mouse !== undefined && !pointerBlocked(liveOverlays())) {
          if (mouse.kind === 'wheel') {
            const geom = chatLiveGeom();
            const motion = mouse.direction === 'up' ? 'line-up' : 'line-down';
            let next = scrollRef.current;
            for (let i = 0; i < WHEEL_LINES; i += 1) next = reduceScroll(next, motion, geom);
            applyScroll(next);
          } else {
            routeSelection(mouse);
          }
        }
        return; // CONSUMED in every state — a mouse report's raw bytes must never type into the prompt
      }
    }
    if (!interrupt) disarmInterrupt();
    // Any key but `Enter` is the person typing: an `Enter` after it is theirs, never a repeat of the one that chose a file.
    if (!key.return) pickEnter.typed();
    const reviewAction = props.store.handleReviewInput(char, key);
    if (reviewAction === 'handled') return;
    if (interrupt) {
      // A card that stopped on this key has already been settled: an approval as a REJECTION, before the abort (ADR-0115 §2), and
      // a checkpoint as the answer "stop", which ends the turn itself (ADR-0136 §2), so nothing is aborted for it.
      if (applyInterrupt(reviewAction) === 'consumed') return;
      // Otherwise an overlay is open and closes itself on `Ctrl+C` below, arming nothing.
    } else if (reviewAction === 'abort') {
      abortTurn();
      return;
    }
    // Read `running` FRESH from the store (not the render closure) so a coalesced same-chunk event after a turn
    // settles sees the current status — matching the ref-shadow `editorRef`/`paletteRef` reads below.
    // Busy = a streaming turn OR a `!`-shell command in flight (the latter has no store status — read the ref so a
    // coalesced same-chunk key after the `!`-submit is gated too). A gated keystroke can't reach `sendMessage`.
    const isRunning =
      props.store.getSnapshot().state.status === 'running' ||
      shellBusyRef.current ||
      submitBusyRef.current;
    // The open `@`-mention completion owns every key (2.5.D step 4): Esc/Ctrl-C cancels + restores the literal
    // keystrokes; ↑/↓ select; Enter/Tab/'/' accept (a dir descends, a file injects); backspace trims the filter
    // then deletes the `@`; a printable extends the filter. Read the REF so a coalesced same-chunk key sees a
    // just-applied state. Checked FIRST — it is mutually exclusive with the palette/search (one submode at a time).
    const activeMention = mentionRef.current;
    if (activeMention !== undefined) {
      const step = foldMentionKey(char, key, activeMention);
      if (step.kind === 'close') {
        applyMention(undefined);
        // Restore the literal keystrokes (`@` + filter on cancel; `''` on backspace-past) so nothing typed is lost.
        // A restore is a real edit ⇒ end history navigation (idempotent), inside the functional updater.
        if (step.restore.length > 0) {
          applyEditor((current) => {
            historyRef.current = resetHistoryNav(historyRef.current);
            return insertAtCursor(current, step.restore);
          });
        }
        return;
      }
      if (step.kind === 'descend') {
        applyMention({ dir: step.dir, filter: '', candidates: [], selected: 0, loading: true });
        loadMentions(step.dir);
        return;
      }
      if (step.kind === 'accept') {
        applyMention(undefined);
        // The `Enter` that chose: its auto-repeats must not send the message the file lands in.
        if (key.return) pickEnter.chosen(performance.now());
        acceptMention(step.path);
        return;
      }
      applyMention(step.state);
      return;
    }
    // The open Ctrl+R reverse-search owns every key (Esc/Ctrl-C cancels; Enter accepts the match; Ctrl+R steps
    // older). Read the REF so a coalesced same-chunk event sees a just-applied close/accept. It is mutually
    // exclusive with the palette (only one submode opens at a time) and yields to a pending approval (below).
    const openSearch = searchRef.current;
    if (openSearch !== undefined) {
      const step = foldReverseSearchKey(char, key, openSearch, historyRef.current.entries);
      if (step.kind === 'close') {
        applySearch(undefined);
        return;
      }
      if (step.kind === 'accept') {
        applySearch(undefined);
        applyEditor(() => {
          // The accepted entry becomes the live buffer, NOT a history-nav result — reset nav (idempotent) so a
          // subsequent Down doesn't clobber it with the stale pre-search draft, and a subsequent Up saves it fresh.
          historyRef.current = resetHistoryNav(historyRef.current);
          return editorFromText(step.text); // load the matched entry (a replace, not a fold)
        });
        return;
      }
      applySearch(step.state);
      return;
    }
    // The open `/` palette owns every key (Ctrl-C closes it gently). Read the REF so a coalesced same-chunk event
    // sees a just-applied close/select, not the stale render-closure value.
    const paletteNow = paletteRef.current;
    if (paletteNow !== undefined) {
      const step = foldPaletteKey(char, key, paletteNow);
      if (step.kind === 'close') {
        applyPalette(undefined);
        return;
      }
      if (step.kind === 'run') {
        applyPalette(undefined);
        if (step.command !== undefined) {
          submit(`/${step.command.name}`); // reuse the S3a slash dispatch
        } else {
          // No row matched, or none is highlighted (A2): the person typed a line of their own (`/doctor --deep`, `/trim 20`, `/mode plan`, a
          // misspelling). It goes down the same dispatch a typed line takes, which validates the tokens and answers an unknown word, instead
          // of the text being dropped when the palette closes (round 2, U1).
          const typed = paletteNow.state.query.trim();
          if (typed.length > 0) submit(`/${typed}`);
        }
        return;
      }
      if (step.kind === 'unavailable') {
        // `Enter` on a dim row: its reason is said (the chat's own line) and the palette stays open. Never "unknown command", never run.
        props.store.note(
          unavailableNotice(
            paletteNow.list.rows[paletteNow.state.index]?.command.name ?? '',
            step.reason,
          ),
        );
        return;
      }
      applyPalette(step.palette);
      return;
    }
    // A pending approval OWNS the keyboard (never opens the palette): the card has taken every key before this point.
    const approvalPending = props.store.getSnapshot().approval !== undefined;
    // Open the palette on a literal '/' at an idle, EMPTY prompt — the discovery entry point (never mid-approval).
    if (
      !approvalPending &&
      shouldOpenPalette(char, key, isRunning, editorRef.current.text.length)
    ) {
      // The list opens ABOVE the prompt, so its first row is the one beside it and it is drawn bottom-up (ADR-0145 §7.1).
      applyPalette(
        openPalette(
          buildPaletteEntries('standalone-chat', {
            hasSession: true,
            hasKey: true,
            turnRunning: isRunning,
          }),
          'up',
        ),
      );
      return;
    }
    // Ctrl+R opens reverse-incremental history search (idle, not mid-approval) — a keyboard-owning submode.
    if (!approvalPending && !isRunning && key.ctrl === true && char === 'r') {
      applySearch(INITIAL_REVERSE_SEARCH);
      return;
    }
    // `@` at a word boundary opens dir-navigable file completion (2.5.D step 4) — idle, not mid-approval, and only
    // when a reader was wired (an interactive session). The `@` is NOT inserted (it lives in the overlay); a cancel
    // restores it. A mid-word `@` (an email/handle) or an absent reader falls through to `reduceChatKey` as a literal.
    if (
      !approvalPending &&
      !isRunning &&
      char === '@' &&
      key.ctrl !== true &&
      key.meta !== true &&
      props.mentionReader !== undefined &&
      mentionOpensAt(editorRef.current.text, editorRef.current.cursor)
    ) {
      openMention();
      return;
    }
    // Esc DISMISSES a live selection first — it is the most recent thing the user did and the only one they can see.
    // Gated on `!isRunning` on purpose: while a turn streams, Esc is the mid-turn ABORT, and shadowing an abort with a
    // cosmetic clear would be a bad trade. A click still clears the highlight mid-turn.
    if (
      key.escape === true &&
      !isRunning &&
      !approvalPending &&
      selectionRef.current !== undefined
    ) {
      applySelection(undefined);
      return;
    }
    // Esc at an IDLE prompt with pending `@`/`!` attachments discards them (a clean cancel affordance — parity with
    // home-controller.ts; when a turn is running Esc is the mid-turn abort, reduced below).
    if (
      key.escape === true &&
      !isRunning &&
      !approvalPending &&
      attachmentsRef.current.length > 0
    ) {
      applyAttachments([]);
      props.store.note('cleared pending attachments');
      return;
    }
    // Alt-screen transcript SCROLL (2.6.F Step 4b-2): PgUp/PgDn/Ctrl+Home/Ctrl+End reduce the scroll state against
    // the lifted viewport geometry. Only in the alt renderer (`props.alternateScreen`) — inline keeps native
    // scrollback, so these keys fall through to the editor there. The overlays `return` ABOVE this, so they keep
    // their keys; a plain pending approval is still REACHED here (it is consumed by
    // reduceChatKey below), which is safe because scroll keys never overlap the Ctrl+Y/Ctrl+G/Ctrl+N answer set. Read the REF
    // for coalesced-chunk safety. Not gated on `isRunning` — you can scroll history WHILE a turn streams.
    if (props.alternateScreen === true) {
      // (Mouse reports are consumed at the TOP of this handler, ahead of the overlay routing — see above.) The scroll
      // reduces against LIVE geometry via `chatLiveGeom()` — the store's CURRENT transcript, not the `onMeasure` ref
      // which lags by up to a commit (Step-4b-2 Sonnet review).
      const motion = scrollMotionForKey(key);
      if (motion !== undefined) {
        applyScroll(reduceScroll(scrollRef.current, motion, chatLiveGeom()));
        return;
      }
    }
    const action = reduceChatKey(char, key, editorRef.current.text, isRunning);
    switch (action.kind) {
      case 'append':
      case 'backspace':
      case 'newline':
      case 'kill':
        // A TRUE functional updater (chains React's `prev`), so a coalesced stdin chunk that interleaves edits
        // with a move/history action folds EVERY edit onto the accumulator — a constant `() => next` precomputed
        // from editorRef.current (stale until the queued updater flushes) would drop all but the last. The no-op
        // check + the idempotent resetHistoryNav (a real edit ends history navigation) live INSIDE the updater.
        applyEditor((current) => {
          const next = applyEditorAction(current, action);
          if (next !== current) historyRef.current = resetHistoryNav(historyRef.current);
          return next;
        });
        return;
      case 'move':
        // Functional updater too (folds over the accumulator across a burst). A real move returns the moved editor;
        // a vertical no-op at the top/bottom edge recalls history (mutating historyRef — ink does not run under
        // React StrictMode, so the updater runs once); a no-op horizontal motion returns `current` unchanged.
        applyEditor((current) => {
          const moved = applyEditorAction(current, action);
          if (moved !== current) return moved;
          if (action.motion !== 'up' && action.motion !== 'down') return current;
          const recall =
            action.motion === 'up'
              ? historyPrev(historyRef.current, current.text)
              : historyNext(historyRef.current);
          if (recall === null) return current;
          historyRef.current = recall.history;
          return editorFromText(recall.text);
        });
        return;
      case 'submit': {
        // A repeat of the `Enter` that chose a file sends nothing.
        if (pickEnter.holds(performance.now())) return;
        // A leading `!` (with a runner wired + a non-empty command) runs the shell escape instead of sending a
        // message; a bare `!` or an absent runner falls through to a normal message send.
        const trimmed = action.line.trim();
        const shellLine =
          props.runShellCommand !== undefined && isShellLine(trimmed)
            ? parseShellLine(trimmed.slice(1))
            : undefined;
        if (shellLine?.kind === 'unterminated_quote') {
          // An open quote is refused, never run to the end of the line (ADR-0118 §3). The line stays in the editor so
          // the person can close the quote, nothing is sent to the model, and — because the buffer is NOT cleared —
          // a pending `@` mention read is left alone (the generation is bumped only where the buffer is consumed).
          props.store.note(SHELL_UNTERMINATED_QUOTE_NOTICE);
          return;
        }
        submitGenRef.current += 1; // the buffer is cleared → a pending mention read / shell run must not re-inject
        const parsed = shellLine?.kind === 'command' ? shellLine.cmd : undefined;
        if (parsed !== undefined) {
          historyRef.current = recordHistory(historyRef.current, action.line);
          applyEditor(() => emptyEditor());
          runShell(parsed); // a `!command` → the shell escape (carried outputs stay pending; a file goes with the line)
          return;
        }
        if (trimmed.startsWith('/') || attachmentsRef.current.length === 0) {
          // a slash command, or a plain message with no attachments — the simple path (message === display)
          historyRef.current = recordHistory(historyRef.current, action.line);
          applyEditor(() => emptyEditor());
          submit(action.line, action.line);
          return;
        }
        // a message WITH attachments → expand into the outbound frame; the transcript shows the compact display.
        const { message, display, consumed } = buildOutbound(action.line, attachmentsRef.current);
        if (message.trim().length === 0) {
          applyEditor(() => emptyEditor()); // nothing to send (empty prose + no consumable attachment)
          return;
        }
        historyRef.current = recordHistory(historyRef.current, action.line); // history recalls the PROSE, not the frame
        applyAttachments(attachmentsRef.current.filter((a) => !consumed.includes(a)));
        applyEditor(() => emptyEditor());
        submit(message, display);
        return;
      }
      case 'cycle-mode':
        // Shift+Tab: advance the mode (read fresh from the store, not the render closure) + re-apply the policy.
        props.onModeChange(nextMode(props.store.getSnapshot().mode));
        return;
      case 'toggle-reasoning':
        // Ctrl+T: flip the "thinking" panel (2.5.H) — a pure store-view toggle, no session effect. Works mid-turn.
        props.store.toggleReasoning();
        return;
      case 'abort':
        // Esc — the mid-turn abort: it stops the turn and keeps the session, and never arms (ADR-0115 §2).
        abortTurn();
        return;
      case 'none':
        return;
    }
  };
  // The chat's one reader never hears a key's release (`pressesOnly`: a release would type a letter twice and give a card or a line a second
  // `Ctrl+Y`).
  useInput(pressesOnly(readChatKey));

  // Observe the captured output stream on resize, as the Home does. Ink's
  // useWindowSize supplies defaults when dimensions are unavailable, but also
  // normalizes explicit 0/NaN widths to 80. Preserve those raw widths so a
  // suspended transcript cannot admit invisible entries or acknowledge them.
  const measuredSize = useWindowSize();
  const rawColumns = useRawTerminalColumns();
  const windowSize = {
    columns: rawColumns === undefined ? measuredSize.columns : rawColumns,
    rows: measuredSize.rows,
  };

  const flushVisible = useVisibleRenderFlush(props.onError, props.suspendPort, acknowledgement);
  useEffect(() => {
    if (props.onActivated === undefined) return;
    let mounted = true;
    // Ink yields for passive raw-input setup. Its flush can also resolve after error-driven unmount,
    // so component ownership AND the driver's observed Ink exit are required before/after activation.
    void flushVisible()
      .then(async () => {
        if (!mounted) return;
        await props.onActivated?.(flushVisible);
        if (mounted) activationReady.current = true;
      })
      .catch(props.onError);
    return () => {
      mounted = false;
      activationReady.current = false;
    };
  }, [flushVisible, props.onActivated, props.onError]);

  // A resize re-wraps the transcript, so every display-line index the live selection holds moves. Drop it rather than
  // highlight — and copy — the wrong text (2.6.F Step 6).
  useEffect(() => {
    applySelection(undefined);
  }, [windowSize.columns]);
  // A resize voids the popup's measured frame, and below the floor a step that holds a chord or a secret closes unanswered (ADR-0148 §4): the
  // slot does both, from `slotProps.size`, BEFORE it commits the frame at the new size (a passive effect here ran after that commit, voided the
  // new frame's acknowledgement as it was made, and left every popup unanswerable until something re-rendered).
  // The notification channel is held while a decision is on screen or the hint row is not drawn (ADR-0148 §2). A running turn, a `!` command and
  // a submit in flight are NOT among them: the prompt block draws a hint row while they run (the running hint, which a notification replaces),
  // and holding for them made a refusal raised mid-turn (a mode change, a refused popup) silent until the turn ended and stale after it (SE7-1).
  const notificationsHeld =
    renderedOverlays.approval ||
    renderedOverlays.review ||
    renderedOverlays.question ||
    renderedOverlays.checkpoint ||
    renderedOverlays.nativePrompt ||
    renderedOverlays.replacesBody ||
    (popupSnapshot.frame !== undefined &&
      currentStep(popupSnapshot.frame).spec.holds !== undefined) ||
    promptHidden(renderedOverlays);
  useEffect(() => {
    notifications?.hold(notificationsHeld);
  }, [notifications, notificationsHeld]);
  // Alt-screen (Step 4b, ADR-0068 §c): the outer container is bounded to the frame's rows (the terminal's less one) so `ChatView`'s
  // flex-grow viewport has a height to fill BELOW any keyboard-owning overlay (palette / search / …), and the
  // transcript renders through the scroll {@link TranscriptViewport} instead of `<Static>`. Absent ⇒ the inline
  // `<Static>` renderer, unbounded height.
  const viewport =
    props.alternateScreen === true
      ? {
          // The frame is one row short of the terminal (ADR-0146 §4: a frame as tall as the terminal makes Ink clear it), whatever the header,
          // the prompt block and the live turn take of it.
          rows: chatFrameRows(windowSize.rows),
          cols: windowSize.columns,
          scroll,
          // Document-ordered here, once: the viewport draws it, `copySelection` re-derives it for the clipboard.
          ...(selection === undefined ? {} : { selection: normalizeSelection(selection) }),
          // Lift the viewport's live geometry into the ref the scroll keymap reduces against (no re-render).
          onMeasure: (g: ViewportGeometry): void => {
            scrollGeomRef.current = g;
          },
        }
      : undefined;

  const flushPopup = (): Promise<void> => app.waitUntilRenderFlush();
  const slotProps: PopupSlotProps = {
    host: popups,
    acknowledgement: popupAcknowledgement,
    native:
      nativeAcknowledgement === undefined
        ? undefined
        : { snapshot: nativeSnapshot, acknowledgement: nativeAcknowledgement },
    placement,
    size: { cols: windowSize.columns, rows: windowSize.rows },
    color,
    flush: flushPopup,
  };
  // The body behind the slot is the backdrop of an open popup, drawn dim, exactly when the slot is drawing an overlay box over it (ADR-0148 §4):
  // the slot's own predicate over the slot's own props. The slot stays OUTSIDE the dimmed subtree, as the last child of the root. The same
  // predicate takes the cursor out of the composer and the notification off the hint row while a popup is drawn.
  const drawing = slotDrawing(slotProps, popupSnapshot);
  const dimmed = dimsBackdrop(drawing, color);
  // A sheet's wait clock ticks in the alternate screen and is the static `waiting since HH:MM` inline (ADR-0147 §2).
  const waitClock = waitClockForm(props.alternateScreen);
  return (
    <>
      <BackdropDim dimmed={dimmed}>
        {nativeActive && props.modePrompt !== undefined && (
          <NativePromptHost
            ui={props.modePrompt.ui}
            acknowledgement={nativeAcknowledgement}
            color={color}
            {...(props.inputEnabled === undefined ? {} : { inputEnabled: props.inputEnabled })}
            suspendPort={props.suspendPort}
            ownsSuspendAttachment={false}
            {...(props.onSuspend === undefined ? {} : { onSuspend: props.onSuspend })}
            onRendererReady={props.modePrompt.ready}
            onRendererError={props.onError}
          />
        )}
        <Box
          display={occupiesRows(renderedOverlays) ? 'none' : 'flex'}
          flexDirection="column"
          width={layoutColumns(windowSize.columns)}
          {...(viewport === undefined ? {} : { height: viewport.rows })}
        >
          <ChatView
            hidden={review !== undefined && review.screen !== 'card'}
            toolDisplays={toolDisplays}
            markdown={markdown}
            displaySuspended={displaySuspended}
            acknowledgement={acknowledgement}
            printedAbove={props.introPrinted}
            state={state}
            tick={tick}
            nowMs={Date.now()}
            color={color}
            editor={editor}
            composerCursor={drawing === undefined}
            surface="standalone-chat"
            provider={props.provider}
            running={chatIsBusy({
              turnRunning: running,
              shellBusy,
              submitBusy,
              // Not observable here today (the stand-alone chat hides its conversation behind a card), and kept so that both hosts feed the
              // one predicate the same inputs: the Home's wire is the one that is drawn, and it is pinned.
              nativePrompt: renderedOverlays.nativePrompt,
              approvalCard: state.approvalSinceMs !== undefined,
            })}
            mode={mode}
            reasoningEffort={reasoningEffort}
            reasoningVisible={reasoningVisible}
            attachments={attachments}
            busyCommand={busyCommand}
            // Live terminal width for the reasoning-panel row bound (2.5.H) — resize-tracked via `useWindowSize` above.
            columns={windowSize.columns}
            viewport={viewport}
            interruptArmed={interruptArmed}
            copied={copied}
            paletteOpen={promptHidden(renderedOverlays)}
            palette={
              palette === undefined
                ? undefined
                : {
                    list: palette.list,
                    state: palette.state,
                    maxRows: chatPaletteRows(windowSize.rows, palette.list),
                  }
            }
            notification={hintRowNotification(notification.current?.text, drawing)}
            cardDocked={dockedCardOpen(renderedOverlays)}
            terminalRows={windowSize.rows}
          />
          {/* The docked approval card (ADR-0129) sits below the live region, where the other keyboard-owning
            overlays do; its full view and call list take the screen instead (ChatView is hidden then). */}
          <ToolReviewHost
            store={props.store}
            size={{ cols: windowSize.columns, rows: windowSize.rows }}
            hasCustody={() => acceptsInput() && props.suspendPort?.isSuspended() !== true}
            clipboard={props.reviewClipboard}
            color={color}
            waitClock={waitClock}
          />
          {/* The docked `ask_user` question card (ADR-0132): where the approval card sits, and never both at once. */}
          <QuestionCardHost
            store={props.store}
            size={{ cols: windowSize.columns, rows: windowSize.rows }}
            hasCustody={() => acceptsInput() && props.suspendPort?.isSuspended() !== true}
            color={color}
            waitClock={waitClock}
          />
          {/* The docked continue checkpoint (ADR-0136 §4): the same place, and never together with another card. */}
          <CheckpointCardHost
            store={props.store}
            size={{ cols: windowSize.columns, rows: windowSize.rows }}
            hasCustody={() => acceptsInput() && props.suspendPort?.isSuspended() !== true}
            color={color}
            waitClock={waitClock}
          />
          {/* The history search and the `@` completion list are host-drawn rows below the prompt that show stored names (a history line, a file
              name): they stand in the content column of the grid like the prompt block above them, never in the margin (unit 9). */}
          {search !== undefined && (
            <ChromeColumn columns={windowSize.columns}>
              <ReverseSearchView
                state={search}
                entries={historyRef.current.entries}
                color={color}
              />
            </ChromeColumn>
          )}
          {mention !== undefined && (
            <ChromeColumn columns={windowSize.columns}>
              <MentionView state={mention} color={color} />
            </ChromeColumn>
          )}
        </Box>
      </BackdropDim>
      {/* The one overlay slot (ADR-0148 §2): the last child of the root, and the only absolutely positioned node of the CLI. */}
      <PopupSlot {...slotProps} />
    </>
  );
}

/**
 * Sequence the `driveInk` exit: on `exited` RESOLVE, run `teardown` FIRST (unmount ink → restore raw mode + cursor)
 * and only THEN resolve the `outcome`. On `exited` REJECT (an unexpected turn-core throw), `teardown` still runs (the
 * `.finally`) but the `outcome` is skipped and the rejection propagates unchanged (→ the command maps it to exit 1) —
 * the pre-2.6.F behavior, preserved. At 2.6.F Step 4b-3 the end-of-session SUMMARY is no longer written here: the
 * alt-buffer exit moved UP to the hoisted `runReplLoop` (ADR-0068 §c), so the summary rides on the {@link
 * ChatDriveOutcome} (`summaryText`) and the loop prints it AFTER the single alt-exit, on the primary buffer. Extracted
 * from `driveInk` because it uses the real ink `render` (untestable without a TTY); this helper isolates the ordering.
 */
export function finalizeInkExit(
  exited: Promise<void>,
  ops: {
    readonly teardown: () => unknown;
    readonly outcome: () => ChatDriveOutcome;
  },
): Promise<ChatDriveOutcome> {
  return exited.finally(ops.teardown).then((): ChatDriveOutcome => ops.outcome());
}

/** The width an inline intro is wrapped to when the terminal's is not known: the supported minimum. */
const INTRO_COLUMNS_FALLBACK = 80;

/**
 * The grid of the inline renderer's pre-mount writes (the header and the intro, unit 9): the terminal's, or the supported minimum's when its width is
 * not known (a width is a number of at least one column; zero, a negative one and a number that is not one are not a width).
 */
function preMountGrid(columns: number | undefined): ChatGrid {
  return chatGrid(
    columns !== undefined && Number.isFinite(columns) && columns >= 1
      ? columns
      : INTRO_COLUMNS_FALLBACK,
  );
}

/** The length of the host's model-switch glyph that leads an intro (in either form of the table) with the space after it, or 0 when it does not lead. */
function modelSwitchLeadLength(intro: string): number {
  for (const glyph of [GLYPHS.modelSwitch.glyph, GLYPHS.modelSwitch.ascii])
    if (intro.startsWith(`${glyph} `)) return glyph.length + 1;
  return 0;
}

/**
 * The inline intro as rows in the content column, each of at most the content column's width, broken at spaces (OB7-M2), with the margin on the left
 * of the first row. It is written straight to the terminal before Ink mounts, so nothing wraps it but the terminal, which cuts a long sentence wherever
 * the row ends (`…to continue it, star|t Relavium…`); the transcript's own notices are word-wrapped by the transcript layout, and so is this. Explicit
 * newlines of the intro are kept. The margin is the grid's (unit 9): blank, except on the first row of the model-switch notice, which the inline
 * renderer marks with the host's role word `note` as it marks the same notice in the transcript (the word is drawn from the closed list and the
 * glyph that led the sentence leaves it; with no room for the word the glyph stays where it was).
 */
function wrapIntro(sentence: string, columns: number | undefined): string {
  const grid = preMountGrid(columns);
  // The intro carries stored strings (a session id, the directory a session was started in, a model id) and it is written straight to the terminal,
  // so it goes through the screen's filter HERE, where it is drawn: the fillers a terminal draws wider than `wrapWords` counts would wrap a row at
  // the right edge, and the rest of it would start at column 0, in the margin (unit 9, review round 2, S2-5). The banner module keeps its own
  // scrub (`sanitizeInline` and the blanked glyphs); the filter is the drawing site's.
  const intro = screenText(sentence);
  const lead = modelSwitchLeadLength(intro);
  const word = lead === 0 ? '' : marginCell('modelSwitch', grid, 'word');
  const marked = word.trim() !== '';
  // `wrapWords` keeps the whitespace a break fell on: a row does not end in it, and the next row does not begin with it
  const rows = (marked ? intro.slice(lead) : intro)
    .split('\n')
    .flatMap((line) =>
      wrapWords(line, grid.content).map((row, index) => (index === 0 ? row.trimEnd() : row.trim())),
    );
  if (rows.length === 0) return intro;
  const blank = ' '.repeat(grid.margin);
  // a blank row is written as nothing (no trailing spaces), and only the first row can carry the word
  return rows
    .map((row, index) => (row === '' ? '' : `${marked && index === 0 ? word : blank}${row}`))
    .join('\n');
}

/**
 * Where a session's INTRO goes — a resume banner (2.N), the `/clear` notice carrying `relavium chat-resume <id>`, or
 * a `/models` reseat line. The renderer decides, and getting it wrong loses the line:
 *
 *  - INLINE: printed before ink mounts, so it scrolls into the terminal's history above the live region (the TTY
 *    counterpart of what `drivePlain` writes).
 *  - FULL-SCREEN: the alt buffer has no scrollback, and ink's first frame is `height: rows` — it paints straight over
 *    a pre-mount write. So the intro goes into the fresh session's TRANSCRIPT, where the viewport keeps it and the
 *    user can scroll back to it. Without this, `/clear` in the DEFAULT renderer silently discarded the only pointer
 *    back to the conversation it had just ended (whole-phase Opus review). The MCP-skipped diagnostic already took
 *    this route (chat.ts); the intro did not.
 *
 * The placement decision is directly testable here; driver integration tests also mount installed Ink
 * over captured native streams.
 */
export function emitIntro(
  intro: string | undefined,
  alternateScreen: boolean,
  ports: {
    readonly notice: (text: string, hostLead?: 'yourTurn' | 'modelSwitch') => void;
    readonly writeOut: (text: string) => void;
    /** The terminal's width, from which the inline intro's grid is made (it is word-wrapped to the content column; absent or not a width ⇒ {@link INTRO_COLUMNS_FALLBACK}). */
    readonly columns?: number | undefined;
  },
): void {
  if (intro === undefined) return; // a fresh session has no intro
  // The intro is the host's own sentence (a resume, a clear, a model switch), and only the model switch leads with the host's `⇄` (ADR-0145 §6):
  // the rows of a notice are guarded, and a lead is the one glyph they keep at the start of a line, so it is named for the notice that has it and for
  // no other: the resume banner and the clear notice have no lead and the guard keeps nothing of them.
  if (!alternateScreen) ports.writeOut(`${wrapIntro(intro, ports.columns)}\n`);
  // The lead is the model switch's in either form of the table: the intro is built in the plain form (`<->`) without colour, and the transcript's own
  // notice lead (`noticeLines`) reads both, so a colour-off chat marks the switch as a colour-on one does (the inline path above reads both too).
  else if (modelSwitchLeadLength(intro) > 0) ports.notice(intro, 'modelSwitch');
  else ports.notice(intro);
}

/**
 * The `io`s a header has been printed to. A stand-alone inline chat is mounted once per conversation (a `/clear` or a reseat mounts the next
 * one over the same `io`), and the header is the introduction of the PROCESS' chat, so a re-mount does not write it again.
 */
const headerPrinted = new WeakSet<object>();

/**
 * The inline renderer's header ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §4): the wordmark in bold and a blank row, written ONCE into the terminal's own scrollback before the live region mounts, because inline has no
 * fixed top row to draw it in. The full-screen renderer draws it as the first child of the frame instead, so it writes nothing here. `owner` is
 * what the once belongs to (the command's `io`): a second chat over the same owner (`/clear`, a reseat) writes nothing. It stands at the content
 * column of the terminal's `columns` (the grid, unit 9: the margin's spaces, then the wordmark), as the full-screen header does; an absent or unusable
 * width is the supported minimum's.
 */
export function emitChatHeader(
  alternateScreen: boolean,
  owner: object,
  writeOut: (text: string) => void,
  columns?: number,
): void {
  if (alternateScreen || headerPrinted.has(owner)) return;
  headerPrinted.add(owner);
  writeOut(`${' '.repeat(preMountGrid(columns).margin)}${emphasize(WORDMARK, 'bold')}\n\n`);
}

/**
 * `instance` with its `unmount` made to erase the live region first when `redriven()` says another chat follows (OB7-M2). Ink's unmount leaves
 * the last frame in the terminal's scrollback; for a chat that ends the session that is the record of where it stopped, but a `/clear` or a reseat
 * mounts the next chat directly under it, and the previous one's prompt block would stay above it as rows that look live and answer nothing. `clear`
 * is Ink's own erase of what it has drawn (the `<Static>` rows already written are history and stay), and it leaves the final render of the unmount
 * with nothing to redraw. Erasing is idempotent, so an unmount called twice is safe.
 */
export function eraseLiveRegionOnRedrive<
  Instance extends { readonly clear: () => void; readonly unmount: () => void },
>(instance: Instance, redriven: () => boolean): Instance {
  return {
    ...instance,
    unmount: () => {
      if (redriven()) instance.clear();
      instance.unmount();
    },
  };
}

/** The TTY ink driver: mount {@link ChatApp}, run the frame loop, and finalize on exit. Returns the drive OUTCOME
 *  ({@link ChatDriveOutcome}) so the re-drive loop can swap in a fresh session on `/clear` (ADR-0062 §7). */
export function driveInk(ctx: ChatDriveContext): Promise<ChatDriveOutcome> {
  // Resolved here, BEFORE the intro: where the intro goes depends on the renderer (see `emitIntro`).
  const outputMode = detectOutputMode({
    stdoutIsTty: ctx.io.stdoutIsTty,
    json: ctx.global.json,
    ci: isCiEnv(ctx.io.env),
  });
  const alternateScreen =
    resolveRenderMode({
      outputMode,
      noAltScreenFlag: ctx.global.noAltScreen === true,
      configAltScreen: ctx.altScreen,
    }) === 'alt';
  // TRIPWIRE (2.6.C) — asserted HERE, at the composition root, and NOT inside `ChatView`. A render-time throw is
  // useless: ink builds its React root with no-op error callbacks (`reconciler.createContainer(…, () => {}, …)`), so
  // a throw from a component is SWALLOWED — React tears the tree down, the frame goes empty, and the suite stays
  // green. (Probed: an inline mount over a full-screen store threw, rendered nothing, and passed.) Here we are in
  // ordinary async code, before `render()`, so a divergence propagates and fails loudly — in a test AND in a dev run.
  //
  // What it guards: "am I the alt screen?" is derived twice — this function resolves the RENDER mode, while the store
  // was built with a `transcriptBound` that decides whether a carried seed transcript is honoured. Both directions
  // corrupt: inline render + full-screen store double-prints through `<Static>`; full-screen render + inline store
  // silently drops the carry and blanks the viewport (F1 itself).
  assertRenderStoreAgree(alternateScreen, ctx.store.getSnapshot().state.transcriptBound);
  emitChatHeader(
    alternateScreen,
    ctx.io,
    (text) => ctx.io.writeOut(text),
    ctx.io.nativeStdout?.columns,
  );
  emitIntro(ctx.intro, alternateScreen, {
    notice: (text, hostLead) => ctx.store.notice(text, hostLead),
    writeOut: (text) => ctx.io.writeOut(text),
    columns: ctx.io.nativeStdout?.columns,
  });
  // Mirror the live stream into the view store the component projects.
  const unsubscribe = ctx.handle.subscribe(
    ownSessionSubscriber(ctx.workOwner, (event) => ctx.store.apply(event)),
  );
  const frame = setInterval(() => ctx.store.tick(), FRAME_MS);
  frame.unref();

  let resolveExit: () => void = () => undefined;
  let rejectExit: (err: unknown) => void = () => undefined;
  let active = true;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = () => {
      active = false;
      resolve();
    };
    rejectExit = (err) => {
      active = false;
      ctx.workOwner?.failure(err); // Observe before finalizeInkExit can wait on native terminal ACK.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Owned failures retain the original opaque cause after observation, including non-Error native rejections.
      reject(
        ctx.workOwner === undefined
          ? err instanceof Error
            ? err
            : new Error('Chat driver failed.')
          : err,
      );
    };
  });

  // An EXTERNAL SIGINT (kill -INT / a parent's signal). A keyboard Ctrl-C is normally intercepted by useInput in raw
  // mode and never reaches the kernel as SIGINT — EXCEPT while a `/scrollback` / `/edit` suspension owns the terminal,
  // where ink's `pauseInput()` has turned raw mode OFF and the tty line discipline delivers a real SIGINT. Running the
  // cooperative `/cancel` there would end the session, unmount ink, and exit the hoisted alt buffer behind the
  // suspension's back — whose pending reclaim would later re-enter the alt buffer and re-enable the mouse on the
  // user's SHELL (Step-5d-3 Sonnet review). So the handler yields while a hatch is suspended: the hatch's own wait
  // resolves on SIGINT, and `$EDITOR` (same foreground process group) receives the signal directly. Register with
  // process.on (NOT once): ink registers a signal-exit SIGINT listener that RE-RAISES SIGINT (→ exit 130) when
  // it is the SOLE remaining listener, which would skip our finally and leave the row 'active'. Staying
  // registered keeps signal-exit from re-raising, so the cooperative /cancel (→ session:cancelled → persister
  // marks 'ended') wins; a second SIGINT forces a clean exit 4 rather than hang on a provider ignoring the
  // abort. Removed LAST in the finally (after unmount), so a Ctrl-C during unmount still hits us.
  // Hoisted so the SIGINT handler can unmount ink (restoring the terminal) before a forced exit.
  let instance: ReturnType<typeof render> | undefined;
  let ownedMount: SessionInkMount | undefined;
  // The full-screen render mode (2.6.F, ADR-0068 §e). driveInk only runs on a TTY (selectChatDriver), so the output
  // mode is 'tui'; the resolver still short-circuits a 'plain' path to inline defensively, then applies
  // `--no-alt-screen` → `[preferences].alt_screen` (ctx.altScreen) → the phase default (alt-ON since Step 4b-3). This
  // value drives ONLY the `ChatApp` component prop (the transcript viewport vs `<Static>`); ink's render OPTION is a
  // hard `false` (Step 4b-3), so ink toggles NO DECSET-1049 per session — the hoisted `runReplLoop` owns the single
  // alt-buffer enter/exit, and the end-of-session summary rides on the outcome + prints after that exit (ADR-0068 §c).
  let cancelRequested = false;
  let activated = false;
  const isActive = (): boolean => active && !cancelRequested && !ctx.shouldStop();
  const onActivated = async (flushNotice: NoticeFlush): Promise<void> => {
    if (activated || !active) return;
    if (!isActive()) {
      resolveExit();
      return;
    }
    activated = true;
    try {
      await ctx.onActivated?.(isActive, flushNotice);
      if (!isActive()) resolveExit();
    } catch (err) {
      // React/Ink can swallow effect errors; propagate through the driver's owned exit promise instead.
      rejectExit(err);
    }
  };
  const onSigint = (): void => {
    if (ctx.workOwner?.signal.aborted === true) {
      resolveExit();
      return;
    }
    if (cancelRequested) {
      if (ctx.workOwner !== undefined) {
        ctx.workOwner.invocation.finiteExit.cooperativeCancel(EXIT_CODES.chatEnded);
        return;
      }
      // A second SIGINT while the cooperative /cancel is still draining (e.g. a provider ignoring the abort):
      // unmount ink FIRST so the terminal is restored from raw mode, then tear the live MCP connections down
      // (best-effort, BOUNDED — a forced quit must not orphan a spawned stdio child, but must also not hang on a
      // teardown), THEN force a clean exit 4. (Process death reclaims the unref'd frame interval, the
      // subscription, and this listener; the terminal restore + MCP teardown are the cleanup that must not be
      // skipped on the hard-exit path — the command's runReplLoop finally never runs after process.exit.)
      instance?.unmount();
      const forceExit = ctx.onForceExit;
      if (forceExit === undefined) {
        process.exit(EXIT_CODES.chatEnded);
      }
      // The fallback timer is deliberately REFERENCED (no `.unref()`): it must keep the event loop alive until it
      // fires so the hard exit is GUARANTEED even if `forceExit()` hangs (an unref'd timer could let the loop
      // drain first, skipping the exit). On the happy path `forceExit()` resolves first → `process.exit` runs
      // immediately and reclaims this still-pending timer, so there is no spurious FORCE_TEARDOWN_MS wait.
      const bounded = new Promise<void>((resolve) => {
        setTimeout(resolve, FORCE_TEARDOWN_MS);
      });
      void Promise.race([forceExit().catch(() => undefined), bounded]).finally(() =>
        process.exit(EXIT_CODES.chatEnded),
      );
      return;
    }
    cancelRequested = true;
    void ctx.processLine('/cancel').then(() => resolveExit(), rejectExit);
  };
  /** Drop a SIGINT that arrives while a hatch owns the terminal — see the note above. Wraps `onSigint` so the guard
   *  can never be forgotten by a later edit to the handler body. */
  const onSigintGated = (): void => {
    if (ctx.suspendPort?.isSuspended() === true) return;
    onSigint();
  };
  let removeInterrupt = (): void => undefined;
  let driverStopped = false;
  const stopDriverInput = (): void => {
    if (driverStopped) return;
    driverStopped = true;
    active = false;
    clearInterval(frame);
    let failed: { readonly cause: unknown } | undefined;
    try {
      unsubscribe();
    } catch (cause) {
      failed = { cause };
    }
    try {
      removeInterrupt();
    } catch (cause) {
      failed ??= { cause };
    }
    resolveExit();
    if (failed !== undefined) throw failed.cause;
  };

  try {
    removeInterrupt =
      ctx.subscribeInterrupt === undefined
        ? (() => {
            process.on('SIGINT', onSigintGated);
            return () => {
              process.removeListener('SIGINT', onSigintGated);
            };
          })()
        : ctx.subscribeInterrupt(onSigintGated);
    const workOwner = ctx.workOwner;
    if (workOwner !== undefined) {
      const { nativeStdin, nativeStdout, nativeStderr } = ctx.io;
      if (nativeStdin === undefined || nativeStdout === undefined || nativeStderr === undefined)
        throw new CliError('cli_internal', '');
      ownedMount = new SessionInkMount({
        invocation: workOwner.invocation,
        assertEntering: workOwner.assertAdmitting,
        failure: workOwner.failure,
        suspendPort: ctx.suspendPort ?? createSuspendPort(),
        stopInput: stopDriverInput,
        drainNative: ctx.finishJobControl ?? (() => Promise.resolve()),
        input: new SessionInkInput({
          input: nativeStdin,
          invocation: workOwner.invocation,
          acknowledge: (text) => ctx.io.writeOutAcknowledged(text),
          failure: workOwner.failure,
        }),
      });
      ctx.adoptTerminalMount?.(ownedMount);
    }
    // Opening a fresh session only emits its lifecycle event. Disclosure/retention waits for a committed mount.
    // Keep setup under the same cleanup ownership as render(), including a throwing startSession hook.
    ctx.workOwner?.assertAdmitting();
    ctx.startSession();
    const mountNative = () =>
      render(
        createElement(ChatApp, {
          inputEnabled: () => active && !driverStopped,
          store: ctx.store,
          ...(ctx.modePrompt === undefined ? {} : { modePrompt: ctx.modePrompt }),
          onActivated,
          // The COMPONENT prop `alternateScreen` (ADR-0068 §c) selects the transcript viewport (vs `<Static>`) — kept
          // as the resolved mode. It is INDEPENDENT of ink's render OPTION below (now hard `false`, Step 4b-3): ink
          // renders full-screen via log-update regardless, and the hoisted `runReplLoop` owns the alt-buffer toggle.
          alternateScreen,
          onSubmit: ctx.processLine,
          shouldStop: ctx.shouldStop,
          onExit: () => resolveExit(),
          // An unexpected turn-core throw reaches the original owner before native teardown, matching
          // the plain driver's escaping cause. Classified outcomes retain their existing surface policy.
          onError: (err) => rejectExit(err),
          // ADR-0057 mode/abort wiring — the REPL loop always supplies these. onModeChange defaults to a no-op so a
          // driver wired without it degrades to a fixed mode; onAbort is passed through AS-IS (optional) so the
          // 'abort' handler can reject a pending approval when it is absent (never a dead Esc — see ChatApp).
          onAbort: ctx.onAbort,
          onModeChange: ctx.onModeChange ?? ((): void => undefined),
          // ADR-0066 §5 effort setter — passed AS-IS (optional).
          onSetEffort: ctx.onSetEffort,
          // `/models` reseat (ADR-0059) — the REPL loop wires it only for an interactive session; passed AS-IS (optional) so a driver
          // wired without it has no `/models` popup (the session's member is withdrawn: `bindModelSwitch`).
          onReseat: ctx.onReseat,
          reports: ctx.reports,
          // The bound agent's provider id, first on the status line (ADR-0146 §2): read once per mount, from the same view `/agent` reads.
          provider: ctx.boundAgent?.().detail.provider,
          // The inline intro written above the live region before this mount (the first entry then has the blank row between turns above it).
          introPrinted: !alternateScreen && ctx.intro !== undefined,
          // The settings popups (`/mode`, `/effort`, `/models`, `/permissions`; ADR-0148 §3, §6), and where their announcements and the typed
          // settings' go: this chat's notification channel, bound while it is mounted. The plain and `--json` drivers have neither and print
          // their text.
          settings: ctx.settings,
          setAnnouncer: ctx.setAnnouncer,
          // `/doctor` opens its popup over this chat (ADR-0148 §8); the plain and `--json` drivers have none and print the text report.
          doctor: ctx.doctor,
          // `@`-mention completion (2.5.D, ADR-0061) — the REPL loop wires it only for an interactive session; passed
          // AS-IS (optional) so an absent reader degrades `@` to a literal char (never a dead key — see ChatApp).
          mentionReader: ctx.mentionReader,
          // `!`-shell runner (2.5.D, ADR-0061) — interactive-only; absent ⇒ a leading `!` is a literal message.
          runShellCommand: ctx.runShellCommand,
          suspendPort: ownedMount?.port ?? ctx.suspendPort,
          onSuspend: ctx.onSuspend,
          clipboard: ctx.clipboard,
          reviewClipboard: ctx.reviewClipboard,
        }),
        {
          ...(workOwner === undefined
            ? {}
            : {
                stdin: ctx.io.nativeStdin,
                stdout: ctx.io.nativeStdout,
                stderr: ctx.io.nativeStderr,
              }),
          // OUR /cancel (the second Ctrl+C) handler drives the cooperative cancel — never ink's process.exit.
          exitOnCtrlC: false,
          patchConsole: false,
          maxFps: Math.max(1, Math.round(1000 / FRAME_MS)),
          // Ink's ambient CI predicate differs from ADR-0054. Own the selected mode so a flushed
          // dynamic disclosure is written before its evidence is swept, including CI='' opt-out.
          interactive: outputMode === 'tui',
          // ink render OPTION is HARD `false` (2.6.F Step 4b-3, ADR-0068 §c): ink must NOT toggle DECSET-1049 per
          // session — the hoisted `runReplLoop` enters the alt buffer ONCE above the loop and exits ONCE, so a `/clear`
          // / reseat re-drive no longer flips the terminal (the flicker). ink still full-screen-renders via log-update.
          alternateScreen: false,
        },
      );
    // A chat that ends to be re-driven (`/clear`, a model reseat) is followed by another over the same terminal: inline, its live region (the prompt,
    // the rule, the status line, the hint) must not be left behind as dead rows above the next one's own (OB7-M2). The full-screen renderer has no
    // scrollback to leave it in; a chat that ends the session leaves its last frame, as it always did.
    const mount = (): ReturnType<typeof render> =>
      alternateScreen
        ? mountNative()
        : eraseLiveRegionOnRedrive(mountNative(), () => ctx.stopReason() !== 'exit');
    instance = ownedMount === undefined ? mount() : ownedMount.acquire(mount);
    // Ink owns passive input/render failures. Observe its terminal promise rather than leave the
    // driver alive after an error boundary has unmounted the disclosure surface.
    void (ownedMount?.exited ?? instance.waitUntilExit()).then(resolveExit, (cause: unknown) => {
      ctx.workOwner?.failure(cause);
      rejectExit(cause);
    });

    return finalizeInkExit(exited, {
      // Tear down + UNMOUNT (restores raw mode + cursor; with the option false it does NOT exit the alt buffer — the
      // hoisted runReplLoop owns that). A throw here must not mask the outcome nor skip the SIGINT-listener removal.
      teardown: () => {
        if (ownedMount !== undefined) return ownedMount.close();
        active = false;
        clearInterval(frame);
        unsubscribe();
        try {
          instance?.unmount(); // best-effort terminal restore — a guarded unmount (parity with driveHome).
        } catch {
          // swallow — never mask the outcome nor skip the SIGINT-listener removal below.
        }
        removeInterrupt();
        return undefined;
      },
      // The end-of-session summary rides on the outcome (Step 4b-3): the hoisted runReplLoop prints it AFTER the
      // single alt-buffer exit, on the primary buffer (ADR-0068 §c). Only a real end (`/exit`) carries one; a `/clear`
      // / reseat swap carries none (ADR-0062 §7 — the fresh session's clearedNotice intro is the sole marker).
      outcome: () =>
        ctx.stopReason() === 'exit'
          ? { kind: 'exit', summaryText: ctx.store.summaryText() }
          : { kind: ctx.stopReason() },
    });
  } catch (err) {
    ctx.workOwner?.failure(err);
    try {
      stopDriverInput();
    } catch (cause) {
      ctx.workOwner?.cleanupUncertain(cause);
    }
    if (ownedMount !== undefined)
      return ownedMount.close().then(() => {
        throw err;
      });
    // render() threw synchronously — clean up the interval, subscription, and SIGINT handler set up above so
    // none leaks past the throw (the finally above is never reached when render() throws).
    active = false;
    clearInterval(frame);
    unsubscribe();
    removeInterrupt();
    throw err;
  }
}

/**
 * Select the chat driver by surface (2.Q): `--json` ⇒ the headless NDJSON `SessionEvent` stream (machine
 * output wins over the TTY); else a real TTY outside CI ⇒ the ink REPL; else the plain line loop.
 */
export const selectChatDriver: ChatDriver = (ctx) => {
  if (ctx.global.json) return driveJson(ctx); // machine output wins over the TTY
  return chatIsInteractive(ctx.io, ctx.global) ? driveInk(ctx) : drivePlain(ctx);
};
