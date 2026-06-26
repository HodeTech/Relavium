import { Box, Static, Text, render, useInput } from 'ink';
import { createElement, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';

import { drivePlain, type ChatDriveContext, type ChatDriver } from '../../commands/chat.js';
import { EXIT_CODES } from '../../process/exit-codes.js';
import { colorProps } from './projection.js';
import { spinnerFrame } from './format.js';
import {
  formatSessionFooter,
  formatToolCall,
  formatTurnSummary,
  stripTerminalControls,
} from './chat-projection.js';
import type { ChatStoreController } from './chat-store.js';
import type { TranscriptEntry } from './session-view-model.js';

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

  useInput((char, key) => {
    // Ctrl-C reaches us (not the kernel) in raw mode — end the session via /cancel, even mid-turn. Dispatch it
    // at most once: cancelOnce() is already idempotent, but a held Ctrl-C would otherwise fire redundant /cancel
    // turns in quick succession.
    if (key.ctrl && char === 'c') {
      if (!cancelFired.current) {
        cancelFired.current = true;
        submit('/cancel');
      }
      return;
    }
    if (running) return; // one turn at a time — ignore typing while the assistant streams
    if (key.return) {
      const line = input;
      setInput('');
      submit(line);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (char.length > 0 && !key.ctrl && !key.meta) {
      setInput((current) => current + char);
    }
  });

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
          surfacing — mirrors RunApp). Integer-only today, but sanitized for belt-and-suspenders defence. */}
      {state.warnings.length > 0 && (
        <Box flexDirection="column">
          {state.warnings.map((w) => (
            <Text key={w} {...colorProps(color, 'yellow')} wrap="truncate-end">
              ⚠ {stripTerminalControls(w)}
            </Text>
          ))}
        </Box>
      )}
      <Text {...colorProps(color, 'gray')}>{formatSessionFooter(state)}</Text>
    </Box>
  );
}

/** The TTY ink driver: mount {@link ChatApp}, run the frame loop, and finalize on exit. */
export function driveInk(ctx: ChatDriveContext): Promise<void> {
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
  let cancelRequested = false;
  const onSigint = (): void => {
    if (cancelRequested) {
      process.exit(EXIT_CODES.chatEnded);
    }
    cancelRequested = true;
    void ctx.processLine('/cancel').then(() => resolveExit(), rejectExit);
  };
  process.on('SIGINT', onSigint);

  try {
    const instance = render(
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
        // The persistent final summary — only on a CLEAN exit; an error reject skips it and propagates (exit 1).
        ctx.io.writeOut(`${ctx.store.summaryText()}\n`);
      })
      .finally(() => {
        clearInterval(frame);
        unsubscribe();
        instance.unmount();
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

/** Select the chat driver by surface: a real TTY (and not `--json`, which is 2.Q) ⇒ ink; else the plain loop. */
export const selectChatDriver: ChatDriver = (ctx) =>
  ctx.io.stdoutIsTty && !ctx.global.json ? driveInk(ctx) : drivePlain(ctx);
