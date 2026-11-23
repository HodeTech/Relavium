import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  canonicalRoot,
  createRunPinStore,
  isRunPinError,
  MAX_PIN_PROJECT_ROOT_LENGTH,
  MAX_PIN_REF_LENGTH,
  MAX_RUN_PINS,
  OVERSIZED_PREVIEW_CODE_POINTS,
  PIN_LIST_LIMIT,
  type RunPinStore,
} from './run-pins.js';

/**
 * The row handle of a pin (MVP-8 step 4): `listPins` returns each pin's `rowid` and `unpinByRow` removes exactly that
 * row, so a pin whose key cannot be spelled back (a ref that is not valid UTF-8, an over-long one) cannot hold one of
 * the fifty slots for good. The text columns pass a byte gate in the list statement, and a workflow pin's project
 * root is keyed by its real path.
 */

const T0 = 1_780_000_000_000;

/** The refusal a call raises, or `undefined` when it returned. */
function refusal(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the row handle of a pin', () => {
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

  /** A row written OUTSIDE the store, the way an older writer or a crafted row would leave it. */
  const craft = (kind: 'run' | 'workflow', projectRoot: string, ref: string | Buffer): void => {
    client.sqlite
      .prepare('INSERT INTO run_pins (kind, project_root, ref, pinned_at) VALUES (?, ?, ?, ?)')
      .run(kind, projectRoot, ref, T0);
  };

  describe('listPins returns each pin with its rowid', () => {
    it('gives every pin its own integer rowid and marks an ordinary pin as not oversized', () => {
      store.pinItem(runPin('run-1', T0));
      store.pinItem(workflowPin('/p1', 'deploy', T0 + 1));
      store.pinItem(runPin('run-2', T0 + 2));
      const listed = store.listPins();
      expect(listed.map((pin) => pin.ref)).toEqual(['run-2', 'deploy', 'run-1']);
      for (const pin of listed) {
        expect(Number.isSafeInteger(pin.rowid)).toBe(true);
        expect(pin.oversized).toBe(false);
      }
      expect(new Set(listed.map((pin) => pin.rowid)).size).toBe(3);
      // The rowid is the row's own: it is what the table says it is.
      const stored = client.sqlite
        .prepare("SELECT rowid AS id FROM run_pins WHERE ref = 'deploy'")
        .get() as { id: number } | undefined;
      expect(listed.find((pin) => pin.ref === 'deploy')?.rowid).toBe(stored?.id);
    });
  });

  describe('a pin whose stored text is not valid UTF-8', () => {
    it('is listed as replacement characters, matches no key, and is removed by its row', () => {
      // The bytes 0x61 0xff 0x62: a TEXT value the way an external writer's CAST leaves it.
      client.sqlite.exec(
        "INSERT INTO run_pins (kind, project_root, ref, pinned_at) VALUES ('run', '', CAST(x'61ff62' AS TEXT), 1780000000000)",
      );
      store.pinItem(runPin('run-keep'));
      const listed = store.listPins();
      const bad = listed.find((pin) => pin.ref !== 'run-keep');
      expect(bad).toBeDefined();
      expect(bad?.ref).toContain('�');
      // The listed text names nothing: this is the defect the row handle closes.
      expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: bad?.ref ?? '' })).toBe(false);
      expect(store.listPins()).toHaveLength(2);

      expect(store.unpinByRow(bad?.rowid ?? -1)).toBe(true);
      expect(store.listPins().map((pin) => pin.ref)).toEqual(['run-keep']);
    });

    it('is listed as text, and removed by its row, when the column holds a BLOB rather than TEXT', () => {
      craft('run', '', Buffer.from([0xff, 0x00, 0xfe]));
      const listed = store.listPins();
      expect(listed).toHaveLength(1);
      expect(typeof listed[0]?.ref).toBe('string');
      expect(store.unpinByRow(listed[0]?.rowid ?? -1)).toBe(true);
      expect(store.listPins()).toEqual([]);
    });

    it('frees the slot it held at the cap, so a fifty-first pin that was refused goes in once the row is removed', () => {
      for (let index = 0; index < MAX_RUN_PINS - 1; index++) store.pinItem(runPin(`run-${index}`));
      client.sqlite.exec(
        "INSERT INTO run_pins (kind, project_root, ref, pinned_at) VALUES ('run', '', CAST(x'ff' AS TEXT), 1780000000000)",
      );
      expect(store.listPins()).toHaveLength(MAX_RUN_PINS);
      // The cap's notice is the typed result `'full'`; it is not an exception.
      expect(store.pinItem(runPin('run-overflow'))).toBe('full');

      const bad = store.listPins().find((pin) => pin.ref.includes('�'));
      expect(bad).toBeDefined();
      expect(store.unpinItem({ kind: 'run', projectRoot: '', ref: bad?.ref ?? '' })).toBe(false);
      expect(store.pinItem(runPin('run-overflow'))).toBe('full');

      expect(store.unpinByRow(bad?.rowid ?? -1)).toBe(true);
      expect(store.pinItem(runPin('run-overflow'))).toBe('pinned');
      expect(store.pinItem(runPin('run-second-overflow'))).toBe('full');
    });
  });

  describe('unpinByRow removes exactly that row and nothing else', () => {
    it('leaves a pin with the same ref in another project, and a run pin with the same text', () => {
      store.pinItem(workflowPin('/p1', 'deploy', T0 + 1));
      store.pinItem(workflowPin('/p2', 'deploy', T0 + 2));
      store.pinItem(runPin('deploy', T0 + 3));
      const second = store.listPins({ kind: 'workflow', projectRoot: '/p2' })[0];
      expect(second?.ref).toBe('deploy');

      expect(store.unpinByRow(second?.rowid ?? -1)).toBe(true);
      expect(store.listPins().map((pin) => [pin.kind, pin.projectRoot, pin.ref] as const)).toEqual([
        ['run', '', 'deploy'],
        ['workflow', '/p1', 'deploy'],
      ]);
    });

    it('answers false for a row that is not there, and for the same row twice', () => {
      store.pinItem(runPin('run-1'));
      const [pin] = store.listPins();
      expect(store.unpinByRow((pin?.rowid ?? 0) + 1000)).toBe(false);
      expect(store.unpinByRow(pin?.rowid ?? -1)).toBe(true);
      expect(store.unpinByRow(pin?.rowid ?? -1)).toBe(false);
    });

    it('refuses a row that is not a safe integer with a typed error that changes nothing', () => {
      store.pinItem(runPin('run-1'));
      for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, '1', null]) {
        const error = refusal(() => Reflect.apply(store.unpinByRow, undefined, [bad]));
        expect(isRunPinError(error)).toBe(true);
        expect(error).toMatchObject({ code: 'invalid_row' });
      }
      expect(store.listPins()).toHaveLength(1);
    });
  });

  describe('the length gates', () => {
    const emoji = String.fromCodePoint(0x1f680);

    it('refuses a ref or a project root over its bound on the write path, with a typed error that does not echo it', () => {
      const longRef = 'r'.repeat(MAX_PIN_REF_LENGTH + 1);
      const longRoot = 'p'.repeat(MAX_PIN_PROJECT_ROOT_LENGTH + 1);
      const refError = refusal(() => store.pinItem(runPin(longRef)));
      expect(isRunPinError(refError)).toBe(true);
      expect(refError).toMatchObject({ code: 'invalid_ref' });
      expect(refError instanceof Error && refError.message.includes(longRef)).toBe(false);
      const rootError = refusal(() => store.pinItem(workflowPin(longRoot, 'deploy')));
      expect(isRunPinError(rootError)).toBe(true);
      expect(rootError).toMatchObject({ code: 'invalid_project_root' });
      // The bound counts UTF-16 units, the way the write path always has: 257 rocket emoji are 514 units.
      const astral = refusal(() => store.pinItem(runPin(emoji.repeat(MAX_PIN_REF_LENGTH / 2 + 1))));
      expect(astral).toMatchObject({ code: 'invalid_ref' });
      expect(store.listPins()).toEqual([]);
      // Exactly at the bound is a pin.
      expect(store.pinItem(runPin(emoji.repeat(MAX_PIN_REF_LENGTH / 2)))).toBe('pinned');
    });

    it('never reads a crafted over-long ref or root whole: the list returns a preview and says it is oversized', () => {
      craft('run', '', 'r'.repeat(600));
      craft('workflow', 'p'.repeat(5000), 'deploy');
      const listed = store.listPins();
      expect(listed).toHaveLength(2);
      for (const pin of listed) {
        expect(pin.oversized).toBe(true);
        expect(Array.from(pin.ref).length).toBeLessThanOrEqual(OVERSIZED_PREVIEW_CODE_POINTS);
        expect(Array.from(pin.projectRoot).length).toBeLessThanOrEqual(
          OVERSIZED_PREVIEW_CODE_POINTS,
        );
      }
      expect(listed.find((pin) => pin.kind === 'run')?.ref).toBe(
        'r'.repeat(OVERSIZED_PREVIEW_CODE_POINTS),
      );
      expect(listed.find((pin) => pin.kind === 'workflow')?.ref).toBe('deploy');
    });

    it('applies the bound in UTF-16 units to what is read, so a text within the bound is whole and one over is not', () => {
      craft('run', '', emoji.repeat(MAX_PIN_REF_LENGTH / 2)); // exactly 512 units
      craft('run', '', `${emoji.repeat(MAX_PIN_REF_LENGTH / 2)}x`); // one unit over
      const listed = store.listPins();
      const whole = listed.find((pin) => !pin.oversized);
      const over = listed.find((pin) => pin.oversized);
      expect(whole?.ref).toBe(emoji.repeat(MAX_PIN_REF_LENGTH / 2));
      expect(over?.ref).toBe(emoji.repeat(OVERSIZED_PREVIEW_CODE_POINTS));
    });

    it('removes an over-long pin by its row, including one so large that only the statement can bound it', () => {
      craft('run', '', 'r'.repeat(600));
      craft('run', '', 'x'.repeat(2_000_000));
      store.pinItem(runPin('run-keep'));
      const listed = store.listPins();
      expect(listed).toHaveLength(3);
      for (const pin of listed.filter((entry) => entry.oversized)) {
        // The key it lists under matches nothing the store wrote...
        expect(
          store.unpinItem({ kind: pin.kind, projectRoot: pin.projectRoot, ref: pin.ref }),
        ).toBe(false);
        // ...and the row handle removes it.
        expect(store.unpinByRow(pin.rowid)).toBe(true);
      }
      expect(store.listPins().map((pin) => pin.ref)).toEqual(['run-keep']);
    });

    it('bounds the text in the list statement itself, so a very large value never leaves the database', () => {
      craft('run', '', 'x'.repeat(2_000_000));
      craft('workflow', 'y'.repeat(2_000_000), 'deploy');
      const prepare = client.sqlite.prepare.bind(client.sqlite);
      const sources: string[] = [];
      const spy = vi.spyOn(client.sqlite, 'prepare').mockImplementation((source: string) => {
        sources.push(source);
        return prepare(source);
      });
      try {
        store.listPins();
      } finally {
        spy.mockRestore();
      }
      const listSource = sources.find((source) => /^select/iu.test(source));
      expect(listSource).toBeDefined();
      // Run the very statement the store prepared (its one parameter is the row limit) and look at what it hands to JavaScript.
      const rows = client.sqlite
        .prepare(listSource ?? '')
        .raw(true)
        .all(PIN_LIST_LIMIT + 1);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        for (const cell of row as unknown[]) {
          if (typeof cell === 'string') expect(cell.length).toBeLessThanOrEqual(1024);
        }
      }
    });
  });
});

describe('a workflow pin is keyed by the real path of its project root', () => {
  let client: DbClient;
  let store: RunPinStore;
  let directory: string;
  let real: string;
  let link: string;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createRunPinStore(client.db);
    directory = mkdtempSync(join(tmpdir(), 'relavium-pin-root-'));
    real = join(directory, 'real');
    link = join(directory, 'link');
    mkdirSync(real);
    // `junction` is the directory link that needs no privilege on Windows; it is ignored elsewhere.
    symlinkSync(real, link, 'junction');
  });

  afterEach(() => {
    client.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const workflowPin = (projectRoot: string, ref = 'deploy') => ({
    kind: 'workflow' as const,
    projectRoot,
    ref,
    at: T0,
  });

  it('gives a symlinked root the key of its target', () => {
    const target = realpathSync.native(real);
    expect(canonicalRoot(link)).toBe(target);
    expect(canonicalRoot(real)).toBe(target);
    expect(canonicalRoot(link)).toBe(canonicalRoot(real));
  });

  it('makes the link and its target one pin, found and removed by either spelling', () => {
    const target = realpathSync.native(real);
    expect(store.pinItem(workflowPin(link))).toBe('pinned');
    expect(store.pinItem(workflowPin(real))).toBe('already-pinned');
    expect(store.pinItem(workflowPin(target))).toBe('already-pinned');

    const stored = store.listPins({ kind: 'workflow', projectRoot: link });
    expect(stored.map((pin) => pin.projectRoot)).toEqual([target]);
    expect(store.listPins({ kind: 'workflow', projectRoot: real })).toHaveLength(1);
    expect(store.listPins({ projectRoot: target })).toHaveLength(1);
    // The row holds the real path, never the spelling it was pinned under.
    const row = client.sqlite.prepare('SELECT project_root AS root FROM run_pins').get() as
      | { root: string }
      | undefined;
    expect(row?.root).toBe(target);

    expect(store.unpinItem({ kind: 'workflow', projectRoot: link, ref: 'deploy' })).toBe(true);
    expect(store.listPins()).toEqual([]);
  });

  it('keeps the slug of one directory apart from the same slug in another directory', () => {
    const other = join(directory, 'other');
    mkdirSync(other);
    expect(store.pinItem(workflowPin(link))).toBe('pinned');
    expect(store.pinItem(workflowPin(other))).toBe('pinned');
    expect(store.listPins()).toHaveLength(2);
  });

  it('falls back to the path as given when the real path cannot be resolved', () => {
    const gone = join(directory, 'gone');
    expect(canonicalRoot(gone)).toBe(gone);
    expect(canonicalRoot('')).toBe('');
    expect(canonicalRoot(`/not/a/real/path${String.fromCharCode(0)}x`)).toBe(
      `/not/a/real/path${String.fromCharCode(0)}x`,
    );
    // A dangling link does not resolve either.
    const dangling = join(directory, 'dangling');
    symlinkSync(join(directory, 'nowhere'), dangling, 'junction');
    expect(canonicalRoot(dangling)).toBe(dangling);

    // A project that was moved or deleted stays pinned and removable under its own spelling.
    expect(store.pinItem(workflowPin(gone))).toBe('pinned');
    expect(store.pinItem(workflowPin(gone))).toBe('already-pinned');
    expect(
      store.listPins({ kind: 'workflow', projectRoot: gone }).map((pin) => pin.projectRoot),
    ).toEqual([gone]);
    expect(store.unpinItem({ kind: 'workflow', projectRoot: gone, ref: 'deploy' })).toBe(true);
  });

  it('does not canonicalise a run pin, whose root is always empty', () => {
    expect(store.pinItem({ kind: 'run', projectRoot: '', ref: 'run-1', at: T0 })).toBe('pinned');
    expect(store.listPins({ kind: 'run', projectRoot: '' }).map((pin) => pin.ref)).toEqual([
      'run-1',
    ]);
  });

  it('holds the real path to the write rule too: a link to a directory whose name is a bidi override is refused', () => {
    const tricky = join(directory, `a${String.fromCharCode(0x202e)}b`);
    mkdirSync(tricky);
    const trickyLink = join(directory, 'tricky-link');
    symlinkSync(tricky, trickyLink, 'junction');
    // The spelling it is given is clean; the real path is not, and it is what would be stored.
    const error = refusal(() => store.pinItem(workflowPin(trickyLink)));
    expect(isRunPinError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'invalid_project_root' });
    expect(store.listPins()).toEqual([]);
  });
});
