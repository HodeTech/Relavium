import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createRunPinStore,
  isRunPinError,
  MAX_PIN_REF_LENGTH,
  MAX_RUN_PINS,
  type RunPinStore,
} from './run-pins.js';
import { runPins } from './schema.js';

/**
 * The Home's pins (ADR-0140 §5): global to the home database, capped at fifty, keyed by `(kind, project_root,
 * ref)`. The cap is checked inside the insert's `BEGIN IMMEDIATE` transaction, so the second half of these tests
 * drives it from two connections to one file, the way two `relavium` processes would.
 */

const T0 = 1_780_000_000_000;

describe('createRunPinStore', () => {
  let client: DbClient;
  let store: RunPinStore;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createRunPinStore(client.db);
  });

  afterEach(() => {
    client.sqlite.close();
  });

  const runPin = (ref: string, at = T0) => ({ kind: 'run' as const, projectRoot: '', ref, at });
  const workflowPin = (projectRoot: string, ref: string, at = T0) => ({
    kind: 'workflow' as const,
    projectRoot,
    ref,
    at,
  });

  it('pins an item once and reports a repeat as already pinned', () => {
    expect(store.pinItem(runPin('run-1'))).toBe('pinned');
    expect(store.pinItem(runPin('run-1', T0 + 99))).toBe('already-pinned');
    expect(store.listPins()).toEqual([
      { kind: 'run', projectRoot: '', ref: 'run-1', pinnedAt: T0 }, // the first pin's time is kept
    ]);
  });

  it('keys a workflow pin by project and slug, so one slug in two projects is two pins', () => {
    expect(store.pinItem(workflowPin('/p1', 'deploy'))).toBe('pinned');
    expect(store.pinItem(workflowPin('/p2', 'deploy'))).toBe('pinned');
    expect(store.pinItem(workflowPin('/p1', 'deploy'))).toBe('already-pinned');
    expect(store.listPins({ kind: 'workflow', projectRoot: '/p1' })).toEqual([
      { kind: 'workflow', projectRoot: '/p1', ref: 'deploy', pinnedAt: T0 },
    ]);
    // A run with the same text as a slug is another pin altogether.
    expect(store.pinItem(runPin('deploy'))).toBe('pinned');
    expect(store.listPins()).toHaveLength(3);
  });

  it('refuses the fifty-first pin, and still answers already-pinned for one that exists at the cap', () => {
    for (let index = 0; index < MAX_RUN_PINS; index++) {
      expect(store.pinItem(runPin(`run-${index}`))).toBe('pinned');
    }
    expect(MAX_RUN_PINS).toBe(50);
    expect(store.pinItem(runPin('run-overflow'))).toBe('full');
    expect(store.pinItem(workflowPin('/p1', 'overflow'))).toBe('full');
    expect(store.listPins()).toHaveLength(MAX_RUN_PINS);
    // Re-pinning something already there is not a refusal, even with the table full.
    expect(store.pinItem(runPin('run-3'))).toBe('already-pinned');

    // Unpinning frees exactly one slot.
    expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: 'run-3' })).toBe(true);
    expect(store.pinItem(runPin('run-overflow'))).toBe('pinned');
    expect(store.pinItem(runPin('run-second-overflow'))).toBe('full');
  });

  it('unpins what exists and reports false for what does not', () => {
    store.pinItem(runPin('run-1'));
    expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: 'run-1' })).toBe(true);
    expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: 'run-1' })).toBe(false);
    expect(store.listPins()).toEqual([]);
    // The kind and project are part of the key: the wrong ones remove nothing.
    store.pinItem(workflowPin('/p1', 'deploy'));
    expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: 'deploy' })).toBe(false);
    expect(store.unpinItem({ kind: 'workflow', projectRoot: '/p2', ref: 'deploy' })).toBe(false);
    expect(store.listPins()).toHaveLength(1);
  });

  it('lists newest first, breaks a tie by key, and narrows by kind and project', () => {
    store.pinItem(runPin('run-b', T0 + 10));
    store.pinItem(runPin('run-a', T0 + 10));
    store.pinItem(workflowPin('/p1', 'old', T0));
    store.pinItem(workflowPin('/p2', 'newest', T0 + 20));

    expect(store.listPins().map((pin) => pin.ref)).toEqual(['newest', 'run-a', 'run-b', 'old']);
    expect(store.listPins({ kind: 'run' }).map((pin) => pin.ref)).toEqual(['run-a', 'run-b']);
    expect(store.listPins({ projectRoot: '/p1' }).map((pin) => pin.ref)).toEqual(['old']);
    expect(store.listPins({ kind: 'workflow', projectRoot: '/p2' }).map((pin) => pin.ref)).toEqual([
      'newest',
    ]);
    expect(store.listPins({ kind: 'run', projectRoot: '/p1' })).toEqual([]);
  });

  describe('validates what it is asked to store', () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const badRefs: readonly [string, string][] = [
      ['empty', ''],
      ['over the length bound', 'x'.repeat(MAX_PIN_REF_LENGTH + 1)],
      ['a newline', 'a\nb'],
      ['a NUL', `a${String.fromCharCode(0)}b`],
      ['an ESC', `a${String.fromCharCode(0x1b)}[31m`],
      ['a DEL', `a${String.fromCharCode(0x7f)}`],
      ['a C1 control', `a${String.fromCharCode(0x85)}`],
      ['a line separator', `a${lineSeparator}b`],
      ['a paragraph separator', `a${paragraphSeparator}b`],
    ];

    it.each(badRefs)(
      'refuses a ref that is %s, with a typed error that does not echo it',
      (_name, ref) => {
        for (const attempt of [
          () => store.pinItem(runPin(ref)),
          () => store.pinItem(workflowPin('/p1', ref)),
          () => store.unpinItem({ kind: 'run', projectRoot: '', ref }),
        ]) {
          let refusal: unknown;
          try {
            attempt();
          } catch (error) {
            refusal = error;
          }
          expect(isRunPinError(refusal)).toBe(true);
          expect(refusal).toMatchObject({ code: 'invalid_ref' });
          if (ref.length > 0 && refusal instanceof Error)
            expect(refusal.message).not.toContain(ref);
        }
        expect(store.listPins()).toEqual([]);
      },
    );

    it('accepts a ref of exactly the maximum length and ordinary text', () => {
      expect(store.pinItem(runPin('r'.repeat(MAX_PIN_REF_LENGTH)))).toBe('pinned');
      expect(store.pinItem(workflowPin('/work/ünïcode project', 'deploy-2'))).toBe('pinned');
    });

    it('refuses an unknown kind, a project root on a run pin, a missing one on a workflow pin, and a bad time', () => {
      const code = (fn: () => unknown): unknown => {
        try {
          fn();
        } catch (error) {
          return isRunPinError(error) ? error.code : error;
        }
        return undefined;
      };
      expect(
        code(() => Reflect.apply(store.pinItem, undefined, [{ ...runPin('x'), kind: 'bogus' }])),
      ).toBe('invalid_kind');
      expect(code(() => store.pinItem({ ...runPin('x'), projectRoot: '/p1' }))).toBe(
        'invalid_project_root',
      );
      expect(code(() => store.pinItem(workflowPin('', 'deploy')))).toBe('invalid_project_root');
      expect(code(() => store.pinItem(workflowPin('/p1\nx', 'deploy')))).toBe(
        'invalid_project_root',
      );
      expect(code(() => store.pinItem(runPin('x', -1)))).toBe('invalid_time');
      expect(code(() => store.pinItem(runPin('x', 1.5)))).toBe('invalid_time');
      expect(code(() => store.pinItem(runPin('x', Number.NaN)))).toBe('invalid_time');
      expect(store.listPins()).toEqual([]);
    });
  });

  it('stores nothing outside the closed kind set, even past the store (the table CHECK)', () => {
    expect(() =>
      client.sqlite
        .prepare('INSERT INTO run_pins (kind, project_root, ref, pinned_at) VALUES (?, ?, ?, ?)')
        .run('bogus', '', 'x', T0),
    ).toThrow(/CHECK/u);
    expect(client.db.select().from(runPins).all()).toEqual([]);
  });
});

describe('the pin cap across two connections to one database file', () => {
  let directory: string;
  let first: DbClient;
  let second: DbClient;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'relavium-run-pins-'));
    const path = join(directory, 'history.db');
    first = createClient(path);
    runMigrations(first.db, { dbPath: path });
    second = createClient(path);
  });

  afterEach(() => {
    first.sqlite.close();
    second.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('counts the rows the other process wrote, so two processes cannot together pass the cap', () => {
    const a = createRunPinStore(first.db);
    const b = createRunPinStore(second.db);
    // Each store holds 24 and 25 of the 50; neither has seen the other's rows by itself.
    for (let index = 0; index < 24; index++)
      a.pinItem({ kind: 'run', projectRoot: '', ref: `a-${index}`, at: T0 });
    for (let index = 0; index < 25; index++)
      b.pinItem({ kind: 'run', projectRoot: '', ref: `b-${index}`, at: T0 });
    expect(a.pinItem({ kind: 'run', projectRoot: '', ref: 'a-last', at: T0 })).toBe('pinned');
    expect(b.pinItem({ kind: 'run', projectRoot: '', ref: 'b-last', at: T0 })).toBe('full');
    expect(a.listPins()).toHaveLength(MAX_RUN_PINS);
    expect(b.listPins()).toHaveLength(MAX_RUN_PINS);
  });
});
