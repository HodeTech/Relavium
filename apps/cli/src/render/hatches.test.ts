import { describe, expect, it } from 'vitest';

import { DISABLE_MOUSE, ENABLE_MOUSE, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from './alt-screen.js';
import { createHatches, type HatchDeps } from './hatches.js';
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
): { deps: HatchDeps; trace: string[]; notes: string[]; edited: string[] } => {
  const trace: string[] = [];
  const notes: string[] = [];
  const edited: string[] = [];
  const port = createSuspendPort();
  if (over.noSuspend !== true) port.attach(inkSuspend(trace));

  const deps: HatchDeps = {
    suspendPort: port,
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
  return { deps, trace, notes, edited };
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
