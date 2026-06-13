import { describe, expect, it } from 'vitest';

import { EngineStateError } from './errors.js';

describe('EngineStateError', () => {
  it('carries the code discriminant and optional run/gate ids, narrowed on code not message', () => {
    const error = new EngineStateError('unknown_gate', 'no pending gate matches', {
      runId: 'run-1',
      gateId: 'gate-1',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EngineStateError');
    expect(error.code).toBe('unknown_gate');
    expect(error.runId).toBe('run-1');
    expect(error.gateId).toBe('gate-1');
  });

  it('omits absent ids and attaches a non-secret cause for logs', () => {
    const cause = new Error('underlying');
    const error = new EngineStateError('unknown_run', 'no run matches', { cause });
    expect(error.runId).toBeUndefined();
    expect(error.gateId).toBeUndefined();
    expect(error.cause).toBe(cause);
  });
});
