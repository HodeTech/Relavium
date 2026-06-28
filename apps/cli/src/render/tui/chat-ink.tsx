import { Box, Static, Text, render, useInput } from 'ink';
import { createElement, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';

import {
  driveJson,
  drivePlain,
  type ChatDriveContext,
  type ChatDriver,
} from '../../commands/chat.js';
import { EXIT_CODES } from '../../process/exit-codes.js';
import { colorProps } from './projection.js';
import { applyChatEdit, reduceChatKey } from './chat-input.js';
import { spinnerFrame } from './format.js';
import {
  formatSessionFooter,
  formatToolCall,
  formatTurnSummary,
  stripTerminalControls,
} from './chat-projection.js';
import type { ChatStoreController } from './chat-store.js';
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

const FRAME_MS = 80;
/** The bound on the best-effort MCP teardown a forced (double-SIGINT) quit waits for before hard-exiting. */
const FORCE_TEARDOWN_MS = 2000;

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
}

interface ChatViewProps {
  readonly state: SessionViewState;
  readonly tick: number;
  readonly color: boolean;
  /** The current prompt buffer (owned by the input owner — `ChatApp` or the Home's `RootApp`). */
  readonly input: string;
  readonly running: boolean;
}

/**
 * The PURE chat render — transcript / in-flight turn / prompt echo / warnings / footer — with no `useInput`,
 * no state, and no store subscription. Extracted from `ChatApp` so the 2.5.B Home can render the chat region
 * inside its OWN single-`useInput` tree (one raw-mode owner) without duplicating this JSX. The live input echo
 * and every model/transcript string are sanitized at this display boundary so a pasted/streamed control
 * sequence cannot corrupt the terminal or inject ANSI/OSC.
 */
export function ChatView(props: Readonly<ChatViewProps>): ReactElement {
  const { state, tick, color, input, running } = props;
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
          containing terminal control sequences cannot corrupt the display or inject ANSI/OSC escapes. */}
      {!running && (
        <Text {...colorProps(color, 'cyan')}>
          {'> '}
          {stripTerminalControls(input)}
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
      <Text {...colorProps(color, 'gray')}>{formatSessionFooter(state)}</Text>
    </Box>
  );
}

export function ChatApp(props: Readonly<ChatAppProps>): ReactElement {
  const { state, tick, color } = useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
  );
  const [input, setInput] = useState('');
  const cancelFired = useRef(false);
  const running = state.status === 'running';

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
    const action = reduceChatKey(char, key, input, running);
    switch (action.kind) {
      case 'cancel':
        if (!cancelFired.current) {
          cancelFired.current = true;
          submit('/cancel');
        }
        return;
      case 'append':
      case 'backspace':
        // Apply the EDIT through the functional updater so a coalesced multi-event stdin chunk composes onto the
        // latest buffer (ink dispatches the chunk's events synchronously with no render flush between them).
        setInput((current) => applyChatEdit(current, action));
        return;
      case 'submit':
        setInput('');
        submit(action.line);
        return;
      case 'none':
        return;
    }
  });

  return <ChatView state={state} tick={tick} color={color} input={input} running={running} />;
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
