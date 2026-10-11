import type Database from 'better-sqlite3';
import type { Logger } from 'drizzle-orm/logger';

import type { SessionUsageReceipt } from '../session-usage-receipt.js';

const REFUSAL = 'USAGE_QUERY_NOT_EXACT_IDENTITY';
type Identity = readonly [sessionId: string, producerId: string, ordinal: number];

/** Test-only structural witness; production settlement never pays this instrumentation cost. */
export class SessionUsageQueryGuard implements Logger {
  readonly #sqlite: Database.Database;
  readonly #plans = new Set<string>();
  #expected: Identity | undefined;
  #lookups = 0;

  constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  get receiptLookups(): number {
    return this.#lookups;
  }

  get queryPlans(): number {
    return this.#plans.size;
  }

  /** Receipt operations are synchronous; each lookup must bind this operation's exact identity. */
  forReceipt<T>(receipt: SessionUsageReceipt, operation: () => T): T {
    if (this.#expected !== undefined) throw new Error(REFUSAL);
    this.#expected = [receipt.sessionId, receipt.invocation.producerId, receipt.invocation.ordinal];
    try {
      return operation();
    } finally {
      this.#expected = undefined;
    }
  }

  logQuery(query: string, params: unknown[]): void {
    // Revision/ACK bookkeeping and ordinary aggregate readers are legitimate separate SQL.
    if (!/^\s*select\b/i.test(query) || !/\bsession_usage_invocations\b/i.test(query)) return;
    const expected = this.#expected;
    const normalized = query.replace(/\s+/g, ' ').trim();
    const match = /^select (.+) from "session_usage_invocations" where (.+)$/i.exec(normalized);
    const columns = match?.[1];
    const where = match?.[2];
    if (
      expected === undefined ||
      columns === undefined ||
      where === undefined ||
      (normalized.match(/\bselect\b/gi)?.length ?? 0) !== 1 ||
      /\b(?:join|union|or|limit|offset|group|order)\b/i.test(normalized) ||
      !/^(?:\*|"[a-z_]+"(?:, "[a-z_]+")*)$/.test(columns)
    )
      throw new Error(REFUSAL);

    const terms = [...where.matchAll(/"session_usage_invocations"\."([a-z_]+)" = \?/g)];
    const remainder = where
      .replace(/"session_usage_invocations"\."[a-z_]+" = \?/g, '')
      .replace(/\band\b/gi, '')
      .replace(/[()\s]/g, '');
    if (
      remainder !== '' ||
      terms.length !== 3 ||
      terms[0]?.[1] !== 'session_id' ||
      terms[1]?.[1] !== 'producer_id' ||
      terms[2]?.[1] !== 'ordinal' ||
      params.length !== 3 ||
      params.some((value, index) => value !== expected[index])
    )
      throw new Error(REFUSAL);

    if (!this.#plans.has(query)) {
      const plan = this.#sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params);
      if (
        plan.length !== 1 ||
        !plan.every(
          (row) =>
            typeof row === 'object' &&
            row !== null &&
            'detail' in row &&
            typeof row.detail === 'string' &&
            /^SEARCH session_usage_invocations USING (?:COVERING )?INDEX idx_session_usage_invocations_identity \(session_id=\? AND producer_id=\? AND ordinal=\?\)$/.test(
              row.detail,
            ),
        )
      )
        throw new Error(REFUSAL);
      this.#plans.add(query);
    }
    // Parameters are validated above on EVERY call, including cached-plan calls.
    this.#lookups += 1;
  }
}
