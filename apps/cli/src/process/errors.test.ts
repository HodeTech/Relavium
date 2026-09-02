import {
  EngineStateError,
  WorkflowGraphError,
  WorkflowSecretLeakError,
  WorkflowSyntaxError,
  WorkflowValidationError,
} from '@relavium/core';
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
      // ADR-0078 §5 — the run produced a terminal whose durable write is not known to have landed.
      // Deliberately neither 0 nor 1: reporting success would be as wrong as reporting failure.
      durabilityUncertain: 5,
      runOwnedElsewhere: 6,
      // ADR-0080 §2b / effect-journal.md §4, §8 — an external effect from a prior attempt is unresolved.
      // The only code whose remedy is "do NOT retry": go look at the target, then resolve the row.
      effectNeedsAttention: 7,
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
    // The one TRANSIENT refusal gets its own code, distinct from every other invocation fault (ADR-0079 §7):
    // a caller must be able to tell "retry shortly" from "never call this again", and exit 2 cannot say it.
    expect(new CliError('run_owned_elsewhere', 'busy').exitCode).toBe(EXIT_CODES.runOwnedElsewhere);
    expect(EXIT_CODES.runOwnedElsewhere).not.toBe(EXIT_CODES.invalidInvocation);
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
    // ORDERED, not four independent substrings: the reading order is the point — what is wrong, then the
    // remedy, then what is NOT lost. Four `toContain`s pass on any shuffle of the same words.
    expect(projected.message).toMatch(
      /^run run-9 contains 2 events.*seq 3, 4.*Upgrade.*still readable/,
    );
  });

  it('maps an engine API refusal to an invocation fault, not a generic internal error (ADR-0083)', () => {
    // `relavium run` calls `engine.start()` DIRECTLY — unlike `gate`, which wraps its resume in a
    // `CliError` — and since ADR-0083 that call throws `input_admission_failed` for a field the CLI's own
    // coercion layer deliberately does not check (`inputs.ts`: "deep per-field validation stays the
    // engine's"). Measured before this arm existed: `--input severity=99` against `max: 10` printed
    // `An unexpected internal error occurred.` and exited 1, discarding every issue.
    const projected = toUserFacing(
      new EngineStateError(
        'input_admission_failed',
        'inputs do not satisfy: severity — value is above the declared maximum',
        {
          issues: [{ name: 'severity', message: 'value is above the declared maximum' }],
        },
      ),
    );
    expect(projected.code).toBe('invalid_invocation');
    expect(projected.exitCode).toBe(EXIT_CODES.invalidInvocation); // exit 2, not 1
    expect(projected.message).toContain('severity');
  });

  it('keeps a TRANSIENT engine refusal on its own code and exit', () => {
    // `run_owned_elsewhere` resolves on its own when the other process finishes; every other engine-state
    // code is a permanent invocation fault. Collapsing the two would tell a caller to fix a call that was
    // never malformed — the same split `gate.ts` already makes on its own resume path (ADR-0079 §7).
    const projected = toUserFacing(
      new EngineStateError('run_owned_elsewhere', 'another process holds the lease', {
        runId: 'run-3',
      }),
    );
    expect(projected.code).toBe('run_owned_elsewhere');
    expect(projected.exitCode).toBe(EXIT_CODES.runOwnedElsewhere);
  });

  it('maps an unknown throw to a generic internal error without leaking detail', () => {
    const userFacing = toUserFacing(new Error('secret stack detail'));
    expect(userFacing.code).toBe('internal');
    expect(userFacing.exitCode).toBe(EXIT_CODES.workflowFailed);
    expect(userFacing.message).not.toContain('secret');
  });
});

describe('a graph fault is an AUTHORING fault, not an internal one (CR-64 review, ADR-0094)', () => {
  it('maps WorkflowGraphError to invalid_invocation/exit 2 and keeps its message', () => {
    // Before this arm, EVERY `WorkflowGraphError` — a cycle, an unknown edge target, an admission ceiling,
    // and (newly) a widened tool grant — fell through to `internal` / exit 1: the code `commands.md`
    // reserves for "the workflow ran and failed", answering a file that could never run. `CR-64` routed a
    // common, easy-to-make authoring mistake into that dead arm, which made the diagnostic strictly WORSE
    // than the mid-run failure it replaced: the user lost the node id entirely.
    const err = new WorkflowGraphError([
      { kind: 'tool_grant_widened', field: 'node `n`.tools[1]', message: 'widened' },
    ]);
    const out = toUserFacing(err);
    expect(out.code).toBe('invalid_invocation');
    expect(out.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(out.message).toContain('node `n`.tools[1]'); // the locator survives to the user
    expect(out.message).not.toContain('unexpected internal');
  });

  it('…and so does a SYNTAX error, which shares the family', () => {
    // The base constructor is protected, so this asserts through a concrete sibling. That is the point of
    // matching on the base: a cycle, a ceiling, a widened grant and a malformed file all land here.
    const out = toUserFacing(new WorkflowSyntaxError('could not parse'));
    expect(out.code).toBe('invalid_invocation');
    expect(out.exitCode).toBe(EXIT_CODES.invalidInvocation);
  });

  it('…and a VALIDATION error and a SECRET-LEAK error — all four subclasses, since the arm keys on the base', () => {
    // The arm matches an ABSTRACT base class, so a fifth subclass added later auto-promotes to the user with
    // no test reddening. `WorkflowSecretLeakError` is the one that matters: its message is assembled from
    // authored identifiers, and it is the reason "echo-safe by contract" needed pinning rather than trusting.
    expect(
      toUserFacing(new WorkflowValidationError([{ field: 'x', message: 'bad' }])).exitCode,
    ).toBe(EXIT_CODES.invalidInvocation);
    const leak = toUserFacing(
      new WorkflowSecretLeakError([
        { location: 'agent `w`.system_prompt', secret: 'inputs.api_key' },
      ]),
    );
    expect(leak.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(leak.message).toContain('inputs.api_key'); // the tainted SYMBOL, never a resolved value
  });

  it('a genuinely unknown error is still internal/exit 1', () => {
    const out = toUserFacing(new Error('boom'));
    expect(out.code).toBe('internal');
    expect(out.exitCode).toBe(EXIT_CODES.workflowFailed);
  });
});
