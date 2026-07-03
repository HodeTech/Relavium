import type { UserCommandOutcome } from '@relavium/core';

import {
  CHAT_PALETTE_COMMANDS,
  HOME_PALETTE_COMMANDS,
  type ReplCommandContext,
} from '../../commands/repl-commands.js';
import { nextMode, type ChatMode } from '../../chat/chat-mode.js';
import { formatDoctorReport, runDoctorChecks, type DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import {
  applyEditorAction,
  editorFromText,
  emptyEditor,
  insertAtCursor,
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
import {
  estimateTokens,
  foldMentionKey,
  formatMentionInjection,
  mentionNonce,
  mentionOpensAt,
  MENTION_TOKEN_WARN,
  type MentionCandidate,
  type MentionReader,
  type MentionState,
} from './mention.js';
import { injectionNonce } from './injection.js';
import {
  commandLine,
  formatCommandInjection,
  isShellLine,
  shellDenyHint,
  tokenizeCommand,
  type ShellCommand,
} from './shell.js';
import { isPasteEnd, isPasteStart, reduceHomeKey, type HomeKey } from './home-input.js';
import {
  foldPaletteKey,
  INITIAL_PALETTE_STATE,
  shouldOpenPalette,
  type PaletteKey,
  type PaletteState,
} from './palette-reducer.js';
import { FORCE_TEARDOWN_MS } from './tui-constants.js';

/**
 * The Home session state machine, extracted from the ink view as a plain external store (2.5.B / ADR-0054) so the
 * lifecycle — submit → build → chat → end, the build/turn error paths, the exit/close-race guards, and bracketed
 * paste — is unit-testable WITHOUT mounting ink (the repo does not render-test ink). `RootApp` is a thin view that
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
  /** The chat view store the chat region projects (already subscribed to the live stream by `driveHome`). */
  readonly store: ChatStoreController;
  /** Handle one line (a slash command or a message) — the shared `createChatLineHandler` semantics. */
  readonly processLine: (line: string) => Promise<void>;
  /** `true` once `/exit` or `/cancel` has run — the chat ends and the Home returns. */
  readonly shouldStop: () => boolean;
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
  readonly snapshot: HomeSnapshot;
  readonly errorText: string | undefined;
  readonly pendingMessage: string;
  readonly input: EditorState;
  readonly session: HomeChatSession | undefined;
  /** The interactive `/` command palette — `undefined` ⇒ closed. Opens in both the bare Home (2.5.C S3c) and the
   *  in-Home chat (S3b); the command set + the run-on-select path differ by surface (see `handlePaletteKey`). */
  readonly palette: PaletteState | undefined;
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
  /** A published copy of the history entries (the closure `history` is not in state) so the external render can
   *  compute the reverse-search match; changes only on submit. */
  readonly historyEntries: readonly string[];
  /** Transient command output in the bare Home — the `/doctor` report (2.5.C S5), rendered below the strip and
   *  cleared on the next edit/submit. Multi-line + secret-free (the doctor formatter sanitizes). `undefined` ⇒ none. */
  readonly notice: string | undefined;
}

export interface HomeControllerDeps {
  /** Build + wire + START a fresh chat session (no first message — the controller sends it on transition). May reject. */
  readonly startChat: () => Promise<HomeChatSession>;
  readonly homeStore: HomeStore;
  /** The Home exited cleanly (Ctrl-C / EOF in Home mode) → `driveHome` resolves with exit 0. */
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
}

export interface HomeController {
  // Declared as function PROPERTIES (not methods) so a `useSyncExternalStore(c.subscribe, c.getSnapshot)`
  // unbound reference is sound (no `this`) — matching the chat store's read surface.
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => HomeControllerState;
  /** Dispatch one `useInput` event (the single raw-mode owner forwards every key here). */
  readonly handleKey: (input: string, key: HomeKey & ChatKey & PaletteKey) => void;
  /** Tear down a live chat session (if any), for the signal handler — idempotent, never the shared db. */
  readonly teardownActive: () => Promise<void>;
}

export function createHomeController(deps: HomeControllerDeps): HomeController {
  const listeners = new Set<() => void>();
  let state: HomeControllerState = {
    mode: 'home',
    snapshot: deps.homeStore.read(),
    errorText: undefined,
    pendingMessage: '',
    input: emptyEditor(),
    session: undefined,
    palette: undefined,
    search: undefined,
    mention: undefined,
    shellBusy: false,
    historyEntries: [],
    notice: undefined,
  };
  // Per-session command history for the in-Home chat (2.5.D step 3) — accumulates submitted lines across the Home
  // process; Up/Down recall, Ctrl+R reverse-searches. Not persisted (a chat-resume starts fresh).
  let history: InputHistory = EMPTY_HISTORY;
  let cancelFired = false;
  let exiting = false; // set on the clean-exit / error / signal paths — guards deferred reads of a closed db
  let tearingDown: HomeChatSession | undefined;
  let activeTeardown: Promise<void> | undefined; // the in-flight teardown of `tearingDown`, so a signal can await it
  let pasting = false; // inside a bracketed paste (DECSET 2004) — content is buffered literally, never submitted
  let buildInFlight: Promise<HomeChatSession> | undefined; // a `loading`-state build, so a signal can reap it
  // A monotonic token: a `/doctor` run captures it at start and lands its report only if it is still current —
  // any prompt edit / submit (which bumps it) invalidates a stale in-flight run so an old report can't reappear.
  let doctorRunId = 0;
  // A monotonic submit generation: bumped when the compose buffer is submitted (cleared). An async mention read
  // captures it at accept time and drops its inject if a submit has since happened — so a slow read resolving after
  // Enter can never splice the file into the (now-empty) buffer meant for the NEXT message (the session-identity
  // guard only catches a chat SWAP, not an in-chat submit that stays in the same session/mode).
  let submitEpoch = 0;

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
    for (const listener of listeners) listener();
  };
  /** Whether a chat turn is streaming — paste content (like every other key) is gated mid-turn. */
  const chatRunning = (): boolean =>
    state.mode === 'chat' && state.session?.store.getSnapshot().state.status === 'running';
  const set = (patch: Partial<HomeControllerState>): void => {
    state = { ...state, ...patch };
    notify();
  };

  const exitHome = (): void => {
    if (exiting) return; // idempotent — a second Ctrl-C (or a race) must not settle `driveHome` twice
    exiting = true;
    deps.onExit();
  };

  const failHome = (err: unknown): void => {
    if (exiting) return; // an exit/error already settled `driveHome` — drop this late failure
    exiting = true;
    deps.onError(err);
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
        pasting = false; // a lost paste-end marker must not leak the latch into the returned Home
        if (exiting) return; // an error/exit closed the db while we awaited teardown — do not read it
        set({
          session: undefined,
          input: emptyEditor(),
          errorText: undefined, // a stale build-failure banner must not haunt a clean return from a good chat
          notice: undefined, // symmetric with errorText — no stale /doctor report leaks into the returned Home
          pendingMessage: '',
          snapshot: deps.homeStore.read(), // the just-finished chat now shows in the refreshed strip
          mode: 'home',
          palette: undefined, // a palette left open when /exit ran must not leak into the returned Home
          search: undefined, // ditto a reverse-search submode
          mention: undefined, // ditto an `@`-completion submode
          shellBusy: false, // a `!`-command in flight when the chat ended must not leave the returned Home gated
        });
      })
      .catch(() => undefined); // a rejecting teardown (or read) must not surface as an unhandled rejection
  };

  // Drive one chat turn; on success end the chat if `/exit`/`/cancel` ran, on an escaping error tear the session
  // down BEFORE propagating so its MCP child / frame loop / row are never orphaned.
  const sendChatLine = (active: HomeChatSession, line: string): void => {
    void active.processLine(line).then(
      () => {
        if (active.shouldStop()) endChat(active);
      },
      (err: unknown) => {
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

  const submit = (): void => {
    const trimmed = state.input.text.trim();
    if (trimmed.length === 0) {
      set({ input: emptyEditor() }); // an empty prompt stays on the Home (no chat)
      return;
    }
    history = recordHistory(history, trimmed); // the message that starts the chat is recallable via Up in it
    // `palette: undefined` makes the loading-state invariant explicit (the palette is never open during a build)
    // rather than only implied by the key-routing order — mirroring the `endChat` reset.
    doctorRunId += 1; // a submit invalidates any in-flight /doctor run (its report must not land on the new chat)
    set({
      input: emptyEditor(),
      errorText: undefined,
      notice: undefined,
      pendingMessage: trimmed,
      mode: 'loading',
      palette: undefined,
      search: undefined,
      mention: undefined,
      historyEntries: history.entries,
    });
    // Track the in-flight build so a signal (or a mid-build exit) during `loading` can reclaim its just-spawned
    // session — its MCP child / frame loop — rather than orphan it (see teardownActive).
    const build = deps.startChat();
    buildInFlight = build;
    void build.then(
      (built) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) {
          void built.teardown().catch(() => undefined); // exited mid-build ⇒ reclaim the just-built session
          return;
        }
        set({ session: built, mode: 'chat' });
        sendChatLine(built, trimmed); // the first turn streams in the chat region
      },
      (err: unknown) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) return;
        pasting = false; // a paste latched during the build window must not leak into the returned Home
        set({
          errorText: err instanceof Error ? err.message : String(err),
          pendingMessage: '',
          mode: 'home', // route a build failure back to Home with the banner
        });
      },
    );
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
    exit: () => exitHome(),
    cancel: () => undefined,
    exportSession: () => undefined,
    help: () => undefined,
    showWorkflows: () => undefined,
    showCost: () => undefined,
    setMode: () => undefined, // `/mode` is chat-only (not in HOME_PALETTE_COMMANDS); inert in the Home surface

    runDoctor: async (deep) => {
      if (exiting) return;
      const runId = (doctorRunId += 1); // a new run; a prompt edit/submit or a later run bumps this, invalidating us
      set({ notice: 'doctor: checking…' });
      let text: string;
      try {
        text = formatDoctorReport(await runDoctorChecks(deep, deps.doctorProbes));
      } catch {
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
    },
  };

  const handlePaletteKey = (input: string, key: PaletteKey): void => {
    const palette = state.palette;
    if (palette === undefined) return;
    // The palette runs in BOTH surfaces: a live chat (a session ⇒ submit the slash through the S3a dispatch) and
    // the bare Home (no session ⇒ run the command over the Home's own context). The command set is the surface's.
    const active = state.session;
    const commands = active === undefined ? HOME_PALETTE_COMMANDS : CHAT_PALETTE_COMMANDS;
    const step = foldPaletteKey(input, key, palette, commands);
    if (step.kind === 'close') {
      set({ palette: undefined });
      return;
    }
    if (step.kind === 'run') {
      set({ palette: undefined });
      if (step.command !== undefined) {
        if (active === undefined) {
          // home: run over the Home context. The palette captures NO args, so the bare command runs (`/doctor`
          // ⇒ fast tier); `--deep` is a typed-in-chat affordance (repl-commands.ts).
          void Promise.resolve(step.command.run(homeReplCtx, [])).catch(() => undefined);
        } else {
          sendChatLine(active, `/${step.command.name}`); // chat: reuse the S3a slash dispatch (createChatLineHandler)
        }
      }
      return;
    }
    set({ palette: step.state });
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
      if (open === undefined || open.dir !== dir) return; // a since-closed / since-descended submode — drop it
      if (state.session !== active || state.mode !== 'chat') return; // a different session / mode — drop it
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
    const stale = (): boolean =>
      state.session !== active || state.mode !== 'chat' || submitEpoch !== epoch;
    void reader.read(path).then(
      ({ content, sizeBytes }) => {
        if (stale()) return; // the chat ended or the buffer was submitted mid-read — drop it
        history = resetHistoryNav(history); // a real edit ends history navigation
        set({
          input: insertAtCursor(state.input, formatMentionInjection(path, content, mentionNonce())),
        });
        if (estimateTokens(sizeBytes) > MENTION_TOKEN_WARN) {
          active.store.note(
            `@ file is large (~${estimateTokens(sizeBytes)} tokens) — it may crowd the context`,
          );
        }
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
    if (state.session !== active || state.mode !== 'chat' || submitEpoch !== epoch) return;
    if (outcome.kind === 'ran') {
      history = resetHistoryNav(history);
      set({
        input: insertAtCursor(
          state.input,
          formatCommandInjection(
            parsed,
            outcome.exitCode,
            outcome.stdout,
            outcome.stderr,
            injectionNonce(),
          ),
        ),
      });
      const exit = outcome.exitCode === 0 ? '' : ` (exit ${outcome.exitCode})`;
      active.store.note(`! ${commandLine(parsed)}${exit} — output added to your next message`);
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
    const runner = active.runShellCommand;
    if (runner === undefined) return;
    const epoch = submitEpoch;
    const mode = active.store.getSnapshot().mode; // captured for a mode-aware deny hint
    set({ shellBusy: true }); // gate input + show busy until the command settles (else a submit crashes the chat)
    // Clear the busy flag only if THIS session is still current (a swap's endChat already reset it — never un-gate
    // a new session's own in-flight command).
    const clearBusy = (): void => {
      if (state.session === active) set({ shellBusy: false });
    };
    void runner(parsed.command, parsed.args).then(
      (outcome) => {
        clearBusy();
        handleShellOutcome(active, parsed, outcome, mode, epoch);
      },
      () => {
        clearBusy();
        if (state.session === active && state.mode === 'chat' && submitEpoch === epoch) {
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
      set({ palette: INITIAL_PALETTE_STATE });
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

  // Apply one reduced chat-key action: edits/motions fold the buffer, submit runs a `!`-command or sends a message,
  // and the surface actions (cancel / cycle-mode / abort / approve / reject) drive the session.
  const applyChatAction = (active: HomeChatSession, action: ChatKeyAction): void => {
    switch (action.kind) {
      case 'cancel':
        if (!cancelFired) {
          cancelFired = true;
          sendChatLine(active, '/cancel'); // /cancel ends the (resumable) session → back to Home
        }
        return;
      case 'append':
      case 'backspace':
      case 'delete':
      case 'newline':
      case 'kill': {
        const next = applyEditorAction(state.input, action);
        if (next === state.input) return; // a no-op edit must not reset the history draft or re-render
        history = resetHistoryNav(history); // a real text edit ends history navigation
        set({ input: next });
        return;
      }
      case 'move': {
        // A vertical Up/Down move within a multi-line buffer; at the top/bottom edge (a no-op) recall history.
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
        return;
      }
      case 'submit': {
        submitEpoch += 1; // the buffer is cleared → a pending mention read / shell run must not re-inject
        history = recordHistory(history, action.line);
        set({ input: emptyEditor(), historyEntries: history.entries });
        // A leading `!` (with a runner + a non-empty command) runs the shell escape; else send a normal message.
        const trimmed = action.line.trim();
        const parsed =
          active.runShellCommand !== undefined && isShellLine(trimmed)
            ? tokenizeCommand(trimmed.slice(1))
            : undefined;
        if (parsed === undefined) {
          sendChatLine(active, action.line); // a bare `!` / no runner → a normal message
        } else {
          runShell(active, parsed); // a `!command` → the shell escape
        }
        return;
      }
      case 'cycle-mode':
        // Shift+Tab: advance the chat mode on the SAME session (ADR-0057; no reseat) — parity with `relavium chat`.
        active.onModeChange?.(nextMode(active.store.getSnapshot().mode));
        return;
      case 'abort':
        // Esc — mid-turn abort (keeps the session; distinct from /cancel). `onAbort` aborts the turn, whose
        // signal also rejects any in-flight approval. If `onAbort` is absent (a session wired without it), a
        // PENDING approval would otherwise hang — reject it directly so Esc is never a dead key at a decision.
        if (active.onAbort !== undefined) {
          active.onAbort();
        } else if (active.store.getSnapshot().approval !== undefined) {
          active.store.answerApproval({ outcome: 'reject' });
        }
        return;
      case 'approve':
        active.store.answerApproval({ outcome: 'approve', scope: action.scope });
        return;
      case 'reject':
        active.store.answerApproval({ outcome: 'reject' });
        return;
      case 'none':
        return;
    }
  };

  const handleChatKey = (active: HomeChatSession, input: string, key: ChatKey): void => {
    if (tearingDown === active) return; // a key arriving mid-teardown must not drive sendMessage on a cancelled session
    // Busy = a streaming turn OR a `!`-shell command in flight (`state.shellBusy` — the session has no store status
    // for it). A gated keystroke can't reach `sendMessage` → no `SessionStateError` crash.
    const running = active.store.getSnapshot().state.status === 'running' || state.shellBusy;
    if (routeMentionKey(active, input, key)) return;
    if (routeSearchKey(input, key)) return;
    const approvalPending = active.store.getSnapshot().approval !== undefined;
    if (tryOpenOverlay(active, input, key, running, approvalPending)) return;
    applyChatAction(active, reduceChatKey(input, key, state.input.text, running, approvalPending));
  };

  const handleHomeKey = (input: string, key: HomeKey): void => {
    // Ctrl-D (EOF) on an EMPTY prompt exits cleanly, the REPL convention (a non-empty buffer keeps it — no data loss).
    if (key.ctrl === true && input === 'd' && state.input.text.length === 0) {
      exitHome();
      return;
    }
    const action = reduceHomeKey(input, key);
    if (action.kind === 'exit') {
      exitHome();
      return;
    }
    if (state.mode === 'loading') return; // ignore edits/submit while a session builds (Ctrl-C above still bails)
    // Open the `/` palette at an idle, EMPTY Home prompt (the Home has no running turn) — the discovery entry point
    // (2.5.C S3c). The Home palette shows the home-applicable commands; selecting runs over the Home context.
    if (shouldOpenPalette(input, key, false, state.input.text.length)) {
      set({ palette: INITIAL_PALETTE_STATE, notice: undefined }); // running another command clears a stale report
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

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    handleKey(input, key) {
      // Bracketed paste (DECSET 2004): the markers bound a literal block, so a pasted multi-line YAML appends
      // verbatim (newlines kept) instead of an embedded newline submitting early. The markers themselves never
      // reach the buffer; content between them is appended literally with no key interpretation.
      if (isPasteStart(input)) {
        pasting = true;
        return;
      }
      if (isPasteEnd(input)) {
        pasting = false;
        return;
      }
      if (pasting) {
        // Escape hatch: Ctrl-C ALWAYS breaks out (a lost paste-end marker must never trap the user with no way
        // to exit/submit) — clear the latch and fall through to the normal dispatch (Home → exit, chat → /cancel).
        if (!(key.ctrl === true && input === 'c')) {
          // Literal content (newlines kept) ONLY when the buffer is editable — drop it while a session builds
          // (`loading`), a chat turn streams (`chatRunning`), or the `/` palette is open, exactly as the keystroke
          // gate does, so paste never diverges from typing (type-ahead is deferred, 2.5.B). CRLF/bare-CR are
          // normalized to LF (matching the reduceEditorMotion append), so a pasted line break is a real newline in
          // the buffer + sent to the model, never a stray '\r' the display strips but the transcript keeps.
          // `state.search === undefined` / `state.mention === undefined`: while the Ctrl+R reverse-search or the `@`
          // completion submode owns the keyboard, a paste is dropped (like the palette) — it must not leak into the
          // hidden input buffer behind the overlay.
          const editable =
            state.mode !== 'loading' &&
            !chatRunning() &&
            !state.shellBusy && // a paste while a `!`-command runs must not leak into the buffer (input is gated)
            state.palette === undefined &&
            state.search === undefined &&
            state.mention === undefined;
          const pasted = input.replace(/\r\n?/g, '\n');
          if (pasted.length > 0 && editable) {
            // Match the typed-edit path: appending clears any stale `/doctor` report + invalidates an in-flight run.
            doctorRunId += 1;
            set({ input: insertAtCursor(state.input, pasted), notice: undefined });
          }
          return;
        }
        pasting = false;
      }
      // The `/` palette (when open) owns every key — before the mode dispatch, so it overlays Home/chat input.
      if (state.palette !== undefined) {
        handlePaletteKey(input, key);
        return;
      }
      if (state.mode === 'chat' && state.session !== undefined) {
        handleChatKey(state.session, input, key);
        return;
      }
      handleHomeKey(input, key);
    },
    async teardownActive() {
      exiting = true; // terminating: a deferred endChat skips the (about-to-close) db; an in-flight build reclaims itself
      const active = state.session;
      if (active !== undefined) {
        if (tearingDown === active) {
          // A teardown is ALREADY in flight (an endChat / error-arm) — await THAT graceful close rather than
          // returning early, so the bounded signal race waits for the MCP handshake instead of hard-killing it.
          // `.catch` so a rejecting teardown can't make this (signal-path) call reject.
          await (activeTeardown ?? Promise.resolve()).catch(() => undefined);
        } else {
          tearingDown = active;
          const td = active.teardown();
          activeTeardown = td;
          await td.catch(() => undefined);
        }
        return;
      }
      // No live session yet — a signal during the `loading` build window. Await + reap the in-flight build so its
      // spawned MCP child / frame loop is never orphaned (bounded by driveHome's force-teardown race). submit's
      // exiting-arm may also reap it once it resolves; both call the SAME idempotent teardown, so the overlap is
      // harmless — awaiting here guarantees the reap completes within the bound.
      const pending = buildInFlight;
      if (pending !== undefined) {
        const built = await pending.catch(() => undefined);
        if (built !== undefined) await built.teardown().catch(() => undefined);
      }
    },
  };
}
