CREATE TABLE `run_pins` (
	`kind` text NOT NULL,
	`project_root` text DEFAULT '' NOT NULL,
	`ref` text NOT NULL,
	`pinned_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `project_root`, `ref`),
	CONSTRAINT "run_pins_kind_check" CHECK("run_pins"."kind" in ('run', 'workflow'))
);
--> statement-breakpoint
CREATE INDEX `idx_runs_project_created` ON `runs` (`project_root`,"created_at" desc,"id" desc) WHERE "runs"."deleted_at" is null;