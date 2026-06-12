import { describe, expect, it } from 'vitest';

import { WorkflowSyntaxError, WorkflowValidationError, type WorkflowIssue } from './errors.js';

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
