import { describe, expect, it } from 'vitest';

import { colorProps, nodeSuffix } from './projection.js';
import type { NodeView } from './run-view-model.js';

const node = (over: Partial<NodeView> & Pick<NodeView, 'status'>): NodeView => ({
  nodeId: 'a',
  ...over,
});

describe('colorProps', () => {
  it('includes the color only when enabled (omitted under --no-color, never explicit undefined)', () => {
    expect(colorProps(true, 'green')).toEqual({ color: 'green' });
    expect(colorProps(false, 'green')).toEqual({}); // no `color` key at all
    expect('color' in colorProps(false, 'green')).toBe(false);
  });
});

describe('nodeSuffix', () => {
  it('shows the duration for a completed node', () => {
    expect(nodeSuffix(node({ status: 'completed', durationMs: 420 }))).toBe(' (420ms)');
  });
  it('shows the error code for a failed node', () => {
    expect(nodeSuffix(node({ status: 'failed', errorCode: 'provider_unavailable' }))).toBe(
      ' — provider_unavailable',
    );
  });
  it('shows the attempt for a retrying node', () => {
    expect(nodeSuffix(node({ status: 'retrying', attempt: 2 }))).toBe(' (retry 2)');
  });
  it('is empty for a pending/running node or when the detail is absent', () => {
    expect(nodeSuffix(node({ status: 'running' }))).toBe('');
    expect(nodeSuffix(node({ status: 'pending' }))).toBe('');
    expect(nodeSuffix(node({ status: 'completed' }))).toBe(''); // no durationMs
  });
});
