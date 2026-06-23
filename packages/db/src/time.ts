/**
 * The single domain ↔ storage timestamp boundary for `@relavium/db`: ISO-8601 strings in the domain
 * (the run-event / session envelopes), epoch-millisecond `INTEGER`s in storage (database-schema.md
 * §conventions — "timezone handled in app code"). Pure + deterministic (no wall-clock read), so a row
 * round-trips an instant: the epoch-ms form preserves the **instant** but normalizes to canonical UTC
 * millisecond `…Z` form, not byte-identical to a sub-millisecond / non-UTC-offset input.
 */

/** ISO-8601 (domain) → epoch-ms (storage). Input is an already-validated ISO string. */
export function isoToEpochMs(iso: string): number {
  return new Date(iso).getTime();
}

/** epoch-ms (storage) → ISO-8601 (domain), canonical UTC millisecond form. */
export function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString();
}
