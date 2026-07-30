import { afterEach, describe, expect, it } from 'vitest';

import { captureIo } from '../test-support.js';
import {
  describeReason,
  escalateExitCode,
  installBackgroundFailureNet,
} from './background-failure.js';
import { EXIT_CODES } from './exit-codes.js';

/** CSI + OSC introducers, built from escapes so the bytes survive every editor and diff tool. */
const CSI = '[';
const OSC = ']';
const BEL = '';

/**
 * The process-level net (#228). Its whole job is to keep the CLI alive after an unhandled rejection instead of
 * letting Node kill it mid-session — so it is exactly the kind of code that silently rots without tests: the
 * listener is attached to the real `process`, and nothing else in the CLI suite would notice its absence.
 */
describe('installBackgroundFailureNet (#228)', () => {
  const originalExitCode = process.exitCode;
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    process.exitCode = originalExitCode;
  });

  /**
   * Drive one real unhandled rejection through Node and wait for the listener to see it. Typed `Error`
   * because every case here rejects with one; the non-Error reasons `describeReason` must survive are
   * covered by calling it directly, which is cheaper and does not need a real rejection.
   */
  async function rejectOnce(reason: Error): Promise<void> {
    void Promise.reject(reason);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it('reports a rejection and does NOT let it kill the process', async () => {
    const { io, err } = captureIo();
    const net = installBackgroundFailureNet(io);
    dispose = net.dispose;
    process.exitCode = EXIT_CODES.success;

    await rejectOnce(new Error('database is locked'));

    expect(net.occurred()).toBe(true);
    expect(err()).toContain('a background operation failed: database is locked');
    // Still running — reaching this assertion at all is itself the proof.
    expect(process.exitCode).toBe(EXIT_CODES.workflowFailed);
  });

  it('upgrades a clean 0 but NEVER overwrites a more specific outcome', () => {
    const { io } = captureIo();
    const net = installBackgroundFailureNet(io);
    dispose = net.dispose;

    // chatEnded / gatePaused / invalidInvocation each carry a truth CI and scripts key on.
    for (const code of [
      EXIT_CODES.chatEnded,
      EXIT_CODES.gatePaused,
      EXIT_CODES.invalidInvocation,
    ]) {
      process.exitCode = code;
      escalateExitCode();
      expect(process.exitCode).toBe(code);
    }
    process.exitCode = EXIT_CODES.success;
    escalateExitCode();
    expect(process.exitCode).toBe(EXIT_CODES.workflowFailed);
  });

  it('SANITIZES the reported reason — a rejection reason is untrusted text', async () => {
    const { io, err } = captureIo();
    const net = installBackgroundFailureNet(io);
    dispose = net.dispose;
    // An MCP server's error text, a provider response body and a tool result can all land here, so the same
    // ANSI/OSC guard every other terminal boundary applies has to apply here too (G34's class).
    await rejectOnce(new Error(`lost ${CSI}31mred${OSC}0;pwned${BEL} write`));
    expect(err()).not.toContain(''); // no CSI/OSC introducer survives
    expect(err()).not.toContain(BEL); // nor the OSC terminator
    expect(err()).toContain('lost'); // …while the readable text still reaches the user
  });

  it('bounds repeated reports so a repeating fault cannot scroll a session away', async () => {
    const { io, err } = captureIo();
    const net = installBackgroundFailureNet(io);
    dispose = net.dispose;
    for (let i = 0; i < 8; i += 1) {
      await rejectOnce(new Error(`boom-${i}`));
    }
    expect(err()).toContain('boom-4'); // the 5th, still reported in full
    expect(err()).not.toContain('boom-5'); // the 6th, suppressed
    expect(err()).toContain('further background failures suppressed');
  });

  it('RELAVIUM_DEBUG lifts the bound — the suppression line must not promise what it does not deliver', async () => {
    const { io, err } = captureIo({ RELAVIUM_DEBUG: '1' });
    const net = installBackgroundFailureNet(io);
    dispose = net.dispose;
    for (let i = 0; i < 8; i += 1) {
      await rejectOnce(new Error(`boom-${i}`));
    }
    // Every one reported, and no suppression notice claiming a flag would reveal them.
    expect(err()).toContain('boom-7');
    expect(err()).not.toContain('further background failures suppressed');
  });

  it('stops listening once disposed', async () => {
    const { io, err } = captureIo();
    const net = installBackgroundFailureNet(io);
    net.dispose();
    await rejectOnce(new Error('after dispose'));
    expect(net.occurred()).toBe(false);
    expect(err()).toBe('');
  });
});

describe('describeReason', () => {
  it('carries the discriminant, not just the message — a bare message cannot identify a wiring gap', () => {
    expect(describeReason(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }))).toBe(
      'locked [SQLITE_BUSY]',
    );
  });

  it('handles the realistic non-Error shapes instead of collapsing them to "unknown"', () => {
    // A driver-shaped plain object is exactly what `retry.ts` matches structurally, so it is a real case.
    expect(describeReason({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(
      'database is locked',
    );
    expect(describeReason('a bare string')).toBe('a bare string');
    expect(describeReason(new AggregateError([new Error('a'), new Error('b')]))).toContain(
      '2 background errors',
    );
    expect(describeReason(42)).toBe('unknown reason');
  });
});
