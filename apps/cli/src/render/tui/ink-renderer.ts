import { render } from 'ink';
import { createElement } from 'react';

import type { RunRenderer } from '../renderer.js';
import { RunApp } from './RunApp.js';
import { createRunStore } from './run-store.js';

/**
 * The `ink` streaming-TUI renderer (workstream **2.E**) — the third {@link RunRenderer} over the one event
 * bus (alongside the `--json` and plain renderers), so the surfaces never fork
 * ([ADR-0047](../../../../../docs/decisions/0047-cli-framework-commander-ink-clack.md)). It is a thin mount
 * wrapper: the throttle / reduction / summary logic lives in the ink-free {@link createRunStore} (unit-tested
 * without React); here we only run the frame loop and own the `ink` lifecycle.
 *
 * This module is the ONLY place `ink`/React are imported on the run path, and `createInkRenderer` is built
 * solely in the `tui` output mode (a real TTY — never `--json`/CI/no-TTY, per `detectOutputMode`), so unit
 * tests, which run without a TTY, never mount it.
 */

/** The frame cadence — ~12.5 fps: smooth spinner + token flow without flooding React on a fast stream. */
export const FRAME_MS = 80;

export interface InkRendererOptions {
  /** Whether to render with color (`false` under `--no-color`). */
  readonly color: boolean;
  /** The TTY stream `ink` renders to — defaults to `process.stdout` (a real terminal in the `tui` path). */
  readonly stdout?: NodeJS.WriteStream;
  /** Where the persistent final summary is written after unmount — defaults to `stdout`. Injectable for tests. */
  readonly writeSummary?: (text: string) => void;
}

/**
 * Build the `ink` TUI renderer. Returns a {@link RunRenderer} whose `finalize` unmounts the live view —
 * restoring the terminal — and writes the persistent summary; `run.ts` awaits it after the event loop.
 */
export function createInkRenderer(options: InkRendererOptions): RunRenderer {
  const stdout = options.stdout ?? process.stdout;
  const store = createRunStore(options.color);

  // The frame loop drives the throttle (coalesced repaints) + the spinner animation. unref() so a pending
  // tick never holds the process open past the run's end.
  const frame = setInterval(() => {
    store.tick();
  }, FRAME_MS);
  frame.unref();

  const instance = render(createElement(RunApp, { store }), {
    stdout,
    exitOnCtrlC: false, // OUR SIGINT handler (run.ts) drives the cooperative cancel — not ink's process.exit
    patchConsole: false, // don't intercept other stdout/console writes
  });

  let finalized = false;

  return {
    onEvent: (event) => {
      store.apply(event);
    },
    finalize: async () => {
      if (finalized) {
        return;
      }
      finalized = true;
      clearInterval(frame);
      store.flush(); // paint the final live frame
      instance.unmount();
      await instance.waitUntilExit();
      // The live frames are ephemeral; write the persistent plain-text summary into the scrollback.
      const write = options.writeSummary ?? ((text: string): void => void stdout.write(text));
      write(store.summaryText());
    },
  };
}
