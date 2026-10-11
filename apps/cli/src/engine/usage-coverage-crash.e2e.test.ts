import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@relavium/db';
import { isUsageCoverageComplete } from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import {
  atCut,
  reopen,
  startWorker,
  type Route,
} from './fixtures/usage-coverage-worker-control.js';

describe('ADR-0104 actual engine and CLI host process crashes', () => {
  for (const cap of ['uncapped', 'capped']) {
    for (const surface of ['run', 'session'] as const) {
      const routes: readonly Route[] =
        surface === 'session' ? ['primary', 'failover', 'summarizer'] : ['primary', 'failover'];
      for (const route of routes)
        for (const cut of ['pending', 'invoked', 'settled'] as const) {
          it(`${surface} ${cap} ${route}: kill after ${cut} before owner acknowledgement`, async () => {
            await atCut(surface, route, cut, cap, (state, barrier) => {
              const earlierPaid = route === 'summarizer' ? 2 : 0;
              const completed = cut === 'settled';
              // Sessions retain their two-attempt primary policy; workflow authored retry bounds it to one.
              const earlierUnknown = route === 'failover' ? (surface === 'session' ? 2 : 1) : 0;
              expect(state.coverage).toEqual({
                unverified: false,
                pendingInvocations: completed ? 0 : 1,
                unknownCalls: earlierUnknown,
              });
              expect(state.actual).toBe(7 * (earlierPaid + Number(completed)));
              expect(state.calls).toBe(earlierPaid + Number(completed));
              expect(barrier.invocations).toBe(
                earlierPaid + earlierUnknown + Number(cut !== 'pending'),
              );
              const model = route === 'failover' ? 'usage-fallback' : 'usage-primary';
              expect(state.models.find((entry) => entry.model === model)?.coverage).toEqual({
                unverified: false,
                pendingInvocations: completed ? 0 : 1,
                unknownCalls: 0,
              });
              expect(isUsageCoverageComplete(state.coverage)).toBe(
                completed && route !== 'failover',
              );
            });
          }, 20_000);
        }
      for (const cut of ['credentials', 'cancel-before-invoke'] as const) {
        it(`${surface} ${cap}: ${cut} after durable pending releases uncertainty without money`, async () => {
          await atCut(surface, 'primary', cut, cap, (state, barrier) => {
            // A model coverage row survives retirement only if pending admission really happened.
            expect(state.models).toEqual([
              {
                model: 'usage-primary',
                coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
              },
            ]);
            expect(barrier.invocations).toBe(0);
            expect(state.actual).toBe(0);
            expect(state.calls).toBe(0);
            expect(state.coverage).toEqual({
              unverified: false,
              pendingInvocations: 0,
              unknownCalls: 0,
            });
          });
        }, 20_000);
      }
      it(`${surface} ${cap}: native pending write refusal proves zero provider invocations`, async () => {
        await atCut(surface, 'primary', 'refuse-pending', cap, (state, barrier) => {
          expect(barrier.invocations).toBe(0);
          expect(state.actual).toBe(0);
          expect(state.calls).toBe(0);
          expect(state.coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: 0,
          });
        });
      }, 20_000);
    }
  }
  for (const cap of ['uncapped', 'capped']) {
    for (const cut of [
      'late-receipt',
      'late-missing',
      'late-partial',
      'late-invalid',
      'late-rejected',
    ] as const) {
      it(`session ${cap} ${cut}: a final raw read settles or retires interrupted uncertainty exactly once`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'relavium-usage-late-receipt-'));
        const path = join(root, 'history.db');
        const worker = startWorker(path, 'session', 'primary', cut, cap);
        try {
          const entered = await worker.ready;
          expect(entered.kind).toBe('ENTERED');
          expect(entered.invocations).toBe(1);
          worker.child.stdin.write('ABORT\n');
          await worker.waitFor('INTERRUPTED');
          const interrupted = reopen(path, 'session', entered.ownerId);
          expect(interrupted.coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: 1,
          });
          expect(interrupted.actual).toBe(0);
          expect(interrupted.calls).toBe(0);
          if (cap === 'capped') expect(interrupted.conservative).toBeGreaterThan(0);
          else expect(interrupted.conservative).toBe(0);
          worker.child.stdin.end('RECEIPT\n');
          await worker.waitFor('DONE');
          const closed = await worker.closed;
          expect(closed.code, closed.error).toBe(0);
          const settled = reopen(path, 'session', entered.ownerId);
          expect(settled.coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: cut === 'late-receipt' ? 0 : 1,
          });
          expect(settled.actual).toBe(cut === 'late-receipt' ? 7 : 0);
          expect(settled.calls).toBe(cut === 'late-receipt' ? 1 : 0);
          expect(settled.conservative).toBe(interrupted.conservative);
          expect(reopen(path, 'session', entered.ownerId)).toEqual(settled);
        } finally {
          worker.child.kill('SIGKILL');
          await worker.closed;
          rmSync(root, { recursive: true, force: true });
        }
      }, 20_000);
    }
  }
  for (const cap of ['uncapped', 'capped'])
    for (const cut of ['lock-release', 'lock-hold'] as const) {
      it(`session ${cap}: pending ${cut} retries native SQLite before permitting egress`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'relavium-usage-lock-'));
        const path = join(root, 'history.db');
        const worker = startWorker(path, 'session', 'primary', cut, cap);
        let locker: ReturnType<typeof createClient> | undefined;
        try {
          const ready = await worker.ready;
          expect(ready.kind).toBe('LOCK_READY');
          locker = createClient(path);
          locker.sqlite.exec('BEGIN IMMEDIATE');
          worker.child.stdin.write('PROCEED\n');
          await worker.waitFor('BUSY');
          if (cut === 'lock-release') locker.sqlite.exec('COMMIT');
          const done = await worker.waitFor('DONE');
          if (cut === 'lock-hold') locker.sqlite.exec('ROLLBACK');
          worker.child.stdin.end();
          const closed = await worker.closed;
          expect(closed.code, closed.error).toBe(0);
          expect(done.invocations).toBe(cut === 'lock-release' ? 1 : 0);
          const state = reopen(path, 'session', ready.ownerId);
          expect(state.actual).toBe(cut === 'lock-release' ? 7 : 0);
          expect(state.calls).toBe(cut === 'lock-release' ? 1 : 0);
          expect(state.coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: 0,
          });
        } finally {
          worker.child.kill('SIGKILL');
          await worker.closed;
          if (locker?.sqlite.inTransaction) locker.sqlite.exec('ROLLBACK');
          locker?.sqlite.close();
          rmSync(root, { recursive: true, force: true });
        }
      }, 20_000);
    }
  it('causal control: bypassing the actual pending append destroys the invoked-crash coverage proof', async () => {
    await atCut('run', 'primary', 'omit-pending', 'uncapped', (state, barrier) => {
      expect(barrier.invocations).toBe(1);
      expect(state.actual).toBe(0);
      // Deliberately lowered host: the positive crash assertion (pending=1) would fail.
      expect(state.coverage.pendingInvocations).toBe(0);
      expect(isUsageCoverageComplete(state.coverage)).toBe(true);
    });
  }, 20_000);
});
