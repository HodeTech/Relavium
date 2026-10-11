CREATE TABLE `session_usage_coverage` (
	`session_id` text NOT NULL,
	`model` text NOT NULL,
	`pending_invocations` integer DEFAULT 0 NOT NULL,
	`unknown_calls` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_usage_coverage_model_check" CHECK(length("session_usage_coverage"."model") between 1 and 4096),
	CONSTRAINT "session_usage_coverage_pending_check" CHECK(typeof("session_usage_coverage"."pending_invocations") = 'integer' and "session_usage_coverage"."pending_invocations" between 0 and 9007199254740991),
	CONSTRAINT "session_usage_coverage_unknown_check" CHECK(typeof("session_usage_coverage"."unknown_calls") = 'integer' and "session_usage_coverage"."unknown_calls" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_usage_coverage_model` ON `session_usage_coverage` (`session_id`,`model`);--> statement-breakpoint
CREATE TABLE `session_usage_invocations` (
	`session_id` text NOT NULL,
	`producer_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`dispatch_id` text NOT NULL,
	`round` integer NOT NULL,
	`chain_attempt` integer NOT NULL,
	`model` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_usage_invocations_producer_check" CHECK(length("session_usage_invocations"."producer_id") between 1 and 256),
	CONSTRAINT "session_usage_invocations_dispatch_check" CHECK(length("session_usage_invocations"."dispatch_id") between 1 and 256),
	CONSTRAINT "session_usage_invocations_model_check" CHECK(length("session_usage_invocations"."model") between 1 and 4096),
	CONSTRAINT "session_usage_invocations_ordinal_check" CHECK(typeof("session_usage_invocations"."ordinal") = 'integer' and "session_usage_invocations"."ordinal" between 1 and 9007199254740991),
	CONSTRAINT "session_usage_invocations_round_check" CHECK(typeof("session_usage_invocations"."round") = 'integer' and "session_usage_invocations"."round" between 0 and 9007199254740991),
	CONSTRAINT "session_usage_invocations_attempt_check" CHECK(typeof("session_usage_invocations"."chain_attempt") = 'integer' and "session_usage_invocations"."chain_attempt" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_usage_invocations_identity` ON `session_usage_invocations` (`session_id`,`producer_id`,`ordinal`);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `usage_mutation_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `usage_ack_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `usage_unverified` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `usage_pending_invocations` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `usage_unknown_calls` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- ADR-0104: dialect-specific metadata only. No money or coverage arithmetic in triggers.
CREATE TRIGGER session_usage_bounds_insert
BEFORE INSERT ON agent_sessions
WHEN typeof(NEW.usage_mutation_revision) <> 'integer' OR NEW.usage_mutation_revision NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.usage_ack_revision) <> 'integer' OR NEW.usage_ack_revision NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.usage_pending_invocations) <> 'integer' OR NEW.usage_pending_invocations NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.usage_unknown_calls) <> 'integer' OR NEW.usage_unknown_calls NOT BETWEEN 0 AND 9007199254740991
  OR NEW.usage_ack_revision > NEW.usage_mutation_revision
  OR typeof(NEW.usage_unverified) <> 'integer' OR NEW.usage_unverified NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'session_usage_metadata_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER session_usage_bounds_update
BEFORE UPDATE OF usage_mutation_revision, usage_ack_revision, usage_pending_invocations, usage_unknown_calls, usage_unverified ON agent_sessions
WHEN typeof(NEW.usage_mutation_revision) <> 'integer' OR NEW.usage_mutation_revision NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.usage_ack_revision) <> 'integer' OR NEW.usage_ack_revision NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.usage_pending_invocations) <> 'integer' OR NEW.usage_pending_invocations NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.usage_unknown_calls) <> 'integer' OR NEW.usage_unknown_calls NOT BETWEEN 0 AND 9007199254740991
  OR NEW.usage_ack_revision > NEW.usage_mutation_revision
  OR typeof(NEW.usage_unverified) <> 'integer' OR NEW.usage_unverified NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'session_usage_metadata_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER session_usage_owner_insert
AFTER INSERT ON agent_sessions
BEGIN
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER session_usage_owner_update
AFTER UPDATE OF id, agent_id, agent_slug, agent_snapshot, title, model_id, working_dir, git_ref, fs_scope_tier, status, context_json, total_input_tokens, total_output_tokens, total_cost_microcents, total_conservative_microcents, exported_workflow_path, deleted_at, created_at, updated_at ON agent_sessions
BEGIN
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER session_messages_usage_insert
AFTER INSERT ON session_messages
BEGIN
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_messages_usage_update
AFTER UPDATE ON session_messages
BEGIN
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = OLD.session_id;
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = NEW.session_id AND NEW.session_id IS NOT OLD.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_messages_usage_delete
AFTER DELETE ON session_messages
BEGIN
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = OLD.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_costs_usage_insert
AFTER INSERT ON session_costs
BEGIN
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_costs_usage_update
AFTER UPDATE ON session_costs
BEGIN
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = OLD.session_id;
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = NEW.session_id AND NEW.session_id IS NOT OLD.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_costs_usage_delete
AFTER DELETE ON session_costs
BEGIN
  UPDATE agent_sessions
  SET usage_mutation_revision = CASE
    WHEN usage_mutation_revision < 9007199254740991 THEN usage_mutation_revision + 1
    ELSE RAISE(ABORT, 'session_usage_revision_exhausted') END
  WHERE id = OLD.session_id;
END;
