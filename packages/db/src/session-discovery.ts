import { AgentSessionSchema, RelaviumError } from '@relavium/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { agentSessions } from './schema.js';
import { epochMsToIso, isoToEpochMs } from './time.js';

export interface SessionPageCursor {
  readonly updatedAt: string;
  readonly id: string;
}
export interface SessionPageOptions {
  /** Absent means every directory. This is discovery, never workspace authority. */
  readonly workingDir?: string;
  /** Literal title substring; SQL wildcards in the input remain literal. */
  readonly title?: string;
  readonly cursor?: SessionPageCursor;
  readonly direction?: 'forward' | 'backward';
  readonly limit?: number;
}
export interface SessionPageRow {
  readonly id: string;
  readonly agentSlug: string;
  readonly title?: string;
  readonly updatedAt: string;
  readonly workingDir: string;
}
export interface SessionPage {
  readonly sessions: readonly SessionPageRow[];
  readonly next?: SessionPageCursor;
  readonly previous?: SessionPageCursor;
}
export class SessionDiscoveryBoundaryError extends RelaviumError {
  readonly code = 'session_discovery_invalid';
  constructor() {
    super('session discovery refused at the persistence boundary');
    this.name = 'SessionDiscoveryBoundaryError';
  }
}
const CursorSchema = AgentSessionSchema.pick({ id: true, updatedAt: true });
const IdentitySchema = AgentSessionSchema.pick({
  id: true,
  agentSlug: true,
  title: true,
  updatedAt: true,
});

/** Indexed keyset pages. No transcript, snapshot, usage history or full JS session list is loaded. */
export function listSessionPage(db: Db, options: SessionPageOptions = {}): SessionPage {
  const limit = options.limit ?? 20;
  const backward = options.direction === 'backward';
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (options.direction !== undefined &&
      options.direction !== 'forward' &&
      options.direction !== 'backward') ||
    (backward && options.cursor === undefined) ||
    (options.title !== undefined &&
      (typeof options.title !== 'string' || options.title.length > 256)) ||
    (options.workingDir !== undefined &&
      (typeof options.workingDir !== 'string' || options.workingDir.length === 0))
  )
    throw new SessionDiscoveryBoundaryError();
  const cursor = options.cursor === undefined ? undefined : CursorSchema.safeParse(options.cursor);
  if (cursor !== undefined && !cursor.success) throw new SessionDiscoveryBoundaryError();
  const after = cursor?.success === true ? cursor.data : undefined;
  const pattern =
    options.title === undefined || options.title.length === 0
      ? undefined
      : `%${options.title.replace(/[\\%_]/gu, '\\$&')}%`;
  const rows = db
    .select({
      id: agentSessions.id,
      title: agentSessions.title,
      agentSlug: agentSessions.agentSlug,
      updatedAt: agentSessions.updatedAt,
      workingDir: agentSessions.workingDir,
    })
    .from(agentSessions)
    .where(
      and(
        isNull(agentSessions.deletedAt),
        options.workingDir === undefined
          ? undefined
          : eq(agentSessions.workingDir, options.workingDir),
        pattern === undefined ? undefined : sql`${agentSessions.title} like ${pattern} escape '\\'`,
        after === undefined
          ? undefined
          : backward
            ? sql`(${agentSessions.updatedAt}, ${agentSessions.id}) > (${isoToEpochMs(after.updatedAt)}, ${after.id})`
            : sql`(${agentSessions.updatedAt}, ${agentSessions.id}) < (${isoToEpochMs(after.updatedAt)}, ${after.id})`,
      ),
    )
    .orderBy(
      backward ? asc(agentSessions.updatedAt) : desc(agentSessions.updatedAt),
      backward ? asc(agentSessions.id) : desc(agentSessions.id),
    )
    .limit(limit + 1)
    .all();
  const selected = rows.slice(0, limit);
  const sessions = (backward ? selected.toReversed() : selected).map((row): SessionPageRow => {
    const parsed = IdentitySchema.safeParse({
      id: row.id,
      agentSlug: row.agentSlug,
      ...(row.title === null ? {} : { title: row.title }),
      updatedAt: epochMsToIso(row.updatedAt),
    });
    if (!parsed.success || typeof row.workingDir !== 'string' || row.workingDir.length === 0)
      throw new SessionDiscoveryBoundaryError();
    return {
      id: parsed.data.id,
      agentSlug: parsed.data.agentSlug,
      updatedAt: parsed.data.updatedAt,
      ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
      workingDir: row.workingDir,
    };
  });
  const last = sessions.at(-1);
  const first = sessions[0];
  const next = backward ? (last ?? after) : rows.length > limit ? last : undefined;
  const previous = backward
    ? rows.length > limit
      ? first
      : undefined
    : after === undefined
      ? undefined
      : (first ?? after);
  return {
    sessions,
    ...(next === undefined ? {} : { next: { updatedAt: next.updatedAt, id: next.id } }),
    ...(previous === undefined
      ? {}
      : { previous: { updatedAt: previous.updatedAt, id: previous.id } }),
  };
}
