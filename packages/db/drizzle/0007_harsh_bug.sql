ALTER TABLE `model_catalog` ADD `source` text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE `model_catalog` ADD `last_refreshed_at` integer;