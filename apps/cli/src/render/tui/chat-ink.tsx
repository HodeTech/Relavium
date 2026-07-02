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
import { applyChatEdit, reduceChatKey } from './chat-input.js';
import { PaletteView } from './palette-view.js';
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
  /** Handle a submitted line (slash or message); resolves when the turn settles. */
  readonly onSubmit: (line: string) => Promise<void>;
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
}

interface ChatViewProps {
  readonly state: SessionViewState;
  readonly tick: number;
  readonly color: boolean;
  /** The current prompt buffer (owned by the input owner — `ChatApp` or the Home's `RootApp`). */
  readonly input: string;
  readonly running: boolean;
  /** The active chat mode (ADR-0057) — shown in the footer so `auto` is never a hidden state. */
  readonly mode: ChatMode;
  /** An in-flight per-tool approval — when set, the `[y]/[a]/[n]` prompt replaces the idle prompt. */
  readonly approval?: PendingApproval | undefined;
  /** When the `/` palette is open it owns the bottom of the view, so the idle prompt + footer are suppressed (2.5.C S3b). */
  readonly paletteOpen?: boolean;
}

/**
 * The PURE chat render — transcript / in-flight turn / prompt echo / warnings / footer — with no `useInput`,
 * no state, and no store subscription. Extracted from `ChatApp` so the 2.5.B Home can render the chat region
 * inside its OWN single-`useInput` tree (one raw-mode owner) without duplicating this JSX. The live input echo
 * and every model/transcript string are sanitized at this display boundary so a pasted/streamed control
 * sequence cannot corrupt the terminal or inject ANSI/OSC.
 */
export function ChatView(props: Readonly<ChatViewProps>): ReactElement {
  const { state, tick, color, input, running, mode, approval, paletteOpen } = props;
  // When the palette is open it renders its own query line + hint below, so suppress the idle prompt + footer to
  // avoid two competing prompts (the palette owns the input focus until it closes).
  const showIdlePrompt = !running && paletteOpen !== true;
  return (
    <Box flexDirection="column">
      {/* Completed transcript — ink Static prints each entry once, then it scrolls into terminal history. */}
      <Static items={[...state.transcript]}>
        {(entry, index) => <TranscriptLine key={index} entry={entry} color={color} />}
      </Static>

      {/* The in-flight turn: tool annotations + the streaming assistant text + a spinner. */}
      {running && (
        <Box flexDirection="column">
          {state.liveToolCalls.map((call) => (
            <Text key={call.id} {...colorProps(color, 'yellow')}>
              {formatToolCall(call)}
            </Text>
          ))}
          <Text>
            {spinnerFrame(tick)} {stripTerminalControls(state.liveTokens)}
          </Text>
        </Box>
      )}

      {/* The input prompt (idle) and the persistent footer. The live input echo is sanitized so a paste
          containing terminal control sequences cannot corrupt the display or inject ANSI/OSC escapes. A trailing
          inverse-space block cursor marks the prompt as a live field (shared with the Home's prompt). */}
      {showIdlePrompt && (
        <Text>
          <Text {...colorProps(color, 'cyan')}>
            {'> '}
            {sanitizeInline(input)}
          </Text>
          {color && <Text inverse> </Text>}
        </Text>
      )}
      {/* The context-aware idle hint bar (2.5.C S6). At an EMPTY prompt, surface the `/` palette as the command-
          discovery entry point (it lists /export, /doctor, /workflows, …) — `/` only opens it from an empty
          buffer, so the hint appears exactly when it works. Once the user is composing, swap to the submit hint.
          The palette renders its own nav hints when open, so keys stay discoverable without a separate command. */}
      {showIdlePrompt && (
        <Text {...dimProps(color)} wrap="truncate-end">
          {input.length === 0
            ? '/ for commands · /exit or Ctrl-C to end'
            : 'Enter to send · Ctrl-C to end'}
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
  const [input, setInput] = useState('');
  // A ref SHADOW of the buffer: in a coalesced stdin chunk ink dispatches every event synchronously with no
  // render flush, so the `input` closure stays stale across the burst. Reading `inputRef.current` gives the
  // latest COMMITTED value, so even a Return that arrives in the same chunk as a preceding char submits the full
  // buffer (not the stale render capture). `applyInput` wraps `setInput` to keep the ref in lockstep with state.
  const inputRef = useRef('');
  const applyInput = (next: (current: string) => string): void => {
    setInput((prev) => {
      const value = next(prev);
      inputRef.current = value;
      return value;
    });
  };
  const cancelFired = useRef(false);
  const running = state.status === 'running';
  // The interactive `/` palette (2.5.C S3b) — `undefined` ⇒ closed. React-local here (the external-store Home
  // keeps it in HomeControllerState); both surfaces drive the SAME foldPaletteKey + render the SAME PaletteView.
  // A ref SHADOW (like `inputRef`) keeps the latest value across a COALESCED stdin chunk — ink fires every event
  // in one chunk synchronously with no render flush, so reading the render-closure `palette` would be stale (a
  // close/select in event A would not be seen by a same-chunk event B, re-opening the palette). `applyPalette`
  // keeps the ref in lockstep with state; the input handler reads `paletteRef.current`, the render reads `palette`.
  const [palette, setPalette] = useState<PaletteState | undefined>(undefined);
  const paletteRef = useRef<PaletteState | undefined>(undefined);
  const applyPalette = (next: PaletteState | undefined): void => {
    paletteRef.current = next;
    setPalette(next);
  };

  const submit = (line: string): void => {
    // Two-arm: a settled turn checks for exit; an UNEXPECTED rejection (the turn core's loud re-throw) goes to
    // onError so the driver always unblocks + tears down (else `exited` never settles and the REPL hangs). The
    // trailing .catch is defensive: a throw inside either callback still routes to onError, never silently lost.
    void props
      .onSubmit(line)
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
    // settles sees the current status — matching the ref-shadow `inputRef`/`paletteRef` reads below.
    const isRunning = props.store.getSnapshot().state.status === 'running';
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
    if (!approvalPending && shouldOpenPalette(char, key, isRunning, inputRef.current.length)) {
      applyPalette(INITIAL_PALETTE_STATE);
      return;
    }
    const action = reduceChatKey(char, key, inputRef.current, isRunning, approvalPending);
    switch (action.kind) {
      case 'cancel':
        if (!cancelFired.current) {
          cancelFired.current = true;
          submit('/cancel');
        }
        return;
      case 'append':
      case 'backspace':
        applyInput((current) => applyChatEdit(current, action));
        return;
      case 'submit':
        applyInput(() => '');
        submit(action.line);
        return;
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
        input={input}
        running={running}
        mode={mode}
        approval={approval}
        paletteOpen={palette !== undefined}
      />
      {palette !== undefined && (
        <PaletteView commands={CHAT_PALETTE_COMMANDS} state={palette} color={color} />
      )}
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
