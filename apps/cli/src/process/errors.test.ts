import { CorruptRunEventError, UnreadableRunEventLogError } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { CliError, isCliError, toUserFacing } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';

describe('EXIT_CODES', () => {
  it('matches the documented values (commands.md)', () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      workflowFailed: 1,
      invalidInvocation: 2,
      gatePaused: 3,
      chatEnded: 4,
    });
  });
});

describe('CliError', () => {
  it('maps invalid_invocation and not_implemented to exit 2', () => {
    expect(new CliError('invalid_invocation', 'bad').exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(new CliError('not_implemented', 'soon').exitCode).toBe(EXIT_CODES.invalidInvocation);
  });

  it('maps internal to exit 1', () => {
    expect(new CliError('internal', 'oops').exitCode).toBe(EXIT_CODES.workflowFailed);
  });

  it('carries the code discriminant and is identifiable', () => {
    const error = new CliError('invalid_invocation', 'bad');
    expect(error.code).toBe('invalid_invocation');
    expect(isCliError(error)).toBe(true);
    expect(isCliError(new Error('plain'))).toBe(false);
  });

  it('preserves the cause chain', () => {
    const cause = new Error('root');
    expect(new CliError('internal', 'wrap', { cause }).cause).toBe(cause);
  });
});

describe('toUserFacing', () => {
  it('passes a CliError through verbatim', () => {
    expect(toUserFacing(new CliError('invalid_invocation', 'name it'))).toEqual({
      code: 'invalid_invocation',
      message: 'name it',
      exitCode: EXIT_CODES.invalidInvocation,
    });
  });

  it('names the run and row for a damaged event row instead of the generic fault (ADR-0074 §5 / ADR-0050)', () => {
    // The generic branch below would report one corrupt row out of a 4,000-event log as
    // `An unexpected internal error occurred.` — no run, no row, no next step. The store's typed error already
    // carries the run id, the `seq` and the `event_type`, none of which is user content or a secret.
    const projected = toUserFacing(
      new CorruptRunEventError('run-7', 42, 'node:started', new Error('bad body')),
    );
    expect(projected.code).toBe('internal');
    expect(projected.exitCode).toBe(EXIT_CODES.workflowFailed); // the read genuinely failed — still exit 1
    expect(projected.message).toContain('run-7');
    expect(projected.message).toContain('42');
    expect(projected.message).toContain('node:started');
    expect(projected.message).not.toContain('bad body'); // the cause stays out of primary output
  });

  it('distinguishes "your binary is too old" from "the data is damaged" (ADR-0075)', () => {
    // The two errors deserve different sentences because they have different remedies: corruption is not
    // repaired by upgrading, and a version gap is not repaired by restoring a backup. Projecting both as one
    // generic fault is what made the refusal indistinguishable from data loss.
    const projected = toUserFacing(new UnreadableRunEventLogError('run-9', [3, 4]));
    expect(projected.code).toBe('internal');
    // Exit 1: the resume genuinely did not happen. NOT exit 2 — the invocation was valid.
    expect(projected.exitCode).toBe(EXIT_CODES.workflowFailed);
    expect(projected.message).toContain('run-9');
    expect(projected.message).toContain('seq 3, 4');
    expect(projected.message).toContain('Upgrade'); // the remedy the user can actually perform
    expect(projected.message).toContain('still readable'); // …and what is NOT lost
  });

  it('maps an unknown throw to a generic internal error without leaking detail', () => {
    const userFacing = toUserFacing(new Error('secret stack detail'));
    expect(userFacing.code).toBe('internal');
    expect(userFacing.exitCode).toBe(EXIT_CODES.workflowFailed);
    expect(userFacing.message).not.toContain('secret');
  });
});
