/**
 * The one predicate behind both the popup host's open gate and the release step's answer ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): each fact alone makes it true, and nothing makes it false but all of them being clear.
 */
import { describe, expect, it } from 'vitest';

import { turnInFlight, type TurnFacts } from './turn-in-flight.js';

const CLEAR: TurnFacts = { running: false, shellBusy: false, submitBusy: false };

describe('turnInFlight', () => {
  it('is false when nothing is in flight, with or without the Home’s native-action fact', () => {
    expect(turnInFlight(CLEAR)).toBe(false);
    expect(turnInFlight({ ...CLEAR, nativeActionBusy: false })).toBe(false);
    expect(turnInFlight({ ...CLEAR, nativeActionBusy: undefined })).toBe(false);
  });

  it.each([
    ['a turn streaming', { running: true }],
    ['a `!` command', { shellBusy: true }],
    ['a submit settling (the auto-compaction after a turn)', { submitBusy: true }],
    ['a native action holding the keyboard', { nativeActionBusy: true }],
  ] as const)('is true for %s alone', (_name, patch) => {
    expect(turnInFlight({ ...CLEAR, ...patch })).toBe(true);
  });
});
