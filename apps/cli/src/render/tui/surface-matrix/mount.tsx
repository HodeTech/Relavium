import { render, type Instance } from 'ink';
import type { ReactElement } from 'react';

import { settleFrames } from '../harness-util.js';
import { OwnedTtyInput } from '../../../test-support.js';
import { FakeStdout } from './terminal.js';
import type { Variant } from './variants.js';

/**
 * One mounted tree over the fake terminal, as `driveHome` and `driveInk` mount it: the real `ink` `render()` (interactive, not debug,
 * `alternateScreen` for the full-screen renderer), so what the matrix reads is what a terminal would show after Ink's erase-and-rewrite
 * cycle, and the bytes that went to it.
 */
export interface InkMount {
  readonly stdout: FakeStdout;
  readonly stdin: OwnedTtyInput;
  readonly variant: Variant;
  /** The screen as a terminal shows it now (styling absent), after the pending render has been flushed by the caller. */
  frame: () => string[];
  /** Every byte written to the terminal since the mount, styling included. */
  raw: () => string;
  /** Write bytes to the terminal's input, as a keyboard does. */
  key: (bytes: string) => void;
  /** Let the pending render land: Ink's own flush (throttle timers, passive effects), then the frames the viewport needs. */
  settle: () => Promise<void>;
  /**
   * Poll until `predicate` holds, flushing Ink's render between checks (never a fixed sleep); `true` when it did. It does not throw: the
   * caller's own check then reports the frame it found.
   */
  until: (predicate: () => boolean, maxFlushes?: number) => Promise<boolean>;
  /** Replace the tree, as a state change that reaches the root does. */
  rerender: (tree: ReactElement) => void;
  /** Change the terminal's size and tell Ink, as a resize does. */
  resize: (cols: number, rows: number) => void;
  unmount: () => void;
}

export interface MountOptions {
  /** A test-only hook on every chunk the terminal receives (the mutation tests break a property with it). */
  readonly tamper?: ((chunk: string) => string) | undefined;
}

/** The ceiling of a poll: Ink flushes in well under a millisecond here, so this is a bound on a defect, not a delay anything waits out. */
const MAX_FLUSHES = 400;

export function mountInk(
  tree: ReactElement,
  variant: Variant,
  options: MountOptions = {},
): InkMount {
  const stdout = new FakeStdout(variant.size.cols, variant.size.rows, options.tamper);
  const stdin = new OwnedTtyInput();
  const instance: Instance = render(tree, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    alternateScreen: variant.renderer === 'alt',
    // The cadence is not what the matrix measures; the smallest throttle keeps a poll from waiting on a timer.
    maxFps: 1000,
  });
  let unmounted = false;
  const flush = async (): Promise<void> => {
    if (!unmounted) await instance.waitUntilRenderFlush();
  };
  const until = async (predicate: () => boolean, maxFlushes = MAX_FLUSHES): Promise<boolean> => {
    for (let i = 0; i < maxFlushes; i += 1) {
      if (predicate()) return true;
      await flush();
    }
    return predicate();
  };
  return {
    stdout,
    stdin,
    variant,
    frame: () => stdout.screen.lines(),
    raw: () => stdout.raw(),
    key: (bytes) => {
      stdin.push(bytes);
    },
    settle: async () => {
      await flush();
      await settleFrames();
      await flush();
    },
    until,
    rerender: (next) => {
      instance.rerender(next);
    },
    resize: (cols, rows) => {
      stdout.resize(cols, rows);
    },
    unmount: () => {
      if (unmounted) return;
      unmounted = true;
      instance.unmount();
      instance.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}
