/**
 * One platform-free corruption error for durable and in-memory run-history readers.
 * The database package re-exports this public error for existing consumers; core must not import db.
 * Discovery and strict replay refuse known damaged rows rather than infer partial authority.
 */
export class CorruptRunEventError extends Error {
  override readonly name = 'CorruptRunEventError';
  readonly code = 'corrupt_run_event' as const;

  constructor(
    readonly runId: string,
    readonly sequenceNumber: number,
    /**
     * The row's `event_type` column. Our own writes put a union literal here, but the column carries no CHECK
     * (database-schema.md), so a hand-edited DB could hold arbitrary text — hence the length bound in the message below.
     * Terminal/bidi control bytes are stripped one layer up, where every user-facing error passes through
     * `sanitizeInline` (`apps/cli/src/process/render-error.ts`); this field is not a second sanitization seam.
     */
    readonly eventType: string,
    cause: unknown,
  ) {
    const shownType = eventType.length > 64 ? `${eventType.slice(0, 64)}…` : eventType;
    super(
      `run ${runId} has a damaged event row at seq ${sequenceNumber} (type ${shownType})`,
      // Preserved so `--verbose` can still show the underlying ZodError/SyntaxError detail.
      { cause },
    );
  }
}

/**
 * Narrow an unknown thrown value to {@link CorruptRunEventError} by its `code`, not by `instanceof`.
 *
 * The CLI bundles `@relavium/db` into one file while its tests import the package directly, so two realizations of
 * the class can coexist and `instanceof` would silently answer `false` at exactly the boundary that has to catch it.
 * Cast-free narrowing (the same shape `content.ts` uses).
 */
export function isCorruptRunEventError(value: unknown): value is CorruptRunEventError {
  return value instanceof Error && 'code' in value && value.code === 'corrupt_run_event';
}
