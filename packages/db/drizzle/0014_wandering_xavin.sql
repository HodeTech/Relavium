CREATE TABLE `run_leases` (
	`run_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
