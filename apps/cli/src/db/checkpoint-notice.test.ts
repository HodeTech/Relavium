import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import * as processOutput from '../process/io.js';
import { openLocalDb } from './open.js';
import { CHECKPOINT_DEFERRED } from './privacy-notice.js';
import { openHistoryStore } from '../history/open.js';
import { openHistoryReader } from '../history/reader.js';
import { openSessionStore } from '../history/session-open.js';
import { loadUserPricingOverlay } from '../engine/pricing-overlay.js';
import { parseWorkflow } from '@relavium/core';
import { withCommandLifetime } from '../process/command-lifetime.js';
import { chatListCommand } from '../commands/chat-list.js';
import * as databaseOpen from './open.js';

vi.mock('@relavium/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relavium/db')>();
  return {
    ...actual,
    runMigrations: (...args: Parameters<typeof actual.runMigrations>) => {
      actual.runMigrations(...args);
      // Real native creation/migrations; force only the physical-checkpoint disposition.
      return 'deferred';
    },
  };
});

afterEach(() => vi.restoreAllMocks());

describe('deferred-checkpoint notice ownership', () => {
  it.each(['healthy', 'throw', 'reject', 'held'] as const)(
    'actual management command retains its default SQLite notice: %s',
    async (mode) => {
      const home = mkdtempSync(join(tmpdir(), 'relavium-checkpoint-command-'));
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      const configPath = join(home, 'config.toml');
      writeFileSync(configPath, '');
      const f = invocationFixture();
      const captured = captureIo();
      let enter = (): void => undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const write = vi.fn((text: string): Promise<void> => {
        enter();
        if (mode === 'throw') throw new Error('SYNTHETIC_PRIVATE_COMMAND_NOTICE');
        if (mode === 'reject') return Promise.reject(new Error('SYNTHETIC_PRIVATE_COMMAND_NOTICE'));
        return mode === 'held' ? held : captured.io.writeErrAcknowledged(text);
      });
      const nativeOpen = databaseOpen.openLocalDb;
      let opened: ReturnType<typeof openLocalDb> | undefined;
      vi.spyOn(databaseOpen, 'openLocalDb').mockImplementation((...args) => {
        opened = nativeOpen(...args);
        return opened;
      });
      const borrowed = vi.spyOn(processOutput, 'processIo').mockImplementation(() => {
        throw new Error('SYNTHETIC_FORBIDDEN_AMBIENT_COMMAND_NOTICE');
      });
      let settled = false;
      const action = withCommandLifetime(
        {
          invocation: f.invocation,
          io: { ...captured.io, writeErrAcknowledged: write },
          global: { cwd: home, configPath, json: true, color: false, verbosity: 'normal' },
        },
        (owned) => Promise.resolve(chatListCommand(owned)),
      ).then(
        (value) => {
          settled = true;
          return { kind: 'value' as const, value };
        },
        (cause: unknown) => {
          settled = true;
          return { kind: 'failure' as const, cause };
        },
      );
      try {
        const first = await Promise.race([
          entered.then(() => 'notice'),
          action.then(() => 'command'),
        ]);
        expect(first, 'ACTUAL_COMMAND_ENTERS_ITS_CAPTURED_CHECKPOINT_NOTICE').toBe('notice');
        expect(write).toHaveBeenCalledExactlyOnceWith(`${CHECKPOINT_DEFERRED}\n`);
        expect(borrowed).not.toHaveBeenCalled();
        if (mode === 'held') {
          expect(settled, 'ACTUAL_COMMAND_RETAINS_PENDING_NOTICE_RECEIPT').toBe(false);
          expect(opened?.db.$client.open).toBe(true);
          expect(f.registry.activeOwners).toBeGreaterThan(0);
        }
        release();
        const outcome = await action;
        if (mode === 'throw' || mode === 'reject')
          expect(outcome).toMatchObject({
            kind: 'failure',
            cause: { code: 'output_unavailable', exitCode: 9 },
          });
        else expect(outcome).toEqual({ kind: 'value', value: 0 });
        expect(opened?.db.$client.open).toBe(false);
        expect(f.registry.activeOwners).toBe(0);
        expect(f.registry.observations.exitCode()).toBe(
          mode === 'throw' || mode === 'reject' ? 9 : 0,
        );
        expect(captured.out()).toBe('');
        expect(captured.err()).not.toContain('SYNTHETIC_PRIVATE_COMMAND_NOTICE');
      } finally {
        release();
        await action;
        await f.registry.terminate({ kind: 'normal' });
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each(
    [false, true].flatMap((owned) =>
      (['healthy', 'throw', 'reject', 'held'] as const).map((mode) => ({ owned, mode })),
    ),
  )('captured writer: owned=$owned mode=$mode', async ({ owned, mode }) => {
    const home = mkdtempSync(join(tmpdir(), 'relavium-checkpoint-notice-'));
    const f = invocationFixture();
    const captured = captureIo();
    const cause = new Error('SYNTHETIC_PRIVATE_CHECKPOINT_NOTICE');
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.fn((text: string): Promise<void> => {
      expect(text).toBe(`${CHECKPOINT_DEFERRED}\n`);
      if (mode === 'throw') throw cause;
      if (mode === 'reject') return Promise.reject(cause);
      if (mode === 'held') return held;
      return captured.io.writeErrAcknowledged(text);
    });
    const io = { ...captured.io, writeErrAcknowledged: write };
    const borrowed = vi.spyOn(processOutput, 'processIo');
    let opened: ReturnType<typeof openLocalDb> | undefined;
    let closed = false;
    try {
      opened = openLocalDb(home, undefined, undefined, {
        io,
        invocation: owned ? f.invocation : undefined,
      });
      expect(opened.db.$client.open, 'NOTICE_FAILURE_DOES_NOT_CLOSE_CALLER_DATABASE').toBe(true);
      if (owned && mode === 'throw')
        expect(
          f.registry.termination,
          'SYNCHRONOUS_NOTICE_FAILURE_SEALS_BEFORE_OPEN_RETURNS',
        ).toBeDefined();
      expect(write, 'CAPTURED_NOTICE_SINK_RECEIVES_THE_ACTUAL_DELIVERY').toHaveBeenCalledTimes(1);
      expect(borrowed, 'CAPTURED_NOTICE_NEVER_BORROWS_PROCESS_STDERR').not.toHaveBeenCalled();
      opened.close();
      closed = true;
      expect(opened.db.$client.open).toBe(false);
      if (mode === 'held') {
        expect(f.registry.activeOwners, 'HELD_NOTICE_REMAINS_OWNED_AFTER_DATABASE_CLOSE').toBe(
          owned ? 1 : 0,
        );
        let joined = false;
        const termination = f.registry.terminate({ kind: 'normal' }).then(() => {
          joined = true;
        });
        await Promise.resolve();
        if (owned) expect(joined).toBe(false);
        release();
        await termination;
      } else {
        await vi.waitFor(() => expect(f.registry.activeOwners).toBe(0));
      }
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.exitCode(), 'ORIGINAL_NOTICE_FAILURE_IS_NOT_SUCCESS').toBe(
        owned && (mode === 'throw' || mode === 'reject') ? 9 : 0,
      );
      expect(f.registry.observations.infrastructureCode()).toBe(
        owned && (mode === 'throw' || mode === 'reject') ? 'output_unavailable' : undefined,
      );
      expect(captured.out()).toBe('');
      expect(captured.err()).toBe(mode === 'healthy' ? `${CHECKPOINT_DEFERRED}\n` : '');
    } finally {
      release();
      if (!closed) opened?.close();
      await f.registry.terminate({ kind: 'normal' });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(['throw', 'reject'] as const)(
    'an explicit notice callback is still invocation-owned: %s',
    async (mode) => {
      const home = mkdtempSync(join(tmpdir(), 'relavium-explicit-checkpoint-notice-'));
      const f = invocationFixture();
      const cause = new Error('SYNTHETIC_PRIVATE_EXPLICIT_NOTICE');
      const captured = captureIo();
      const notice = vi.fn(() => {
        if (mode === 'throw') throw cause;
        return Promise.reject(cause);
      });
      let opened: ReturnType<typeof openLocalDb> | undefined;
      try {
        opened = openLocalDb(home, notice, undefined, {
          io: captured.io,
          invocation: f.invocation,
        });
        expect(opened.db.$client.open).toBe(true);
        expect(notice).toHaveBeenCalledExactlyOnceWith(`${CHECKPOINT_DEFERRED}\n`);
        await f.registry.terminate({ kind: 'normal' });
        expect(f.registry.observations.exitCode()).toBe(9);
        expect(f.registry.observations.infrastructureCode()).toBe('output_unavailable');
        expect(f.registry.activeOwners).toBe(0);
        expect(captured.err()).toBe('');
      } finally {
        opened?.close();
        await f.registry.terminate({ kind: 'normal' });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each(
    (['run-history', 'session', 'reader', 'transient-pricing'] as const).flatMap((surface) =>
      [false, true].map((fault) => ({ surface, fault })),
    ),
  )(
    'actual default $surface factory forwards captured notice authority: fault=$fault',
    async ({ surface, fault }) => {
      const home = mkdtempSync(join(tmpdir(), 'relavium-checkpoint-factory-'));
      const f = invocationFixture();
      const captured = captureIo();
      const write = vi.fn((text: string): Promise<void> => {
        if (fault) throw new Error('SYNTHETIC_PRIVATE_FACTORY_NOTICE');
        return captured.io.writeErrAcknowledged(text);
      });
      const io = { ...captured.io, writeErrAcknowledged: write };
      const context = { io, invocation: f.invocation };
      const borrowed = vi.spyOn(processOutput, 'processIo').mockImplementation(() => {
        throw new Error('SYNTHETIC_FORBIDDEN_AMBIENT_NOTICE');
      });
      let close = (): void => undefined;
      let primary: { readonly cause: unknown } | undefined;
      try {
        try {
          switch (surface) {
            case 'run-history': {
              const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: synthetic
  nodes:
    - { id: start, type: input }
    - { id: end, type: output }
  edges:
    - { from: start, to: end }
`);
              const opened = openHistoryStore(workflow, home, home, undefined, context);
              expect(opened.db.$client.open).toBe(true);
              close = opened.close;
              break;
            }
            case 'session': {
              const opened = openSessionStore(home, undefined, context);
              expect(opened.db.$client.open).toBe(true);
              close = opened.close;
              break;
            }
            case 'reader': {
              const opened = openHistoryReader(home, undefined, undefined, context);
              close = opened.close;
              break;
            }
            case 'transient-pricing': {
              const overlay = loadUserPricingOverlay(home, io, f.invocation);
              if (!fault) expect(overlay).toBeDefined();
              break;
            }
          }
        } catch (cause) {
          primary = { cause };
        } finally {
          close();
        }
        expect(
          write,
          'DEFAULT_STORAGE_FACTORY_USES_CAPTURED_NOTICE_SINK',
        ).toHaveBeenCalledExactlyOnceWith(`${CHECKPOINT_DEFERRED}\n`);
        expect(borrowed).not.toHaveBeenCalled();
        if (!fault || surface !== 'transient-pricing') expect(primary).toBeUndefined();
        else expect(primary, 'FAILED_NOTICE_REFUSES_LATER_TRANSIENT_ENTRY').toBeDefined();
        await f.registry.terminate({ kind: 'normal' });
        expect(f.registry.activeOwners).toBe(0);
        expect(f.registry.observations.exitCode()).toBe(fault ? 9 : 0);
        expect(captured.out()).toBe('');
        expect(captured.err()).toBe(fault ? '' : `${CHECKPOINT_DEFERRED}\n`);
      } finally {
        await f.registry.terminate({ kind: 'normal' });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
