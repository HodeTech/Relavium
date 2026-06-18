CREATE TABLE `media_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`mime_type` text NOT NULL,
	`modality` text NOT NULL,
	`byte_length` integer NOT NULL,
	`duration_ms` integer,
	`last_referenced_at` integer NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "media_objects_modality_check" CHECK("media_objects"."modality" in ('image', 'audio', 'video', 'document'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_media_objects_handle` ON `media_objects` (`handle`);--> statement-breakpoint
CREATE INDEX `idx_media_objects_gc` ON `media_objects` (`last_referenced_at`) WHERE "media_objects"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `media_references` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`handle`) REFERENCES `media_objects`(`handle`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_references_scope_kind_check" CHECK("media_references"."scope_kind" in ('run', 'node', 'session', 'workspace'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_media_references_unique` ON `media_references` (`handle`,`scope_kind`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_media_references_scope` ON `media_references` (`scope_kind`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_media_references_handle` ON `media_references` (`handle`);