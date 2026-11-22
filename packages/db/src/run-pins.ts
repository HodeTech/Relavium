import { RelaviumError } from '@relavium/shared';
import { and, desc, asc, eq, sql } from 'drizzle-orm';

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
/** The longest `ref` (a run id or a workflow slug) the store accepts. */
export const MAX_PIN_REF_LENGTH = 512;
/** The longest `projectRoot` the store accepts. */
export const MAX_PIN_PROJECT_ROOT_LENGTH = 4096;

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
}

export type RunPinErrorCode =
  | 'invalid_kind'
  | 'invalid_ref'
  | 'invalid_project_root'
  | 'invalid_time';

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

export interface RunPinStore {
  /**
   * Pin an item. `'already-pinned'` when the exact `(kind, projectRoot, ref)` is there — which also wins over
   * `'full'`, so re-pinning at the cap is not reported as a refusal — and `'full'` when {@link MAX_RUN_PINS} rows
   * exist already. `at` is epoch ms. A run pin carries `projectRoot: ''`; a workflow pin must carry its project.
   * @throws {RunPinError} for an invalid kind, ref, project root or time.
   */
  readonly pinItem: (input: PinKey & { readonly at: number }) => PinResult;
  /**
   * Remove a pin; `true` when a row was removed, `false` when there was none. It matches the EXACT stored key and
   * does not judge its content: a row written outside this store (an older writer, a crafted row) must stay
   * removable by the ref {@link listPins} shows for it, and a content rule here would turn a bad row into a pin
   * nothing can remove. Only the shape is checked: a known kind, text for the ref and the project root, and the
   * fixed length bounds.
   * @throws {RunPinError} for an unknown kind, a non-text ref or project root, or a key over its length bound.
   */
  readonly unpinItem: (key: PinKey) => boolean;
  /** The pins as stored, newest first (ties in a stable key order), optionally narrowed by kind and project. */
  readonly listPins: (filter?: {
    readonly kind?: PinKind;
    readonly projectRoot?: string;
  }) => PinRecord[];
}

/**
 * What no pin's text may contain, because the Home lists it back to a terminal and a pin is found again by the text
 * it was listed with: control characters (C0, DEL, C1), format characters (`\p{Cf}`: the bidirectional overrides
 * U+202A to U+202E, the zero-width characters, the soft hyphen, the byte-order mark), the Unicode line and
 * paragraph separators, and a lone surrogate. A lone surrogate is stored as bytes that read back as replacement
 * characters, so a pin written with one could not be matched by the ref the list shows for it.
 */
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function validateKind(key: PinKey): void {
  if (!PIN_KINDS.some((kind) => kind === key.kind)) {
    throw new RunPinError('invalid_kind', 'a pin is a run or a workflow');
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
      `a pin reference is 1 to ${MAX_PIN_REF_LENGTH} characters with no control, format or unpaired-surrogate characters`,
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
  } else if (
    key.projectRoot.length === 0 ||
    key.projectRoot.length > MAX_PIN_PROJECT_ROOT_LENGTH ||
    FORBIDDEN_TEXT.test(key.projectRoot)
  ) {
    throw new RunPinError(
      'invalid_project_root',
      `a workflow pin carries its project root: 1 to ${MAX_PIN_PROJECT_ROOT_LENGTH} characters with no control, format or unpaired-surrogate characters`,
    );
  }
}

/**
 * The unpin path's rule set: the shape and the fixed bounds, never the content. The key is matched exactly as
 * stored, so a row an older writer (or a crafted row) left with an escape character in its ref is still removable
 * by the ref {@link RunPinStore.listPins} returns for it. The bounds keep an absurd key out of the statement.
 */
function validateLookupKey(key: PinKey): void {
  validateKind(key);
  if (typeof key.ref !== 'string' || key.ref.length > MAX_PIN_REF_LENGTH) {
    throw new RunPinError(
      'invalid_ref',
      `a pin reference is at most ${MAX_PIN_REF_LENGTH} characters`,
    );
  }
  if (typeof key.projectRoot !== 'string' || key.projectRoot.length > MAX_PIN_PROJECT_ROOT_LENGTH) {
    throw new RunPinError(
      'invalid_project_root',
      `a pin project root is at most ${MAX_PIN_PROJECT_ROOT_LENGTH} characters`,
    );
  }
}

/** Wire a {@link RunPinStore} over a `@relavium/db` connection. */
export function createRunPinStore(db: Db): RunPinStore {
  return {
    pinItem: (input) => {
      validateKey(input);
      if (!Number.isSafeInteger(input.at) || input.at < 0) {
        throw new RunPinError('invalid_time', 'a pin time is a non-negative integer of epoch ms');
      }
      const row: NewRunPinRow = {
        kind: input.kind,
        projectRoot: input.projectRoot,
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
                  eq(runPins.projectRoot, input.projectRoot),
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
      return withBusyRetry(
        () =>
          db
            .delete(runPins)
            .where(
              and(
                eq(runPins.kind, key.kind),
                eq(runPins.projectRoot, key.projectRoot),
                eq(runPins.ref, key.ref),
              ),
            )
            .run().changes > 0,
      );
    },

    listPins: (filter) =>
      db
        .select()
        .from(runPins)
        .where(
          and(
            filter?.kind === undefined ? undefined : eq(runPins.kind, filter.kind),
            filter?.projectRoot === undefined
              ? undefined
              : eq(runPins.projectRoot, filter.projectRoot),
          ),
        )
        // Newest first; the key columns settle a tie so the order never flips between reads.
        .orderBy(
          desc(runPins.pinnedAt),
          asc(runPins.kind),
          asc(runPins.projectRoot),
          asc(runPins.ref),
        )
        .all()
        .map(
          (row): PinRecord => ({
            kind: row.kind,
            projectRoot: row.projectRoot,
            ref: row.ref,
            pinnedAt: row.pinnedAt,
          }),
        ),
  };
}
