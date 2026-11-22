import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createRunPinStore,
  isRunPinError,
  MAX_PIN_PROJECT_ROOT_LENGTH,
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

  describe('unpinItem matches the exact stored key and does not judge its content', () => {
    /** A row written OUTSIDE the store, the way an older writer or a crafted row would leave it. */
    const craftRow = (kind: 'run' | 'workflow', projectRoot: string, ref: string): void => {
      client.sqlite
        .prepare('INSERT INTO run_pins (kind, project_root, ref, pinned_at) VALUES (?, ?, ?, ?)')
        .run(kind, projectRoot, ref, T0);
    };

    it('removes a crafted row whose ref is longer than a store would ever write, so it cannot hold a slot for good', () => {
      // A foreign writer's row past the write-path bound: it is listed, it counts toward the cap, and it must go.
      const long = 'r'.repeat(600);
      craftRow('run', '', long);
      expect(store.listPins().map((pin) => pin.ref)).toEqual([long]);
      expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: long })).toBe(true);
      expect(store.listPins()).toEqual([]);
    });

    it('removes a crafted row whose ref holds an escape character, by the ref the list shows for it', () => {
      const escaped = `run-${String.fromCharCode(0x1b)}[31mred`;
      craftRow('run', '', escaped);
      craftRow(
        'workflow',
        `/work/${String.fromCharCode(0x202e)}p1`,
        `deploy-${String.fromCharCode(0x7)}`,
      );
      // The list returns what is stored, character for character...
      const listed = store.listPins();
      expect(listed.map((pin) => pin.ref).sort()).toEqual(
        [`deploy-${String.fromCharCode(0x7)}`, escaped].sort(),
      );
      // ...and each listed key removes exactly its own row. Nothing in `unpinItem` judges the characters.
      for (const pin of listed) {
        expect(
          store.unpinItem({ kind: pin.kind, projectRoot: pin.projectRoot, ref: pin.ref }),
        ).toBe(true);
      }
      expect(store.listPins()).toEqual([]);
    });

    it('answers false, never an error, for a key with a control character that matches no row', () => {
      store.pinItem(runPin('run-1'));
      expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: 'run-1\n' })).toBe(false);
      expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: '' })).toBe(false);
      expect(store.unpinItem({ kind: 'run', projectRoot: '/not-for-a-run', ref: 'run-1' })).toBe(
        false,
      );
      expect(store.listPins()).toHaveLength(1);
    });

    it('refuses an unknown kind or a non-text part, and never judges the length of a key, with a typed error', () => {
      const code = (fn: () => unknown): unknown => {
        try {
          fn();
        } catch (error) {
          return isRunPinError(error) ? error.code : error;
        }
        return undefined;
      };
      // The bound is not checked on unpin: an over-length key matches no row written by the store, and the exact
      // match of a crafted row is what removes it. So an over-length key is not a refusal, it is simply not found.
      expect(
        code(() =>
          store.unpinItem({
            kind: 'run',
            projectRoot: '',
            ref: 'r'.repeat(MAX_PIN_REF_LENGTH + 1),
          }),
        ),
      ).toBe(undefined);
      expect(
        code(() =>
          store.unpinItem({
            kind: 'workflow',
            projectRoot: 'p'.repeat(MAX_PIN_PROJECT_ROOT_LENGTH + 1),
            ref: 'deploy',
          }),
        ),
      ).toBe(undefined);
      expect(
        code(() =>
          Reflect.apply(store.unpinItem, undefined, [{ kind: 'bogus', projectRoot: '', ref: 'x' }]),
        ),
      ).toBe('invalid_kind');
      expect(
        code(() =>
          Reflect.apply(store.unpinItem, undefined, [{ kind: 'run', projectRoot: '', ref: 5 }]),
        ),
      ).toBe('invalid_ref');
      // Exactly at the bound is a lookup, not a refusal.
      expect(
        store.unpinItem({ kind: 'run', projectRoot: '', ref: 'r'.repeat(MAX_PIN_REF_LENGTH) }),
      ).toBe(false);
    });
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
      ['a right-to-left override (a format character)', `a${String.fromCharCode(0x202e)}b`],
      ['a zero-width space (a format character)', `a${String.fromCharCode(0x200b)}b`],
      ['a left-to-right mark (a format character)', `a${String.fromCharCode(0x200e)}b`],
      ['a word joiner (a format character)', `a${String.fromCharCode(0x2060)}b`],
      ['a left-to-right embedding (a bidi control)', `a${String.fromCharCode(0x202a)}b`],
      ['a left-to-right isolate (a bidi control)', `a${String.fromCharCode(0x2066)}b`],
      ['a pop directional isolate (a bidi control)', `a${String.fromCharCode(0x2069)}b`],
      ['a byte-order mark (a format character)', `${String.fromCharCode(0xfeff)}a`],
      ['a soft hyphen (a format character)', `a${String.fromCharCode(0xad)}b`],
      ['a lone high surrogate', `a${String.fromCharCode(0xd800)}b`],
      ['a lone low surrogate', `a${String.fromCharCode(0xdc00)}b`],
      ['a high surrogate at the end', `ab${String.fromCharCode(0xd83d)}`],
    ];

    it.each(badRefs)(
      'refuses a ref that is %s on the write path, with a typed error that does not echo it',
      (_name, ref) => {
        for (const attempt of [
          () => store.pinItem(runPin(ref)),
          () => store.pinItem(workflowPin('/p1', ref)),
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

    it.each([
      ['a right-to-left override', String.fromCharCode(0x202e)],
      ['a right-to-left isolate', String.fromCharCode(0x2067)],
      ['a zero-width space', String.fromCharCode(0x200b)],
      ['a word joiner', String.fromCharCode(0x2060)],
      ['an ESC', String.fromCharCode(0x1b)],
      ['a lone surrogate', String.fromCharCode(0xd800)],
    ])('refuses a workflow project root that holds %s', (_name, character) => {
      let refusal: unknown;
      try {
        store.pinItem(workflowPin(`/work/p${character}1`, 'deploy'));
      } catch (error) {
        refusal = error;
      }
      expect(isRunPinError(refusal)).toBe(true);
      expect(refusal).toMatchObject({ code: 'invalid_project_root' });
      expect(store.listPins()).toEqual([]);
    });

    it('does not refuse an astral character, which is a surrogate PAIR and not a lone surrogate', () => {
      const emoji = String.fromCodePoint(0x1f680);
      expect(store.pinItem(runPin(`run-${emoji}`))).toBe('pinned');
      expect(store.pinItem(workflowPin(`/work/${emoji}`, 'deploy'))).toBe('pinned');
      expect(store.listPins().map((pin) => pin.ref)).toEqual(
        expect.arrayContaining([`run-${emoji}`, 'deploy']),
      );
    });

    it('accepts exactly the two zero-width joiners in a ref and a project root, lists them back unchanged, and unpins by the exact key', () => {
      const zwnj = String.fromCharCode(0x200c);
      const zwj = String.fromCharCode(0x200d);
      // A Persian word spelled with a non-joiner, and an emoji sequence held together by joiners.
      const persianRoot = `/work/${String.fromCharCode(0x645, 0x6cc)}${zwnj}${String.fromCharCode(0x62e, 0x648, 0x627, 0x647, 0x6cc)}`;
      const familyRoot = `/work/${String.fromCodePoint(0x1f469)}${zwj}${String.fromCodePoint(0x1f4bb)}`;
      const jointRef = `deploy${zwnj}one${zwj}two`;

      expect(store.pinItem(workflowPin(persianRoot, jointRef))).toBe('pinned');
      expect(store.pinItem(workflowPin(familyRoot, 'deploy'))).toBe('pinned');
      expect(store.pinItem(runPin(`run${zwj}1`, T0 + 1))).toBe('pinned');
      expect(store.pinItem(workflowPin(persianRoot, jointRef))).toBe('already-pinned');

      const listed = store.listPins();
      expect(listed).toEqual([
        { kind: 'run', projectRoot: '', ref: `run${zwj}1`, pinnedAt: T0 + 1 },
        { kind: 'workflow', projectRoot: persianRoot, ref: jointRef, pinnedAt: T0 },
        { kind: 'workflow', projectRoot: familyRoot, ref: 'deploy', pinnedAt: T0 },
      ]);
      expect(store.listPins({ kind: 'workflow', projectRoot: persianRoot })).toHaveLength(1);

      // Each listed key removes exactly its own row.
      for (const pin of listed) {
        expect(
          store.unpinItem({ kind: pin.kind, projectRoot: pin.projectRoot, ref: pin.ref }),
        ).toBe(true);
      }
      expect(store.listPins()).toEqual([]);
    });

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

    it('refuses a workflow project root over its length bound on the write path, and accepts one exactly at it', () => {
      let refusal: unknown;
      try {
        store.pinItem(workflowPin('p'.repeat(MAX_PIN_PROJECT_ROOT_LENGTH + 1), 'deploy'));
      } catch (error) {
        refusal = error;
      }
      expect(isRunPinError(refusal)).toBe(true);
      expect(refusal).toMatchObject({ code: 'invalid_project_root' });
      expect(store.listPins()).toEqual([]);
      // Exactly at the bound is a pin, not a refusal.
      const atBound = 'p'.repeat(MAX_PIN_PROJECT_ROOT_LENGTH);
      expect(store.pinItem(workflowPin(atBound, 'deploy'))).toBe('pinned');
      expect(store.listPins()).toEqual([
        { kind: 'workflow', projectRoot: atBound, ref: 'deploy', pinnedAt: T0 },
      ]);
    });

    it('pins at epoch 0 (the time is a NON-negative integer) and lists it back as 0, and refuses a negative time', () => {
      expect(store.pinItem(runPin('at-zero', 0))).toBe('pinned');
      expect(store.listPins()).toEqual([
        { kind: 'run', projectRoot: '', ref: 'at-zero', pinnedAt: 0 },
      ]);
      for (const at of [-1, Number.MIN_SAFE_INTEGER, -0.5]) {
        let refusal: unknown;
        try {
          store.pinItem(runPin('negative', at));
        } catch (error) {
          refusal = error;
        }
        expect(isRunPinError(refusal)).toBe(true);
        expect(refusal).toMatchObject({ code: 'invalid_time' });
      }
      expect(store.listPins().map((pin) => pin.ref)).toEqual(['at-zero']);
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

  it('waits for the write lock: while another connection holds BEGIN IMMEDIATE a pin does not go in, and it does once that commits', () => {
    // A tiny busy timeout so the refusal is quick; the store's own busy retry still runs its few attempts.
    second.sqlite.pragma('busy_timeout = 5');
    const b = createRunPinStore(second.db);
    first.sqlite.exec('BEGIN IMMEDIATE');
    let refusal: unknown;
    try {
      try {
        b.pinItem({ kind: 'run', projectRoot: '', ref: 'blocked', at: T0 });
      } catch (error) {
        refusal = error;
      }
      // The driver's busy fault surfaces unchanged once the retry budget is spent: it is not swallowed into
      // a 'pinned' or a 'full' that never happened.
      expect(refusal).toMatchObject({ code: 'SQLITE_BUSY' });
      expect(b.listPins()).toEqual([]);
    } finally {
      if (first.sqlite.inTransaction) first.sqlite.exec('COMMIT');
    }
    expect(b.pinItem({ kind: 'run', projectRoot: '', ref: 'blocked', at: T0 })).toBe('pinned');
    expect(b.listPins().map((pin) => pin.ref)).toEqual(['blocked']);
  });

  it('takes the write lock BEFORE it counts: a rival cannot write between the count and the insert', () => {
    const a = createRunPinStore(first.db);
    const b = createRunPinStore(second.db);
    for (let index = 0; index < MAX_RUN_PINS - 1; index++)
      a.pinItem({ kind: 'run', projectRoot: '', ref: `seed-${index}`, at: T0 });
    // The rival must fail at once if it cannot write, never wait on B.
    first.sqlite.pragma('busy_timeout = 0');

    // At the moment B prepares its INSERT it has already read "49 rows". Inside B's transaction a rival
    // connection tries to take the 50th slot. Under `BEGIN IMMEDIATE` B holds the write lock by then, so the
    // rival is refused; under a deferred BEGIN B holds only a read snapshot and the rival's write would commit,
    // leaving B to insert past a count it no longer holds.
    const prepare = second.sqlite.prepare.bind(second.sqlite);
    let rival: 'not tried' | 'wrote' | 'refused' = 'not tried';
    let rivalCode: unknown;
    const spy = vi.spyOn(second.sqlite, 'prepare').mockImplementation((source: string) => {
      if (rival === 'not tried' && /^insert into "run_pins"/iu.test(source)) {
        try {
          first.sqlite
            .prepare(
              "INSERT INTO run_pins (kind, project_root, ref, pinned_at) VALUES ('run', '', 'rival', ?)",
            )
            .run(T0);
          rival = 'wrote';
        } catch (error) {
          rival = 'refused';
          rivalCode =
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        }
      }
      return prepare(source);
    });
    let outcome: string;
    try {
      outcome = b.pinItem({ kind: 'run', projectRoot: '', ref: 'mine', at: T0 });
    } finally {
      spy.mockRestore();
    }
    expect(rival).toBe('refused');
    expect(rivalCode).toBe('SQLITE_BUSY');
    expect(outcome).toBe('pinned');
    const refs = b.listPins().map((pin) => pin.ref);
    expect(refs).toHaveLength(MAX_RUN_PINS);
    expect(refs).toContain('mine');
    expect(refs).not.toContain('rival');
  });
});
