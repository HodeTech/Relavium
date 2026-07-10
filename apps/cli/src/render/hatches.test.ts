import { describe, expect, it } from 'vitest';

import { DISABLE_MOUSE, ENABLE_MOUSE, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from './alt-screen.js';
import {
  EMPTY_TRANSCRIPT_NOTICE,
  createHatches,
  DEFAULT_COLUMNS,
  hoistedTerminal,
  inertHatchPorts,
  inkOwnedTerminal,
  type HatchDeps,
} from './hatches.js';
import { createSuspendPort, type SuspendTerminal } from './suspend.js';
import type { TranscriptEntry } from './tui/session-view-model.js';

/**
 * The `/scrollback` + `/edit` hatches (2.6.F Step 5d, ADR-0068 §e). These pin what the USER experiences: the terminal
 * is always given back, no fault ever crashes the REPL, the transcript is dumped at the live width but handed to
 * `$EDITOR` unwrapped, and a driver with no full-screen renderer says so instead of failing.
 */

const userEntry = (text: string): TranscriptEntry => ({ role: 'user', text });

/** A real (recording) `suspendTerminal`, so the terminal-mode writes are asserted through the real primitive. */
const inkSuspend =
  (trace: string[]): SuspendTerminal =>
  async (callback) => {
    trace.push('ink:begin');
    try {
      await callback();
    } finally {
      trace.push('ink:end');
    }
  };

const harness = (
  over: Partial<HatchDeps> & {
    transcriptEntries?: readonly TranscriptEntry[];
    noSuspend?: boolean;
    columns?: number;
  } = {},
): {
  deps: HatchDeps;
  trace: string[];
  notes: string[];
  edited: string[];
  copied: string[];
} => {
  const trace: string[] = [];
  const notes: string[] = [];
  const edited: string[] = [];
  const copied: string[] = [];
  const port = createSuspendPort();
  if (over.noSuspend !== true) port.attach(inkSuspend(trace));

  const deps: HatchDeps = {
    suspendPort: port,
    clipboard: (text) => {
      copied.push(text);
      trace.push('clipboard');
      return { kind: 'written', characters: text.length };
    },
    transcript: () => over.transcriptEntries ?? [userEntry('hello')],
    // Notes go into the SAME trace as the terminal writes: their ORDER relative to `ink:begin`/`ink:end` is the
    // property under test (a notice pushed mid-suspension is never painted — ink's frame is erased there).
    note: (text) => {
      notes.push(text);
      trace.push(`NOTE:${text}`);
    },
    terminal: () => ({
      columns: over.columns ?? 80,
      altActive: true,
      mouseActive: true,
      inkOwnsAltScreen: false, // the `relavium chat` shape
    }),
    writeControl: (sequence) => trace.push(sequence),
    dump: {
      writeOut: (text) => trace.push(`OUT:${text.split('\n').length}L`),
      waitForContinue: () => {
        trace.push('wait');
        return Promise.resolve();
      },
    },
    editor: {
      env: { EDITOR: 'vim' },
      createTempDocument: (contents) => {
        edited.push(contents);
        return Promise.resolve({ path: '/tmp/t.md', dispose: () => Promise.resolve() });
      },
      spawnEditor: () => {
        trace.push('editor');
        return Promise.resolve({ code: 0, signal: null });
      },
    },
    ...over,
  };
  return { deps, trace, notes, edited, copied };
};

describe('/scrollback', () => {
  it('suspends the renderer, dumps, waits, and restores every terminal mode — in order', async () => {
    const { deps, trace, notes } = harness();
    await createHatches(deps).dumpScrollback();
    expect(trace).toEqual([
      'ink:begin',
      DISABLE_MOUSE, // native selection back, and no mouse reports into the dump
      expect.stringContaining(EXIT_ALT_SCREEN), // the chat surface owns 1049
      'OUT:5L',
      'wait', // the dump is useless if the frame repaints before the user looks
      expect.stringContaining(ENTER_ALT_SCREEN),
      ENABLE_MOUSE,
      'ink:end',
    ]);
    expect(notes).toEqual([]); // a clean run says nothing
  });

  it('wraps to the LIVE terminal width (it is printed to THAT terminal)', async () => {
    const { deps, trace } = harness({
      transcriptEntries: [userEntry('x'.repeat(50))],
      columns: 20,
    });
    await createHatches(deps).dumpScrollback();
    // 52 chars (`> ` + 50) char-wrap to 3 rows at width 20. The single write is header + 3 rows + footer + prompt,
    // each newline-terminated ⇒ `split('\n')` yields 7 (the trailing newline leaves an empty last element).
    expect(trace).toContain('OUT:7L');
  });

  it('an EMPTY transcript notices instead of flipping the screen for nothing', async () => {
    const { deps, trace, notes } = harness({ transcriptEntries: [] });
    await createHatches(deps).dumpScrollback();
    expect(trace).toEqual(['NOTE:/scrollback: the transcript is empty.']); // the terminal is never touched
    expect(notes).toEqual(['/scrollback: the transcript is empty.']);
  });
});

describe('/edit', () => {
  it('hands $EDITOR the UNWRAPPED document (the editor re-flows at its own width)', async () => {
    const { deps, edited } = harness({
      transcriptEntries: [userEntry('y'.repeat(500))],
      columns: 20,
    });
    await createHatches(deps).editTranscript();
    expect(edited).toHaveLength(1);
    expect(edited[0]?.split('\n')).toHaveLength(1); // NOT wrapped to 20 columns
  });

  it('a missing $EDITOR notices AFTER the suspension, never mid-suspension (ink’s frame is erased there)', async () => {
    const { deps, trace, notes } = harness({
      editor: {
        env: {}, // neither VISUAL nor EDITOR
        createTempDocument: () => Promise.reject(new Error('should not be reached')),
        spawnEditor: () => Promise.reject(new Error('should not be reached')),
      },
    });
    await createHatches(deps).editTranscript();
    const notice = '/edit: set $EDITOR (or $VISUAL) to open the transcript in your editor.';
    expect(notes).toEqual([notice]);
    // The ORDER is the point: the whole suspension completed and the terminal was restored BEFORE the notice.
    expect(trace.indexOf(`NOTE:${notice}`)).toBeGreaterThan(trace.indexOf('ink:end'));
  });

  it('a clean editor session says nothing (the user knows they just closed their editor)', async () => {
    const { deps, notes } = harness();
    await createHatches(deps).editTranscript();
    expect(notes).toEqual([]);
  });

  it('a dead editor is a notice, not a crash — and the terminal is restored first', async () => {
    const { deps, trace, notes } = harness({
      editor: {
        env: { EDITOR: 'vim' },
        createTempDocument: () =>
          Promise.resolve({ path: '/t.md', dispose: () => Promise.resolve() }),
        spawnEditor: () => Promise.reject(new Error('ENOENT')),
      },
    });
    await createHatches(deps).editTranscript();
    expect(trace).toContain(ENABLE_MOUSE);
    expect(notes).toEqual(['/edit: could not start vim']);
    expect(trace.indexOf('NOTE:/edit: could not start vim')).toBeGreaterThan(
      trace.indexOf('ink:end'),
    );
  });

  it('an EMPTY transcript notices without spawning anything', async () => {
    const { deps, trace, notes } = harness({ transcriptEntries: [] });
    await createHatches(deps).editTranscript();
    expect(trace).toEqual(['NOTE:/edit: the transcript is empty.']); // nothing spawned, nothing written
    expect(notes).toEqual(['/edit: the transcript is empty.']);
  });
});

describe('the hatches on a driver with NO full-screen renderer (plain / --json)', () => {
  it('both notice honestly instead of failing — the port is empty, so there is no terminal to suspend', async () => {
    const { deps, trace, notes } = harness({ noSuspend: true });
    const hatches = createHatches(deps);
    await hatches.dumpScrollback();
    await hatches.editTranscript();
    expect(trace.filter((t) => !t.startsWith('NOTE:'))).toEqual([]); // no terminal mode was ever touched
    expect(notes).toEqual([
      '/scrollback: needs an interactive terminal.',
      '/edit: needs an interactive terminal.',
    ]);
  });

  it('reads the port at CALL time, so a hatch works the moment a renderer mounts', async () => {
    const { deps, trace, notes } = harness({ noSuspend: true });
    const hatches = createHatches(deps);
    await hatches.dumpScrollback();
    expect(notes).toHaveLength(1);

    deps.suspendPort.attach(inkSuspend(trace)); // ink mounted
    await hatches.dumpScrollback();
    expect(trace).toContain('ink:begin');
    expect(notes).toHaveLength(1); // no second "needs an interactive terminal"
  });
});

describe('a rejected suspension never crashes the REPL', () => {
  it('surfaces ink’s error as a notice (the terminal is already restored by suspendFullScreen)', async () => {
    const { deps, notes } = harness();
    deps.suspendPort.attach(() => Promise.reject(new Error('The terminal is already suspended.')));
    await createHatches(deps).dumpScrollback();
    expect(notes).toEqual(['/scrollback: The terminal is already suspended.']);
  });

  it('the busy latch makes a CONCURRENT hatch a no-op rather than ink’s "already suspended" throw', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trace: string[] = [];
    const { deps, notes } = harness();
    deps.suspendPort.attach(async (callback) => {
      trace.push('ink:begin');
      await gate; // hold the suspension open
      await callback();
      trace.push('ink:end');
    });
    const hatches = createHatches(deps);
    const first = hatches.dumpScrollback();
    await hatches.editTranscript(); // arrives while the first suspension is still open
    release?.();
    await first;
    expect(trace.filter((t) => t === 'ink:begin')).toHaveLength(1); // never a second beginSuspend
    expect(notes).toEqual([]); // and the dropped hatch is silent, not an error
  });
});

/**
 * The per-surface terminal-fact factories (Step-5d-3 Opus review). `inkOwnsAltScreen` is the single most dangerous
 * boolean in this feature: get it backwards and `/scrollback` either paints into the invisible alt buffer or
 * double-toggles DECSET-1049 — a stranded or garbled terminal. It is therefore decided ONCE per surface, by a factory
 * whose NAME says which surface it is for, and pinned here. Before this, both were bare booleans at call sites in
 * `chat.ts` / `drive-home.tsx` with no test at all.
 */
describe('the per-surface terminal facts', () => {
  it('hoistedTerminal (`relavium chat`): WE own 1049 — ink mounts with alternateScreen:false', () => {
    const term = hoistedTerminal(
      () => true,
      () => true,
      () => 120,
    )();
    expect(term).toEqual({
      columns: 120,
      altActive: true,
      mouseActive: true,
      inkOwnsAltScreen: false,
    });
  });

  it('inkOwnedTerminal (the bare Home): INK owns 1049 — it mounts with alternateScreen:true', () => {
    const term = inkOwnedTerminal(
      () => true,
      () => true,
      () => 120,
    )();
    expect(term).toEqual({
      columns: 120,
      altActive: true,
      mouseActive: true,
      inkOwnsAltScreen: true,
    });
  });

  it('both read their predicate LIVE, so a hatch reflects the buffer’s real state, not the startup mode', () => {
    let entered = false;
    const chat = hoistedTerminal(
      () => entered,
      () => entered,
      () => 80,
    );
    const home = inkOwnedTerminal(
      () => entered,
      () => entered,
      () => 80,
    );
    expect(chat().altActive).toBe(false);
    expect(home().mouseActive).toBe(false);
    entered = true; // the alt buffer is entered AFTER the ports were built
    expect(chat().altActive).toBe(true);
    expect(chat().mouseActive).toBe(true);
    expect(home().altActive).toBe(true);
  });

  it('mouseActive is INDEPENDENT of altActive — the `--no-mouse` shape (alt buffer on, mouse off)', () => {
    // Step 5e decoupled them: `--no-mouse` / `[preferences].mouse = false` leaves the alt buffer entered with mouse
    // reporting never armed. A suspension must then NOT "restore" DECSET-1000 on the way back — it was never set.
    const chat = hoistedTerminal(
      () => true,
      () => false,
      () => 80,
    )();
    expect(chat.altActive).toBe(true);
    expect(chat.mouseActive).toBe(false);

    const home = inkOwnedTerminal(
      () => true,
      () => false,
      () => 80,
    )();
    expect(home.altActive).toBe(true);
    expect(home.mouseActive).toBe(false);
  });

  it('falls back to a sane width when the terminal reports no column count', () => {
    expect(
      hoistedTerminal(
        () => true,
        () => true,
        () => undefined,
      )().columns,
    ).toBe(DEFAULT_COLUMNS);
    expect(
      inkOwnedTerminal(
        () => true,
        () => true,
        () => undefined,
      )().columns,
    ).toBe(DEFAULT_COLUMNS);
  });
});

describe('inertHatchPorts — a driver with no renderer (plain / --json, or a unit test)', () => {
  it('short-circuits on the ONE "needs an interactive terminal" notice, never touching the dump/editor ports', async () => {
    const notes: string[] = [];
    const hatches = createHatches({
      ...inertHatchPorts(),
      transcript: () => [userEntry('hello')],
      note: (text) => notes.push(text),
    });
    await hatches.dumpScrollback();
    await hatches.editTranscript();
    expect(notes).toEqual([
      '/scrollback: needs an interactive terminal.',
      '/edit: needs an interactive terminal.',
    ]);
    // The editor port would REJECT if reached — proving the short-circuit is what produced the notices.
    await expect(inertHatchPorts().editor.spawnEditor('x', [], 'f')).rejects.toThrow(
      'no full-screen renderer is attached',
    );
  });
});

/**
 * `/copy` (2.6.F Step 6e). The third hatch, and the only one that suspends NOTHING: OSC 52 is a single control write,
 * so the renderer never gives up the terminal. It copies the UNWRAPPED document — a paragraph the viewport folded
 * across four rows comes back as one line, which is what a user pasting into a bug report wants. The mouse selection
 * copies the VISUAL rows instead; they are different jobs.
 */
describe('createHatches — /copy', () => {
  it('copies the unwrapped transcript document and never suspends the renderer', () => {
    const { deps, trace, copied, notes } = harness({ columns: 20 });
    createHatches(deps).copyTranscript();

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('hello');
    // The clipboard write happens, then the notice — and no `ink:begin` / `ink:end` between them.
    expect(trace[0]).toBe('clipboard');
    expect(trace.filter((t) => t.startsWith('ink:'))).toEqual([]);
    expect(notes[0]).toMatch(/^\/copy: sent \d+ characters to the clipboard\.$/);
  });

  it('an EMPTY transcript is a notice, and the clipboard is never touched', () => {
    const { deps, copied, notes } = harness({ transcriptEntries: [] });
    createHatches(deps).copyTranscript();
    expect(copied).toEqual([]);
    expect(notes).toEqual([`/copy: ${EMPTY_TRANSCRIPT_NOTICE}`]);
  });

  it('a transcript past the terminal’s OSC 52 floor is REFUSED, and points at the hatches that scale', () => {
    const { deps, notes } = harness({
      clipboard: () => ({ kind: 'too-large', base64Length: 120_000, limit: 74_994 }),
    });
    createHatches(deps).copyTranscript();
    expect(notes[0]).toContain('too large');
    expect(notes[0]).toContain('/scrollback or /edit');
  });

  it('reports what it WROTE, never that it was copied — OSC 52 has no acknowledgement', () => {
    const { deps, notes } = harness();
    createHatches(deps).copyTranscript();
    expect(notes[0]).toContain('sent');
    expect(notes[0]).not.toContain('copied');
  });

  it('works with NO full-screen renderer attached — unlike /scrollback and /edit, it needs no suspension', () => {
    const { deps, copied } = harness({ noSuspend: true });
    createHatches(deps).copyTranscript();
    expect(copied).toHaveLength(1); // a plain / `--json` chat can still `/copy`
  });
});
