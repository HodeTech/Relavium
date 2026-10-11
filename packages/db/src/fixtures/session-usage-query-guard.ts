import type Database from 'better-sqlite3';
import type { Logger } from 'drizzle-orm/logger';

import type { SessionUsageReceipt } from '../session-usage-receipt.js';

const REFUSAL = 'USAGE_QUERY_NOT_EXACT_IDENTITY';
type Identity = readonly [sessionId: string, producerId: string, ordinal: number];

/** Test-only structural witness; production settlement never pays this instrumentation cost. */
export class SessionUsageQueryGuard implements Logger {
  readonly #sqlite: Database.Database;
  readonly #plans = new Set<string>();
  readonly #mutationPlans = new Set<string>();
  #expected: Identity | undefined;
  #lookups = 0;
  #mutations = 0;

  constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }
  get receiptLookups(): number {
    return this.#lookups;
  }
  /** SELECT plans, kept separate from mutation plans for the existing scale control. */
  get queryPlans(): number {
    return this.#plans.size;
  }
  get receiptMutations(): number {
    return this.#mutations;
  }
  get mutationQueryPlans(): number {
    return this.#mutationPlans.size;
  }

  /** Receipt operations are synchronous; each statement must bind this operation's exact identity. */
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
    // Admissions INSERT new identities; revision/ACK and ordinary aggregates are separate SQL.
    if (
      !/^\s*(?:select|update|delete)\b/i.test(query) ||
      !/\bsession_usage_invocations\b/i.test(query)
    )
      return;
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (/\b(?:join|union|or|limit|offset|group|order|returning)\b/i.test(normalized))
      throw new Error(REFUSAL);
    const select = /^select (.+) from "session_usage_invocations" where (.+)$/i.exec(normalized);
    const update =
      /^update "session_usage_invocations" set "coverage_state" = \? where (.+)$/i.exec(normalized);
    const deletion = /^delete from "session_usage_invocations" where (.+)$/i.exec(normalized);
    const where = select?.[2] ?? update?.[1] ?? deletion?.[1];
    const expected = this.#expected;
    const columns = select?.[1];
    const offset = update === null ? 0 : 1;
    if (
      expected === undefined ||
      where === undefined ||
      (normalized.match(/\bselect\b/gi)?.length ?? 0) !== (select === null ? 0 : 1) ||
      (select !== null &&
        (columns === undefined || !/^(?:\*|"[a-z_]+"(?:, "[a-z_]+")*)$/.test(columns))) ||
      (update !== null && params[0] !== 'incomplete')
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
      params.length !== 3 + offset ||
      expected.some((value, index) => params[index + offset] !== value)
    )
      throw new Error(REFUSAL);
    const plans = select === null ? this.#mutationPlans : this.#plans;
    if (!plans.has(query)) {
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
      plans.add(query);
    }
    // Validate bindings above on EVERY call, including cached-plan calls.
    if (select === null) this.#mutations += 1;
    else this.#lookups += 1;
  }
}
