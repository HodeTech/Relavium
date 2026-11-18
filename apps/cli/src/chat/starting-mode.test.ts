import type { ConfirmActionHook } from '@relavium/core';
import type { ChatMode } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  StartingModeAuthority,
  assertStartingModeDispatch,
  bindStartingModePolicy,
  type StartingModePreference,
} from './starting-mode.js';

function preference(mode: ChatMode): StartingModePreference {
  return { mode, globalMode: mode, source: 'global', hintShown: false };
}
const governed = new Set(['write_file']);
const hook = (): ConfirmActionHook => () => Promise.resolve({ outcome: 'approve' });

describe('invocation starting-auto authority', () => {
  it('revokes an old configured turn before a failed narrower replacement and never reloads it', () => {
    const authority = new StartingModeAuthority(true, preference('auto'));
    const prior = authority.resolve(() => preference('auto'));
    const confirm = hook();
    bindStartingModePolicy(confirm, prior);
    expect(() =>
      assertStartingModeDispatch(authority, confirm, 'write_file', governed),
    ).not.toThrow();
    authority.resolve(() => preference('ask'));
    // A replacement may fail later; retaining the old host must not recover its admission.
    expect(
      () => assertStartingModeDispatch(authority, confirm, 'write_file', governed),
      'W2_STARTUP_AUTO_DISPATCH_ADMISSION',
    ).toThrow('revoked');
    expect(() => authority.resolve(() => preference('auto'))).toThrow('no longer admitted');
    expect(() =>
      assertStartingModeDispatch(authority, confirm, 'read_file', governed),
    ).not.toThrow();
  });

  it('a later explicit mode uses a different hook without reauthorizing the old turn', () => {
    const authority = new StartingModeAuthority(true, preference('auto'));
    const oldHook = hook();
    bindStartingModePolicy(
      oldHook,
      authority.resolve(() => preference('auto')),
    );
    authority.revoke();
    const explicitHook = hook();
    bindStartingModePolicy(explicitHook, authority.explicit('auto'));
    expect(() =>
      assertStartingModeDispatch(authority, explicitHook, 'write_file', governed),
    ).not.toThrow();
    expect(
      () => assertStartingModeDispatch(authority, oldHook, 'write_file', governed),
      'W2_STARTUP_AUTO_DISPATCH_ADMISSION',
    ).toThrow('revoked');
    expect(() => authority.resolve(() => preference('auto'))).toThrow();
  });

  it('read failures revoke retained hosts and confirmed operator auto is the only re-admission', () => {
    const authority = new StartingModeAuthority(true, preference('auto'));
    const selection = authority.resolve(() => preference('auto'));
    expect(() =>
      authority.resolve(() => {
        throw new Error('unreadable configuration');
      }),
    ).toThrow('unreadable');
    expect(() => authority.assertDispatch(selection, 'write_file')).toThrow('revoked');
    expect(() => authority.resolve(() => preference('auto'))).toThrow();
    authority.admitConfirmedAutoDefault(authority.revocationRevision);
    expect(authority.resolve(() => preference('auto')).mode).toBe('auto');
  });

  it('a newly read auto cannot widen an initially narrower invocation', () => {
    const authority = new StartingModeAuthority(true, preference('ask'));
    expect(() => authority.resolve(() => preference('auto'))).toThrow();
    expect(authority.explicit('auto').mode).toBe('auto');
    expect(() => authority.resolve(() => preference('auto'))).toThrow();
  });

  it('headless modes remain ask while read validation and failure still run', () => {
    const authority = new StartingModeAuthority(false, preference('auto'));
    expect(authority.resolve(() => preference('auto')).mode).toBe('ask');
    expect(authority.explicit('auto').mode).toBe('ask');
    expect(() => authority.admitConfirmedAutoDefault(authority.revocationRevision)).toThrow(
      'interactive',
    );
    expect(() =>
      authority.resolve(() => {
        throw new Error('invalid configuration');
      }),
    ).toThrow('invalid');
  });

  it('refuses a missing, foreign or rebound turn hook for a governed action', () => {
    const authority = new StartingModeAuthority(true, preference('auto'));
    expect(() => assertStartingModeDispatch(authority, undefined, 'write_file', governed)).toThrow(
      'unavailable',
    );
    expect(() => assertStartingModeDispatch(authority, hook(), 'write_file', governed)).toThrow(
      'unavailable',
    );
    const foreign = new StartingModeAuthority(true, preference('auto'));
    const confirm = hook();
    bindStartingModePolicy(confirm, foreign.explicit('auto'));
    expect(() => assertStartingModeDispatch(authority, confirm, 'write_file', governed)).toThrow();
    expect(() => bindStartingModePolicy(confirm, authority.explicit('auto'))).toThrow(
      'already bound',
    );
  });
});
