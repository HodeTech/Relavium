ALTER TABLE `agent_sessions` ADD `usage_invocation_high_water` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_session_usage_invocations` (
	`session_id` text NOT NULL,
	`producer_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`dispatch_id` text NOT NULL,
	`round` integer NOT NULL,
	`chain_attempt` integer NOT NULL,
	`model` text NOT NULL,
	`coverage_state` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_usage_invocations_state_check" CHECK("coverage_state" in ('pending', 'incomplete')),
	CONSTRAINT "session_usage_invocations_producer_check" CHECK(length("producer_id") between 1 and 256),
	CONSTRAINT "session_usage_invocations_dispatch_check" CHECK(length("dispatch_id") between 1 and 256),
	CONSTRAINT "session_usage_invocations_model_check" CHECK(length("model") between 1 and 4096),
	CONSTRAINT "session_usage_invocations_ordinal_check" CHECK(typeof("ordinal") = 'integer' and "ordinal" between 1 and 9007199254740991),
	CONSTRAINT "session_usage_invocations_round_check" CHECK(typeof("round") = 'integer' and "round" between 0 and 9007199254740991),
	CONSTRAINT "session_usage_invocations_attempt_check" CHECK(typeof("chain_attempt") = 'integer' and "chain_attempt" between 1 and 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_session_usage_invocations`("session_id", "producer_id", "ordinal", "dispatch_id", "round", "chain_attempt", "model", "coverage_state") SELECT "session_id", "producer_id", "ordinal", "dispatch_id", "round", "chain_attempt", "model", 'pending' FROM `session_usage_invocations`;--> statement-breakpoint
DROP TABLE `session_usage_invocations`;--> statement-breakpoint
ALTER TABLE `__new_session_usage_invocations` RENAME TO `session_usage_invocations`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_usage_invocations_identity` ON `session_usage_invocations` (`session_id`,`producer_id`,`ordinal`);
--> statement-breakpoint
-- Preserve monotonic identity even for rows retained by the inert foundation.
UPDATE agent_sessions SET usage_invocation_high_water = coalesce((SELECT max(ordinal) FROM session_usage_invocations WHERE session_id = agent_sessions.id), 0);
--> statement-breakpoint
CREATE TRIGGER session_usage_high_water_insert
BEFORE INSERT ON agent_sessions
WHEN typeof(NEW.usage_invocation_high_water) <> 'integer' OR NEW.usage_invocation_high_water NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'session_usage_metadata_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER session_usage_high_water_update
BEFORE UPDATE OF usage_invocation_high_water ON agent_sessions
WHEN typeof(NEW.usage_invocation_high_water) <> 'integer' OR NEW.usage_invocation_high_water NOT BETWEEN OLD.usage_invocation_high_water AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'session_usage_metadata_invalid'); END;
