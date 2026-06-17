CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`agent_slug` text NOT NULL,
	`agent_snapshot` text,
	`title` text,
	`model_id` text,
	`working_dir` text,
	`git_ref` text,
	`fs_scope_tier` text DEFAULT 'sandboxed' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`context_json` text DEFAULT '{}' NOT NULL,
	`total_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_output_tokens` integer DEFAULT 0 NOT NULL,
	`total_cost_microcents` integer DEFAULT 0 NOT NULL,
	`exported_workflow_path` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_id`) REFERENCES `model_catalog`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_sessions_fs_scope_tier_check" CHECK("agent_sessions"."fs_scope_tier" in ('sandboxed', 'project', 'full')),
	CONSTRAINT "agent_sessions_status_check" CHECK("agent_sessions"."status" in ('active', 'idle', 'exported', 'ended'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_sessions_status` ON `agent_sessions` (`status`,"updated_at" desc) WHERE "agent_sessions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `idx_agent_sessions_agent` ON `agent_sessions` (`agent_id`,"created_at" desc) WHERE "agent_sessions"."agent_id" is not null;--> statement-breakpoint
CREATE TABLE `session_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`content_parts` text,
	`tool_calls` text,
	`tool_call_id` text,
	`name` text,
	`finish_reason` text,
	`model_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_microcents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `model_catalog`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_messages_seq` ON `session_messages` (`session_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `idx_session_messages_session` ON `session_messages` (`session_id`,`created_at`);