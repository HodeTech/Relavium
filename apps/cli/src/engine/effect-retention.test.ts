import {
  createClient,
  createEffectJournalStore,
  createSessionStore,
  runMigrations,
  SessionEffectTurnError,
  type DbClient,
} from '@relavium/db';
import { effectScope, type EffectCorrelation } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sanitizeInline } from '../render/sanitize.js';
import { captureIo } from '../test-support.js';
import { reconcileResumedSessionEffects, sweepOneShotSessionEffects } from './effect-retention.js';

let client: DbClient;
let count: number;
const journal = () =>
  createEffectJournalStore(client.db, { uuid: () => `e${String(++count)}`, now: () => count });
function effect(turn = 1, state: 'committed' | 'ambiguous' | 'prepared' = 'committed') {
  const correlation: EffectCorrelation = { kind: 'session', sessionId: 's1', turn };
  const identity = { scope: effectScope(correlation), slot: 0, toolId: 'run_command' };
  journal().prepare(
    identity,
    correlation,
    { providerAttempt: 1, toolCallId: `session-tool:${String(turn)}:0` },
    3,
    'digest',
  );
  if (state !== 'prepared') journal().settle(identity, state);
  return identity;
}
const rows = () => client.sqlite.prepare('SELECT * FROM run_effects').all();

beforeEach(() => {
  client = createClient();
  runMigrations(client.db);
  count = 0;
  createSessionStore(client.db).reserveOneShotEffectTurnKey('s1', 1);
});
afterEach(() => {
  vi.restoreAllMocks();
  client.sqlite.close();
});

describe('active session disclosure before exact retention (ADR-0098)', () => {
  it.each(['synchronous throw', 'promise rejection'] as const)(
    'keeps audit evidence when the fallback diagnostic writer fails with %s',
    async (failure) => {
      effect();
      const io = captureIo();
      const writeErrAcknowledged = vi.fn((): Promise<void> => {
        if (failure === 'synchronous throw') throw new Error('SECRET_DIAGNOSTIC_FAILURE');
        return Promise.reject(new Error('SECRET_DIAGNOSTIC_FAILURE'));
      });
      const deliverNotice = vi.fn(() => {
        throw new Error('SECRET_DISCLOSURE_FAILURE');
      });
      expect(() =>
        reconcileResumedSessionEffects({
          io: { ...io.io, writeErrAcknowledged },
          db: client.db,
          sessionId: 's1',
          sanitize: sanitizeInline,
          deliverNotice,
        }),
      ).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(deliverNotice).toHaveBeenCalledTimes(2);
      expect(writeErrAcknowledged).toHaveBeenCalledExactlyOnceWith(
        'warning: session effect disclosure could not be completed; audit evidence was retained.\n',
      );
      expect(rows()).toHaveLength(1);
      expect(io.out() + io.err()).toBe('');
    },
  );

  it.each(['omitted', 'discarded rejection'] as const)(
    'refuses a flush that falsely acknowledges publication (%s)',
    async (kind) => {
      effect();
      const io = captureIo();
      const notices: string[] = [];
      await reconcileResumedSessionEffects({
        io: io.io,
        db: client.db,
        sessionId: 's1',
        sanitize: sanitizeInline,
        deliverNotice: (text) => {
          notices.push(text);
          return text.startsWith('note:')
            ? Promise.reject(new Error('SECRET_OUTPUT'))
            : Promise.resolve();
        },
        flushNotice: async (publish) => {
          if (kind === 'discarded rejection') void publish?.();
          await Promise.resolve();
        },
      });
      expect(rows()).toHaveLength(1);
      expect(notices.at(-1)).toContain('audit evidence was retained');
      expect(notices.join('')).not.toContain('SECRET_OUTPUT');
    },
  );

  it('delivers before deletion, leaves unresolved evidence and discloses a committed incomplete turn once', () => {
    effect();
    effect(2, 'ambiguous');
    const io = captureIo();
    const notices: string[] = [];
    const reconcile = () =>
      void reconcileResumedSessionEffects({
        io: io.io,
        db: client.db,
        sessionId: 's1',
        sanitize: sanitizeInline,
        deliverNotice: (text) => {
          expect(rows()).toHaveLength(notices.length === 0 ? 2 : 1);
          notices.push(text);
        },
      });
    void reconcile();
    expect(notices[0]).toContain('landed in a turn that did not complete');
    expect(notices[0]).toContain('ambiguous');
    expect(rows()).toHaveLength(1);
    void reconcile();
    expect(notices[1]).not.toContain('landed in a turn that did not complete');
    expect(io.out()).toBe('');
  });

  it('never sweeps when the disclosure query fails and emits no driver or stored content', () => {
    effect();
    const prepare = client.sqlite.prepare.bind(client.sqlite);
    vi.spyOn(client.sqlite, 'prepare').mockImplementation((query) => {
      if (query.startsWith('select') && query.includes('session_messages'))
        throw new Error('SECRET_DB_CONTENT /private/path');
      return prepare(query);
    });
    const io = captureIo();
    const notices: string[] = [];
    void reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId: 's1',
      sanitize: sanitizeInline,
      deliverNotice: (text) => {
        notices.push(text);
      },
    });
    expect(rows()).toHaveLength(1);
    expect(notices).toEqual([
      'warning: session effect disclosure could not be completed; audit evidence was retained.',
    ]);
    expect(io.err()).not.toContain('SECRET');
  });

  it('never sweeps a corrupt historical transcript, including one outside the resumable projection', () => {
    effect();
    client.sqlite
      .prepare(
        "INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, created_at) VALUES ('m1','s1',0,'assistant',?,0)",
      )
      .run('{SECRET_HISTORY');
    const io = captureIo();
    void reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId: 's1',
      sanitize: sanitizeInline,
      deliverNotice: (text) => io.io.writeErr(`${text}\n`),
    });
    expect(rows()).toHaveLength(1);
    expect(io.err()).toContain('audit evidence was retained');
    expect(io.err()).not.toContain('SECRET_HISTORY');
  });

  it('never sweeps when the active notice sink throws, even when the fallback warning also throws', () => {
    effect();
    const io = captureIo();
    const deliverNotice = vi.fn(() => {
      throw new Error('SECRET_OUTPUT');
    });
    void reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId: 's1',
      sanitize: sanitizeInline,
      deliverNotice,
    });
    expect(deliverNotice).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);
    expect(io.err()).toContain('audit evidence was retained');
    expect(io.err()).not.toContain('SECRET_OUTPUT');
  });

  it('rechecks active ownership after notice delivery, including a synchronous exit', () => {
    effect();
    const io = captureIo();
    let active = true;
    void reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId: 's1',
      sanitize: sanitizeInline,
      isActive: () => active,
      deliverNotice: () => {
        active = false;
      },
    });
    expect(rows()).toHaveLength(1);
    const deliverNotice = vi.fn();
    void reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId: 's1',
      sanitize: sanitizeInline,
      isActive: () => false,
      deliverNotice,
    });
    expect(deliverNotice).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it('does not delete a different committed effect created during disclosure delivery', () => {
    effect();
    const io = captureIo();
    void reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId: 's1',
      sanitize: sanitizeInline,
      deliverNotice: () => {
        effect(2);
      },
    });
    expect(rows()).toHaveLength(1);
    expect(journal().recordsFor({ kind: 'session', sessionId: 's1', turn: 2 })).toHaveLength(1);
  });

  it('routes a plain/JSON disclosure to stderr and preserves an unpolluted stdout stream', () => {
    effect();
    const io = captureIo();
    void reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId: 's1',
      sanitize: sanitizeInline,
      deliverNotice: (text) => io.io.writeErr(`${text}\n`),
    });
    expect(io.err()).toContain('They are NOT retried');
    expect(io.out()).toBe('');
    expect(rows()).toEqual([]);
  });

  it('sweeps a never-resumed one-shot without a completion transcript, retaining ambiguous and prepared rows', () => {
    effect();
    effect(2, 'prepared');
    effect(3, 'ambiguous');
    const io = captureIo();
    sweepOneShotSessionEffects(io.io, client.db, 's1');
    expect(rows()).toHaveLength(2);
    expect(io.err()).toBe('');
  });

  it.each(['flushed', 'exited', 'failed'] as const)(
    'awaits rendered notice acknowledgement before retention (%s)',
    async (result) => {
      effect();
      const io = captureIo();
      let active = true;
      let resolve: () => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const flushed = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void flushed.catch(() => undefined); // a rejected fixture stays handled even under a skipped-flush mutation.
      const notices: string[] = [];
      const done = reconcileResumedSessionEffects({
        io: io.io,
        db: client.db,
        sessionId: 's1',
        sanitize: sanitizeInline,
        isActive: () => active,
        deliverNotice: (text) => {
          notices.push(text);
        },
        flushNotice: (publish) => {
          void publish?.();
          return flushed;
        },
      });
      expect(notices[0]).toContain('landed in a turn that did not complete');
      await new Promise<void>((yes) => setImmediate(yes));
      expect(rows()).toHaveLength(1);
      effect(2); // a later commit while publication is pending is never part of the captured deletion.
      if (result === 'exited') active = false;
      if (result === 'failed') reject(new Error('SECRET_OUTPUT_FAILURE'));
      else resolve();
      await done;
      expect(rows()).toHaveLength(result === 'flushed' ? 1 : 2);
      expect(notices.join('')).not.toContain('SECRET_OUTPUT_FAILURE');
      if (result === 'failed') expect(notices.at(-1)).toContain('audit evidence was retained');
    },
  );
});

describe('legacy identity evidence across acknowledged activation retention', () => {
  const sessionId = 'legacy-activation';
  function legacy(malformed: boolean): void {
    createSessionStore(client.db).createSession({
      id: sessionId,
      agentSlug: 'chatter',
      context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
      status: 'active',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      totalConservativeMicrocents: 0,
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
    });
    createSessionStore(client.db).appendMessage({
      id: 'legacy-terminal',
      sessionId,
      sequenceNumber: 0,
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      timestamp: '2026-10-07T00:00:00.000Z',
    });
    for (const turn of [2, 99]) {
      const correlation: EffectCorrelation = { kind: 'session', sessionId, turn };
      const identity = { scope: effectScope(correlation), slot: 0, toolId: 'run_command' };
      journal().prepare(
        identity,
        correlation,
        { providerAttempt: 1, toolCallId: `session-tool:${String(turn)}:0` },
        3,
        'digest',
      );
      journal().settle(identity, 'committed');
    }
    if (malformed) {
      client.sqlite
        .prepare('UPDATE run_effects SET scope = ? WHERE scope = ?')
        .run(`session:${sessionId}:01`, `session:${sessionId}:2`);
      // Keep both previously used canonical identities in addition to the corrupt address.
      const correlation: EffectCorrelation = { kind: 'session', sessionId, turn: 2 };
      const identity = { scope: effectScope(correlation), slot: 0, toolId: 'run_command' };
      journal().prepare(
        identity,
        correlation,
        { providerAttempt: 1, toolCallId: 'session-tool:2:0' },
        3,
        'digest',
      );
      journal().settle(identity, 'committed');
    }
  }

  it('retains quarantined committed evidence after genuine acknowledged activation and refuses reissue', async () => {
    legacy(true);
    expect(() => runMigrations(client.db)).not.toThrow();
    const session = createSessionStore(client.db);
    expect(session.loadFull(sessionId)).toBeDefined();
    const before = rows();
    expect(() => session.reserveEffectTurnKey(sessionId)).toThrow(SessionEffectTurnError);
    const notices: string[] = [];
    const io = captureIo();
    await reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId,
      sanitize: sanitizeInline,
      isActive: () => true,
      deliverNotice: (text) => {
        notices.push(text);
      },
      flushNotice: async (publish) => {
        await publish?.();
      },
    });
    expect(rows()).toEqual(before);
    expect(notices.at(-1)).toBe(
      'warning: session effect identity history is invalid; audit evidence was retained and effect-turn allocation remains blocked.',
    );
    expect(() => session.reserveEffectTurnKey(sessionId)).toThrow(SessionEffectTurnError);
    expect(io.out() + io.err()).toBe('');
  });

  it('seeds a trustworthy floor atomically with acknowledged cleanup without requiring another open', async () => {
    legacy(false);
    const notices: string[] = [];
    const io = captureIo();
    await reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId,
      sanitize: sanitizeInline,
      deliverNotice: (text) => {
        notices.push(text);
      },
      flushNotice: async (publish) => {
        await publish?.();
      },
    });
    expect(rows()).toEqual([]);
    expect(notices.join('')).not.toContain('warning:');
    expect(createSessionStore(client.db).reserveEffectTurnKey(sessionId)).toBe(100);
  });
});
