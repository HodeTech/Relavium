import { openInEditor, type EditorOutcome, type OpenInEditorDeps } from './editor.js';
import { dumpToScrollback, type DumpToScrollbackDeps } from './scrollback.js';
import { createSuspendPort, suspendFullScreen, type SuspendPort } from './suspend.js';
import { transcriptDocument, wrapTranscript } from './tui/chat-projection.js';
import type { TranscriptEntry } from './tui/session-view-model.js';

/**
 * The two ADR-0068 §e **copy-and-search escape hatches**, shared verbatim by both interactive surfaces (2.6.F Step 5d):
 *
 * - **`/scrollback`** — dump the transcript into the terminal's native scrollback, where every tool the user already
 *   has (scroll, search, click-drag select, copy) works on it.
 * - **`/edit`** — open the transcript in `$EDITOR`, read-only, for search and copy.
 *
 * They exist because the alternate screen structurally removes those affordances: it has no scrollback, and mouse
 * reporting captures the click-drag the emulator would use for selection.
 *
 * WHY THIS IS SHARED, and why neither surface intercepts them. `/models` and `/effort` must be intercepted at the
 * render layer on BOTH surfaces (four call sites) because they open a React overlay. These two open nothing — they
 * need a *function*, `suspendTerminal`, which the {@link SuspendPort} carries out of the ink tree. So they are plain
 * registry commands whose `run` calls a `ReplCommandContext` capability, dispatched through the one existing slash
 * path. The standalone chat and the in-Home chat therefore cannot drift.
 *
 * NEVER CRASH THE REPL: every fault (no live renderer, an empty transcript, a rejected suspension, a missing
 * `$EDITOR`, a dead editor) becomes a one-line transcript notice. The terminal is restored by `suspendFullScreen`
 * regardless — see `suspend.ts` for the exit-safety contract.
 */

/** The live terminal facts, read at CALL time — a resize, or a future `--no-mouse` toggle, must never be captured. */
export interface HatchTerminal {
  /** The current column count, for wrapping the scrollback dump to the terminal the user is looking at. */
  readonly columns: number;
  /** Whether the alt buffer is currently entered. */
  readonly altActive: boolean;
  /** Whether mouse reporting (DECSET 1000+1006) is currently on. */
  readonly mouseActive: boolean;
  /** `true` on the bare Home (ink's `alternateScreen` render option owns 1049); `false` on `relavium chat`. */
  readonly inkOwnsAltScreen: boolean;
}

export interface HatchDeps {
  /** The React→core bridge carrying ink's `suspendTerminal`. `undefined` ⇒ no live full-screen renderer. */
  readonly suspendPort: SuspendPort;
  /** The transcript at call time (the store's CURRENT snapshot — never a stale capture). */
  readonly transcript: () => readonly TranscriptEntry[];
  /** Surface a one-line result in the transcript (the store's sanitized notice channel). */
  readonly note: (text: string) => void;
  /** The live terminal facts, read at call time. */
  readonly terminal: () => HatchTerminal;
  /** Write a raw control sequence (the alt-buffer / mouse toggles). */
  readonly writeControl: (sequence: string) => void;
  /** The scrollback dump's I/O (production: `nodeWriteOut` + `nodeWaitForContinue`). */
  readonly dump: DumpToScrollbackDeps;
  /** The `$EDITOR` ports (production: `nodeSpawnEditor` + `nodeCreateTempDocument`). */
  readonly editor: OpenInEditorDeps;
}

/** The notice a hatch surfaces when no ink tree is mounted — a plain / `--json` driver has no terminal to suspend. */
export const NO_RENDERER_NOTICE = 'needs an interactive terminal.';
/** The assumed width when the terminal reports no column count (a detached / zero-sized TTY). The dump is printed to
 *  a real terminal, so a sane fallback beats refusing to print. */
export const DEFAULT_COLUMNS = 80;

/**
 * The terminal facts for **`relavium chat`**: ink mounts with `alternateScreen: false`, so the HOISTED
 * `AltScreenController` owns DECSET-1049 and the suspension must toggle it itself. Mouse reporting is enabled with
 * the buffer (alt-screen.ts bundles them), so both read the SAME live predicate — never the mode resolved at startup.
 */
export const hoistedTerminal =
  (altEntered: () => boolean, columns: () => number | undefined) => (): HatchTerminal => ({
    columns: columns() ?? DEFAULT_COLUMNS,
    altActive: altEntered(),
    mouseActive: altEntered(),
    inkOwnsAltScreen: false,
  });

/**
 * The terminal facts for the **bare Home**: ink mounts with `alternateScreen: true`, so ink's own begin/endSuspend
 * exit and re-enter DECSET-1049 — the suspension must NOT touch it. Only the mouse is ours.
 *
 * The two factories exist so `inkOwnsAltScreen` is chosen ONCE per surface, by a name that says which surface it is
 * for. Inverting it strands or garbles the terminal, and a bare boolean at a call site is exactly the kind of thing
 * a future edit gets backwards (Step-5d-3 Opus review).
 */
export const inkOwnedTerminal =
  (altActive: () => boolean, columns: () => number | undefined) => (): HatchTerminal => ({
    columns: columns() ?? DEFAULT_COLUMNS,
    altActive: altActive(),
    mouseActive: altActive(),
    inkOwnsAltScreen: true,
  });

/**
 * Ports for a caller with NO full-screen renderer (a plain / `--json` driver, or a unit test). The suspend port is
 * empty, so {@link createHatches} short-circuits on {@link NO_RENDERER_NOTICE} and never reaches the dump/editor
 * ports. They exist to satisfy the type — and this is why there is no second, drifting "unavailable" string anywhere.
 */
export function inertHatchPorts(): Omit<HatchDeps, 'transcript' | 'note'> {
  const unreachable = (): Promise<never> =>
    Promise.reject(new Error('no full-screen renderer is attached'));
  return {
    suspendPort: createSuspendPort(),
    writeControl: () => undefined,
    terminal: () => ({
      columns: DEFAULT_COLUMNS,
      altActive: false,
      mouseActive: false,
      inkOwnsAltScreen: false,
    }),
    dump: { writeOut: () => undefined, waitForContinue: () => Promise.resolve() },
    editor: { env: {}, spawnEditor: unreachable, createTempDocument: unreachable },
  };
}
/** The notice a hatch surfaces before a single turn has completed — nothing to dump or edit yet. */
export const EMPTY_TRANSCRIPT_NOTICE = 'the transcript is empty.';

/** Render an {@link EditorOutcome} as the one line the user sees. `closed` is silent: the user just came back from
 *  their editor and does not need to be told that they did. */
function editorNotice(outcome: EditorOutcome): string | undefined {
  switch (outcome.kind) {
    case 'closed':
      return undefined;
    case 'unavailable':
      return '/edit: set $EDITOR (or $VISUAL) to open the transcript in your editor.';
    case 'failed':
      return `/edit: ${outcome.message}`;
  }
}

export interface Hatches {
  readonly dumpScrollback: () => Promise<void>;
  readonly editTranscript: () => Promise<void>;
}

/**
 * Build the two hatches over a surface's ports. The `busy` latch makes ink's `beginSuspend()` "already suspended"
 * throw unreachable: input is paused for the whole suspension, so a second invocation should be impossible — but the
 * cost of being sure is one boolean, and the failure it prevents is a rejected promise mid-terminal-handover.
 */
export function createHatches(deps: HatchDeps): Hatches {
  let busy = false;

  /** Run `body` with the full-screen renderer suspended, funnelling every fault into a notice. */
  const withSuspension = async (label: string, body: () => Promise<void>): Promise<boolean> => {
    const suspend = deps.suspendPort.current();
    if (suspend === undefined) {
      deps.note(`${label}: ${NO_RENDERER_NOTICE}`);
      return false;
    }
    if (busy) return false; // a suspension is already in flight; ink would throw
    busy = true;
    const term = deps.terminal();
    try {
      await suspendFullScreen(
        {
          suspendTerminal: suspend,
          writeControl: deps.writeControl,
          inkOwnsAltScreen: term.inkOwnsAltScreen,
          altActive: term.altActive,
          mouseActive: term.mouseActive,
        },
        body,
      );
      return true;
    } catch (error) {
      // The terminal is already restored (suspend.ts's contract). Report the ROOT cause, never crash the REPL.
      deps.note(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      busy = false;
    }
  };

  return {
    dumpScrollback: async () => {
      const transcript = deps.transcript();
      if (transcript.length === 0) {
        deps.note(`/scrollback: ${EMPTY_TRANSCRIPT_NOTICE}`);
        return;
      }
      // Wrapped to the LIVE width, because it is printed to that terminal (unlike `/edit`, which the editor re-flows).
      const lines = wrapTranscript(transcript, deps.terminal().columns).map((line) => line.text);
      await withSuspension('/scrollback', () => dumpToScrollback(deps.dump, lines));
    },

    editTranscript: async () => {
      const transcript = deps.transcript();
      if (transcript.length === 0) {
        deps.note(`/edit: ${EMPTY_TRANSCRIPT_NOTICE}`);
        return;
      }
      const contents = transcriptDocument(transcript);
      let outcome: EditorOutcome | undefined;
      // The outcome is noted AFTER the suspension: ink's frame is erased and its render loop paused for the whole
      // window, so a notice pushed mid-suspension would never be painted (and the editor owns the screen anyway).
      const ran = await withSuspension('/edit', async () => {
        outcome = await openInEditor(deps.editor, contents);
      });
      if (!ran || outcome === undefined) return;
      const notice = editorNotice(outcome);
      if (notice !== undefined) deps.note(notice);
    },
  };
}
