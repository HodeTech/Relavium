import { describe, expect, it } from 'vitest';

import {
  EngineStateError,
  isTransientEngineStateError,
  TRANSIENT_ENGINE_STATE_CODES,
} from './errors.js';

describe('EngineStateError', () => {
  it('keeps the public transient allowlist immutable and authoritative for API refusals', () => {
    expect(Reflect.set(TRANSIENT_ENGINE_STATE_CODES, 0, 'unknown_gate')).toBe(false);
    expect(Reflect.set(TRANSIENT_ENGINE_STATE_CODES, 'length', 0)).toBe(false);
    expect(isTransientEngineStateError(new EngineStateError('run_owned_elsewhere', ''))).toBe(true);
    expect(isTransientEngineStateError(new EngineStateError('unknown_gate', ''))).toBe(false);
  });
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
