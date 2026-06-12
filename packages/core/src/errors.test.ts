import { describe, expect, it } from 'vitest';

import {
  InterpolationError,
  WorkflowSecretLeakError,
  WorkflowSyntaxError,
  WorkflowValidationError,
  type SecretLeak,
  type WorkflowIssue,
} from './errors.js';

const issue = (field: string): WorkflowIssue => ({ field, message: 'bad' });

describe('WorkflowValidationError', () => {
  it('summarizes the first issue and counts the rest (plural)', () => {
    const err = new WorkflowValidationError([issue('a'), issue('b'), issue('c')]);
    expect(err.code).toBe('schema_validation');
    expect(err.message).toBe('a: bad (and 2 more issues)');
  });

  it('summarizes two issues with a singular "more" suffix', () => {
    expect(new WorkflowValidationError([issue('a'), issue('b')]).message).toBe(
      'a: bad (and 1 more issue)',
    );
  });

  it('summarizes a single issue with no "more" suffix', () => {
    expect(new WorkflowValidationError([issue('only')]).message).toBe('only: bad');
  });

  it('summarizes an empty issue list defensively', () => {
    expect(new WorkflowValidationError([]).message).toBe('workflow validation failed');
  });

  it('does not set a source when none is given', () => {
    expect(new WorkflowValidationError([issue('a')]).source).toBeUndefined();
  });
});

describe('WorkflowSyntaxError', () => {
  it('carries code, optional position, and the cause', () => {
    const cause = new Error('inner');
    const err = new WorkflowSyntaxError('bad yaml', { line: 4, column: 2, cause });
    expect(err.code).toBe('invalid_yaml');
    expect(err.line).toBe(4);
    expect(err.column).toBe(2);
    expect(err.cause).toBe(cause);
  });

  it('omits position fields when not provided', () => {
    const err = new WorkflowSyntaxError('bad yaml');
    expect(err.line).toBeUndefined();
    expect(err.column).toBeUndefined();
  });
});

describe('WorkflowSecretLeakError', () => {
  const leak = (over: Partial<SecretLeak> = {}): SecretLeak => ({
    location: 'node `n`.prompt_template',
    secret: 'inputs.api_key',
    ...over,
  });

  it('summarizes the first leak, names the field/symbol, and cites the ADR', () => {
    const err = new WorkflowSecretLeakError([leak()]);
    expect(err.code).toBe('secret_interpolation');
    expect(err.message).toBe(
      'node `n`.prompt_template interpolates the secret `inputs.api_key` — secrets are rejected from agent/human text (ADR-0029)',
    );
  });

  it('includes a `via` hop and a plural "more" suffix', () => {
    const err = new WorkflowSecretLeakError([
      leak({ secret: 'ctx.creds', via: 'inputs.api_key' }),
      leak(),
      leak(),
    ]);
    expect(err.message).toContain('the secret `ctx.creds` (via `inputs.api_key`)');
    expect(err.message).toContain('(and 2 more leaks)');
  });

  it('uses a singular "more leak" suffix for exactly two leaks', () => {
    expect(new WorkflowSecretLeakError([leak(), leak()]).message).toContain('(and 1 more leak)');
  });

  it('summarizes an empty leak list defensively', () => {
    expect(new WorkflowSecretLeakError([]).message).toBe('secret interpolation rejected');
  });

  it('omits a `via` that equals the secret (a direct, un-laundered reference)', () => {
    const err = new WorkflowSecretLeakError([leak({ via: 'inputs.api_key' })]);
    expect(err.message).not.toContain('(via');
  });
});

describe('InterpolationError', () => {
  it('carries a typed code and the offending reference as location', () => {
    const err = new InterpolationError('unknown_filter', 'unknown filter `nope`', {
      location: '{{inputs.x | nope}}',
    });
    expect(err.code).toBe('unknown_filter');
    expect(err.location).toBe('{{inputs.x | nope}}');
    expect(err.cause).toBeUndefined();
  });

  it('keeps a host error on cause and omits location when not given', () => {
    const cause = new Error('inner');
    const err = new InterpolationError('read_file_failed', 'read failed', { cause });
    expect(err.cause).toBe(cause);
    expect(err.location).toBeUndefined();
  });
});
