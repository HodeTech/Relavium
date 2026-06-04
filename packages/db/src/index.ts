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
} from './schema.js';

export { createClient, runMigrations, type Db, type DbClient } from './client.js';
