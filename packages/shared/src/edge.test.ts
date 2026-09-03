import { describe, expect, it } from 'vitest';

import { EdgeSchema } from './edge.js';

const accepts = (edge: unknown): boolean => EdgeSchema.safeParse(edge).success;

describe('EdgeSchema', () => {
  it('accepts a plain node-to-node edge', () => {
    expect(accepts({ from: 'input', to: 'fan-out' })).toBe(true);
  });

  it('accepts a branch-handle source (nodeId:handle)', () => {
    expect(accepts({ from: 'severity-gate:true', to: 'human-approval' })).toBe(true);
    expect(accepts({ from: 'severity-gate:7', to: 'escalate' })).toBe(true);
  });

  it('accepts an optional label', () => {
    expect(accepts({ from: 'a', to: 'b', label: 'ok' })).toBe(true);
  });

  it('REJECTS an edge `condition` — the field was accepted and read by nothing', () => {
    // This test used to pin `condition: 'x > 1'` as ACCEPTED, and it was right about the schema and
    // wrong about the contract: three canonical documents said the field gated its edge, and the engine
    // never read it. An author could write a routing rule, watch it parse, and get an edge that was
    // always followed. The old assertion is replaced rather than deleted so the history is legible —
    // what changed is the contract, not a typo (ADR-0093 §3, §4).
    expect(accepts({ from: 'a', to: 'b', condition: 'x > 1' })).toBe(false);
    // …and it is refused even when it would have been trivially true, because the point is that nothing
    // evaluates it at all — not that this particular expression is unsupported.
    expect(accepts({ from: 'a', to: 'b', condition: 'true' })).toBe(false);
    const issue = EdgeSchema.safeParse({ from: 'a', to: 'b', condition: 'x > 1' });
    expect(issue.success).toBe(false);
    if (!issue.success) {
      const [first] = issue.error.issues;
      expect(first?.path).toEqual(['condition']);
      // Points at the replacement, and does NOT echo the authored expression (error-handling.md).
      expect(first?.message).toContain('`condition` node');
      expect(first?.message).not.toContain('x > 1');
    }
  });

  it('rejects a non-kebab-case target', () => {
    expect(accepts({ from: 'a', to: 'My Node' })).toBe(false);
    expect(accepts({ from: 'a', to: 'Node_2' })).toBe(false);
    expect(accepts({ from: 'a', to: 'a:handle' })).toBe(false); // `to` may not carry a handle
  });

  it('rejects a malformed source node id', () => {
    expect(accepts({ from: 'Bad From', to: 'b' })).toBe(false);
    expect(accepts({ from: 'UPPER', to: 'b' })).toBe(false);
  });

  it('rejects missing from / to', () => {
    expect(accepts({ to: 'b' })).toBe(false);
    expect(accepts({ from: 'a' })).toBe(false);
    expect(accepts({})).toBe(false);
  });

  it('pins the branch-handle grammar: empty handle rejects, any non-empty handle is accepted', () => {
    // The handle after `:` is a condition branch `when` value resolved by the engine, so it is
    // deliberately permissive (`.+`) — but a trailing colon with no handle is malformed.
    expect(accepts({ from: 'severity-gate:', to: 'b' })).toBe(false); // empty handle
    expect(accepts({ from: 'severity-gate:UPPER', to: 'b' })).toBe(true); // permissive value
    expect(accepts({ from: 'severity-gate:a:b', to: 'b' })).toBe(true); // colons inside the handle
  });
});
