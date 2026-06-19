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
  mediaObjects,
  mediaReferences,
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
  MediaObjectRow,
  NewMediaObjectRow,
  MediaReferenceRow,
  NewMediaReferenceRow,
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

// Media store (1.AF, ADR-0042) — the host-side content-addressed blob store the engine references by
// handle. Node-side (node:crypto + node:fs); a host wires one into ExecutionHost.mediaStore. The pure
// engine never imports this — it depends only on the @relavium/shared `MediaStore` interface.
export { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

// Media egress (1.AF/D9, ADR-0043) — the host-side SSRF-validated, size-bounded URL fetch the engine
// binds into a `MediaUrlFetch` hook so `deInlineMedia` can re-host a url media source to a handle.
// Node-side (node:dns + node:https + node:net). The pure engine never imports this.
export {
  fetchMediaBytes,
  nodeMediaEgressDeps,
  MediaEgressError,
  type FetchMediaBytesOptions,
  type MediaEgressDeps,
  type MediaEgressErrorCode,
  type HopRequest,
  type HopResponse,
} from './media-egress.js';

// Media references (1.AF/D12c + D11, ADR-0042/0044) — the media_objects/media_references retention + authz
// junction store. A host wires `describe` behind the read_media MediaReadAccess delegate + `removeRunReferences`
// behind the engine's terminal sweep; the pure engine never imports it.
export {
  createMediaReferenceStore,
  createMediaReferencePort,
  type MediaReferenceStore,
  type MediaObjectInput,
  type MediaHandleRecord,
} from './media-reference-store.js';

// Media write (1.AF/D16, ADR-0044 §2) — the host-side fail-closed `save_to` write port (realpath+commonpath
// jail under a scope root, symlinks off, atomic publish). A host wires it into `ExecutionHost.mediaWrite`;
// the pure engine never imports it (Node `node:fs` — it depends only on the @relavium/shared `MediaWritePort`).
export { createFilesystemMediaWrite } from './media-write.js';
