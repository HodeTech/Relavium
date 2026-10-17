import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { CommandLifetime } from '../process/command-lifetime.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { openLocalDb } from './open.js';

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('original database acquisition also owns the separate native migration lock', () => {
  it.each(['storage', 'opaque', 'native'] as const)(
    'retains failed lock release and signals without operational laundering (%s)',
    async (kind) => {
      const home = mkdtempSync(join(tmpdir(), 'relavium-migration-custody-'));
      const f = invocationFixture();
      const removeSignals = vi.fn();
      const lifetime = new CommandLifetime(f.invocation, captureIo().io, () => removeSignals);
      const nativeClose: unknown = Object.getOwnPropertyDescriptor(
        Database.prototype,
        'close',
      )?.value;
      if (typeof nativeClose !== 'function')
        throw new Error('Native close fixture is unavailable.');
      const nativeExec: unknown = Object.getOwnPropertyDescriptor(
        Database.prototype,
        'exec',
      )?.value;
      if (typeof nativeExec !== 'function') throw new Error('Native exec fixture is unavailable.');
      const handles: { main?: Database.Database; lock?: Database.Database } = {};
      let iterator: ReturnType<Database.Statement['iterate']> | undefined;
      let closeFailure: unknown;
      let lockCloseAttempts = 0;
      const exec = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
        this: Database.Database,
        sql: string,
      ) {
        Reflect.apply(nativeExec, this, [sql]);
        if (kind === 'native' && this.name.endsWith('.migrate.lock') && sql === 'BEGIN EXCLUSIVE') {
          handles.lock = this;
          iterator = this.prepare('SELECT 1 AS value').iterate();
          iterator.next(); // Actual native busy-close refusal, not a replacement Error.
        }
        return this;
      });
      const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
        this: Database.Database,
      ) {
        if (this.name.endsWith('.migrate.lock')) {
          handles.lock = this;
          lockCloseAttempts++;
          try {
            if (kind === 'storage')
              throw new Database.SqliteError('synthetic lock close refusal', 'SQLITE_IOERR_CLOSE');
            if (kind === 'opaque') throw new Error('synthetic lock close refusal');
            Reflect.apply(nativeClose, this, []);
            return this;
          } catch (cause) {
            closeFailure = cause;
            throw cause;
          }
        }
        handles.main = this;
        Reflect.apply(nativeClose, this, []);
        return this;
      });
      let settled = false;
      const action = lifetime.execute(async () => {
        lifetime.acquire((capture) => openLocalDb(home, () => {}, capture));
        await Promise.resolve();
        return 0;
      });
      void action.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await reactions();
        expect(handles.main).toBeInstanceOf(Database);
        expect(handles.lock).toBeInstanceOf(Database);
        expect(handles.main).not.toBe(handles.lock);
        expect(handles.main?.open, 'LOCK_FAILURE_DOES_NOT_SKIP_INDEPENDENT_MAIN_RELEASE').toBe(
          false,
        );
        expect(handles.lock?.open).toBe(true);
        if (kind === 'native') expect(closeFailure).toBeInstanceOf(TypeError);
        else expect(handles.lock?.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
        expect(settled, 'MIGRATION_LOCK_NATIVE_CLOSE_REMAINS_ORIGINAL_OWNER_OBLIGATION').toBe(
          false,
        );
        expect(f.registry.activeOwners).toBe(1);
        expect(lockCloseAttempts).toBe(3); // Lock scope, opener recovery, original owner's cleanup.
        expect(removeSignals).not.toHaveBeenCalled();
        expect(f.registry.observations.exitCode(), 'FAILED_LOCK_CLOSE_IS_INFRASTRUCTURE').toBe(9);
        expect(f.registry.budget.deadline()).toBe(3000);
        f.advance(3000);
        expect(await f.invocation.finiteExit.exited).toBe(9);
        expect(handles.lock?.open).toBe(true);
        expect(f.registry.activeOwners).toBe(1);
        expect(removeSignals).not.toHaveBeenCalled();
      } finally {
        exec.mockRestore();
        close.mockRestore();
        iterator?.return?.();
        // Harness disposal is not an acknowledgement to the still-uncertain product owner.
        if (handles.lock?.open) Reflect.apply(nativeClose, handles.lock, []);
        if (handles.main?.open) Reflect.apply(nativeClose, handles.main, []);
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('later actual release cannot erase an earlier lock cleanup infrastructure failure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relavium-migration-retry-'));
    const f = invocationFixture();
    const removeSignals = vi.fn();
    const lifetime = new CommandLifetime(f.invocation, captureIo().io, () => removeSignals);
    const nativeClose: unknown = Object.getOwnPropertyDescriptor(
      Database.prototype,
      'close',
    )?.value;
    if (typeof nativeClose !== 'function') throw new Error('Native close fixture is unavailable.');
    const handles: { main?: Database.Database; lock?: Database.Database } = {};
    let lockAttempts = 0;
    const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
      this: Database.Database,
    ) {
      if (this.name.endsWith('.migrate.lock')) {
        handles.lock = this;
        if (++lockAttempts === 1)
          throw new Database.SqliteError('synthetic first release failure', 'SQLITE_IOERR_CLOSE');
      } else handles.main = this;
      Reflect.apply(nativeClose, this, []);
      return this;
    });
    try {
      await expect(
        lifetime.execute(async () => {
          lifetime.acquire((capture) => openLocalDb(home, () => {}, capture));
          await Promise.resolve();
          return 0;
        }),
      ).rejects.toMatchObject({ code: 'cli_internal', exitCode: 9 });
      expect(lockAttempts).toBe(2);
      expect(handles.lock?.open).toBe(false);
      expect(handles.main?.open).toBe(false);
      expect(f.registry.activeOwners).toBe(0);
      expect(removeSignals).toHaveBeenCalledOnce();
      expect(f.registry.observations.exitCode()).toBe(9);
    } finally {
      close.mockRestore();
      if (handles.lock?.open) Reflect.apply(nativeClose, handles.lock, []);
      if (handles.main?.open) Reflect.apply(nativeClose, handles.main, []);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('transfers one composite before either connection setup and returns that same capability', () => {
    const home = mkdtempSync(join(tmpdir(), 'relavium-migration-composite-'));
    const nativePragma: unknown = Object.getOwnPropertyDescriptor(
      Database.prototype,
      'pragma',
    )?.value;
    if (typeof nativePragma !== 'function')
      throw new Error('Native pragma fixture is unavailable.');
    const capture = vi.fn<(close: () => void) => void>();
    const handles = new Set<Database.Database>();
    const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      ...args: Parameters<Database.Database['pragma']>
    ) {
      expect(capture, 'DATABASE_COMPOSITE_PRECEDES_EVERY_NATIVE_SETUP').toHaveBeenCalledOnce();
      handles.add(this);
      return Reflect.apply(nativePragma, this, args);
    });
    let opened: ReturnType<typeof openLocalDb> | undefined;
    try {
      opened = openLocalDb(home, () => {}, capture);
      expect(handles.size).toBe(2);
      expect(capture).toHaveBeenCalledExactlyOnceWith(opened.close);
      expect([...handles].filter((handle) => handle.open)).toEqual([opened.db.$client]);
      opened.close();
      expect([...handles].every((handle) => !handle.open)).toBe(true);
      expect(() => opened?.close()).not.toThrow();
    } finally {
      pragma.mockRestore();
      opened?.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
