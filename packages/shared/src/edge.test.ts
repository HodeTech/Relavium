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

  it('accepts optional label and condition', () => {
    expect(accepts({ from: 'a', to: 'b', label: 'ok', condition: 'x > 1' })).toBe(true);
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
});
