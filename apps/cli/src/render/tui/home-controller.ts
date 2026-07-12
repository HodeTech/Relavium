import type { UserCommandOutcome } from '@relavium/core';
import type { ModelCatalogEntry } from '@relavium/llm';
import type { ReasoningEffort } from '@relavium/shared';

import {
  CHAT_PALETTE_COMMANDS,
  HOME_PALETTE_COMMANDS,
  type ReplCommandContext,
} from '../../commands/repl-commands.js';
import type { RefreshReport } from '../../engine/model-refresh.js';
import {
  canControlEffort,
  foldEffortPickerKey,
  initialEffortPickerState,
  type EffortPickerState,
} from './effort-picker.js';
import { foldModelPickerKey, partialFailureBanner, type ModelPickerState } from './model-picker.js';
import type { ReseatTarget } from '../../commands/chat.js';
import { nextMode, type ChatMode } from '../../chat/chat-mode.js';
import { clearedNotice, modelSwitchNotice } from '../../chat/repl-info.js';
import { formatDoctorReport, runDoctorChecks, type DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import {
  applyEditorAction,
  editorFromText,
  emptyEditor,
  insertAtCursor,
  pasteIsEditable,
  reduceChatKey,
  reduceEditorMotion,
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
import { sanitizeApprovalReason } from './chat-projection.js';
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
  shellDenyHint,
  tokenizeCommand,
  type ShellCommand,
} from './shell.js';
import { reduceHomeKey, type HomeKey } from './home-input.js';
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
  /** The open `/models` picker (2.5.G S7, ADR-0064 §10) — `undefined` ⇒ closed. HOME-ONLY (a next-session config
   *  action); a keyboard-owning overlay like the palette. Opened from the Home palette's `/models`; on selection it
   *  writes the next session's default (ADR-0063), never rebinding the live session. Mutually exclusive with the palette. */
  readonly modelPicker: ModelPickerState | undefined;
  /** The open standalone `/effort` overlay (ADR-0066 §6) — `undefined` ⇒ closed. CHAT-scoped (a live in-Home chat
   *  with the effort setter wired + a reasoning-capable model); a keyboard-owning overlay like the mention/search
   *  submodes. On accept it pushes the per-turn session override via `active.onSetEffort` (no reseat). */
  readonly effortPicker: EffortPickerState | undefined;
  /** The in-flight `[c]` typed-reason capture (Step 14) — `undefined` ⇒ closed. CHAT-scoped; opened FROM a pending
   *  approval to record WHY the user denies. A keyboard-owning submode; on submit it rejects with the reason. */
  readonly reasonDraft: EditorState | undefined;
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
  /** Unbounded, user-initiated refresh (Ctrl+R) — every connected provider, per-provider-isolated. Never rejects. */
  refresh: () => Promise<RefreshReport>;
  /** The current `[preferences].default_model` (the picker's `✓` marker), or `undefined` when none is set. */
  currentDefault: () => string | undefined;
  /** The current resolved default reasoning-effort tier (ADR-0066 §6) — the `✓`/opening highlight of the bare-Home
   *  effort sub-step; `undefined` ⇒ none set (the sub-list opens on a neutral middle tier). */
  currentEffort: () => ReasoningEffort | undefined;
  /** Persist the chosen model as the next session's default, and (ADR-0066 §6) — when the effort sub-step ran for a
   *  reasoning model — its effort tier too, in ONE atomic write (writeGlobalPreferences). An absent `reasoningEffort`
   *  leaves any prior effort default unchanged. Throws `ConfigError` on a bad write. */
  writeDefault: (modelId: string, reasoningEffort?: ReasoningEffort) => void;
}

export interface HomeControllerDeps {
  /** Build + wire + START a fresh chat session (no first message — the controller sends it on transition). May reject. */
  readonly startChat: () => Promise<HomeChatSession>;
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
  /** The `/models` catalog port (2.5.G S7, ADR-0064) — absent ⇒ `/models` degrades to an honest "unavailable"
   *  notice (a test may omit it). Production (`driveHome`) always wires the real db-backed port. */
  readonly models?: HomeModelsPort;
}

export interface HomeController {
  // Declared as function PROPERTIES (not methods) so a `useSyncExternalStore(c.subscribe, c.getSnapshot)`
  // unbound reference is sound (no `this`) — matching the chat store's read surface.
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => HomeControllerState;
  /** Dispatch one `useInput` event (the single raw-mode owner forwards every key here). */
  readonly handleKey: (input: string, key: HomeKey & ChatKey & PaletteKey) => void;
  /** Handle a bracketed paste as ONE native event (ink 7 `usePaste`, a channel separate from `useInput`):
   *  insert it into the prompt buffer, or drop it while a keyboard-owning overlay/submode, a pending approval,
   *  or a mid-turn/build/`!`-shell/submit state is active. Paste never reaches the key reducers. */
  readonly handlePaste: (text: string) => void;
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
    submitBusy: false,
    shellCommand: undefined,
    attachments: [],
    historyEntries: [],
    notice: undefined,
    modelPicker: undefined,
    effortPicker: undefined,
    reasonDraft: undefined,
  };
  // Per-session command history for the in-Home chat (2.5.D step 3) — accumulates submitted lines across the Home
  // process; Up/Down recall, Ctrl+R reverse-searches. Not persisted (a chat-resume starts fresh).
  let history: InputHistory = EMPTY_HISTORY;
  let cancelFired = false;
  let exiting = false; // set on the clean-exit / error / signal paths — guards deferred reads of a closed db
  let tearingDown: HomeChatSession | undefined;
  let activeTeardown: Promise<void> | undefined; // the in-flight teardown of `tearingDown`, so a signal can await it
  let buildInFlight: Promise<HomeChatSession> | undefined; // a `loading`-state build, so a signal can reap it
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
    for (const listener of listeners) listener();
  };
  /** Whether a chat turn is streaming — paste content (like every other key) is gated mid-turn. */
  const chatRunning = (): boolean =>
    state.mode === 'chat' && state.session?.store.getSnapshot().state.status === 'running';
  /** Whether a native bracketed paste (ink 7 `usePaste`) may append to the prompt buffer — only when the main
   *  Home/chat prompt is the active editable target: no build/turn/`!`-shell/submit in flight, no keyboard-owning
   *  overlay/submode (palette, reverse-search, `@`-mention, `/models`, `/effort`, the `[c]` reason capture), and
   *  NO pending approval (a paste must never reach the fail-closed approval floor — ADR-0057). */
  const pasteEditable = (): boolean =>
    state.mode !== 'loading' && // the build window is Home-only; every other gate is the SHARED paste predicate
    pasteIsEditable({
      running: chatRunning(),
      shellBusy: state.shellBusy,
      submitBusy: state.submitBusy,
      paletteOpen: state.palette !== undefined,
      searchOpen: state.search !== undefined,
      mentionOpen: state.mention !== undefined,
      modelPickerOpen: state.modelPicker !== undefined,
      effortPickerOpen: state.effortPicker !== undefined,
      reasonCaptureOpen: state.reasonDraft !== undefined,
      approvalPending: state.session?.store.getSnapshot().approval !== undefined,
    });
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
          effortPicker: undefined, // ditto the `/effort` overlay (chat-scoped — closed on return to the bare Home)
          reasonDraft: undefined,
          modelPicker: undefined, // ditto the `/models` picker (Home-only, so never open here — reset for hygiene)
          shellBusy: false, // a `!`-command in flight when the chat ended must not leave the returned Home gated
          submitBusy: false, // ditto a submit/compaction in flight — the returned Home must not be left gated
          shellCommand: undefined,
          attachments: [], // pending `@`/`!` attachments must not leak into the next chat
        });
      })
      .catch(() => undefined); // a rejecting teardown (or read) must not surface as an unhandled rejection
  };

  // `/clear` (ADR-0062 §7) — swap the current in-Home chat for a FRESH session, STAYING in chat (the defining
  // difference from endChat, which returns to the bare Home). BUILD-FIRST: the old session stays live + rendered
  // while the fresh one builds, so a build failure leaves the user in a working, resumable conversation rather than
  // a dead screen. Input is re-gated (submitBusy) for the whole swap so a message typed mid-swap can't land on the
  // about-to-be-cleared session. On success the old session is torn down (bounded, mirroring endChat) and the fresh
  // one is swapped in, its transcript opening with the clearedNotice naming the prior (resumable) conversation.
  const clearChat = (old: HomeChatSession): void => {
    if (tearingDown === old) return; // already ending this session (a double-/clear race) — mirror endChat
    const oldId = old.sessionId;
    set({ submitBusy: true }); // re-gate input for the whole swap (the old chat is still live underneath)
    const build = deps.startChat();
    buildInFlight = build;
    void build.then(
      (fresh) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) {
          void fresh.teardown().catch(() => undefined); // exited mid-build ⇒ reap the just-built fresh session
          return;
        }
        // Guard a SUPERSEDING /clear: a mid-build Ctrl-C→/cancel re-routes to a SECOND clearChat(old) (the old
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
          errorText: undefined,
          notice: undefined,
          pendingMessage: '',
          palette: undefined,
          search: undefined,
          mention: undefined,
          modelPicker: undefined,
          effortPicker: undefined,
          reasonDraft: undefined,
          shellBusy: false,
          submitBusy: false, // the swap is done — un-gate the fresh chat
          shellCommand: undefined,
          attachments: [], // pending `@`/`!` attachments must not leak into the fresh conversation
        });
      },
      () => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) return;
        // The fresh build FAILED — keep the OLD session live + resumable (do NOT tear it down); surface a static,
        // secret-free note in the old chat and un-gate it so the user can keep going or /exit.
        if (state.session === old) {
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
          errorText: undefined,
          notice: undefined,
          pendingMessage: '',
          palette: undefined,
          search: undefined,
          mention: undefined,
          modelPicker: undefined,
          effortPicker: undefined,
          reasonDraft: undefined,
          shellBusy: false,
          submitBusy: false, // the swap is done — un-gate the reseated chat
          shellCommand: undefined,
          attachments: [], // pending `@`/`!` attachments must not leak into the reseated conversation
        });
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
    set({ submitBusy: true });
    void active.processLine(line, display).then(
      () => {
        if (state.session === active) set({ submitBusy: false });
        if (active.shouldStop()) {
          // `/clear` (ADR-0062 §7) swaps in a FRESH session, staying in chat; `/exit`/`/cancel` end to the bare Home.
          if (active.stopReason() === 'clear') clearChat(active);
          else endChat(active);
        }
      },
      (err: unknown) => {
        if (state.session === active) set({ submitBusy: false });
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
      modelPicker: undefined,
      effortPicker: undefined,
      reasonDraft: undefined,
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
        set({
          errorText: err instanceof Error ? err.message : String(err),
          pendingMessage: '',
          mode: 'home', // route a build failure back to Home with the banner
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
    if (epoch !== pickerEpoch || open === undefined || deps.models === undefined) return; // stale/closed — drop it
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
    const epoch = pickerEpoch; // capture THIS picker generation so a reopened picker never adopts this result
    const open = state.modelPicker;
    if (open === undefined) return;
    set({ modelPicker: { ...open, loading: true } });
    void refresh().then(
      (report) => applyRefreshResult(epoch, report),
      () => {
        // refresh()/refreshIfStale() never reject (per-provider isolation), but stay defensive: drop the spinner
        // only when this is still the same open picker generation.
        const cur = state.modelPicker;
        if (epoch === pickerEpoch && cur !== undefined)
          set({ modelPicker: { ...cur, loading: false } });
      },
    );
  };
  const openModelPicker = (): void => {
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
    if (effortStep) {
      currentEffort =
        active !== undefined ? active.store.getSnapshot().reasoningEffort : port.currentEffort();
    }
    set({
      notice: undefined, // opening the picker clears any stale /doctor report behind it
      modelPicker: {
        entries: view.entries,
        filter: '',
        selected: 0,
        loading: false,
        currentDefault: activeModel ?? port.currentDefault(),
        refreshedAt: view.refreshedAt,
        banner: undefined,
        hint: undefined,
        phase: 'model',
        effortStep,
        pending: undefined,
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
    const effort = reasoningEffort === undefined ? '' : ` at effort ${reasoningEffort}`;
    if (effective === modelId)
      return `Default model set to ${displayName}${effort} — applies to your next chat session.`;
    if (effective === undefined) {
      return `Saved ${displayName}${effort} as your global default, but your config could not be re-read to confirm it.`;
    }
    return `Saved ${displayName}${effort} as your global default, but a project or workspace setting overrides it here.`;
  };

  // The BARE-Home next-session-default write (ADR-0063 · ADR-0066 §6). Persists the GLOBAL `[preferences].default_model`
  // and — when the effort sub-step ran for a reasoning model — `[preferences].reasoning_effort` too, in ONE atomic
  // write; a write fault keeps the picker open with a secret-free hint rather than crashing.
  const writeNextSessionDefault = (
    modelId: string,
    displayName: string,
    reasoningEffort?: ReasoningEffort,
  ): void => {
    const port = deps.models;
    if (port === undefined) return;
    try {
      port.writeDefault(modelId, reasoningEffort);
    } catch {
      // A generic save-failure hint — the actual write target may be a `--config` override, not the canonical
      // `~/.relavium/config.toml`, so don't name a path the user may not be using.
      const open = state.modelPicker;
      if (open !== undefined) {
        set({
          modelPicker: {
            ...open,
            hint: 'could not save the default model — check your config file.',
          },
        });
      }
      return;
    }
    set({
      modelPicker: undefined,
      notice: defaultWriteNotice(port.currentDefault(), modelId, displayName, reasoningEffort),
    });
  };

  // EFFORT-phase accept on the live session (ADR-0066 §5): a per-turn SESSION override via the setter — NOT a reseat
  // (no teardown/approval-wipe/MCP-reconnect/context-loss). Close + note (the effort sub-list renders no hint, so a
  // no-op must give visible store feedback).
  const applyEffortOnlyUpdate = (
    active: HomeChatSession,
    displayName: string,
    reasoningEffort: ReasoningEffort,
  ): void => {
    if (reasoningEffort !== active.store.getSnapshot().reasoningEffort) {
      active.onSetEffort?.(reasoningEffort);
      active.store.note(
        `Reasoning effort set to ${reasoningEffort} — applies to your next message.`,
      );
    } else {
      active.store.note(`Already on ${displayName} at effort ${reasoningEffort}.`);
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
    writeNextSessionDefault(modelId, displayName, reasoningEffort);
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
        const hint =
          step.reason === 'no-key'
            ? // `set-key` alone auto-registers a known provider (no prior `add` needed) — the single-command form
              // every other "no key" message uses.
              `${step.displayName}: no key for ${step.provider} — run \`relavium provider set-key ${step.provider}\``
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
    }
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
      case 'accept':
        set({ effortPicker: undefined });
        if (step.effort === open.current) {
          active.store.note(`Already at reasoning effort ${step.effort}.`);
        } else {
          active.onSetEffort?.(step.effort);
          active.store.note(
            `Reasoning effort set to ${step.effort} — applies to your next message.`,
          );
        }
        break;
      case 'state':
        set({ effortPicker: step.state });
        break;
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
    exit: () => exitHome(),
    cancel: () => undefined,
    exportSession: () => undefined,
    help: () => undefined,
    showWorkflows: () => undefined,
    // `/cost` is chat-only in the BARE Home: there is no live session to cost. (The in-Home CHAT reaches the real
    // implementation through `createChatLineHandler`, so it gets the ADR-0070 per-model breakdown like the standalone
    // chat does.) Now that the breakdown reads the DB rather than an in-memory counter, costing a PAST session needs
    // only a sessionId — which is what 2.6.G's session browser will supply.
    showCost: () => undefined,
    setMode: () => undefined, // `/mode` is chat-only (not in HOME_PALETTE_COMMANDS); inert in the Home surface
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
        } else if (step.command.name === 'models' && deps.reseatChat !== undefined) {
          // chat: `/models` opens the reseat picker (ADR-0059) — parity with the typed-`/models` intercept, so the
          // palette route + the typed route behave identically (never the "interactive terminal" dispatch hint).
          openModelPicker();
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
      if (open === undefined) return; // no submode open (narrows `open` for the spread below)
      // Drop a stale resolve: a since-descended submode, or (after /exit → new chat) a different session / mode.
      if (open.dir !== dir || state.session !== active || state.mode !== 'chat') return;
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
    if (state.session !== active || state.mode !== 'chat' || submitEpoch !== epoch) return;
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

  // Submit `line`: a leading `!command` runs the shell escape (attachments stay pending — they ride the NEXT
  // message); a `/slash` passes through unchanged (attachments stay); otherwise it is a MESSAGE — expand the pending
  // attachments (files whose `@marker` is present + all carried commands) into the outbound frame, show the compact
  // form in the transcript, and clear exactly the consumed attachments.
  const applySubmitAction = (active: HomeChatSession, line: string): void => {
    submitEpoch += 1; // the buffer is cleared → a pending mention read / shell run must not re-inject
    const trimmed = line.trim();
    const parsed =
      active.runShellCommand !== undefined && isShellLine(trimmed)
        ? tokenizeCommand(trimmed.slice(1))
        : undefined;
    if (parsed !== undefined) {
      history = recordHistory(history, line);
      set({ input: emptyEditor(), historyEntries: history.entries });
      runShell(active, parsed); // a `!command` → the shell escape (does NOT consume pending attachments)
      return;
    }
    // `/models` in a LIVE chat opens the reseat picker (ADR-0059) instead of dispatching — parity with the standalone
    // ChatApp's submit-intercept. Only when a reseat builder is wired (always, in production); else it falls through
    // to the normal slash dispatch (which surfaces the "interactive terminal" hint). `/models <arg>` is NOT
    // intercepted (exact match) — it dispatches and is rejected as an unknown argument, like the standalone chat.
    if (trimmed === '/models' && deps.reseatChat !== undefined) {
      history = recordHistory(history, line);
      set({ input: emptyEditor(), historyEntries: history.entries });
      openModelPicker();
      return;
    }
    // Bare `/effort` on a reasoning-capable model opens the interactive tier overlay (ADR-0066 §6) instead of the
    // informational notice — parity with the standalone ChatApp. A non-reasoning model falls through to the slash
    // dispatch (the ctx handler's "no controllable tier" notice). `/effort <tier>` (with an arg) is not intercepted.
    if (trimmed === '/effort' && canOpenEffortPicker(active)) {
      history = recordHistory(history, line);
      set({ input: emptyEditor(), historyEntries: history.entries });
      openEffortPicker(active);
      return;
    }
    if (trimmed.startsWith('/') || state.attachments.length === 0) {
      // a slash command, or a plain message with no attachments — the simple path
      history = recordHistory(history, line);
      set({ input: emptyEditor(), historyEntries: history.entries });
      sendChatLine(active, line);
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
      case 'reject-with-reason':
        // `[c]` — open the typed-reason capture (Step 14); the next keys fill it (handleChatKey routes them),
        // then submit rejects WITH the reason. The approval stays pending until then (parity with `relavium chat`).
        set({ reasonDraft: emptyEditor() });
        return;
      case 'none':
        return;
    }
  };

  // The `[c]` typed-reason capture (Step 14) owns the keyboard while open — returns `true` when it handled the key.
  // It ONLY opens from a pending approval; if that approval settled out-of-band, the capture is stale → drop it.
  // Esc CANCELS back to the [y]/[a]/[n] prompt (still pending — not an abort); plain Enter rejects WITH the
  // sanitized+bounded reason; every other key edits the buffer. Parity with the standalone ChatApp; the floor is
  // unchanged (this only enriches a reject — a governed dispatch still cannot proceed without an explicit decision).
  // Extracted (like routeMentionKey/routeSearchKey) so handleChatKey stays flat.
  const routeReasonKey = (active: HomeChatSession, input: string, key: ChatKey): boolean => {
    const openReason = state.reasonDraft;
    if (openReason === undefined) return false;
    if (active.store.getSnapshot().approval === undefined) {
      set({ reasonDraft: undefined }); // the approval vanished — discard the orphaned capture
    } else if (key.escape === true) {
      set({ reasonDraft: undefined }); // cancel the reason; the approval stays pending
    } else if (key.return === true && key.shift !== true) {
      const reason = sanitizeApprovalReason(openReason.text);
      set({ reasonDraft: undefined });
      active.store.answerApproval(
        reason === undefined ? { outcome: 'reject' } : { outcome: 'reject', reason },
      );
    } else {
      const edit = reduceEditorMotion(input, key);
      if (edit !== undefined) set({ reasonDraft: applyEditorAction(openReason, edit) });
    }
    return true; // while the capture is open it OWNS every key
  };

  const handleChatKey = (active: HomeChatSession, input: string, key: ChatKey): void => {
    if (tearingDown === active) return; // a key arriving mid-teardown must not drive sendMessage on a cancelled session
    if (routeReasonKey(active, input, key)) return; // the `[c]` typed-reason capture owns the keyboard while open
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

  // The open-overlay + mode key router — extracted from `handleKey` so its bracketed-paste handling stays within the
  // cognitive-complexity budget. Precedence (each open overlay owns EVERY key while open, and only one opens at a
  // time): the `/` palette → the `/models` picker → the `/effort` overlay → the live chat → else the bare Home.
  const dispatchKey = (input: string, key: HomeKey & ChatKey & PaletteKey): void => {
    // The `/` palette (when open) owns every key — before the mode dispatch, so it overlays Home/chat input.
    if (state.palette !== undefined) {
      handlePaletteKey(input, key);
      return;
    }
    // The `/models` picker (2.5.G S7) — opened from the bare-Home palette (next-session default, ADR-0063) OR a live
    // in-Home chat (a typed/palette `/models` → the reseat picker, ADR-0059), so it is routed before the mode branches.
    if (state.modelPicker !== undefined) {
      routeModelPickerKey(input, key);
      return;
    }
    // The `/effort` overlay (ADR-0066 §6) — chat-scoped, so it always has a live session; the guard keeps
    // `routeEffortPickerKey`'s `active` non-null (a stale overlay with no session falls through, never expected).
    if (state.effortPicker !== undefined && state.session !== undefined) {
      routeEffortPickerKey(state.session, input, key);
      return;
    }
    if (state.mode === 'chat' && state.session !== undefined) {
      handleChatKey(state.session, input, key);
      return;
    }
    handleHomeKey(input, key);
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
      // Bracketed paste is handled natively by ink 7's `usePaste` → `handlePaste` (a channel separate from
      // `useInput`), so a pasted multi-line block never arrives here char-by-char and a pasted approval token can
      // never reach the approval reducer. Every real keystroke is dispatched by the open-overlay + mode router.
      dispatchKey(input, key);
    },
    handlePaste(text) {
      // ink 7 delivers a whole bracketed paste as ONE native event; CRLF/CR → LF (matching a typed newline).
      // Dropped (not char-inserted) unless the main prompt is the active editable target — `pasteEditable` mirrors
      // the old bracketed-paste gate and additionally refuses a pending approval (the fail-closed floor, ADR-0057)
      // and the `[c]` reason capture. Type-ahead behind a busy/overlay state is deferred (2.5.B).
      const pasted = text.replace(/\r\n?/g, '\n');
      if (pasted.length === 0 || !pasteEditable()) return;
      doctorRunId += 1; // an append clears a stale `/doctor` report + invalidates an in-flight run, like a typed edit
      history = resetHistoryNav(history); // a paste is a real edit ⇒ end history nav (parity with append/backspace/kill)
      set({ input: insertAtCursor(state.input, pasted), notice: undefined });
    },
    async teardownActive() {
      exiting = true; // terminating: a deferred endChat/clearChat skips the (about-to-close) db; an in-flight build reclaims itself
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
    },
  };
}
