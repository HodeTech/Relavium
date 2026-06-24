import { render } from 'ink';
import { createElement } from 'react';

import type { RunRenderer } from '../renderer.js';
import { RunApp } from './RunApp.js';
import { createRunStore, type RunStore } from './run-store.js';

/**
 * The `ink` streaming-TUI renderer (workstream **2.E**) — the third {@link RunRenderer} over the one event
 * bus (alongside the `--json` and plain renderers), so the surfaces never fork
 * ([ADR-0047](../../../../../docs/decisions/0047-cli-framework-commander-ink-clack.md)). It is a thin mount
 * wrapper: the throttle / reduction / summary logic lives in the ink-free {@link createRunStore} (unit-tested
 * without React); here we only run the frame loop and own the `ink` lifecycle.
 *
 * This module is the ONLY place `ink`/React are imported on the run path, and `createInkRenderer` is built
 * solely in the `tui` output mode (a real TTY — never `--json`/CI/no-TTY, per `detectOutputMode`), so unit
 * tests, which run without a TTY, never mount it via the production path.
 */

/** The frame cadence — ~12.5 fps: smooth spinner + token flow without flooding React on a fast stream. */
export const FRAME_MS = 80;

/** The subset of `ink`'s render instance this renderer drives — also the shape a test's `mount` returns. */
export interface InkMountInstance {
  unmount: () => void;
  // ink's `waitUntilExit()` resolves `Promise<unknown>`; we only await it, never read the value.
  waitUntilExit: () => Promise<unknown>;
}

export interface InkRendererOptions {
  /** Whether to render with color (`false` under `--no-color`). */
  readonly color: boolean;
  /** The TTY stream `ink` renders to — defaults to `process.stdout` (a real terminal in the `tui` path). */
  readonly stdout?: NodeJS.WriteStream;
  /** Where the persistent final summary is written after unmount — defaults to `stdout`. Injectable for tests. */
  readonly writeSummary?: (text: string) => void;
  /** Mounts the `ink` app — defaults to `ink`'s `render`. Injectable so finalize is tested without a real mount. */
  readonly mount?: (store: RunStore) => InkMountInstance;
}

/**
 * Build the `ink` TUI renderer. Returns a {@link RunRenderer} whose `finalize` unmounts the live view —
 * restoring the terminal — and writes the persistent summary; `run.ts` awaits it after the event loop.
 */
export function createInkRenderer(options: InkRendererOptions): RunRenderer {
  const stdout = options.stdout ?? process.stdout;
  const store = createRunStore(options.color);

  const mount =
    options.mount ??
    ((s: RunStore): InkMountInstance =>
      render(createElement(RunApp, { store: s }), {
        stdout,
        // OUR SIGINT handler (run.ts) drives the cooperative cancel — not ink's process.exit. RunApp uses no
        // `useInput`/`useFocus`, so ink stays in COOKED mode (never raw): the kernel keeps translating Ctrl-C
        // → SIGINT, which reaches run.ts. (If a future RunApp adds input, re-verify cancel on a real TTY.)
        exitOnCtrlC: false,
        patchConsole: false, // don't intercept other stdout/console writes
        // Pin ink's internal render throttle to the store's frame cadence so the two can't drift.
        maxFps: Math.max(1, Math.round(1000 / FRAME_MS)),
      }));

  // The live view is a (frame loop + ink mount) pair that can be torn down and re-created: `start` after
  // construction and on `resume`, `stop` on `suspend` and `finalize`. The store outlives every cycle, so a
  // re-mount re-projects the exact same state (2.E: ink is a thin projection of an ink-free store).
  let frame: ReturnType<typeof setInterval> | undefined;
  let instance: InkMountInstance | undefined;

  const start = (): void => {
    // The frame loop drives the throttle (coalesced repaints) + the spinner animation. unref() so a pending
    // tick never holds the process open past the run's end.
    const f = setInterval(() => {
      store.tick();
    }, FRAME_MS);
    f.unref();
    try {
      instance = mount(store);
    } catch (err) {
      clearInterval(f); // mount threw — don't leak the frame loop (finalize won't run)
      throw err;
    }
    frame = f; // only after a successful mount, so a mount throw leaves no dangling timer
  };

  const stop = async (): Promise<void> => {
    if (frame !== undefined) {
      clearInterval(frame);
      frame = undefined;
    }
    if (instance !== undefined) {
      const live = instance;
      instance = undefined;
      live.unmount();
      await live.waitUntilExit();
    }
  };

  start(); // initial mount (a construction throw propagates, leaving no timer — see `start`)

  let finalized = false;

  return {
    onEvent: (event) => {
      store.apply(event);
    },
    suspend: async () => {
      // Release the terminal so a `@clack/prompts` gate card (2.G) can render. Paint the latest live frame
      // first, then unmount WITHOUT writing the summary (that is finalize's job — the run is not over).
      store.flush();
      await stop();
    },
    resume: () => {
      // Re-mount the live view from the SAME store after the gate prompt. A no-op once finalized (a late
      // resume after teardown must never re-open the TUI) or while already mounted (idempotent).
      if (!finalized && instance === undefined) {
        start();
      }
    },
    finalize: async () => {
      if (finalized) {
        return;
      }
      finalized = true;
      store.flush(); // paint the final live frame
      await stop();
      // The live frames are ephemeral; write the persistent plain-text summary into the scrollback.
      const write =
        options.writeSummary ??
        ((text: string): void => {
          stdout.write(text);
        });
      write(store.summaryText());
    },
  };
}
