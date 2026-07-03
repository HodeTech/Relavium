import { Box, Static, Text, render, useInput } from 'ink';
import { createElement, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';

import {
  driveJson,
  drivePlain,
  type ChatDriveContext,
  type ChatDriver,
} from '../../commands/chat.js';
import { CHAT_PALETTE_COMMANDS } from '../../commands/repl-commands.js';
import { EXIT_CODES } from '../../process/exit-codes.js';
import { colorProps, dimProps } from './projection.js';
import { FORCE_TEARDOWN_MS, FRAME_MS } from './tui-constants.js';
import {
  applyEditorAction,
  editorFromText,
  emptyEditor,
  insertAtCursor,
  reduceChatKey,
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
  formatApprovalTarget,
  formatSessionFooterWithMode,
  formatToolCall,
  formatTurnSummary,
  sanitizeInline,
  stripTerminalControls,
} from './chat-projection.js';
import { nextMode, type ChatMode } from '../../chat/chat-mode.js';
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
  return (
    <Box flexDirection="column">
      <Text>{stripTerminalControls(entry.text)}</Text>
      <Text {...colorProps(color, 'gray')}> {formatTurnSummary(entry.summary)}</Text>
    </Box>
  );
}

interface ChatAppProps {
  readonly store: ChatStoreController;
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
}

interface ChatViewProps {
  readonly state: SessionViewState;
  readonly tick: number;
  readonly color: boolean;
  /** The current prompt editor — text + cursor (owned by the input owner — `ChatApp` or the Home's `RootApp`). */
  readonly editor: EditorState;
  readonly running: boolean;
  /** The active chat mode (ADR-0057) — shown in the footer so `auto` is never a hidden state. */
  readonly mode: ChatMode;
  /** An in-flight per-tool approval — when set, the `[y]/[a]/[n]` prompt replaces the idle prompt. */
  readonly approval?: PendingApproval | undefined;
  /** When the `/` palette is open it owns the bottom of the view, so the idle prompt + footer are suppressed (2.5.C S3b). */
  readonly paletteOpen?: boolean;
  /** Pending `@`/`!` attachments (2.5.D chip redesign) — rendered as a compact chip bar above the idle prompt. */
  readonly attachments?: readonly PendingAttachment[];
  /** The in-flight `!`-shell command line (2.5.D) — when set, the busy indicator labels WHAT is running (a `!`-
   *  command emits no session tokens, so without this the spinner would be bare) + how to cancel (Esc). */
  readonly busyCommand?: string | undefined;
}

/**
 * The PURE chat render — transcript / in-flight turn / prompt echo / warnings / footer — with no `useInput`,
 * no state, and no store subscription. Extracted from `ChatApp` so the 2.5.B Home can render the chat region
 * inside its OWN single-`useInput` tree (one raw-mode owner) without duplicating this JSX. The live input echo
 * and every model/transcript string are sanitized at this display boundary so a pasted/streamed control
 * sequence cannot corrupt the terminal or inject ANSI/OSC.
 */
export function ChatView(props: Readonly<ChatViewProps>): ReactElement {
  const { state, tick, color, editor, running, mode, approval, paletteOpen } = props;
  const attachments = props.attachments ?? [];
  // When the palette is open it renders its own query line + hint below, so suppress the idle prompt + footer to
  // avoid two competing prompts (the palette owns the input focus until it closes).
  const showIdlePrompt = !running && paletteOpen !== true;
  return (
    <Box flexDirection="column">
      {/* Completed transcript — ink Static prints each entry once, then it scrolls into terminal history. */}
      <Static items={[...state.transcript]}>
        {(entry, index) => <TranscriptLine key={index} entry={entry} color={color} />}
      </Static>

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
          {props.busyCommand === undefined ? (
            <Text>
              {spinnerFrame(tick)} {stripTerminalControls(state.liveTokens)}
            </Text>
          ) : (
            <Text {...dimProps(color)} wrap="truncate-end">
              {`${spinnerFrame(tick)} ! ${sanitizeInline(props.busyCommand)} — running · Esc to cancel`}
            </Text>
          )}
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
          <Text {...dimProps(color)}>
            {approval.cacheable
              ? '[y] yes   [a] always   [n] no   [esc] abort'
              : '[y] yes   [n] no   [esc] abort'}
          </Text>
        </Box>
      )}

      <Text {...colorProps(color, 'gray')}>{formatSessionFooterWithMode(state, mode)}</Text>
    </Box>
  );
}

export function ChatApp(props: Readonly<ChatAppProps>): ReactElement {
  const { state, tick, color, mode, approval } = useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
  );
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

  const submit = (message: string, display?: string): void => {
    // Two-arm: a settled turn checks for exit; an UNEXPECTED rejection (the turn core's loud re-throw) goes to
    // onError so the driver always unblocks + tears down (else `exited` never settles and the REPL hangs). The
    // trailing .catch is defensive: a throw inside either callback still routes to onError, never silently lost.
    void props
      .onSubmit(message, display)
      .then(
        () => {
          if (props.shouldStop()) props.onExit();
        },
        (err: unknown) => props.onError(err),
      )
      .catch((err: unknown) => props.onError(err));
  };

  // Ctrl-C reaches us (not the kernel) in raw mode — `reduceChatKey` maps it to `cancel` even mid-turn. Dispatch
  // /cancel at most once: cancelOnce() is idempotent, but a held Ctrl-C would otherwise fire redundant turns.
  useInput((char, key) => {
    // Read `running` FRESH from the store (not the render closure) so a coalesced same-chunk event after a turn
    // settles sees the current status — matching the ref-shadow `editorRef`/`paletteRef` reads below.
    // Busy = a streaming turn OR a `!`-shell command in flight (the latter has no store status — read the ref so a
    // coalesced same-chunk key after the `!`-submit is gated too). A gated keystroke can't reach `sendMessage`.
    const isRunning = props.store.getSnapshot().state.status === 'running' || shellBusyRef.current;
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
      case 'delete':
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
      case 'none':
        return;
    }
  });

  return (
    <Box flexDirection="column">
      <ChatView
        state={state}
        tick={tick}
        color={color}
        editor={editor}
        running={running || shellBusy}
        mode={mode}
        approval={approval}
        attachments={attachments}
        busyCommand={busyCommand}
        paletteOpen={palette !== undefined || search !== undefined || mention !== undefined}
      />
      {palette !== undefined && (
        <PaletteView commands={CHAT_PALETTE_COMMANDS} state={palette} color={color} />
      )}
      {search !== undefined && (
        <ReverseSearchView state={search} entries={historyRef.current.entries} color={color} />
      )}
      {mention !== undefined && <MentionView state={mention} color={color} />}
    </Box>
  );
}

/** The TTY ink driver: mount {@link ChatApp}, run the frame loop, and finalize on exit. */
export function driveInk(ctx: ChatDriveContext): Promise<void> {
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

  // An EXTERNAL SIGINT (kill -INT / a parent's signal) — a keyboard Ctrl-C is intercepted by useInput in raw
  // mode and never reaches the kernel as SIGINT, so this covers only the out-of-band case. Register with
  // process.on (NOT once): ink registers a signal-exit SIGINT listener that RE-RAISES SIGINT (→ exit 130) when
  // it is the SOLE remaining listener, which would skip our finally and leave the row 'active'. Staying
  // registered keeps signal-exit from re-raising, so the cooperative /cancel (→ session:cancelled → persister
  // marks 'ended') wins; a second SIGINT forces a clean exit 4 rather than hang on a provider ignoring the
  // abort. Removed LAST in the finally (after unmount), so a Ctrl-C during unmount still hits us.
  // Hoisted so the SIGINT handler can unmount ink (restoring the terminal) before a forced exit.
  let instance: ReturnType<typeof render> | undefined;
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
  process.on('SIGINT', onSigint);

  try {
    instance = render(
      createElement(ChatApp, {
        store: ctx.store,
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
        // `@`-mention completion (2.5.D, ADR-0061) — the REPL loop wires it only for an interactive session; passed
        // AS-IS (optional) so an absent reader degrades `@` to a literal char (never a dead key — see ChatApp).
        mentionReader: ctx.mentionReader,
        // `!`-shell runner (2.5.D, ADR-0061) — interactive-only; absent ⇒ a leading `!` is a literal message.
        runShellCommand: ctx.runShellCommand,
      }),
      {
        // OUR /cancel (Ctrl-C) handler drives the cooperative cancel — never ink's process.exit.
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: Math.max(1, Math.round(1000 / FRAME_MS)),
      },
    );

    return exited
      .then(() => {
        // The persistent final summary — written on any cooperative end (/exit, /cancel, keyboard Ctrl-C, or
        // an external SIGINT, all of which resolve `exited`); an unexpected error reject skips it (→ exit 1).
        ctx.io.writeOut(`${ctx.store.summaryText()}\n`);
      })
      .finally(() => {
        clearInterval(frame);
        unsubscribe();
        instance?.unmount();
        process.removeListener('SIGINT', onSigint);
      });
  } catch (err) {
    // render() threw synchronously — clean up the interval, subscription, and SIGINT handler set up above so
    // none leaks past the throw (the finally above is never reached when render() throws).
    clearInterval(frame);
    unsubscribe();
    process.removeListener('SIGINT', onSigint);
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
