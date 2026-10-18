import { RunSuspensionCorruptionError } from '@relavium/shared';
import {
  AgentParseError,
  EngineStateError,
  WorkflowGraphError,
  WorkflowSecretLeakError,
  WorkflowSyntaxError,
  WorkflowValidationError,
} from '@relavium/core';
import {
  CorruptRunEventError,
  createClient,
  DbOpenError,
  ProviderHeaderPolicyError,
  SessionMessageBoundaryError,
  UnreadableRunEventLogError,
} from '@relavium/db';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ERROR_POLICY } from './cli-error.js';

import { CliError, isCliError, toUserFacing } from './errors.js';
import {
  CliError as LightweightCliError,
  isCliError as isLightweightCliError,
} from './cli-error.js';
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
      // ADR-0103 — required money receipts are not confirmed, independently of terminal durability.
      moneyDurabilityUncertain: 8,
      infrastructureFailed: 9,
    });
  });
});

describe('CliError', () => {
  it('keeps the runtime compatibility re-exports on the exact lightweight class and guard identity', () => {
    expect(CliError).toBe(LightweightCliError);
    expect(isCliError).toBe(isLightweightCliError);
    expect(isCliError(new LightweightCliError('internal', 'known refusal'))).toBe(true);
  });

  it.each([
    'cli_internal',
    'output_unavailable',
    'storage_unavailable',
    'config_write_refused',
  ] as const)(
    'retains the fixed %s diagnostic even if the native Error message is mutated',
    (code) => {
      const value = new CliError(code, 'PRIVATE_CONSTRUCTOR_TEXT');
      const expected = value.message;
      value.message = 'PRIVATE_MUTATED_TEXT';
      expect(toUserFacing(value)).toEqual({ code, message: expected, exitCode: value.exitCode });
      expect(JSON.stringify(toUserFacing(value))).not.toContain('PRIVATE_');
    },
  );

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
  it.each([
    'gate_identity_conflict',
    'gate_state_conflict',
    'legacy_gate_join_missing',
    'legacy_gate_join_ambiguous',
  ] as const)(
    'keeps typed %s history corruption operational without reflecting mutated detail',
    (code) => {
      const failure = new RunSuspensionCorruptionError(code);
      failure.message = 'PRIVATE_CORRUPT_HISTORY';
      expect(toUserFacing(failure)).toEqual({
        code: 'internal',
        message:
          'The stored gate history is inconsistent. Inspect its history before resuming or repeating the run.',
        exitCode: 1,
      });
      expect(toUserFacing(Object.assign(new Error('PRIVATE_LOOKALIKE'), { code })).exitCode).toBe(
        9,
      );
    },
  );

  it.each(['message_invalid', 'metadata_invalid'] as const)(
    'maps a %s session boundary refusal to a fixed, value-free invocation diagnostic',
    (code) => {
      const error = new SessionMessageBoundaryError(code);
      error.message = 'PRIVATE_SESSION_BODY_AND_PROPERTY';
      const projected = toUserFacing(error);
      expect(projected).toEqual({
        code: 'invalid_invocation',
        message:
          'A session message has an invalid persistence format. Restore a safe history backup or start a new session.',
        exitCode: EXIT_CODES.invalidInvocation,
      });
      expect(JSON.stringify(projected)).not.toContain('PRIVATE_SESSION_BODY_AND_PROPERTY');
    },
  );

  it('maps a provider-header policy refusal to the fixed invocation diagnostic (ADR-0108)', () => {
    expect(toUserFacing(new ProviderHeaderPolicyError())).toEqual({
      code: 'invalid_invocation',
      message: new ProviderHeaderPolicyError().message,
      exitCode: EXIT_CODES.invalidInvocation,
    });
  });

  it('uses the structural DB guard for another bundle and refuses altered lookalikes', () => {
    const compatible = new Error(new ProviderHeaderPolicyError().message);
    Object.defineProperty(compatible, 'code', { value: 'provider_header_policy' });
    compatible.name = 'ProviderHeaderPolicyError';
    expect(toUserFacing(compatible)).toEqual({
      code: 'invalid_invocation',
      message: new ProviderHeaderPolicyError().message,
      exitCode: EXIT_CODES.invalidInvocation,
    });
    expect(toUserFacing({ code: 'provider_header_policy' }).code).toBe('cli_internal');
    compatible.message = 'opaque compatibility payload';
    expect(toUserFacing(compatible)).toEqual({
      code: 'cli_internal',
      message: CLI_ERROR_POLICY.cli_internal.fixedMessage,
      exitCode: EXIT_CODES.infrastructureFailed,
    });
  });

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
    expect(userFacing.code).toBe('cli_internal');
    expect(userFacing.exitCode).toBe(EXIT_CODES.infrastructureFailed);
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

  it('an unknown error is infrastructure/exit 9', () => {
    const out = toUserFacing(new Error('boom'));
    expect(out.code).toBe('cli_internal');
    expect(out.exitCode).toBe(EXIT_CODES.infrastructureFailed);
  });
});

describe('toUserFacing — a malformed standalone agent file', () => {
  it('is an invalid invocation (exit 2), not an internal error (exit 1)', () => {
    // `AgentParseError extends Error`, not `WorkflowParseError`, so it fell through the arm added for the
    // workflow case: `chat --agent`, Home and `agent run` all answered an unloadable agent with
    // "An unexpected internal error occurred." and exit 1.
    const mapped = toUserFacing(
      new AgentParseError('agent_validation', 'invalid agent: output_schema: …', ['output_schema']),
    );
    expect(mapped.code).toBe('invalid_invocation');
    expect(mapped.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(mapped.message).toContain('invalid agent');
  });
});

describe('owned storage origin (ADR-0110 Step 8a)', () => {
  it('projects real corrupt database setup to fixed storage 1 without its private path/cause', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relavium-owned-storage-'));
    const path = join(dir, 'PRIVATE_HISTORY_PATH.db');
    writeFileSync(path, 'PRIVATE_NOT_SQLITE_BYTES');
    try {
      let failure: unknown;
      try {
        createClient(path);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DbOpenError);
      expect(toUserFacing(failure), 'CLI_ORIGIN_DB_FACT').toEqual({
        code: 'storage_unavailable',
        message: CLI_ERROR_POLICY.storage_unavailable.fixedMessage,
        exitCode: EXIT_CODES.workflowFailed,
      });
      expect(JSON.stringify(toUserFacing(failure))).not.toContain('PRIVATE_');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    new DbOpenError('open_failed', 'PRIVATE_ABI_MESSAGE', '/PRIVATE_PATH', {
      cause: Object.assign(new Error('PRIVATE_ABI_CAUSE'), { code: 'ERR_DLOPEN_FAILED' }),
    }),
    new DbOpenError('open_failed', 'PRIVATE_NATIVE_MESSAGE', '/PRIVATE_PATH', {
      cause: Object.assign(new Error('PRIVATE_NATIVE_CAUSE'), { code: 'SQLITE_FULL' }),
    }),
    Object.assign(new Error('PRIVATE_ERRNO_MESSAGE'), { code: 'EACCES' }),
    { code: 'open_failed', cause: { code: 'SQLITE_CANTOPEN' } },
  ])(
    'case %#: does not infer storage from a public constructor, errno or convincing cause',
    (failure) => {
      expect(toUserFacing(failure)).toEqual({
        code: 'cli_internal',
        message: CLI_ERROR_POLICY.cli_internal.fixedMessage,
        exitCode: EXIT_CODES.infrastructureFailed,
      });
      expect(JSON.stringify(toUserFacing(failure))).not.toContain('PRIVATE_');
    },
  );

  it('preserves the programmer-invalid DB URI API refusal as invocation 2', () => {
    let failure: unknown;
    try {
      createClient('file:PRIVATE_URI?mode=memory');
    } catch (error) {
      failure = error;
    }
    expect(toUserFacing(failure).code).toBe('invalid_invocation');
    expect(toUserFacing(failure).exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(toUserFacing(failure).message).not.toContain('PRIVATE_URI');
  });
});

describe('defensive runtime projection', () => {
  it.each(['code', 'message', 'name', 'stack', 'cause'])(
    'does not invoke hostile %s accessors on unknown errors',
    (key) => {
      let calls = 0;
      const value = new Error('PRIVATE_UNKNOWN');
      Object.defineProperty(value, key, {
        get: () => {
          calls += 1;
          throw new Error('PRIVATE_GETTER');
        },
      });
      expect(toUserFacing(value)).toEqual({
        code: 'cli_internal',
        message: CLI_ERROR_POLICY.cli_internal.fixedMessage,
        exitCode: 9,
      });
      expect(calls).toBe(0);
    },
  );

  it.each([
    new CorruptRunEventError('run-safe', 1, 'node:started', undefined),
    new UnreadableRunEventLogError('run-safe', [1]),
    new EngineStateError('unknown_run', 'safe'),
    new AgentParseError('agent_validation', 'safe'),
    new WorkflowSyntaxError('safe'),
    new CliError('internal', 'safe'),
  ])(
    'case %#: refuses accessor messages on known mutable typed errors without executing them',
    (value) => {
      let calls = 0;
      Object.defineProperty(value, 'message', {
        get: () => {
          calls += 1;
          return 'PRIVATE_GETTER';
        },
      });
      expect(toUserFacing(value).code).toBe('cli_internal');
      expect(toUserFacing(value).exitCode).toBe(9);
      expect(calls).toBe(0);
    },
  );

  it('does not invoke inherited code accessors or coerce their arbitrary values', () => {
    let calls = 0;
    const value = new Error('PRIVATE_UNKNOWN');
    const inherited: unknown = Object.create(Error.prototype, {
      code: {
        get: () => {
          calls += 1;
          return 'corrupt_run_event';
        },
      },
    });
    if (typeof inherited !== 'object' || inherited === null)
      throw new Error('Missing test prototype');
    Object.setPrototypeOf(value, inherited);
    expect(toUserFacing(value).code).toBe('cli_internal');
    expect(calls).toBe(0);
  });

  it.each(['getPrototypeOf', 'getOwnPropertyDescriptor'] as const)(
    'reflection trap %s becomes a fixed infrastructure diagnostic',
    (trap) => {
      const value = new Proxy(new Error('PRIVATE_PROXY_BYTES'), {
        [trap]: () => {
          throw new Error('PRIVATE_REFLECTION');
        },
      });
      expect(toUserFacing(value)).toEqual({
        code: 'cli_internal',
        message: CLI_ERROR_POLICY.cli_internal.fixedMessage,
        exitCode: 9,
      });
    },
  );

  it('refuses a mutated public CliError code and derives valid-code exit only from policy', () => {
    const value = new CliError('internal', 'known refusal');
    Object.defineProperty(value, 'code', { value: '__proto__' });
    expect(toUserFacing(value).code).toBe('cli_internal');
    expect(toUserFacing(value).exitCode).toBe(9);
    Object.defineProperty(value, 'code', { value: 'storage_unavailable' });
    Object.defineProperty(value, 'exitCode', { value: 0 });
    expect(toUserFacing(value).exitCode).toBe(1);
  });

  it.each(['corrupt_run_event', 'unreadable_run_event_log'])(
    'retains stable own-data %s history compatibility from another bundle',
    (code) => {
      const value = Object.assign(new Error('safe history reason'), { code });
      expect(toUserFacing(value).code).toBe('internal');
      expect(toUserFacing(value).exitCode).toBe(1);
    },
  );
});
