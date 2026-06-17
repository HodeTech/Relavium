/**
 * `@relavium/db` — the Drizzle schema, the local SQLite client, and the migration
 * runner for Relavium's run history, event log, and cost data. **One schema, two
 * dialects** ([ADR-0005](../../docs/decisions/0005-sqlite-drizzle-local-postgres-cloud.md));
 * the canonical DDL is [database-schema.md](../../docs/reference/desktop/database-schema.md).
 *
 * Curated public surface: the schema tables + their inferred row types, and the client
 * factory / migration runner. Internal column helpers in `schema.ts` are not exported.
 */

export {
  llmProviders,
  modelCatalog,
  agents,
  workflows,
  runs,
  stepExecutions,
  messages,
  runEvents,
  runCosts,
  agentSessions,
  sessionMessages,
} from './schema.js';

export type {
  LlmProviderRow,
  NewLlmProviderRow,
  ModelCatalogRow,
  NewModelCatalogRow,
  AgentRow,
  NewAgentRow,
  WorkflowRow,
  NewWorkflowRow,
  RunRow,
  NewRunRow,
  StepExecutionRow,
  NewStepExecutionRow,
  MessageRow,
  NewMessageRow,
  RunEventRow,
  NewRunEventRow,
  RunCostRow,
  NewRunCostRow,
  AgentSessionRow,
  NewAgentSessionRow,
  SessionMessageRow,
  NewSessionMessageRow,
} from './schema.js';

export { createClient, runMigrations, type Db, type DbClient } from './client.js';

// Session persistence (1.X) — the directly-stored, append-only transcript layer over the
// agent_sessions + session_messages tables. The domain ↔ row mappers double as the validation
// boundary; the platform-free engine never imports this (a host wires it over the encrypted history.db).
export {
  createSessionStore,
  toAgentSessionRow,
  fromAgentSessionRow,
  toSessionMessageRow,
  fromSessionMessageRow,
  type SessionStore,
  type SessionMessageMeta,
} from './session-store.js';
