import { realpathSync } from 'node:fs';

import { RelaviumError } from '@relavium/shared';
import { and, desc, asc, eq, sql, type SQL } from 'drizzle-orm';

import type { Db } from './client.js';
import { withBusyRetry } from './retry.js';
import { PIN_KINDS, runPins, type NewRunPinRow, type PinKind } from './schema.js';

/**
 * The Home's pins ([ADR-0140](../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §5): a run or a workflow the operator marked to keep at the top of its list. A pin names something and never
 * changes it — there is no foreign key, and no read here touches `runs`. The store is global to the home database
 * like the runs it names, and capped, so a list that renders every pin stays a screenful.
 *
 * **The write is one `BEGIN IMMEDIATE` transaction** that checks, counts and inserts: the cap is a promise about
 * the table, and two processes pinning at once must not both read "49 rows" and both insert. The same
 * immediate-transaction and busy-retry policy as every other multi-statement writer in this package
 * (database-schema.md §Concurrency & transaction behavior).
 */

/** The most pins the table holds, in total (a fifty-first is refused with `'full'`). */
export const MAX_RUN_PINS = 50;
/**
 * The most pins one {@link RunPinStore.listPins} call returns. The write path holds the table to {@link MAX_RUN_PINS},
 * but the read does not trust that: a second process, or an older version, may have written rows beyond the cap, and a
 * list that renders every pin must stay a screenful whatever the table holds.
 */
export const PIN_LIST_LIMIT = 200;
/** The longest `ref` (a run id or a workflow slug) the store accepts. */
export const MAX_PIN_REF_LENGTH = 512;
/** The longest `projectRoot` the store accepts. */
export const MAX_PIN_PROJECT_ROOT_LENGTH = 4096;
/**
 * The most UTF-8 bytes one UTF-16 code unit takes: a BMP character is at most 3 bytes, and an astral character is 4
 * bytes for TWO units. A text of at most N units is therefore at most `3 * N` bytes, and a stored text of more bytes
 * than that is over its character bound without being decoded (the SQL length gate of {@link RunPinStore.listPins}).
 */
const MAX_UTF8_BYTES_PER_UNIT = 3;
/** How many code points of an over-long text {@link RunPinStore.listPins} still returns, to say which pin it is. */
export const OVERSIZED_PREVIEW_CODE_POINTS = 64;

export type { PinKind } from './schema.js';

/** What `pinItem` did: wrote a new row, found the pin already there, or refused because the table is at the cap. */
export type PinResult = 'pinned' | 'already-pinned' | 'full';

/** The identity of a pin — also its primary key. */
export interface PinKey {
  readonly kind: PinKind;
  /** The project directory of a workflow pin; `''` for a run pin (a run id is globally unique). */
  readonly projectRoot: string;
  /** The run id of a run pin, or the workflow's slug within its project. */
  readonly ref: string;
}

export interface PinRecord extends PinKey {
  /** Epoch ms the pin was made, as the caller stated it. */
  readonly pinnedAt: number;
  /**
   * SQLite's `rowid` of the pin's row, the handle {@link RunPinStore.unpinByRow} removes it by. It names a pin whose
   * text cannot be given back as a key: a ref that is not valid UTF-8 reads as replacement characters, and an
   * over-long one is cut (below). A rowid is good for the listing it came from: SQLite hands the number of a deleted
   * last row to the next insert, and `VACUUM` may renumber a table, so a list kept open across another process's
   * writes can name a different pin by then (`unpinByRow` removes what the number names now).
   */
  readonly rowid: number;
  /**
   * `true` when the stored `ref` or `projectRoot` is longer than its write-path bound ({@link MAX_PIN_REF_LENGTH},
   * {@link MAX_PIN_PROJECT_ROOT_LENGTH}), which only a row written outside this store can be. An over-long column is
   * never read whole: it is returned as its first {@link OVERSIZED_PREVIEW_CODE_POINTS} code points, so `ref` and
   * `projectRoot` are then a PREVIEW, not the key, and the pin is removed by its {@link PinRecord.rowid}.
   */
  readonly oversized: boolean;
}

export type RunPinErrorCode =
  | 'invalid_kind'
  | 'invalid_ref'
  | 'invalid_project_root'
  | 'invalid_time'
  | 'invalid_row';

/**
 * A pin the store refused to describe. Content-free by construction: the message names the rule and never echoes
 * the value, because a `ref` or a path is operator-supplied text that reaches a terminal.
 */
export class RunPinError extends RelaviumError {
  readonly code: RunPinErrorCode;
  constructor(code: RunPinErrorCode, message: string) {
    super(message);
    this.name = 'RunPinError';
    this.code = code;
  }
}

/** Narrow an unknown thrown value to {@link RunPinError} by its own discriminants (bundling-safe). */
export function isRunPinError(value: unknown): value is RunPinError {
  return value instanceof Error && value.name === 'RunPinError' && 'code' in value;
}

/**
 * What {@link RunPinStore.listPins} returns: the pins, as a plain array, plus whether more rows matched than
 * {@link PIN_LIST_LIMIT}. `truncated` is a NON-ENUMERABLE property, so a list compared, spread or serialised as an
 * array is exactly the array it was before the limit existed; read it by name (`pins.truncated`). A list made by
 * `filter` or `map` is a new array and does not carry it.
 */
export type PinList = PinRecord[] & { readonly truncated: boolean };

export interface RunPinStore {
  /**
   * Pin an item. `'already-pinned'` when the exact `(kind, projectRoot, ref)` is there — which also wins over
   * `'full'`, so re-pinning at the cap is not reported as a refusal — and `'full'` when {@link MAX_RUN_PINS} rows
   * exist already. `at` is epoch ms. A run pin carries `projectRoot: ''`; a workflow pin must carry its project.
   * A workflow pin is KEYED by {@link canonicalRoot} of its project root, so two spellings of one directory (a
   * symlink and its target) are one pin; the root is checked in the form it is given AND in the form it is stored.
   * @throws {RunPinError} for an invalid kind, ref, project root or time.
   */
  readonly pinItem: (input: PinKey & { readonly at: number }) => PinResult;
  /**
   * Remove a pin; `true` when a row was removed, `false` when there was none. It matches the EXACT stored key (a
   * workflow pin's root through {@link canonicalRoot}, as `pinItem` stored it) and does not judge its content: a row
   * written outside this store (an older writer, a crafted row) must stay removable, and a content rule here would
   * turn a bad row into a pin nothing can remove. Only the kind and the text types are checked: a known kind, and
   * text for the ref and the project root; the length is not judged either. A row whose key cannot be spelled back
   * (not valid UTF-8, over-long, a root that is not the canonical spelling) is removed by {@link unpinByRow}.
   * @throws {RunPinError} for an unknown kind, or a non-text ref or project root.
   */
  readonly unpinItem: (key: PinKey) => boolean;
  /**
   * Remove exactly the row with this `rowid` (from {@link listPins}) and nothing else; `true` when a row was removed.
   * It is the way out for a pin whose key cannot be given back as text: a ref that is not valid UTF-8 (the list shows
   * it as replacement characters, which match no row), an over-long one (never read whole), or a crafted row.
   * @throws {RunPinError} (`invalid_row`) when `rowid` is not a safe integer.
   */
  readonly unpinByRow: (rowid: number) => boolean;
  /**
   * The pins as stored, newest first (ties in a stable key order), optionally narrowed by kind and project (a
   * workflow root through {@link canonicalRoot}). Each carries its {@link PinRecord.rowid}. A `ref` or `projectRoot`
   * longer than its bound is never read whole: it comes back as a preview and the record is {@link PinRecord.oversized}.
   * At most {@link PIN_LIST_LIMIT} pins come back (the newest); {@link PinList.truncated} says there were more.
   */
  readonly listPins: (filter?: {
    readonly kind?: PinKind;
    readonly projectRoot?: string;
  }) => PinList;
}

/**
 * What no pin's text may contain, because the Home lists it back to a terminal and a pin is found again by the text
 * it was listed with: control characters (C0, DEL, C1), format characters (`\p{Cf}`: the bidirectional overrides
 * U+202A to U+202E and U+2066 to U+2069, the zero-width space, the soft hyphen, the byte-order mark), the Unicode
 * line and paragraph separators, and a lone surrogate. A lone surrogate is stored as bytes that read back as
 * replacement characters, so a pin written with one could not be matched by the ref the list shows for it.
 *
 * Exactly two format characters are allowed: the zero-width non-joiner (U+200C) and the zero-width joiner
 * (U+200D). They are part of the spelling of ordinary Persian, Indic and emoji-sequence directory names, so a
 * project in such a directory must stay pinnable; neither reorders text or hides a character the way a bidi
 * control does. Every other `\p{Cf}` stays refused.
 */
const FORBIDDEN_TEXT = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function validateKind(key: PinKey): void {
  if (!PIN_KINDS.some((kind) => kind === key.kind)) {
    throw new RunPinError('invalid_kind', 'a pin is a run or a workflow');
  }
}

/** A workflow pin's project root: 1 to {@link MAX_PIN_PROJECT_ROOT_LENGTH} characters of the allowed classes. */
function validateWorkflowRoot(projectRoot: string): void {
  if (
    projectRoot.length === 0 ||
    projectRoot.length > MAX_PIN_PROJECT_ROOT_LENGTH ||
    FORBIDDEN_TEXT.test(projectRoot)
  ) {
    throw new RunPinError(
      'invalid_project_root',
      `a workflow pin carries its project root: 1 to ${MAX_PIN_PROJECT_ROOT_LENGTH} characters with no control, format (other than the zero-width joiners) or unpaired-surrogate characters`,
    );
  }
}

/** The write path's whole rule set: the kind, the bounds AND the character classes of {@link FORBIDDEN_TEXT}. */
function validateKey(key: PinKey): void {
  validateKind(key);
  if (
    typeof key.ref !== 'string' ||
    key.ref.length === 0 ||
    key.ref.length > MAX_PIN_REF_LENGTH ||
    FORBIDDEN_TEXT.test(key.ref)
  ) {
    throw new RunPinError(
      'invalid_ref',
      `a pin reference is 1 to ${MAX_PIN_REF_LENGTH} characters with no control, format (other than the zero-width joiners) or unpaired-surrogate characters`,
    );
  }
  if (typeof key.projectRoot !== 'string') {
    throw new RunPinError('invalid_project_root', 'a pin project root is text');
  }
  if (key.kind === 'run') {
    // A run id names the run alone; a second spelling of the same run would be a second pin.
    if (key.projectRoot !== '') {
      throw new RunPinError('invalid_project_root', 'a run pin carries no project root');
    }
  } else {
    validateWorkflowRoot(key.projectRoot);
  }
}

/**
 * The unpin path's rule set: only the kind and the text types of the key are checked; its length and its content
 * are never judged. The key is a bound parameter that matches the exact stored row, so a row an older writer (or a
 * crafted row) left with an over-length ref or an escape character in it is still removable by the ref
 * {@link RunPinStore.listPins} returns for it (a refusal here would hold one of the capped slots for good).
 */
function validateLookupKey(key: PinKey): void {
  validateKind(key);
  if (typeof key.ref !== 'string') {
    throw new RunPinError('invalid_ref', 'a pin reference is text');
  }
  if (typeof key.projectRoot !== 'string') {
    throw new RunPinError('invalid_project_root', 'a pin project root is text');
  }
}

/**
 * The spelling a workflow pin's project root is KEYED by: the directory's real path, so `/work/link` and the
 * `/work/real` it points at are one project and one pin. A pin is the operator's mark on a project, and the same
 * project reached through a symlink (or a different case on a case-insensitive disk) must not be pinnable twice, nor
 * lose its pins when it is opened by another spelling. Only the PIN key is canonicalised: a run reads `project_root`
 * exactly as the run recorded it (`process.cwd()` at its start), and nothing here rewrites that.
 *
 * **When `realpath` fails the path is returned as given.** It fails for a directory that is gone, one the process
 * cannot traverse, a string that is not a usable path (an embedded NUL, a name past the system limit) and the empty
 * string. A project that has since been moved or deleted must stay pinned and removable, so the raw spelling is the
 * key, never a refusal; the write path still checks its bounds and characters either way.
 */
export function canonicalRoot(projectRoot: string): string {
  if (projectRoot.length === 0) return projectRoot;
  try {
    return realpathSync.native(projectRoot);
  } catch {
    // The documented fallback above: an unresolvable path is its own key.
    return projectRoot;
  }
}

/** The root a pin of `kind` is stored and compared under: canonical for a workflow pin, `''` as given for a run pin. */
function keyRoot(kind: PinKind, projectRoot: string): string {
  return kind === 'workflow' ? canonicalRoot(projectRoot) : projectRoot;
}

/**
 * What the list reads of a text column: the whole text when it is at most `maxUnits * 3` bytes (every text within its
 * character bound is), else only its first {@link OVERSIZED_PREVIEW_CODE_POINTS} code points. The byte length is the
 * gate (`length(CAST(col AS BLOB))`, the same gate the run documents use) because `length()` of text stops at an
 * embedded NUL and counts characters only after decoding. The `CAST(.. AS TEXT)` makes a column that holds a BLOB
 * (a crafted row) come back as text rather than as a buffer the types would not describe.
 */
function boundedText(column: SQL, maxUnits: number): SQL<string> {
  const limit = sql.raw(String(maxUnits * MAX_UTF8_BYTES_PER_UNIT));
  const preview = sql.raw(String(OVERSIZED_PREVIEW_CODE_POINTS));
  return sql<string>`CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN CAST(${column} AS TEXT) ELSE substr(CAST(${column} AS TEXT), 1, ${preview}) END`;
}

/** The first {@link OVERSIZED_PREVIEW_CODE_POINTS} code points of `text`, never splitting a surrogate pair. */
function previewOf(text: string): string {
  return Array.from(text).slice(0, OVERSIZED_PREVIEW_CODE_POINTS).join('');
}

/** A column as the list returns it: the text, or its preview when the column is over its bound. */
function shownText(
  text: string,
  bytes: number,
  maxUnits: number,
): { readonly text: string; readonly over: boolean } {
  // Over when the byte gate cut it, or when it was read whole and still has more UTF-16 units than the bound.
  const over = bytes > maxUnits * MAX_UTF8_BYTES_PER_UNIT || text.length > maxUnits;
  return { text: over ? previewOf(text) : text, over };
}

/** The pins as a {@link PinList}: the same array, with `truncated` attached non-enumerably (so it still equals a plain array). */
function withTruncated(pins: PinRecord[], truncated: boolean): PinList {
  const list = Object.assign(pins, { truncated });
  // `Object.assign` makes the property enumerable; narrowing the attribute keeps the value and the type.
  Object.defineProperty(list, 'truncated', { enumerable: false });
  return list;
}

/** Wire a {@link RunPinStore} over a `@relavium/db` connection. */
export function createRunPinStore(db: Db): RunPinStore {
  return {
    pinItem: (input) => {
      validateKey(input);
      if (!Number.isSafeInteger(input.at) || input.at < 0) {
        throw new RunPinError('invalid_time', 'a pin time is a non-negative integer of epoch ms');
      }
      // The key is the root's real path. The raw root passed the bounds above (so a long one never reaches the file
      // system); the real path is another string, so it is held to the same rule before it is written.
      const projectRoot = keyRoot(input.kind, input.projectRoot);
      if (projectRoot !== input.projectRoot) validateWorkflowRoot(projectRoot);
      const row: NewRunPinRow = {
        kind: input.kind,
        projectRoot,
        ref: input.ref,
        pinnedAt: input.at,
      };
      // `BEGIN IMMEDIATE` + `withBusyRetry`: the existence check, the count and the insert are ONE write
      // transaction, so the cap holds against a second `relavium` process pinning at the same moment.
      return withBusyRetry(() =>
        db.transaction(
          (tx): PinResult => {
            const existing = tx
              .select({ ref: runPins.ref })
              .from(runPins)
              .where(
                and(
                  eq(runPins.kind, input.kind),
                  eq(runPins.projectRoot, projectRoot),
                  eq(runPins.ref, input.ref),
                ),
              )
              .get();
            if (existing !== undefined) return 'already-pinned';
            const count =
              tx
                .select({ n: sql<number>`count(*)` })
                .from(runPins)
                .get()?.n ?? 0;
            if (count >= MAX_RUN_PINS) return 'full';
            tx.insert(runPins).values(row).run();
            return 'pinned';
          },
          { behavior: 'immediate' },
        ),
      );
    },

    unpinItem: (key) => {
      validateLookupKey(key);
      const projectRoot = keyRoot(key.kind, key.projectRoot);
      return withBusyRetry(
        () =>
          db
            .delete(runPins)
            .where(
              and(
                eq(runPins.kind, key.kind),
                eq(runPins.projectRoot, projectRoot),
                eq(runPins.ref, key.ref),
              ),
            )
            .run().changes > 0,
      );
    },

    unpinByRow: (rowid) => {
      if (!Number.isSafeInteger(rowid)) {
        throw new RunPinError('invalid_row', 'a pin row is an integer');
      }
      // One statement, one row: `rowid` is unique in the table, and nothing else about the row is read or judged.
      return withBusyRetry(
        () =>
          db
            .delete(runPins)
            .where(sql`rowid = ${rowid}`)
            .run().changes > 0,
      );
    },

    listPins: (filter) => {
      const rows = db
        .select({
          rowid: sql<number>`rowid`,
          kind: runPins.kind,
          // Both text columns pass the byte gate in the statement, so an over-long value never enters JavaScript whole.
          projectRoot: boundedText(sql`${runPins.projectRoot}`, MAX_PIN_PROJECT_ROOT_LENGTH),
          rootBytes: sql<number>`length(CAST(${runPins.projectRoot} AS BLOB))`,
          ref: boundedText(sql`${runPins.ref}`, MAX_PIN_REF_LENGTH),
          refBytes: sql<number>`length(CAST(${runPins.ref} AS BLOB))`,
          pinnedAt: runPins.pinnedAt,
        })
        .from(runPins)
        .where(
          and(
            filter?.kind === undefined ? undefined : eq(runPins.kind, filter.kind),
            filter?.projectRoot === undefined
              ? undefined
              : eq(
                  runPins.projectRoot,
                  filter.kind === 'run' ? filter.projectRoot : canonicalRoot(filter.projectRoot),
                ),
          ),
        )
        // Newest first; the key columns settle a tie so the order never flips between reads.
        .orderBy(
          desc(runPins.pinnedAt),
          asc(runPins.kind),
          asc(runPins.projectRoot),
          asc(runPins.ref),
        )
        // One row past the limit tells "exactly the limit" from "more than the limit" without a second query.
        .limit(PIN_LIST_LIMIT + 1)
        .all();
      const pins = rows.slice(0, PIN_LIST_LIMIT).map((row): PinRecord => {
        const ref = shownText(row.ref, row.refBytes, MAX_PIN_REF_LENGTH);
        const root = shownText(row.projectRoot, row.rootBytes, MAX_PIN_PROJECT_ROOT_LENGTH);
        return {
          rowid: row.rowid,
          kind: row.kind,
          projectRoot: root.text,
          ref: ref.text,
          pinnedAt: row.pinnedAt,
          oversized: ref.over || root.over,
        };
      });
      return withTruncated(pins, rows.length > PIN_LIST_LIMIT);
    },
  };
}
