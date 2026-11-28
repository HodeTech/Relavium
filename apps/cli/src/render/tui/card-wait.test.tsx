/**
 * The chat's approval, command and checkpoint cards say when the answer lockout holds their affirmative chords (MVP-11 unit 8, owed by unit 6:
 * the `(wait)` rule unit 6 built for the popups, ADR-0145 §3): a display value beside the store's snapshot (`answerLock`), never a field of it,
 * with one timer at the instant the lock opens, one repaint then, and the fit rule when the marks make a row too wide. Only the LOCKOUT is drawn
 * (the dwell, the quiet gap and the typing window follow from the person's own keys and are short); the question card has no lockout layer, so it
 * has nothing to draw.
 *
 * On the drawn grid: a `Ctrl+Y` held through one answer onto the next card never answers it with a repeat, the card says `(wait)` while it holds,
 * the legend flips once at the lock's end, the card's state is the same object across the flip (the acknowledgement stays valid), and the first
 * deliberate press after it counts.
 *
 * The guard's clock is faked (`performance`, `Date`); the lock display's one-shot timer is the test's; the renderer keeps its own timers.
 */
import type { ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import { OwnedTtyInput, OwnedTtyOutput, PlainTtyOutput } from '../../test-support.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { projectCheckpointCard } from './checkpoint-card.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from './session-view-model.js';
import { cardKeyLegend } from './tool-review-card.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date'] });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});

const REQUEST: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
const PREVIEW: ToolPreview = editedFilePreview(8, { 4: 'four' });
const CTRL_Y = '\x19';
// eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[78]/gu;

/** Real time for the renderer: the guard's clock is faked, Ink's own timers are not. */
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

function mount() {
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const input = new OwnedTtyInput();
  const output = new PlainTtyOutput();
  const stderr = new OwnedTtyOutput();
  output.columns = 80;
  output.rows = 24;
  // The product's real guard; only the lock display's one-shot timer is the test's.
  const store: ChatStoreController = createChatStore(
    false,
    undefined,
    FULLSCREEN_TRANSCRIPT_BOUND,
    {
      lockSchedule: (run, ms) => {
        const timer = { at: performance.now() + ms, run, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  );
  const instance = render(
    createElement(ChatApp, {
      store,
      onSubmit: () => Promise.resolve(),
      shouldStop: () => false,
      onExit: () => {},
      onError: () => {},
      onModeChange: () => {},
      alternateScreen: true,
    }),
    {
      stdin: input,
      stdout: output,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
    },
  );
  cleanups.push(() => {
    store.sealToolPreviews();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  const answers: unknown[] = [];
  const open = (callId: string): void => {
    void store
      .requestApproval(REQUEST, true, undefined, { callId, preview: PREVIEW })
      .then((answer) => answers.push(answer))
      .catch(() => undefined);
  };
  /** The last frame written, as rows, control sequences stripped. */
  const frame = (): string =>
    output.frames
      .map((chunk) => chunk.replace(CONTROL, ''))
      .filter((f) => f.includes('=='))
      .at(-1) ?? '';
  /** Move the guard's clock by `ms` and fire the lock display's timers that are due. */
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
    for (const timer of timers.filter((t) => !t.cancelled && t.at <= performance.now())) {
      timer.cancelled = true;
      timer.run();
    }
  };
  return { store, input, frame, open, answers, advance, output };
}

describe('the approval card says (wait) while the lockout holds its grants', () => {
  it('a Ctrl+Y held through one answer onto the next card: never a repeat answer, (wait) while it holds, one flip, then a deliberate press counts', async () => {
    const m = mount();
    await pause(40);
    m.open('a');
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow · [Ctrl+G]'));
    await pause(60); // the frame is measured and acknowledged
    m.advance(1_000); // read for longer than the dwell
    m.input.push(CTRL_Y);
    await vi.waitFor(() => expect(m.answers).toHaveLength(1));
    // The engine asks again at once: the next card opens under the key that is still held.
    m.open('b');
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow (wait)'));
    expect(m.frame(), 'every grant waits').toContain(
      '[Ctrl+G] Allow all file edits this session (wait)',
    );
    await pause(60);
    // The key's auto-repeats, for longer than the lockout: each lands inside it and restarts it.
    for (let held = 0; held < 25; held += 1) {
      m.advance(100);
      m.input.push(CTRL_Y);
      await pause(5);
    }
    await pause(60);
    expect(m.answers, 'no repeat answered the card that appeared under the key').toHaveLength(1);
    expect(m.frame(), 'the card still says it waits').toContain('[Ctrl+Y] Allow (wait)');
    // Released: the lock opens one lockout after the last repeat, and the legend flips once.
    const card = m.store.getSnapshot().review;
    let flips = 0;
    const stop = m.store.answerLock.subscribe(() => {
      flips += 1;
    });
    m.advance(APPROVAL_LOCKOUT_MS - 1);
    expect(m.store.answerLock.read(), 'a millisecond before the end').toBe(true);
    m.advance(1);
    expect(m.store.answerLock.read()).toBe(false);
    expect(flips, 'one change: one repaint').toBe(1);
    stop();
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow · [Ctrl+G]'));
    expect(m.frame()).not.toContain('(wait)');
    expect(m.store.getSnapshot().review, 'the lock is no field of the card: the same state').toBe(
      card,
    );
    // The acknowledgement of the frame stayed valid: the first deliberate press after the flip counts.
    m.input.push(CTRL_Y);
    await vi.waitFor(() => expect(m.answers).toHaveLength(2));
    expect(m.answers[1]).toEqual({ outcome: 'approve', scope: 'once' });
  });

  it('a card that opens with no recent answer holds nothing and says nothing', async () => {
    const m = mount();
    await pause(40);
    m.open('a');
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow · [Ctrl+G]'));
    expect(m.store.answerLock.read()).toBe(false);
    expect(m.frame()).not.toContain('(wait)');
  });
});

describe('the checkpoint card says (wait) on Continue while the lockout holds it', () => {
  it('right after an answer it waits, and Stop here never does', async () => {
    const m = mount();
    await pause(40);
    m.open('a');
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow'));
    await pause(60);
    m.advance(1_000);
    m.input.push(CTRL_Y);
    await vi.waitFor(() => expect(m.answers).toHaveLength(1));
    void m.store.requestCheckpoint({ rounds: 12, interval: 8 }).catch(() => undefined);
    await vi.waitFor(() =>
      expect(m.frame()).toContain('[Ctrl+Y] Continue (wait) · [Ctrl+N] Stop here'),
    );
    m.advance(APPROVAL_LOCKOUT_MS);
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Continue · [Ctrl+N] Stop here'));
  });

  it('the projection marks only Continue', () => {
    const view = projectCheckpointCard({ rounds: 3, interval: 4, elapsedMs: 1000 }, 80, true);
    expect(view.keys[0]).toBe('[Ctrl+Y] Continue (wait) · [Ctrl+N] Stop here');
    expect(projectCheckpointCard({ rounds: 3, interval: 4, elapsedMs: 1000 }, 80).keys[0]).toBe(
      '[Ctrl+Y] Continue · [Ctrl+N] Stop here',
    );
  });
});

describe('the fit rule: the marks never push a row past its width', () => {
  const command = {
    inspected: true,
    cacheable: true,
    scope: 'run_command calls',
    command: true,
    remember: true,
  } as const;

  it('a command card at 80 columns keeps Allow once and This session waiting, and drops Remember until the lock opens', () => {
    expect(cardKeyLegend({ ...command, locked: true, columns: 78 })[0].text).toBe(
      '[Ctrl+Y] Allow once (wait) · [Ctrl+G] Allow this session (wait)',
    );
    expect(cardKeyLegend({ ...command, locked: false, columns: 78 })[0].text).toBe(
      '[Ctrl+Y] Allow once · [Ctrl+G] Allow this session · [Ctrl+O] Allow + remember',
    );
  });

  it('Allow is never the part dropped, however narrow', () => {
    expect(cardKeyLegend({ ...command, locked: true, columns: 10 })[0].text).toBe(
      '[Ctrl+Y] Allow once (wait)',
    );
  });

  it('a row that fits keeps every grant waiting', () => {
    expect(cardKeyLegend({ ...command, locked: true, columns: 120 })[0].text).toBe(
      '[Ctrl+Y] Allow once (wait) · [Ctrl+G] Allow this session (wait) · [Ctrl+O] Allow + remember (wait)',
    );
  });
});

describe('the host hands the fit rule the card’s own width', () => {
  it('a command card with every grant, held by the lockout, at 80 columns: Remember is dropped from the grants row and no row is cut', async () => {
    const m = mount();
    await pause(40);
    m.open('a');
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow · [Ctrl+G]'));
    await pause(60);
    m.advance(1_000);
    m.input.push(CTRL_Y);
    await vi.waitFor(() => expect(m.answers).toHaveLength(1));
    const argv = ['git', 'status'];
    const facts: CommandCardFacts = {
      standing: 'not-pre-approved',
      runsCode: false,
      protectedPath: false,
      cwd: '/work/project',
      offers: { session: true, remember: true },
    };
    void m.store
      .requestApproval(
        {
          toolId: 'run_command',
          action: 'process',
          preview: { command: 'git status' },
          unredactedPreview: { command: 'git status' },
          argv,
          commandAdmitted: false,
        },
        true,
        undefined,
        {
          callId: 'cmd',
          preview: {
            kind: 'operation',
            target: 'git status',
            fields: argv.map((value) => ({ name: '', value })),
          },
        },
        facts,
      )
      .catch(() => undefined);
    await vi.waitFor(() => expect(m.frame()).toContain('Allow once (wait)'));
    const grants =
      m
        .frame()
        .split('\n')
        .find((row) => row.includes('Allow once (wait)')) ?? '';
    expect(grants.trimEnd()).toBe(
      '[Ctrl+Y] Allow once (wait) · [Ctrl+G] Allow this session (wait)',
    );
    expect(m.frame()).not.toContain('Allow + remember');
  });
});

describe('the inspection popup’s grants row says (wait) too', () => {
  it('a full view opened while the lockout holds says `[Ctrl+Y] Allow (wait)` and flips with the card', async () => {
    const m = mount();
    await pause(40);
    m.open('a');
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow · [Ctrl+G]'));
    await pause(60);
    m.advance(1_000);
    m.input.push(CTRL_Y);
    await vi.waitFor(() => expect(m.answers).toHaveLength(1));
    m.open('b');
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow (wait)'));
    await pause(60);
    m.input.push('v');
    const popup = (): string =>
      m.output.frames
        .map((chunk) => chunk.replace(CONTROL, ''))
        .filter((f) => f.includes('Full diff'))
        .at(-1) ?? '';
    await vi.waitFor(() => expect(popup()).toContain('Full diff'));
    await pause(60);
    expect(popup()).toContain('[Ctrl+Y] Allow (wait)');
    m.advance(APPROVAL_LOCKOUT_MS);
    await vi.waitFor(() => expect(popup()).not.toContain('(wait)'));
  });
});

describe('the inspection popup hands the fit rule its own width (unit 8 fix wave, M-7: B14)', () => {
  it('the full view of a command card held by the lockout, at 80 columns: Remember gives way in its grants row too, and no row is cut', async () => {
    const m = mount();
    await pause(40);
    m.open('a');
    await vi.waitFor(() => expect(m.frame()).toContain('[Ctrl+Y] Allow · [Ctrl+G]'));
    await pause(60);
    m.advance(1_000);
    m.input.push(CTRL_Y);
    await vi.waitFor(() => expect(m.answers).toHaveLength(1));
    const argv = ['git', 'status'];
    void m.store
      .requestApproval(
        {
          toolId: 'run_command',
          action: 'process',
          preview: { command: 'git status' },
          unredactedPreview: { command: 'git status' },
          argv,
          commandAdmitted: false,
        },
        true,
        undefined,
        {
          callId: 'cmd',
          preview: {
            kind: 'operation',
            target: 'git status',
            fields: argv.map((value) => ({ name: '', value })),
          },
        },
        {
          standing: 'not-pre-approved',
          runsCode: false,
          protectedPath: false,
          cwd: '/work/project',
          offers: { session: true, remember: true },
        },
      )
      .catch(() => undefined);
    await vi.waitFor(() => expect(m.frame()).toContain('Allow once (wait)'));
    await pause(60);
    m.input.push('v');
    const popup = (): readonly string[] =>
      (
        m.output.frames
          .map((chunk) => chunk.replace(CONTROL, ''))
          .filter((f) => f.includes('Full view'))
          .at(-1) ?? ''
      ).split('\n');
    await vi.waitFor(() => expect(popup().join('\n')).toContain('Allow once (wait)'));
    const grants = popup().find((row) => row.includes('Allow once (wait)')) ?? '';
    expect(grants.trim()).toBe('[Ctrl+Y] Allow once (wait) · [Ctrl+G] Allow this session (wait)');
    expect(popup().join('\n')).not.toContain('Allow + remember');
    expect(popup().join('\n')).not.toContain('…');
  });
});
