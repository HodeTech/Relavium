import type Database from 'better-sqlite3';
import { getTableColumns } from 'drizzle-orm';

import { agentSessions } from '../schema.js';

const bookkeeping = new Set([
  'usage_mutation_revision',
  'usage_ack_revision',
  'usage_unverified',
  'usage_pending_invocations',
  'usage_unknown_calls',
  'usage_invocation_high_water',
  'effect_turn_high_water',
]);
/** Every new schema business column automatically joins the trigger and unchanged-write controls. */
export const sessionBusinessColumns = Object.values(getTableColumns(agentSessions))
  .map((column) => column.name)
  .filter((name) => !bookkeeping.has(name));
const refusal = () => {
  throw new Error('SESSION_USAGE_TRIGGER_COLUMN_DRIFT');
};

/** Independent schema/native-column/trigger parity; neither SQL nor tests repeat a business allowlist. */
export function assertSessionUsageColumnInventory(sqlite: Database.Database): void {
  const schemaNames = Object.values(getTableColumns(agentSessions))
    .map((column) => column.name)
    .sort();
  const actual = sqlite
    .prepare("PRAGMA table_info('agent_sessions')")
    .all()
    .map((row) => {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('name' in row) ||
        typeof row.name !== 'string'
      )
        return refusal();
      return row.name;
    })
    .sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(schemaNames) ||
    [...bookkeeping].some((name) => !schemaNames.includes(name))
  )
    refusal();
  const row = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'session_usage_owner_update'",
    )
    .get();
  if (typeof row !== 'object' || row === null || !('sql' in row) || typeof row.sql !== 'string')
    return refusal();
  const text = /AFTER\s+UPDATE\s+OF\s+(.+?)\s+ON\s+agent_sessions/is.exec(row.sql)?.[1];
  if (text === undefined) return refusal();
  const columns = text
    .split(',')
    .map((name) => name.trim().replace(/^["`]|["`]$/g, ''))
    .sort();
  if (JSON.stringify(columns) !== JSON.stringify([...sessionBusinessColumns].sort())) refusal();
}
