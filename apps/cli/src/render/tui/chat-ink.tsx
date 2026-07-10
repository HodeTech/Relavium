import { Box, Static, Text, render, useApp, useInput, usePaste, useWindowSize } from 'ink';
import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';

import type { SuspendPort } from '../suspend.js';
import {
  driveJson,
  drivePlain,
  type ChatDriveContext,
  type ChatDriveOutcome,
  type ChatDriver,
  type ChatModelsPort,
  type ReseatTarget,
} from '../../commands/chat.js';
import { CHAT_PALETTE_COMMANDS } from '../../commands/repl-commands.js';
import type { RefreshReport } from '../../engine/model-refresh.js';
import {
  canControlEffort,
  foldEffortPickerKey,
  initialEffortPickerState,
  type EffortPickerState,
} from './effort-picker.js';
import { EffortTierList } from './effort-tier-list.js';
import {
  foldModelPickerKey,
  partialFailureBanner,
  type ModelPickerKey,
  type ModelPickerState,
  type ModelPickerStep,
} from './model-picker.js';
import { ModelPickerView } from './model-picker-view.js';
import { EXIT_CODES } from '../../process/exit-codes.js';
import { detectOutputMode, isCiEnv } from '../../process/output-mode.js';
import { resolveRenderMode } from '../render-mode.js';
import { colorProps, dimProps } from './projection.js';
import { FORCE_TEARDOWN_MS, FRAME_MS } from './tui-constants.js';
import {
  applyEditorAction,
  editorFromText,
  emptyEditor,
  insertAtCursor,
  pasteIsEditable,
  reduceChatKey,
  reduceEditorMotion,
  type EditorState,
} from './chat-input.js';
import {
  foldMentionKey,
  mentionOpensAt,
  type MentionReader,
  type MentionState,
} from './mention.js';
import { MentionView } from './mention-view.js';
import {
  appendAttachment,
  buildOutbound,
  commandResultPreview,
  fileAttachmentWarning,
  mentionMarker,
  MAX_PENDING_ATTACHMENTS,
  type PendingAttachment,
} from './attachments.js';
import { AttachmentBar } from './attachment-bar.js';
import {
  commandLine,
  isShellLine,
  shellDenyHint,
  tokenizeCommand,
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
import { PaletteView } from './palette-view.js';
import { PromptEditor } from './prompt-view.js';
import { ReverseSearchView } from './reverse-search-view.js';
import {
  foldPaletteKey,
  INITIAL_PALETTE_STATE,
  shouldOpenPalette,
  type PaletteState,
} from './palette-reducer.js';
import { spinnerFrame } from './format.js';
import {
  errorRecoveryHint,
  formatApprovalTarget,
  formatBusyLine,
  formatReasoningPanel,
  formatSessionFooterWithMode,
  formatToolCall,
  formatTurnSummary,
  liveScrollGeometry,
  reasoningLabelActive,
  sanitizeApprovalReason,
  sanitizeInline,
  streamingAbortHint,
  stripTerminalControls,
  wrapTranscript,
} from './chat-projection.js';
import { TranscriptViewport } from './transcript-viewport.js';
import { parseMouseEvent, type MouseEvent as TerminalMouseEvent } from './mouse.js';
import {
  normalizeSelection,
  reduceSelection,
  selectionText,
  type SelectionRange,
  type SelectionState,
  type SelectionViewport,
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
import type { ClipboardOutcome } from '../clipboard.js';
import type { ChatStoreController, PendingApproval } from './chat-store.js';
import type { SessionViewState, TranscriptEntry } from './session-view-model.js';

/**
 * The `ink` TTY driver + `ChatApp` for `relavium chat` (2.M) — the session counterpart of the 2.E run TUI
 * (`ink-renderer.ts` + `RunApp.tsx`). The component is a thin projection of the ink-free
 * {@link ChatStoreController} (all logic is the unit-tested reducer/store/formatters); here we only own the
 * `ink` lifecycle + the raw-mode text input. The plain (non-TTY) driver lives in `commands/chat.ts`; this is
 * the ONLY place `ink`/React are imported on the chat path, so the command core stays framework-free.
 *
 * RAW-MODE NOTE: unlike `RunApp`, `ChatApp` uses `useInput`, so `ink` puts the terminal in RAW mode and the
 * kernel no longer translates Ctrl-C → SIGINT. The command's SIGINT handler therefore can't see it — the
 * ChatApp handles Ctrl-C itself (→ `/cancel`). (Re-verify cancel on a real TTY when changing the input.)
 */

function TranscriptLine(props: Readonly<{ entry: TranscriptEntry; color: boolean }>): ReactElement {
  const { entry, color } = props;
  if (entry.role === 'user') {
    return (
      <Text {...colorProps(color, 'cyan')}>
        {'> '}
        {stripTerminalControls(entry.text)}
      </Text>
    );
  }
  if (entry.role === 'notice') {
    // Command output (`/workflows`, `/cost`): a dim block, distinct from the cyan user line + the assistant turn.
    // NO `wrap` (like the assistant turn): multi-line output renders each line on its own row, and a long line
    // WRAPS. `wrap="truncate-end"` would make ink's cli-truncate measure the whole \n-joined string and DROP
    // every line after an over-wide one — silent data loss for the catalog list.
    return <Text {...dimProps(color)}>{stripTerminalControls(entry.text)}</Text>;
  }
  // An actionable, secret-free recovery hint for a failed turn (2.5.H) — a yellow one-liner below the gray summary
  // that names the next step and makes explicit the session is still active. `undefined` (a success/aborted turn, or
  // a code with no guidance) renders nothing.
  const hint = errorRecoveryHint(entry.summary.errorCode, entry.summary.errorMessage);
  return (
    <Box flexDirection="column">
      <Text>{stripTerminalControls(entry.text)}</Text>
      <Text {...colorProps(color, 'gray')}> {formatTurnSummary(entry.summary)}</Text>
      {hint !== undefined && <Text {...colorProps(color, 'yellow')}> → {hint}</Text>}
    </Box>
  );
}

interface ChatAppProps {
  readonly store: ChatStoreController;
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
  /** Set the reasoning-effort tier (ADR-0066 §5) — the `/models` effort sub-step calls it on a SAME-model pick (a
   *  per-turn session override, NO reseat). Absent ⇒ the effort sub-step is not offered. `| undefined` for the
   *  createElement passthrough. */
  readonly onSetEffort?: ((effort: ReasoningEffort) => void) | undefined;
  /** Request a mid-session model switch (ADR-0059) — the `/models` picker overlay calls it on accept. Absent (a
   *  driver/test wired without it) ⇒ the overlay never opens (see `modelPicker`). `| undefined` for the passthrough. */
  readonly onReseat?: ((target: ReseatTarget) => void) | undefined;
  /** The `/models` reseat picker catalog port (ADR-0059). When present (with `onReseat`), a typed `/models` opens a
   *  keyboard-owning model-picker overlay whose accept triggers a live reseat. Absent ⇒ `/models` is a normal
   *  message/slash (no overlay). `| undefined` so the createElement passthrough forwards an absent `ctx.modelPicker`. */
  readonly modelPicker?: ChatModelsPort | undefined;
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
  /** Write the mouse selection to the system clipboard (OSC 52, 2.6.F Step 6). Absent ⇒ selection still highlights
   *  but copy-on-select is inert (a driver/test that wires no terminal). */
  readonly clipboard?: ((text: string) => ClipboardOutcome) | undefined;
}

interface ChatViewProps {
  readonly state: SessionViewState;
  readonly tick: number;
  /** Wall-clock ms at render, for the live in-flight turn timer ("thinking…/working… {elapsed} · Esc to stop",
   *  2.5.H). Render-only + cosmetic (no engine-purity concern — parity with `ModelPickerView`'s `nowMs`); the
   *  owner (`ChatApp` / the Home's `RootApp`) passes `Date.now()` so it advances with the frame loop. */
  readonly nowMs: number;
  readonly color: boolean;
  /** The current prompt editor — text + cursor (owned by the input owner — `ChatApp` or the Home's `RootApp`). */
  readonly editor: EditorState;
  readonly running: boolean;
  /** The active chat mode (ADR-0057) — shown in the footer so `auto` is never a hidden state. */
  readonly mode: ChatMode;
  /** The active reasoning-effort tier (ADR-0066) — shown in the footer (parity with `mode`) so the tier is never a
   *  hidden state; absent ⇒ not shown (a non-reasoning model / no tier). */
  readonly reasoningEffort?: ReasoningEffort | undefined;
  /** Whether the collapsible "thinking" panel is EXPANDED (2.5.H — `/thinking` / Ctrl+T). Only affects the render
   *  when the turn streamed reasoning (`state.liveReasoning` non-empty). */
  readonly reasoningVisible: boolean;
  /** An in-flight per-tool approval — when set, the `[y]/[a]/[n]` prompt replaces the idle prompt. */
  readonly approval?: PendingApproval | undefined;
  /** When the `/` palette is open it owns the bottom of the view, so the idle prompt + footer are suppressed (2.5.C S3b). */
  readonly paletteOpen?: boolean;
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
  /** The in-flight `[c]` typed-reason capture buffer (Step 14) — when set (only while `approval` is pending), the
   *  approval prompt shows the reason input instead of the `[y]/[a]/[n]` hint. `| undefined` ⇒ the normal prompt. */
  readonly reasonDraft?: EditorState | undefined;
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
    approval,
    paletteOpen,
  } = props;
  const attachments = props.attachments ?? [];
  // The turn streamed reasoning ⇒ render the collapsible "thinking" panel (2.5.H).
  const hasReasoning = state.liveReasoning.length > 0;
  const reasoningPanel = hasReasoning
    ? formatReasoningPanel({
        liveReasoning: state.liveReasoning,
        liveReasoningTruncated: state.liveReasoningTruncated,
        visible: reasoningVisible,
        columns: props.columns,
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
  const elapsedMs =
    state.turnStartedAtMs === undefined
      ? undefined
      : Math.max(0, props.nowMs - state.turnStartedAtMs);
  // The in-flight busy line — the labeled compaction moment (ADR-0062 §7), the `!`-shell command line, the
  // pre-token live-turn status ("Working… {elapsed} · Esc to stop"), or the streaming token line (with the
  // elision marker). The branch matrix lives in the pure, unit-tested {@link formatBusyLine}; here we only map
  // its `dim` flag to `<Text>`. Only rendered while `running`.
  const renderBusyLine = (): ReactElement => {
    const line = formatBusyLine({
      spinner: spinnerFrame(tick),
      compacting: state.compacting,
      busyCommand: props.busyCommand,
      liveTokens: state.liveTokens,
      liveTokensTruncated: state.liveTokensTruncated,
      elapsedMs,
      reasoningActive,
    });
    // A STATUS line (compaction / shell / pre-token) already carries its inline "· Esc to …" hint; a streaming
    // CONTENT line has no room for it, so surface the abort affordance on a compact dim line beneath it — `Esc`
    // aborts the whole turn (EA7), so the hint must persist for the ENTIRE turn, not just the pre-token wait.
    const abortHint = streamingAbortHint(line);
    return (
      <Box flexDirection="column">
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
      </Box>
    );
  };
  // The full-screen alt-screen renderer (ADR-0068 §c, 2.6.F Step 4b) renders the transcript through the scroll
  // VIEWPORT (the alt buffer has no scrollback for `<Static>` to use); the inline renderer (default) keeps `<Static>`
  // + native scrollback. In alt mode this Box FLEX-GROWS to fill the leftover height its OWNER (ChatApp / the Home's
  // ChatRegion) leaves below any keyboard-owning overlay, inside their terminal-`rows`-bounded container — so the
  // TranscriptViewport inside has a bound to flex-grow into, and the overlays are never pushed off-screen.
  const viewport = props.viewport;
  // Alt-screen only: flatten + width-wrap the transcript to display lines, MEMOIZED on (transcript, cols) so a
  // streaming turn (which re-renders each frame with the SAME completed-transcript reference) reuses the prior wrap
  // instead of re-wrapping all history every frame. `state.transcript` is a stable reference until an entry is
  // appended (immutable session-view-model), so the memo hits across ticks and busts on a real append or a resize.
  const wrappedTranscript = useMemo(
    () => (viewport === undefined ? undefined : wrapTranscript(state.transcript, viewport.cols)),
    [viewport?.cols, state.transcript],
  );
  return (
    <Box flexDirection="column" {...(viewport === undefined ? {} : { flexGrow: 1 })}>
      {/* Completed transcript. Inline: ink `<Static>` prints each entry once → native scrollback. Alt-screen: the
          {@link TranscriptViewport} flex-grows to the leftover height and renders only the visible window (tail-
          following at Step 4b-1), since the alt buffer has no scrollback for `<Static>`. */}
      {viewport === undefined || wrappedTranscript === undefined ? (
        <Static items={[...state.transcript]}>
          {(entry, index) => <TranscriptLine key={index} entry={entry} color={color} />}
        </Static>
      ) : (
        <TranscriptViewport
          lines={wrappedTranscript}
          color={color}
          scroll={viewport.scroll}
          selection={viewport.selection}
          onMeasure={viewport.onMeasure}
        />
      )}

      {/* The in-flight turn: tool annotations + the streaming assistant text + a spinner. A `!`-shell command in
          flight (busyCommand set) emits no session tokens, so it shows a distinct LABELED line — what is running +
          the honest Esc-to-cancel affordance (Esc aborts the command, keeping the session; Ctrl-C would end it). */}
      {running && (
        <Box flexDirection="column">
          {state.liveToolCalls.map((call) => (
            <Text key={call.id} {...colorProps(color, 'yellow')}>
              {formatToolCall(call)}
            </Text>
          ))}
          {/* The collapsible "thinking" panel (2.5.H) — a dim header with the Ctrl+T toggle hint, and the reasoning
              body only when expanded. Shown above the busy line whenever the turn streamed reasoning. */}
          {reasoningPanel !== undefined && (
            <Box flexDirection="column">
              <Text {...dimProps(color)} wrap="truncate-end">
                {reasoningPanel.header}
              </Text>
              {reasoningPanel.body !== undefined && (
                <Text {...dimProps(color)}>{reasoningPanel.body}</Text>
              )}
            </Box>
          )}
          {renderBusyLine()}
        </Box>
      )}

      {/* The pending `@`/`!` attachment chip bar (2.5.D) — shown above the idle prompt so the queued file/command
          context is always visible without flooding the editor. */}
      {showIdlePrompt && attachments.length > 0 && (
        <AttachmentBar attachments={attachments} color={color} />
      )}

      {/* The multi-line input prompt (idle) with the cursor at its position. Every segment is sanitized inside
          PromptEditor so a pasted/typed control sequence cannot corrupt the display or inject ANSI/OSC. Shared
          with the Home's prompt so both surfaces render the editor identically. */}
      {showIdlePrompt && <PromptEditor editor={editor} color={color} />}
      {/* The context-aware idle hint bar (2.5.C S6). At an EMPTY prompt, surface the `/` palette as the command-
          discovery entry point (it lists /export, /doctor, /workflows, …) — `/` only opens it from an empty
          buffer, so the hint appears exactly when it works. Once the user is composing, swap to the submit hint
          (which surfaces Ctrl+J for a newline). The palette renders its own nav hints when open. */}
      {showIdlePrompt && (
        <Text {...dimProps(color)} wrap="truncate-end">
          {editor.text.length === 0
            ? '/ for commands · /exit or Ctrl-C to end'
            : 'Enter to send · Ctrl+J newline · Ctrl-C to end'}
        </Text>
      )}

      {/* Sequence-gap / out-of-order diagnostics (the live stream is no-drop, so any gap is a defect worth
          surfacing — mirrors RunApp). Integer-only today, but sanitized for belt-and-suspenders defence. Joined
          into a single newline-separated Text so there is no keyed list — sidestepping both a duplicate React
          key (two identical warning strings) and an array-index key. */}
      {state.warnings.length > 0 && (
        <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
          {state.warnings.map((w) => `⚠ ${stripTerminalControls(w)}`).join('\n')}
        </Text>
      )}

      {/* The per-tool approval prompt (ADR-0057) — shown mid-turn when a governed dispatch awaits consent. It
          OWNS the keyboard via the reduceChatKey approval-intercept (no deadlock): [y] once, [a] always (only
          when the answer is cacheable — accept-edits, not auto's protected-path fallback), [n] no, Esc aborts. */}
      {approval !== undefined && (
        <Box flexDirection="column">
          <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
            {`Approve ${sanitizeInline(approval.request.toolId)}${
              formatApprovalTarget(approval.request).length > 0
                ? ` → ${formatApprovalTarget(approval.request)}`
                : ''
            }?`}
          </Text>
          {props.reasonDraft !== undefined ? (
            // The `[c]` typed-reason capture (Step 14): a hint + the buffer echoed SANITIZED (bidi/control-stripped,
            // one line) with a block cursor. Enter denies WITH this reason; Esc cancels back to the choices below.
            <Box flexDirection="column">
              <Text {...dimProps(color)} wrap="truncate-end">
                reason to deny · Enter to send · Esc to cancel
              </Text>
              <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
                {`> ${sanitizeInline(props.reasonDraft.text)}█`}
              </Text>
            </Box>
          ) : (
            <Text {...dimProps(color)}>
              {approval.cacheable
                ? '[y] yes   [a] always   [n] no   [c] reason   [esc] abort'
                : '[y] yes   [n] no   [c] reason   [esc] abort'}
            </Text>
          )}
        </Box>
      )}

      <Text {...colorProps(color, 'gray')}>
        {formatSessionFooterWithMode(state, mode, reasoningEffort)}
      </Text>
    </Box>
  );
}

export function ChatApp(props: Readonly<ChatAppProps>): ReactElement {
  const { state, tick, color, mode, reasoningEffort, reasoningVisible, approval } =
    useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
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
  };
  const cancelFired = useRef(false);
  // The alt-screen transcript SCROLL state (2.6.F Step 4b-2) — React-local here (the Home keeps it in the
  // controller), ref-shadowed like the editor so a coalesced stdin chunk reduces off the latest. The live geometry
  // (total wrapped lines + measured viewport rows) is lifted from `TranscriptViewport.onMeasure` into `scrollGeomRef`
  // so a scroll key reduces against the SAME geometry the viewport windows with. Inert in the inline renderer.
  const [scroll, setScroll] = useState<ScrollState>(INITIAL_SCROLL);
  const scrollRef = useRef<ScrollState>(INITIAL_SCROLL);
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
  // paused scroll. In this layout it inherently cannot be — the [y]/[a]/[n] prompt renders in the FIXED live region
  // BELOW the scrollable transcript viewport, so it is always on-screen regardless of the transcript scroll offset.
  // A transcript force-follow would only yank the user off history they are reading, so it is deliberately NOT wired.
  const running = state.status === 'running';
  // The interactive `/` palette (2.5.C S3b) — `undefined` ⇒ closed. React-local here (the external-store Home
  // keeps it in HomeControllerState); both surfaces drive the SAME foldPaletteKey + render the SAME PaletteView.
  // A ref SHADOW (like `editorRef`) keeps the latest value across a COALESCED stdin chunk — ink fires every event
  // in one chunk synchronously with no render flush, so reading the render-closure `palette` would be stale (a
  // close/select in event A would not be seen by a same-chunk event B, re-opening the palette). `applyPalette`
  // keeps the ref in lockstep with state; the input handler reads `paletteRef.current`, the render reads `palette`.
  const [palette, setPalette] = useState<PaletteState | undefined>(undefined);
  const paletteRef = useRef<PaletteState | undefined>(undefined);
  const applyPalette = (next: PaletteState | undefined): void => {
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
  // The `/models` reseat picker overlay (ADR-0059) — a keyboard-owning submode (like the palette/mention/search),
  // React-local + ref-shadowed so a coalesced stdin chunk sees a just-applied open/close/accept. A monotonic epoch
  // drops a stale async refresh whose picker has since closed/reopened (the Home controller's `pickerEpoch` pattern).
  const [modelPicker, setModelPicker] = useState<ModelPickerState | undefined>(undefined);
  const modelPickerRef = useRef<ModelPickerState | undefined>(undefined);
  const applyModelPicker = (next: ModelPickerState | undefined): void => {
    modelPickerRef.current = next;
    setModelPicker(next);
  };
  const pickerEpochRef = useRef(0);
  // The standalone `/effort` overlay (ADR-0066 §6) — a keyboard-owning submode like `/models`, ref-shadowed so a
  // coalesced stdin chunk sees a just-applied open/close/accept. Opened only on a reasoning-capable bound model.
  const [effortPicker, setEffortPicker] = useState<EffortPickerState | undefined>(undefined);
  const effortPickerRef = useRef<EffortPickerState | undefined>(undefined);
  const applyEffortPicker = (next: EffortPickerState | undefined): void => {
    effortPickerRef.current = next;
    setEffortPicker(next);
  };
  // The `[c]` typed-reason capture (Step 14) — a small keyboard-owning buffer opened FROM a pending approval to
  // record WHY the user denies. `undefined` ⇒ closed (the normal [y]/[a]/[n] prompt). React-local + ref-shadowed
  // (survives a coalesced stdin chunk, like the other submodes); only ever open while an approval is pending.
  const [reasonDraft, setReasonDraft] = useState<EditorState | undefined>(undefined);
  const reasonDraftRef = useRef<EditorState | undefined>(undefined);
  const applyReasonDraft = (next: EditorState | undefined): void => {
    reasonDraftRef.current = next;
    setReasonDraft(next);
  };
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
  const applyAttachments = (next: readonly PendingAttachment[]): void => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
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
        const open = mentionRef.current;
        if (open !== undefined && open.dir === dir)
          applyMention({ ...open, candidates, loading: false });
      },
      () => {
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
    const reader = props.mentionReader;
    if (reader === undefined) return;
    const gen = submitGenRef.current; // capture: a submit since accept ⇒ the buffer moved on (drop the marker/attachment)
    void reader.read(path).then(
      ({ content, sizeBytes }) => {
        if (submitGenRef.current !== gen) return; // the buffer was submitted since accept — never touch the next message
        applyEditor((current) => {
          historyRef.current = resetHistoryNav(historyRef.current); // a real edit ends history navigation
          return insertAtCursor(current, `${mentionMarker(path)} `);
        });
        addAttachment({ kind: 'file', path, content, sizeBytes });
        const warn = fileAttachmentWarning(path, content, sizeBytes);
        if (warn !== undefined) props.store.note(warn);
      },
      () => {
        if (submitGenRef.current !== gen) return;
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
    if (submitGenRef.current !== gen) return;
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
        if (submitGenRef.current === gen) props.store.note('! shell command failed unexpectedly');
      },
    );
  };

  // ---- The `/models` reseat picker overlay (ADR-0059) — mirrors the Home controller's picker functions --------
  // Apply a refresh result INTO the same picker generation that kicked it (drop a stale/closed/reopened one via the
  // epoch); keep the user's filter/selection, surface the per-provider partial-failure banner. Never crash the REPL.
  const applyPickerRefresh = (epoch: number, report: RefreshReport | undefined): void => {
    const port = props.modelPicker;
    const open = modelPickerRef.current;
    if (epoch !== pickerEpochRef.current || open === undefined || port === undefined) return;
    const failed =
      report?.providers.filter((p) => p.status === 'failed').map((p) => p.provider) ?? [];
    let view: ReturnType<ChatModelsPort['load']>;
    try {
      view = port.load(); // a DB read — never crash the REPL (parity with the Home)
    } catch {
      applyModelPicker({ ...open, loading: false, banner: partialFailureBanner(failed) });
      return;
    }
    applyModelPicker({
      ...open,
      entries: view.entries,
      refreshedAt: view.refreshedAt,
      loading: false,
      banner: partialFailureBanner(failed),
    });
  };
  const runPickerRefresh = (refresh: () => Promise<RefreshReport | undefined>): void => {
    const epoch = pickerEpochRef.current; // capture THIS generation so a reopened picker never adopts this result
    const open = modelPickerRef.current;
    if (open === undefined) return;
    applyModelPicker({ ...open, loading: true });
    void refresh().then(
      (report) => applyPickerRefresh(epoch, report),
      () => {
        // refresh()/refreshIfStale() never reject (per-provider isolation), but stay defensive: drop the spinner
        // only when this is still the same open picker generation.
        const cur = modelPickerRef.current;
        if (epoch === pickerEpochRef.current && cur !== undefined)
          applyModelPicker({ ...cur, loading: false });
      },
    );
  };
  // Open the picker on a typed `/models` (interactive only — the port is present): render the cached catalog
  // synchronously (the ✓ is the session's BOUND model — the reseat "you are here"), then kick a TTL-bounded refresh.
  const openModelPicker = (): void => {
    const port = props.modelPicker;
    if (port === undefined) return;
    let view: ReturnType<ChatModelsPort['load']>;
    try {
      view = port.load(); // a DB read — a fault must not crash the REPL (the "never crash the REPL" discipline)
    } catch {
      props.store.note('/models: could not read the model catalog.');
      return;
    }
    pickerEpochRef.current += 1; // a fresh generation — invalidates any in-flight refresh from a prior (closed) open
    applyModelPicker({
      entries: view.entries,
      filter: '',
      selected: 0,
      loading: false,
      currentDefault: port.boundModel,
      refreshedAt: view.refreshedAt,
      banner: undefined,
      hint: undefined,
      // ADR-0066: offer the effort sub-step when the setter is wired (interactive). `currentEffort` reads the LIVE
      // store tier (not a stale build-time value), so after a no-reseat `/effort` change the sub-list opens on it.
      phase: 'model',
      effortStep: props.onSetEffort !== undefined,
      pending: undefined,
      effortSelected: 0,
      currentEffort: props.store.getSnapshot().reasoningEffort,
    });
    runPickerRefresh(() => port.refreshIfStale());
  };
  // A DIMMED (unavailable) model's actionable hint (ADR-0064 §6) — a keyless provider names the remedy, else the
  // pre-existing "not on your key" note.
  const blockedHint = (step: Extract<ModelPickerStep, { kind: 'blocked' }>): string =>
    step.reason === 'no-key'
      ? `${step.displayName}: no key for ${step.provider} — run \`relavium provider set-key ${step.provider}\``
      : `${step.displayName} is not available on your key — pick another`;

  // Act on an accepted pick. A SAME-model pick is an effort-only change (ADR-0066 §5) — a per-turn SESSION override
  // (no reseat, no teardown/approval-wipe/MCP-reconnect/context-loss); a re-pick of the same tier (or a non-reasoning
  // model with no tier) is a gentle no-op. A DIFFERENT-model pick is a live reseat (ADR-0059) carrying the chosen
  // effort, then ends the driver loop so runReplLoop rebuilds on the new model.
  const acceptModelPick = (
    step: Extract<ModelPickerStep, { kind: 'accept' }>,
    open: ModelPickerState,
  ): void => {
    if (step.modelId === open.currentDefault) {
      if (step.reasoningEffort === undefined || step.reasoningEffort === open.currentEffort) {
        const at = step.reasoningEffort === undefined ? '' : ` at effort ${step.reasoningEffort}`;
        props.store.note(`Already on ${step.displayName}${at}.`);
      } else {
        props.onSetEffort?.(step.reasoningEffort);
        props.store.note(
          `Reasoning effort set to ${step.reasoningEffort} — applies to your next message.`,
        );
      }
      return;
    }
    // DIFFERENT model: a live reseat — only when `onReseat` is actually wired. Without it (a driver/test with the
    // picker but no reseat support), do NOT call `onExit()` — that would close the chat WITHOUT applying the switch;
    // the pick is simply dropped (defensive — production always wires `onReseat` alongside the picker).
    if (props.onReseat === undefined) return;
    props.onReseat({
      modelId: step.modelId,
      provider: step.provider,
      ...(step.reasoningEffort === undefined ? {} : { reasoningEffort: step.reasoningEffort }),
    });
    props.onExit(); // the reseat set the stop state; end the loop so runReplLoop swaps in the new-model session
  };

  // The open picker owns every key (mirrors routeMentionKey). Route the fold's step; the accept/blocked cases
  // delegate to the helpers above.
  const routeModelPickerKey = (char: string, key: ModelPickerKey): void => {
    const open = modelPickerRef.current;
    if (open === undefined) return;
    const step = foldModelPickerKey(char, key, open);
    switch (step.kind) {
      case 'close':
        applyModelPicker(undefined);
        return;
      case 'accept':
        applyModelPicker(undefined);
        acceptModelPick(step, open);
        return;
      case 'blocked':
        applyModelPicker({ ...open, hint: blockedHint(step) });
        return;
      case 'refresh':
        runPickerRefresh(() => props.modelPicker?.refresh() ?? Promise.resolve(undefined));
        return;
      case 'state':
        // Clear the transient hint only on a REAL interaction — the fold returns the SAME state ref for an inert key.
        applyModelPicker(step.state === open ? open : { ...step.state, hint: undefined });
        return;
    }
  };

  // ---- The standalone `/effort` overlay (ADR-0066 §6) — interactive tier selection (no reseat) ----------------
  // Open on the LIVE bound model + the LIVE store tier (so it opens on the currently-bound effort). The caller
  // (submit) gates this on a reasoning-capable model + a wired setter, so opening here is unconditional.
  const openEffortPicker = (): void => {
    const snap = props.store.getSnapshot();
    if (snap.state.model === undefined) return; // defensive — submit only opens on a bound reasoning-capable model
    applyEffortPicker(initialEffortPickerState(snap.state.model, snap.reasoningEffort));
  };
  // The open effort overlay owns every key (mirrors routeModelPickerKey). Accept applies the tier via the per-turn
  // setter (no reseat); a re-pick of the same tier is a gentle no-op with visible store feedback.
  const routeEffortPickerKey = (char: string, key: ModelPickerKey): void => {
    const open = effortPickerRef.current;
    if (open === undefined) return;
    const step = foldEffortPickerKey(char, key, open);
    switch (step.kind) {
      case 'close':
        applyEffortPicker(undefined);
        return;
      case 'accept':
        applyEffortPicker(undefined);
        if (step.effort === open.current) {
          props.store.note(`Already at reasoning effort ${step.effort}.`);
        } else {
          props.onSetEffort?.(step.effort);
          props.store.note(
            `Reasoning effort set to ${step.effort} — applies to your next message.`,
          );
        }
        return;
      case 'state':
        applyEffortPicker(step.state);
        return;
    }
  };

  // Attach ink's `suspendTerminal` to the ADR-0068 §e port while this tree is mounted (2.6.F Step 5d). `useApp()` is
  // the only place it exists, and the slash dispatch that runs `/scrollback` / `/edit` lives outside React — so the
  // port is the bridge. Detaching on unmount is what makes the hatches report "needs an interactive terminal" between
  // a `/clear`-swap's unmount and the next mount, rather than calling into a dead ink instance.
  // Invoked as a METHOD (`app.suspendTerminal(cb)`), never a bare destructured reference: ink 7 hands it out unbound
  // off the prototype, so this form is immune to how the context object is shaped.
  const app = useApp();
  const suspendPort = props.suspendPort;
  useEffect(() => {
    if (suspendPort === undefined) return;
    suspendPort.attach((callback) => app.suspendTerminal(callback));
    return () => suspendPort.attach(undefined);
  }, [app, suspendPort]);

  const submit = (message: string, display?: string): void => {
    // A typed `/models` opens the reseat picker overlay (ADR-0059) instead of sending — interactive only (the port
    // is wired). Covers a directly-typed `/models` AND a chat-palette selection (both route through `submit`).
    if (props.modelPicker !== undefined && message.trim() === '/models') {
      openModelPicker();
      return;
    }
    // A typed (or palette-selected) bare `/effort` opens the interactive tier overlay (ADR-0066 §6) instead of the
    // informational notice — but ONLY when the setter is wired AND the bound model is reasoning-capable; a
    // non-reasoning model falls through to the dispatch, whose ctx handler prints the "no controllable tier" notice.
    // `/effort <tier>` (with an arg) is NOT intercepted (exact match) — it dispatches and sets the tier directly.
    if (
      message.trim() === '/effort' &&
      canControlEffort(props.store.getSnapshot().state.model, props.onSetEffort !== undefined)
    ) {
      openEffortPicker();
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
  // ONE `text` event, so a multi-line block appends verbatim and a pasted approval token can never reach
  // `reduceApprovalKey` and answer the fail-closed floor (ADR-0057). Dropped unless the compose buffer is the active
  // editable target (mirrors the keystroke gate + the Home's `pasteEditable`): no running turn / `!`-shell / submit
  // in flight, no keyboard-owning overlay/submode, and NO pending approval (read FRESH from the store). This also
  // closes the standalone-chat paste gap — it never enabled DECSET 2004 before; usePaste enables it natively now.
  usePaste((text) => {
    const pasted = text.replace(/\r\n?/g, '\n');
    if (pasted.length === 0) return;
    const snap = props.store.getSnapshot();
    const editable = pasteIsEditable({
      running: snap.state.status === 'running',
      shellBusy: shellBusyRef.current,
      submitBusy: submitBusyRef.current,
      paletteOpen: paletteRef.current !== undefined,
      searchOpen: searchRef.current !== undefined,
      mentionOpen: mentionRef.current !== undefined,
      modelPickerOpen: modelPickerRef.current !== undefined,
      effortPickerOpen: effortPickerRef.current !== undefined,
      reasonCaptureOpen: reasonDraftRef.current !== undefined,
      approvalPending: snap.approval !== undefined,
    });
    if (!editable) return;
    applyEditor((cur) => insertAtCursor(cur, pasted));
  });

  // Ctrl-C reaches us (not the kernel) in raw mode — `reduceChatKey` maps it to `cancel` even mid-turn. Dispatch
  // /cancel at most once: cancelOnce() is idempotent, but a held Ctrl-C would otherwise fire redundant turns.
  /**
   * Reduce one non-wheel mouse report into the selection (2.6.F Step 6). The viewport facts come from the measured
   * geometry (`top`/`left` — where the box sits in ink's frame) plus the LIVE wrap (`totalLines`/`height`), so a
   * drag during a streaming turn reduces against the transcript as it is now, not as it was at the last commit.
   */
  const routeSelection = (event: TerminalMouseEvent): void => {
    const measured = scrollGeomRef.current;
    const live = liveScrollGeometry(
      props.store.getSnapshot().state.transcript,
      windowSize.columns,
      measured.height,
    );
    const viewport: SelectionViewport = {
      top: measured.top,
      left: measured.left,
      height: live.height,
      totalLines: live.totalLines,
      offset: effectiveOffset(scrollRef.current, live),
    };
    const action = reduceSelection(selectionRef.current, event, viewport);
    switch (action.kind) {
      case 'none':
        return;
      case 'clear':
        applySelection(undefined);
        return;
      case 'set':
        applySelection(action.state);
        return;
      case 'copy':
        applySelection(action.state); // keep the highlight, as every terminal does
        copySelection(action.state);
        return;
    }
  };

  /**
   * Copy the selection to the system clipboard on release. SILENT on success: `store.notice` appends a transcript
   * entry, which would re-wrap and SHIFT the very lines the user just selected — the highlight would jump out from
   * under their pointer. Only a refusal (a selection past the terminal's OSC 52 length floor) is worth a notice.
   */
  const copySelection = (state: SelectionState): void => {
    const clipboard = props.clipboard;
    if (clipboard === undefined) return;
    const rows = wrapTranscript(props.store.getSnapshot().state.transcript, windowSize.columns).map(
      (line) => line.text,
    );
    const outcome = clipboard(selectionText(rows, normalizeSelection(state)));
    if (outcome.kind === 'too-large') {
      props.store.note(
        `selection too large to copy (${Math.ceil(outcome.base64Length / 1024)} KB) — use /scrollback or /edit`,
      );
    }
  };

  useInput((char, key) => {
    // Mouse reports (Step 5): the alt screen enables mouse reporting, so a wheel/click arrives in EVERY state —
    // including while an overlay owns the keyboard. CONSUME every report HERE, ahead of the overlay routing below,
    // so its raw bytes can never type into the prompt, the `/` palette filter, or the `[c]` reason capture. The wheel
    // only SCROLLS when no overlay owns the keyboard (parity with the Home + the Step-4b-2 overlay gate).
    if (props.alternateScreen === true) {
      const mouse = parseMouseEvent(char);
      if (mouse !== undefined) {
        const overlayOwnsKeyboard =
          reasonDraftRef.current !== undefined ||
          paletteRef.current !== undefined ||
          searchRef.current !== undefined ||
          mentionRef.current !== undefined ||
          modelPickerRef.current !== undefined ||
          effortPickerRef.current !== undefined;
        if (!overlayOwnsKeyboard) {
          if (mouse.kind === 'wheel') {
            const geom = liveScrollGeometry(
              props.store.getSnapshot().state.transcript,
              windowSize.columns,
              scrollGeomRef.current.height,
            );
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
    // Read `running` FRESH from the store (not the render closure) so a coalesced same-chunk event after a turn
    // settles sees the current status — matching the ref-shadow `editorRef`/`paletteRef` reads below.
    // Busy = a streaming turn OR a `!`-shell command in flight (the latter has no store status — read the ref so a
    // coalesced same-chunk key after the `!`-submit is gated too). A gated keystroke can't reach `sendMessage`.
    const isRunning =
      props.store.getSnapshot().state.status === 'running' ||
      shellBusyRef.current ||
      submitBusyRef.current;
    // The `[c]` typed-reason capture (Step 14) owns the keyboard while open — checked FIRST. It ONLY opens from a
    // pending approval, so if that approval settled out-of-band (an external abort while typing) the capture is
    // stale: drop it. Else `Esc` CANCELS back to the [y]/[a]/[n] prompt (the approval is STILL pending — not an
    // abort); plain `Enter` submits the reject with the sanitized+bounded reason; every other key edits the buffer
    // (Ctrl-C / a non-edit chord is a harmless no-op, matching the approval floor's keyboard ownership). Read the
    // REF so a coalesced same-chunk key sees a just-applied open/edit. The floor is unchanged — this only enriches
    // a reject; a governed dispatch still cannot proceed without an explicit decision.
    const openReason = reasonDraftRef.current;
    if (openReason !== undefined) {
      if (props.store.getSnapshot().approval === undefined) {
        applyReasonDraft(undefined); // the approval vanished — discard the orphaned capture
        return;
      }
      if (key.escape === true) {
        applyReasonDraft(undefined); // cancel the reason; the approval stays pending ([y]/[a]/[n] again)
        return;
      }
      if (key.return === true && key.shift !== true) {
        applyReasonDraft(undefined);
        const reason = sanitizeApprovalReason(openReason.text);
        props.store.answerApproval(
          reason === undefined ? { outcome: 'reject' } : { outcome: 'reject', reason },
        );
        return;
      }
      const edit = reduceEditorMotion(char, key);
      if (edit !== undefined) applyReasonDraft(applyEditorAction(openReason, edit));
      return;
    }
    // The open `/models` reseat picker owns every key (ADR-0059) — checked FIRST (mutually exclusive with the other
    // submodes; it only opens at an idle prompt). Read the REF so a coalesced same-chunk key sees a just-applied
    // open/close/accept; on accept it triggers the reseat + ends the loop (see routeModelPickerKey).
    if (modelPickerRef.current !== undefined) {
      routeModelPickerKey(char, key);
      return;
    }
    // The open `/effort` overlay owns every key (ADR-0066 §6) — mutually exclusive with the other submodes (it only
    // opens at an idle prompt). Read the REF so a coalesced same-chunk key sees a just-applied open/close/accept.
    if (effortPickerRef.current !== undefined) {
      routeEffortPickerKey(char, key);
      return;
    }
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
    const openPalette = paletteRef.current;
    if (openPalette !== undefined) {
      const step = foldPaletteKey(char, key, openPalette, CHAT_PALETTE_COMMANDS);
      if (step.kind === 'close') {
        applyPalette(undefined);
        return;
      }
      if (step.kind === 'run') {
        applyPalette(undefined);
        if (step.command !== undefined) submit(`/${step.command.name}`); // reuse the S3a slash dispatch
        return;
      }
      applyPalette(step.state);
      return;
    }
    // A pending approval OWNS the keyboard (never opens the palette) — the reduceChatKey approval-intercept.
    const approvalPending = props.store.getSnapshot().approval !== undefined;
    // Open the palette on a literal '/' at an idle, EMPTY prompt — the discovery entry point (never mid-approval).
    if (
      !approvalPending &&
      shouldOpenPalette(char, key, isRunning, editorRef.current.text.length)
    ) {
      applyPalette(INITIAL_PALETTE_STATE);
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
    // scrollback, so these keys fall through to the editor there. The overlays + the `[c]` reason capture `return`
    // ABOVE this, so they keep their keys; a plain pending approval is still REACHED here (it is consumed by
    // reduceChatKey below), which is safe because scroll keys never overlap the [y]/[a]/[n] answer set. Read the REF
    // for coalesced-chunk safety. Not gated on `isRunning` — you can scroll history WHILE a turn streams.
    if (props.alternateScreen === true) {
      const liveGeom = (): ScrollGeometry =>
        // Reduce against LIVE geometry: wrap the store's CURRENT transcript at the keypress (rare, user-driven) for
        // a fresh `totalLines`, not the `onMeasure` ref which lags by up to a commit — else a mid-stream burst makes
        // `settle` resume-follow against a stale bottom (Step-4b-2 Sonnet review). `props.store` is a stable prop, so
        // its snapshot is read fresh here regardless of any coalesced-chunk closure staleness.
        liveScrollGeometry(
          props.store.getSnapshot().state.transcript,
          windowSize.columns,
          scrollGeomRef.current.height,
        );
      // (Mouse reports are consumed at the TOP of this handler, ahead of the overlay routing — see above.)
      const motion = scrollMotionForKey(key);
      if (motion !== undefined) {
        applyScroll(reduceScroll(scrollRef.current, motion, liveGeom()));
        return;
      }
    }
    const action = reduceChatKey(char, key, editorRef.current.text, isRunning, approvalPending);
    switch (action.kind) {
      case 'cancel':
        if (!cancelFired.current) {
          cancelFired.current = true;
          submit('/cancel');
        }
        return;
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
        submitGenRef.current += 1; // the buffer is cleared → a pending mention read / shell run must not re-inject
        // A leading `!` (with a runner wired + a non-empty command) runs the shell escape instead of sending a
        // message; a bare `!` or an absent runner falls through to a normal message send.
        const trimmed = action.line.trim();
        const parsed =
          props.runShellCommand !== undefined && isShellLine(trimmed)
            ? tokenizeCommand(trimmed.slice(1))
            : undefined;
        if (parsed !== undefined) {
          historyRef.current = recordHistory(historyRef.current, action.line);
          applyEditor(() => emptyEditor());
          runShell(parsed); // a `!command` → the shell escape (does NOT consume pending attachments)
          return;
        }
        if (trimmed.startsWith('/') || attachmentsRef.current.length === 0) {
          // a slash command, or a plain message with no attachments — the simple path (message === display)
          historyRef.current = recordHistory(historyRef.current, action.line);
          applyEditor(() => emptyEditor());
          submit(action.line);
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
        // Esc — mid-turn abort (keeps the session; distinct from Ctrl-C /cancel). `onAbort` aborts the turn,
        // whose signal also rejects any in-flight approval. If `onAbort` is absent (a driver/test wired without
        // it), a PENDING approval would otherwise hang — reject it directly so Esc is never a dead key at a
        // decision (parity with home-controller.ts's handleChatKey).
        if (props.onAbort !== undefined) {
          props.onAbort();
        } else if (props.store.getSnapshot().approval !== undefined) {
          props.store.answerApproval({ outcome: 'reject' });
        }
        return;
      case 'approve':
        props.store.answerApproval({ outcome: 'approve', scope: action.scope });
        return;
      case 'reject':
        props.store.answerApproval({ outcome: 'reject' });
        return;
      case 'reject-with-reason':
        // `[c]` — open the typed-reason capture; the next keys fill it, then submit rejects WITH the reason
        // (Step 14). The approval stays pending until then; the capture handler above owns the keyboard while open.
        applyReasonDraft(emptyEditor());
        return;
      case 'none':
        return;
    }
  });

  // The live terminal size via ink 7's `useWindowSize` (2.6.F Step 4b): unlike a raw `process.stdout.columns` read,
  // this RE-RENDERS the component on a SIGWINCH resize (ink's own resize handler only re-lays-out yoga width; it does
  // not re-execute React, and the idle frame loop does not repaint), so the alt-screen container height, the wrap
  // width, and the viewport's re-measure all track a resize — parity with the Home's `subscribeResize`. It falls
  // back to 80×24 off a TTY (a harness), moot on a real TTY (the only place alt mounts, via the driveInk gate).
  const windowSize = useWindowSize();

  // A resize re-wraps the transcript, so every display-line index the live selection holds moves. Drop it rather than
  // highlight — and copy — the wrong text (2.6.F Step 6).
  useEffect(() => {
    applySelection(undefined);
  }, [windowSize.columns]);
  // Alt-screen (Step 4b, ADR-0068 §c): the outer container is bounded to the terminal `rows` so `ChatView`'s
  // flex-grow viewport has a height to fill BELOW any keyboard-owning overlay (palette / search / …), and the
  // transcript renders through the scroll {@link TranscriptViewport} instead of `<Static>`. Absent ⇒ the inline
  // `<Static>` renderer, unbounded height.
  const viewport =
    props.alternateScreen === true
      ? {
          rows: windowSize.rows,
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

  return (
    <Box flexDirection="column" {...(viewport === undefined ? {} : { height: viewport.rows })}>
      <ChatView
        state={state}
        tick={tick}
        nowMs={Date.now()}
        color={color}
        editor={editor}
        running={running || shellBusy || submitBusy}
        mode={mode}
        reasoningEffort={reasoningEffort}
        reasoningVisible={reasoningVisible}
        approval={approval}
        attachments={attachments}
        busyCommand={busyCommand}
        // Live terminal width for the reasoning-panel row bound (2.5.H) — resize-tracked via `useWindowSize` above.
        columns={windowSize.columns}
        viewport={viewport}
        reasonDraft={reasonDraft}
        paletteOpen={
          palette !== undefined ||
          search !== undefined ||
          mention !== undefined ||
          modelPicker !== undefined ||
          effortPicker !== undefined
        }
      />
      {palette !== undefined && (
        <PaletteView commands={CHAT_PALETTE_COMMANDS} state={palette} color={color} />
      )}
      {search !== undefined && (
        <ReverseSearchView state={search} entries={historyRef.current.entries} color={color} />
      )}
      {mention !== undefined && <MentionView state={mention} color={color} />}
      {/* The `/models` reseat picker overlay (ADR-0059) — mounted like the palette; nowMs feeds the freshness badge
          (cosmetic, render-only, so `Date.now()` is fine on this UI path — no engine-purity concern here). */}
      {modelPicker !== undefined && (
        <ModelPickerView state={modelPicker} color={color} nowMs={Date.now()} />
      )}
      {/* The standalone `/effort` overlay (ADR-0066 §6) — the shared tier list; `Esc` cancels (not a back-out). */}
      {effortPicker !== undefined && (
        <EffortTierList
          selected={effortPicker.selected}
          current={effortPicker.current}
          labelSuffix={effortPicker.model}
          footer="↑/↓ select · Enter apply · Esc cancel"
          color={color}
        />
      )}
    </Box>
  );
}

/** The TTY ink driver: mount {@link ChatApp}, run the frame loop, and finalize on exit. Returns the drive OUTCOME
 *  ({@link ChatDriveOutcome}) so the re-drive loop can swap in a fresh session on `/clear` (ADR-0062 §7). */
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
    readonly teardown: () => void;
    readonly outcome: () => ChatDriveOutcome;
  },
): Promise<ChatDriveOutcome> {
  return exited.finally(ops.teardown).then((): ChatDriveOutcome => ops.outcome());
}

export function driveInk(ctx: ChatDriveContext): Promise<ChatDriveOutcome> {
  // The resume banner (2.N): print it once before mounting ink so it scrolls into the terminal history above
  // the live region — the TTY counterpart of the line drivePlain writes, so a resumed session is visibly a
  // resume (not just an N-turn footer). A fresh session has no intro and prints nothing here.
  if (ctx.intro !== undefined) {
    ctx.io.writeOut(`${ctx.intro}\n`);
  }
  // Mirror the live stream into the view store the component projects.
  const unsubscribe = ctx.handle.subscribe((event) => ctx.store.apply(event));
  // Open the session ONLY now — the store is subscribed, so the synchronous session:started (which carries
  // the model for the footer) is observed, not raced.
  ctx.startSession();
  const frame = setInterval(() => ctx.store.tick(), FRAME_MS);
  frame.unref();

  let resolveExit: () => void = () => undefined;
  let rejectExit: (err: unknown) => void = () => undefined;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
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
  // The full-screen render mode (2.6.F, ADR-0068 §e). driveInk only runs on a TTY (selectChatDriver), so the output
  // mode is 'tui'; the resolver still short-circuits a 'plain' path to inline defensively, then applies
  // `--no-alt-screen` → `[preferences].alt_screen` (ctx.altScreen) → the phase default (alt-ON since Step 4b-3). This
  // value drives ONLY the `ChatApp` component prop (the transcript viewport vs `<Static>`); ink's render OPTION is a
  // hard `false` (Step 4b-3), so ink toggles NO DECSET-1049 per session — the hoisted `runReplLoop` owns the single
  // alt-buffer enter/exit, and the end-of-session summary rides on the outcome + prints after that exit (ADR-0068 §c).
  const alternateScreen =
    resolveRenderMode({
      outputMode: detectOutputMode({
        stdoutIsTty: ctx.io.stdoutIsTty,
        json: ctx.global.json,
        ci: isCiEnv(ctx.io.env),
      }),
      noAltScreenFlag: ctx.global.noAltScreen === true,
      configAltScreen: ctx.altScreen,
    }) === 'alt';
  let cancelRequested = false;
  const onSigint = (): void => {
    if (cancelRequested) {
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
  process.on('SIGINT', onSigintGated);

  try {
    instance = render(
      createElement(ChatApp, {
        store: ctx.store,
        // The COMPONENT prop `alternateScreen` (ADR-0068 §c) selects the transcript viewport (vs `<Static>`) — kept
        // as the resolved mode. It is INDEPENDENT of ink's render OPTION below (now hard `false`, Step 4b-3): ink
        // renders full-screen via log-update regardless, and the hoisted `runReplLoop` owns the alt-buffer toggle.
        alternateScreen,
        onSubmit: ctx.processLine,
        shouldStop: ctx.shouldStop,
        onExit: () => resolveExit(),
        // An unexpected turn-core throw rejects `exited` → the finally tears down + the rejection propagates out
        // of the command (mapped to exit 1), matching the plain driver where the throw escapes the for-await loop.
        onError: (err) => rejectExit(err),
        // ADR-0057 mode/abort wiring — the REPL loop always supplies these. onModeChange defaults to a no-op so a
        // driver wired without it degrades to a fixed mode; onAbort is passed through AS-IS (optional) so the
        // 'abort' handler can reject a pending approval when it is absent (never a dead Esc — see ChatApp).
        onAbort: ctx.onAbort,
        onModeChange: ctx.onModeChange ?? ((): void => undefined),
        // ADR-0066 §5 effort setter — passed AS-IS (optional); absent ⇒ the `/models` effort sub-step is not offered.
        onSetEffort: ctx.onSetEffort,
        // `/models` reseat (ADR-0059) — the REPL loop wires both onReseat + the picker port only for an interactive
        // session; passed AS-IS (optional) so a driver wired without them simply has no `/models` overlay.
        onReseat: ctx.onReseat,
        modelPicker: ctx.modelPicker,
        // `@`-mention completion (2.5.D, ADR-0061) — the REPL loop wires it only for an interactive session; passed
        // AS-IS (optional) so an absent reader degrades `@` to a literal char (never a dead key — see ChatApp).
        mentionReader: ctx.mentionReader,
        // `!`-shell runner (2.5.D, ADR-0061) — interactive-only; absent ⇒ a leading `!` is a literal message.
        runShellCommand: ctx.runShellCommand,
        suspendPort: ctx.suspendPort,
        clipboard: ctx.clipboard,
      }),
      {
        // OUR /cancel (Ctrl-C) handler drives the cooperative cancel — never ink's process.exit.
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: Math.max(1, Math.round(1000 / FRAME_MS)),
        // ink render OPTION is HARD `false` (2.6.F Step 4b-3, ADR-0068 §c): ink must NOT toggle DECSET-1049 per
        // session — the hoisted `runReplLoop` enters the alt buffer ONCE above the loop and exits ONCE, so a `/clear`
        // / reseat re-drive no longer flips the terminal (the flicker). ink still full-screen-renders via log-update.
        alternateScreen: false,
      },
    );

    return finalizeInkExit(exited, {
      // Tear down + UNMOUNT (restores raw mode + cursor; with the option false it does NOT exit the alt buffer — the
      // hoisted runReplLoop owns that). A throw here must not mask the outcome nor skip the SIGINT-listener removal.
      teardown: () => {
        clearInterval(frame);
        unsubscribe();
        try {
          instance?.unmount(); // best-effort terminal restore — a guarded unmount (parity with driveHome).
        } catch {
          // swallow — never mask the outcome nor skip the SIGINT-listener removal below.
        }
        process.removeListener('SIGINT', onSigintGated);
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
    // render() threw synchronously — clean up the interval, subscription, and SIGINT handler set up above so
    // none leaks past the throw (the finally above is never reached when render() throws).
    clearInterval(frame);
    unsubscribe();
    process.removeListener('SIGINT', onSigintGated);
    throw err;
  }
}

/**
 * Select the chat driver by surface (2.Q): `--json` ⇒ the headless NDJSON `SessionEvent` stream (machine
 * output wins over the TTY); else a real TTY ⇒ the ink REPL; else the plain non-TTY line loop.
 */
export const selectChatDriver: ChatDriver = (ctx) => {
  if (ctx.global.json) return driveJson(ctx); // machine output wins over the TTY
  return ctx.io.stdoutIsTty ? driveInk(ctx) : drivePlain(ctx);
};
