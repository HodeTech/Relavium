CREATE TABLE `run_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`slot` integer NOT NULL,
	`tool_id` text NOT NULL,
	`tier` integer NOT NULL,
	`state` text NOT NULL,
	`args_digest` text NOT NULL,
	`target_idempotency_key` text,
	`result_json` text,
	`attempt_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_effects_identity` ON `run_effects` (`scope`,`slot`,`tool_id`);--> statement-breakpoint
CREATE INDEX `idx_run_effects_scope` ON `run_effects` (`scope`);