/**
 * The Home's status line after a read of its facts THROWS (MVP-11 unit 7, round 1: SE72). The reader is a strict configuration reload; one that
 * lands on a half-saved file fails, and the next chat then refuses to start (the starting mode's authority was revoked as a side effect). The
 * line must never claim what the next chat will not do, so a failed read drops the facts (the status row is drawn blank) instead of keeping the
 * ones read before it; the next read that succeeds puts them back. The reads happen only at the controller's refresh points: here a provider
 * state change, the one a test can drive without a popup.
 */
import { describe, expect, it } from 'vitest';

import type { HomeStatusFacts } from '../../home/home-status-facts.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createHomeController } from './home-controller.js';

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const AUTO: HomeStatusFacts = {
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  mode: 'auto',
  directory: '~/acme',
};
const ASK: HomeStatusFacts = { ...AUTO, mode: 'ask' };

function rig(reads: readonly (HomeStatusFacts | Error)[]) {
  let at = 0;
  const controller = createHomeController({
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    statusFacts: {
      read: () => {
        const next = reads[Math.min(at, reads.length - 1)];
        at += 1;
        if (next === undefined || next instanceof Error) throw next ?? new Error('no read');
        return next;
      },
    },
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  return {
    status: () => controller.getSnapshot().status,
    /** One refresh point: a provider run finished (the facts are read again). */
    refresh: (): void => controller.setProviderState(false),
  };
}

describe('a read of the status facts that throws', () => {
  it('drops the facts the line had: it never keeps saying `auto mode` for a chat that will not start', () => {
    const r = rig([AUTO, new Error('strict reload failed')]);
    expect(r.status()).toEqual(AUTO);
    r.refresh();
    expect(r.status()).toBeUndefined();
  });

  it('the next read that succeeds puts the facts back, as they are now', () => {
    const r = rig([AUTO, new Error('strict reload failed'), ASK]);
    r.refresh();
    expect(r.status()).toBeUndefined();
    r.refresh();
    expect(r.status()).toEqual(ASK);
  });

  it('a first read that throws leaves the line blank from the start', () => {
    const r = rig([new Error('strict reload failed'), AUTO]);
    expect(r.status()).toBeUndefined();
    r.refresh();
    expect(r.status()).toEqual(AUTO);
  });
});
