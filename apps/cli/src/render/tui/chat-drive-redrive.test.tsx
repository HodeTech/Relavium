import { createSessionHandle, RunEventBus } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { SessionWorkOwner } from '../../chat/session-work-owner.js';
import { clearedNotice, modelSwitchNotice } from '../../chat/repl-info.js';
import type { ChatStopReason } from '../../commands/chat.js';
import type { CliIo } from '../../process/io.js';
import { invocationFixture } from '../../process/invocation.test-support.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createSuspendPort } from '../suspend.js';
import { chatGrid } from './chat-grid.js';
import { driveInk } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND, type SessionViewSeed } from './session-view-model.js';
import { FakeStdout } from './surface-matrix/terminal.js';

/**
 * OB7-M2 (the observation of unit 7's chat half): in the STAND-ALONE inline chat, `/clear` and a model reseat re-drive a new chat over the same
 * terminal, and two things were wrong in the scrollback they leave. The old Ink instance was unmounted without erasing its live region, so the
 * previous chat's prompt, rule, status line and hint stayed as dead rows above the new chat's own; and the intro notice (the cleared-session
 * sentence, the model-switch sentence) was written as one raw line, so the terminal hard-wrapped it in the middle of a word
 * (`…to continue it, star|t Relavium without arguments…`). These tests drive the real `driveInk` over a fake terminal that understands Ink's
 * erase-and-rewrite (`FakeStdout`'s screen), twice over the same `io`, as `runReplLoop` does.
 */
const WIDTH = 80;
const ROWS = 40;

function ioOver(input: OwnedTtyInput, output: OwnedTtyOutput, stderr: OwnedTtyOutput): CliIo {
  return {
    env: {},
    stdoutIsTty: true,
    stdinIsTty: true,
    stdin: input,
    nativeStdin: input,
    nativeStdout: output,
    nativeStderr: stderr,
    writeOut: (text) => {
      output.write(text);
    },
    writeErr: (text) => {
      stderr.write(text);
    },
    writeOutAcknowledged: (text) =>
      new Promise<void>((resolve, reject) => {
        output.write(text, (cause) =>
          cause === null || cause === undefined ? resolve() : reject(cause),
        );
      }),
    writeErrAcknowledged: (text) =>
      new Promise<void>((resolve, reject) => {
        stderr.write(text, (cause) =>
          cause === null || cause === undefined ? resolve() : reject(cause),
        );
      }),
  };
}

interface Drive {
  /** What the chat is asked to end with when `line` is typed, and the intro and seed it starts with. */
  readonly endsWith: { readonly line: string; readonly reason: ChatStopReason };
  readonly intro?: string;
  readonly seed?: SessionViewSeed;
}

/** Drive one inline chat over `io` until the person types the line that ends it; returns the screen lines once it is idle and just before it ends. */
async function driveOnce(
  io: CliIo,
  output: FakeStdout,
  input: OwnedTtyInput,
  drive: Drive,
): Promise<{ readonly idle: string[] }> {
  const f = invocationFixture();
  const owner = new SessionWorkOwner(f.invocation, 'chat', {
    cancel: () => undefined,
    cleanup: () => Promise.resolve(),
  });
  const store = createChatStore(false, drive.seed, INLINE_TRANSCRIPT_BOUND);
  const bus = new RunEventBus({ now: () => new Date(0).toISOString() });
  const handle = createSessionHandle(bus, 'drive-redrive', () => undefined, 16, 'subscribe-only');
  let requestedExit = false;
  let reason: ChatStopReason = 'exit';
  let activated = false;
  const driving = driveInk({
    workOwner: owner,
    handle,
    store,
    suspendPort: createSuspendPort(),
    subscribeInterrupt: () => () => undefined,
    startSession: () => undefined,
    onActivated: () => {
      activated = true;
    },
    processLine: (line) => {
      if (line === drive.endsWith.line) {
        requestedExit = true;
        reason = drive.endsWith.reason;
      }
      return Promise.resolve();
    },
    shouldStop: () => requestedExit,
    stopReason: () => reason,
    ...(drive.intro === undefined ? {} : { intro: drive.intro }),
    io,
    global: {
      configPath: undefined,
      cwd: process.cwd(),
      json: false,
      color: false,
      verbosity: 'normal',
      noAltScreen: true,
    },
  });
  const settled = driving.then(
    () => undefined,
    () => undefined,
  );
  try {
    await vi.waitFor(() => expect(activated).toBe(true));
    await vi.waitFor(() =>
      expect(output.screen.lines().join('\n')).toMatch(/type a message|reply to continue/u),
    );
    const idle = output.screen.lines();
    input.push(drive.endsWith.line);
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.push('\r');
    await driving;
    return { idle };
  } finally {
    requestedExit = true;
    await settled;
  }
}

// The chat stands on the grid (unit 9): its prompt, rule, status line and hint begin at the content column, `GAP` columns from the left edge at 80.
const GAP = chatGrid(WIDTH).margin;
const PROMPT_ROW = new RegExp(`^ {${String(GAP)}}> (?:type a message|reply to continue)`, 'u');
const RULE_ROW = new RegExp(`^ {${String(GAP)}}-{40,}$`, 'u');

const countRows = (lines: readonly string[], pattern: RegExp): number =>
  lines.filter((line) => pattern.test(line)).length;

const CASES = [
  {
    name: '/clear',
    reason: 'clear' as const,
    intro: clearedNotice('standalone-chat'),
    seed: undefined,
    placeholder: 'type a message',
  },
  {
    name: 'a model reseat',
    reason: 'reseat' as const,
    intro: modelSwitchNotice('claude-sonnet-4-6', 'claude-opus-4-6'),
    seed: { model: 'claude-opus-4-6', turnCount: 3, transcript: [] } satisfies SessionViewSeed,
    placeholder: 'reply to continue',
  },
];

interface Chats {
  readonly first: string[];
  readonly second: string[];
}

/** Two chats over one terminal of `width` columns: the first ends with `reason`, the second starts with `intro` and `seed`. */
async function twoChats(
  width: number,
  reason: ChatStopReason,
  intro: string,
  seed: SessionViewSeed | undefined,
): Promise<Chats> {
  const input = new OwnedTtyInput();
  const output = new FakeStdout(width, ROWS);
  const stderr = new OwnedTtyOutput();
  const io = ioOver(input, output, stderr);
  const first = await driveOnce(io, output, input, { endsWith: { line: '/end', reason } });
  const second = await driveOnce(io, output, input, {
    endsWith: { line: '/exit', reason: 'exit' },
    intro,
    ...(seed === undefined ? {} : { seed }),
  });
  return { first: first.idle, second: second.idle };
}

const SWITCH = String.fromCodePoint(0x21c4);

/**
 * The rows of the intro as the terminal shows them, from the row that holds its first word to the blank row after it: the raw rows, and their
 * content (the row without its margin). The intro is written in the content column of the grid (unit 9): the margin is blank, except on the first
 * row of the model-switch notice, where the inline renderer's word `model` stands in place of the glyph that led the sentence.
 */
function introRowsOf(
  lines: readonly string[],
  intro: string,
  width: number,
): { readonly raw: string[]; readonly content: string[]; readonly body: string } {
  const grid = chatGrid(width);
  const switched = intro.startsWith(`${SWITCH} `);
  const body = switched ? intro.slice(`${SWITCH} `.length) : intro;
  const [firstWord = ''] = body.split(' ');
  const start = lines.findIndex((line) => line.slice(grid.margin).startsWith(firstWord));
  expect(start, lines.join('\n')).toBeGreaterThanOrEqual(0);
  const raw: string[] = [];
  for (let at = start; at < lines.length && (lines[at] ?? '') !== ''; at += 1)
    raw.push(lines[at] ?? '');
  for (const [index, row] of raw.entries())
    expect(row.slice(0, grid.margin), `row ${String(index)} of ${lines.join('\n')}`).toBe(
      index === 0 && switched ? 'model'.padEnd(grid.margin) : ' '.repeat(grid.margin),
    );
  return { raw, content: raw.map((row) => row.slice(grid.margin)), body };
}

describe.each(CASES)(
  'the stand-alone inline chat after $name',
  ({ reason, intro, seed, placeholder }) => {
    it('leaves no dead prompt block of the previous chat above the new one: one prompt row, one rule, one hint', async () => {
      const { second } = await twoChats(WIDTH, reason, intro, seed);
      const shown = second.join('\n');
      expect(countRows(second, PROMPT_ROW), shown).toBe(1);
      expect(countRows(second, RULE_ROW), shown).toBe(1);
      expect(
        second.filter((line) => /\[\/\] commands/u.test(line)),
        shown,
      ).toHaveLength(1);
    });

    it.each([60, 80, 100])(
      'writes the intro word-wrapped to a terminal of %i columns: no row wider than it, and no word cut',
      async (width) => {
        const { second } = await twoChats(width, reason, intro, seed);
        const { raw, content, body } = introRowsOf(second, intro, width);
        expect(raw.length, second.join('\n')).toBeGreaterThan(1);
        for (const row of raw)
          expect(row.length, `${row}\n---\n${second.join('\n')}`).toBeLessThanOrEqual(width);
        // the text is the content column wide at most
        for (const row of content) expect(row.length).toBeLessThanOrEqual(chatGrid(width).content);
        // joined with single spaces the rows are the sentence again: every break fell at a space, never inside a word
        expect(content.join(' ')).toBe(body);
      },
    );

    it(`says "${placeholder}" in the new chat`, async () => {
      const { second } = await twoChats(WIDTH, reason, intro, seed);
      expect(second.join('\n')).toContain(`> ${placeholder}`);
    });
  },
);

describe('a chat that ends the session keeps its last frame', () => {
  it('leaves the live region of a chat that ended with /exit where it stopped: only a re-drive erases it', async () => {
    const input = new OwnedTtyInput();
    const output = new FakeStdout(WIDTH, ROWS);
    const io = ioOver(input, output, new OwnedTtyOutput());
    await driveOnce(io, output, input, { endsWith: { line: '/exit', reason: 'exit' } });
    const lines = output.screen.lines();
    // `/exit` is a submit in flight when the chat ends, so the last frame is the busy form: its rule, its status line and its hint are what stays
    expect(countRows(lines, RULE_ROW), lines.join('\n')).toBe(1);
    expect(
      lines.filter((line) => new RegExp(`^ {${String(GAP)}}ask mode · `, 'u').test(line)),
    ).toHaveLength(1);
    expect(lines.filter((line) => /\[Ctrl\+C\] end/u.test(line))).toHaveLength(1);
  });
});
