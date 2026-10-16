import { RelaviumError } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  isProviderHeaderPolicyError,
  isUnreadableRunEventLogError,
  MediaEgressError,
  MediaWriteError,
  ModelCatalogCapabilitiesError,
  ProviderHeaderPolicyError,
  SafeEgressError,
  UnreadableRunEventLogError,
} from './index.js';

describe('database error family compatibility', () => {
  it('preserves optional native ErrorOptions on the catalog error without inventing a code', () => {
    const absent = new ModelCatalogCapabilitiesError('invalid capabilities');
    const explicit = new ModelCatalogCapabilitiesError('invalid capabilities', {
      cause: undefined,
    });
    const cause = new SyntaxError('invalid JSON');
    const wrapped = new ModelCatalogCapabilitiesError('invalid capabilities', { cause });
    expect(absent).toBeInstanceOf(Error);
    expect(absent).toBeInstanceOf(RelaviumError);
    expect(absent).toMatchObject({
      name: 'ModelCatalogCapabilitiesError',
      message: 'invalid capabilities',
    });
    expect(Object.hasOwn(absent, 'cause')).toBe(false);
    expect(Object.hasOwn(explicit, 'cause')).toBe(true);
    expect(explicit.cause).toBeUndefined();
    expect(wrapped.cause).toBe(cause);
    expect(Object.hasOwn(wrapped, 'code')).toBe(false);
  });

  it('preserves code-free write errors and the public egress alias identity', () => {
    const write = new MediaWriteError('filesystem write failed');
    expect(write).toBeInstanceOf(RelaviumError);
    expect(write).toMatchObject({ name: 'MediaWriteError', message: 'filesystem write failed' });
    expect(Object.hasOwn(write, 'code')).toBe(false);
    expect(Object.hasOwn(write, 'cause')).toBe(false);
    expect(MediaEgressError).toBe(SafeEgressError);
    const egress = new MediaEgressError('network', 'connection failed');
    expect(egress).toBeInstanceOf(RelaviumError);
    expect(egress).toBeInstanceOf(SafeEgressError);
    expect(egress).toMatchObject({
      name: 'SafeEgressError',
      code: 'network',
      message: 'connection failed',
    });
  });

  it('preserves unreadable-log context and recognizes a simulated foreign error identity', () => {
    const sequences = Object.freeze([2, 4]);
    const error = new UnreadableRunEventLogError('run-1', sequences);
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toMatchObject({
      name: 'UnreadableRunEventLogError',
      code: 'unreadable_run_event_log',
      runId: 'run-1',
    });
    expect(error.skippedSequenceNumbers).toBe(sequences);
    // Independently defined simulation; no actual second package bundle is loaded here.
    class ForeignUnreadableRunEventLogError extends Error {
      readonly code = 'unreadable_run_event_log';
    }
    const foreign = new ForeignUnreadableRunEventLogError('cannot replay');
    expect(foreign).not.toBeInstanceOf(UnreadableRunEventLogError);
    expect(foreign).not.toBeInstanceOf(RelaviumError);
    expect(isUnreadableRunEventLogError(foreign)).toBe(true);
    expect(isUnreadableRunEventLogError({ code: 'unreadable_run_event_log' })).toBe(false);
    expect(isUnreadableRunEventLogError(new Error('cannot replay'))).toBe(false);
  });

  it('retains the fixed local provider-header diagnostic without cause or context additions', () => {
    const error = new ProviderHeaderPolicyError();
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toMatchObject({
      name: 'ProviderHeaderPolicyError',
      code: 'provider_header_policy',
    });
    expect(isProviderHeaderPolicyError(error)).toBe(true);
    expect(Object.hasOwn(error, 'cause')).toBe(false);
    expect(Object.hasOwn(error, 'context')).toBe(false);
  });
});
