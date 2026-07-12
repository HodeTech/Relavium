CREATE TABLE `session_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`model` text NOT NULL,
	`model_catalog_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_microcents` integer DEFAULT 0 NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`unpriced_calls` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_catalog_id`) REFERENCES `model_catalog`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "session_costs_model_nonempty" CHECK("session_costs"."model" <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_costs_session_model` ON `session_costs` (`session_id`,`model`);--> statement-breakpoint
CREATE INDEX `idx_session_costs_session` ON `session_costs` (`session_id`,`cost_microcents`);--> statement-breakpoint
ALTER TABLE `session_messages` DROP COLUMN `input_tokens`;--> statement-breakpoint
ALTER TABLE `session_messages` DROP COLUMN `output_tokens`;--> statement-breakpoint
ALTER TABLE `session_messages` DROP COLUMN `cost_microcents`;--> statement-breakpoint
-- BACKFILL (ADR-0070 §4) — hand-appended DML; drizzle-kit emits DDL only. A documented deviation, and the reason for
-- it is the whole point of the invariant: every pre-migration session carries a non-zero total with ZERO rows behind
-- it, and no backfill SOURCE exists (the per-attempt increments were discarded; session_messages.cost_microcents was
-- never written). Without this row, `SUM(session_costs) == agent_sessions.total_cost_microcents` would be true only
-- for sessions created after this migration — an invariant with a silent exception class, which is exactly the
-- half-truth ADR-0070 exists to eliminate.
--
-- One row per legacy session. `id = session_id` is safe (exactly one row per session, so the PK can reuse it). The
-- model is the sentinel `(pre-2.6.C)`: parenthesised, so it can never collide with a real provider model id (no
-- provider id contains parentheses), and it satisfies the non-empty CHECK. `/cost` renders it honestly as
-- "per-model breakdown unavailable — session predates per-model attribution" rather than as an implied zero.
INSERT INTO `session_costs` (
  `id`, `session_id`, `model`, `model_catalog_id`,
  `input_tokens`, `output_tokens`, `cost_microcents`, `call_count`, `unpriced_calls`,
  `created_at`, `updated_at`
)
SELECT `id`, `id`, '(pre-2.6.C)', NULL, 0, 0, `total_cost_microcents`, 0, 0, `created_at`, `updated_at`
  FROM `agent_sessions`
 WHERE `total_cost_microcents` > 0;
