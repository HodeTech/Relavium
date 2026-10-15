import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { schemaIssueReason } from './schema-issue.js';

describe('shared parser issue reasons', () => {
  it('describes a schema literal, never the received value', () => {
    const result = z.literal('1.0').safeParse('private-received-sentinel');
    if (result.success) throw new Error('literal mismatch must reject');
    expect(result.error.issues.map(schemaIssueReason)).toEqual(['expected literal "1.0"']);
  });

  it('handles non-string literals without JSON serialization exceptions', () => {
    const result = z.literal(42n).safeParse(43n);
    if (result.success) throw new Error('literal mismatch must reject');
    expect(result.error.issues.map(schemaIssueReason)).toEqual(['expected literal 42']);
  });

  it('retains field-useful reasons while excluding received enum values', () => {
    const result = z
      .object({ mode: z.enum(['one', 'two']), count: z.number() })
      .safeParse({ mode: 'private-received-sentinel' });
    if (result.success) throw new Error('missing count and wrong mode must reject');
    expect(result.error.issues.map(schemaIssueReason)).toEqual([
      'invalid value — expected one of: one, two',
      'missing — expected number',
    ]);
  });
});
