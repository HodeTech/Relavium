import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileTerminalOutbox } from './terminal-outbox.js';

/**
 * The file-backed outbox had NO test when it landed, and it is the half the maintainer specifically chose
 * over an in-database row — so it is the half whose failure modes matter most (ADR-0078 §4).
 */
const TS = '2026-01-01T00:00:00.000Z';

const terminal = (runId: string, seq = 9, outputs: Record<string, unknown> = {}): RunEvent => ({
  type: 'run:completed',
  runId,
  sequenceNumber: seq,
  timestamp: TS,
  outputs,
  totalTokensUsed: { input: 1, output: 1 },
  totalCostMicrocents: 5,
  durationMs: 10,
});

describe('createFileTerminalOutbox', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-outbox-'));
    path = join(dir, 'terminal-outbox.ndjson');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a terminal through the file', async () => {
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1', 9, { answer: 42 }));

    const held = await outbox.list();
    expect(held).toHaveLength(1);
    expect(held[0]?.runId).toBe('r1');
    expect(held[0]?.type === 'run:completed' ? held[0].outputs : undefined).toEqual({ answer: 42 });
  });

  it('is EMPTY-safe — listing a file that does not exist yields nothing, never a throw', async () => {
    const outbox = createFileTerminalOutbox(join(dir, 'never-written.ndjson'));
    await expect(outbox.list()).resolves.toEqual([]);
  });

  it('keeps the NEWEST entry per run — the file is append-only, the read is last-wins', async () => {
    // Appending rather than rewriting is deliberate: the process writing here has already demonstrated a
    // write can fail, and a rewrite that dies mid-truncate would lose every OTHER run's entry too.
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1', 5, { v: 'first' }));
    await outbox.put(terminal('r1', 9, { v: 'second' }));

    const held = await outbox.list();
    expect(held).toHaveLength(1);
    expect(held[0]?.sequenceNumber).toBe(9);
    // …and both lines really are on disk, so this is last-wins on READ, not overwrite on write. Counting
    // NON-BLANK lines: each entry is written with a leading newline as well as a trailing one, so a partial
    // line left by a killed process cannot swallow the next entry.
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
  });

  it('SKIPS a corrupt or truncated line instead of failing the whole read', async () => {
    // A process killed mid-append leaves a partial last line. That must cost one entry, never the file.
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1'));
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"type":"run:completed","runId":"trunc`, {
      mode: 0o600,
    });
    await outbox.put(terminal('r2'));

    const held = await outbox.list();
    expect(held.map((e) => e.runId).sort()).toEqual(['r1', 'r2']);
  });

  it('REJECTS a line that is valid JSON but not a valid RunEvent', async () => {
    // This file is read on a LATER start, possibly by a different binary. A malformed line must not become
    // a fabricated terminal — it is parsed through the canonical schema, not trusted.
    writeFileSync(path, `${JSON.stringify({ type: 'run:completed', runId: 'evil' })}\n`, {
      mode: 0o600,
    });
    const outbox = createFileTerminalOutbox(path);
    await expect(outbox.list()).resolves.toEqual([]);
  });

  it('remove TOMBSTONES rather than rewriting — only that run disappears from the read', async () => {
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1'));
    await outbox.put(terminal('r2'));
    await outbox.remove('r1');

    expect((await outbox.list()).map((e) => e.runId)).toEqual(['r2']);
    // The file was APPENDED to, never truncated — r1's original line is still there, retired by a marker.
    // Rewriting is what raced a concurrent process's `put` and destroyed it.
    expect(readFileSync(path, 'utf8')).toContain('"r1"');
  });

  it('never TRUNCATES — a concurrent append cannot be destroyed by a removal', async () => {
    // The race this replaced, reproduced in the shape that matters: an append that lands "during" a removal
    // must survive. With the old truncate-then-write compaction the interleaved entry vanished silently.
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1'));
    const removal = outbox.remove('r1');
    await outbox.put(terminal('r2')); // a second process, mid-removal
    await removal;

    expect((await outbox.list()).map((e) => e.runId)).toEqual(['r2']);
  });

  it('a run put AGAIN after its tombstone is held again — a second failed retry must re-enter', async () => {
    // Order-sensitivity, stated as a property: the reader replays the file, so a later `put` outranks an
    // earlier tombstone. Without this a run whose retry also failed would be forgotten forever.
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1', 5));
    await outbox.remove('r1');
    await outbox.put(terminal('r1', 9));

    const held = await outbox.list();
    expect(held.map((e) => e.runId)).toEqual(['r1']);
    expect(held[0]?.sequenceNumber).toBe(9);
  });

  it('removing an ABSENT run is harmless', async () => {
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1'));
    await outbox.remove('nobody');
    expect((await outbox.list()).map((e) => e.runId)).toEqual(['r1']);
  });

  it('creates the file 0600, like history.db (ADR-0050)', async () => {
    // A terminal payload carries `run:completed.outputs` — model output, not secrets, but run data all the
    // same, so it inherits the at-rest posture rather than whatever the umask says.
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('NEVER throws when the directory is gone — the caller is already handling a failed write', async () => {
    // `put` is called from inside the engine's terminal path, having just failed one write. A throw here
    // would break exactly-one-terminal on the way out of the code that exists to protect it.
    const missing = join(dir, 'no-such-dir', 'outbox.ndjson');
    const outbox = createFileTerminalOutbox(missing);
    await expect(outbox.put(terminal('r1'))).resolves.toBeUndefined();
    await expect(outbox.list()).resolves.toEqual([]);
    await expect(outbox.remove('r1')).resolves.toBeUndefined();
  });

  it('NEVER throws when the file is unreadable', async () => {
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1'));
    // A directory where a file is expected is the portable way to make a read fail (chmod 000 is a no-op
    // for root and on Windows).
    rmSync(path);
    mkdirSync(path);
    await expect(outbox.list()).resolves.toEqual([]);
    await expect(outbox.put(terminal('r2'))).resolves.toBeUndefined();
  });

  it('survives an event carrying a C1 / bidi payload — the line is re-read, so it must round-trip', async () => {
    // The entry is written with `stringifyJsonLine` and parsed back on a later start. A bare
    // `JSON.stringify` leaves `U+009B` and the Trojan-Source family raw, and this file is read by a process
    // that then persists what it finds (`CR-03`).
    const hostile = { text: `ok${String.fromCharCode(0x9b)}2J${String.fromCharCode(0x202e)}evil` };
    const outbox = createFileTerminalOutbox(path);
    await outbox.put(terminal('r1', 9, hostile));

    expect(readFileSync(path, 'utf8')).not.toContain(String.fromCharCode(0x9b));
    const held = await outbox.list();
    expect(held[0]?.type === 'run:completed' ? held[0].outputs : undefined).toEqual(hostile);
  });
});
