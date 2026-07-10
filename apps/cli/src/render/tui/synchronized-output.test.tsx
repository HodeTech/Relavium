import { Box, render, Text } from 'ink';
import { Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FRAME_MS } from './tui-constants.js';

/**
 * **DEC-2026 synchronized output** (2.6.F Step 5f, ADR-0068).
 *
 * ADR-0068's Decision says flicker "is avoided with terminal synchronized output (DEC 2026, `\x1b[?2026h/l`) framing,
 * since `ink` does not emit it", and Step 5f was scheduled to build it — a `Proxy` over `process.stdout` wrapping every
 * write. That claim is FALSE for `ink` 7. It ships `build/write-synchronized.js` (`bsu`/`esu` = `?2026h`/`?2026l`) and
 * wraps every frame write in it, gated on `shouldSynchronize(stream, interactive)`. Building the Proxy would have
 * NESTED the escapes — ink emits `bsu` as its own `write()` call — for no benefit at all.
 *
 * So there is nothing to implement, and everything to PIN. These tests are the regression guard: if an `ink` bump drops
 * the framing, or a future render option turns it off, the frame flicker returns silently and only a human staring at a
 * 60-row repaint would notice. They also pin the other half of the contract — that a NON-TTY / `--json` / CI path emits
 * no `2026` byte at all, which the ADR's "byte-identical inline output" guarantee depends on.
 *
 * `ink` keeps one renderer per `stdout`, so every mount here gets its own stream.
 */

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

/** A capture stream that can pretend to be a TTY — `shouldSynchronize` reads `isTTY`. */
interface CaptureStream extends Writable {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  written: string[];
}

function captureStdout(isTTY: boolean): CaptureStream {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as CaptureStream;
  if (isTTY) stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  stream.written = chunks;
  return stream;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, FRAME_MS * 4));

/** Mount a one-line tree with RELAVIUM's production render options, rerender once, and return everything written. */
async function frames(
  isTTY: boolean,
  options: Record<string, unknown> = {},
): Promise<{ all: string; chunks: string[] }> {
  const stdout = captureStdout(isTTY);
  const stdin = new PassThrough();
  const app = render(
    <Box>
      <Text>first</Text>
    </Box>,
    {
      // ink only ever reads `isTTY` / `columns` / `on('resize')` and calls `write()` — a Writable is enough. The cast
      // is the test double's, not production's.
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      // The SAME cadence both surfaces pin (`chat-ink.tsx`, `drive-home.tsx`, `ink-renderer.ts`).
      maxFps: Math.max(1, Math.round(1000 / FRAME_MS)),
      ...options,
    },
  );
  await settle();
  app.rerender(
    <Box>
      <Text>second</Text>
    </Box>,
  );
  await settle();
  app.unmount();
  return { all: stdout.written.join(''), chunks: stdout.written };
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('ink 7 already frames every write in DEC-2026 synchronized output', () => {
  let previousCi: string | undefined;

  beforeEach(() => {
    // `shouldSynchronize` is `isTTY && (interactive ?? !isInCi)`, and `is-in-ci` reads the env at import. Vitest sets
    // CI in some environments; clear it so `interactive` resolves from `isTTY` alone.
    previousCi = process.env['CI'];
    delete process.env['CI'];
  });

  afterEach(() => {
    if (previousCi !== undefined) process.env['CI'] = previousCi;
  });

  it('a TTY gets a balanced BSU/ESU pair around each frame it writes', async () => {
    const { all } = await frames(true);
    expect(count(all, BSU)).toBeGreaterThan(0);
    expect(count(all, ESU)).toBe(count(all, BSU)); // never a stranded BSU — that FREEZES the terminal
  });

  it('the BSU precedes the frame and the ESU follows it', async () => {
    const { all } = await frames(true);
    const open = all.indexOf(BSU);
    const body = all.indexOf('first');
    const close = all.indexOf(ESU);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(open).toBeLessThan(body);
    expect(body).toBeLessThan(close);
  });

  it('a NON-TTY (a pipe, `--json`, CI) emits no 2026 byte at all — the inline path stays byte-identical', async () => {
    const { all } = await frames(false);
    expect(all).not.toContain('\x1b[?2026');
  });

  it('`interactive: false` disables it even on a TTY (the option ink resolves from `is-in-ci`)', async () => {
    const { all } = await frames(true, { interactive: false });
    expect(all).not.toContain('\x1b[?2026');
  });

  it('SANITY: the escapes are ink’s own, written as separate chunks — a stdout Proxy would have NESTED them', async () => {
    // This is why Step 5f built nothing. A `Proxy` wrapping every `write()` in `?2026h`…`?2026l`, as the ADR planned,
    // would have wrapped ink's own `bsu` write in a second pair.
    const { chunks } = await frames(true);
    expect(chunks).toContain(BSU);
    expect(chunks).toContain(ESU);
  });
});
