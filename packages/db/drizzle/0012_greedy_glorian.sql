-- ADR-0072 — the DB-backed model catalog behind the offline snapshot floor.
--
-- Three additive, reversible changes (a fresh CREATE cannot break existing rows; the ALTER carries a constant
-- default): the `model_metadata` mirror of the models.dev catalog, the `catalog_meta` singleton cursor, and the
-- `model_catalog.visible` picker flag. The `model_catalog.id` FK graph (six referrer tables) is untouched — neither
-- new table references it, and `model_metadata` is a leaf keyed by `model_id` (the CATALOG_SNAPSHOT key space), NOT
-- the catalog UUID. This DB is NEVER the terminal money source: the generated binary snapshot stays the floor; these
-- tables only BACK the additive overlay, so a fresh/torn/older-schema DB degrades to the snapshot, offline.
CREATE TABLE `catalog_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`seeded_snapshot_sha` text,
	`catalog_schema_version` integer,
	`availability_checked_at` integer,
	`catalog_checked_at` integer,
	`catalog_source_etag` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "catalog_meta_singleton" CHECK("catalog_meta"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `model_metadata` (
	`model_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`display_name` text NOT NULL,
	`context_window_tokens` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`input_cost_per_mtok_microcents` integer NOT NULL,
	`output_cost_per_mtok_microcents` integer NOT NULL,
	`cached_input_cost_per_mtok_microcents` integer,
	`cache_write_cost_per_mtok_microcents` integer,
	`context_tiers` text,
	`reasoning` text,
	`request_capabilities` text,
	`input_modalities` text,
	`output_modalities` text,
	`knowledge_cutoff` text,
	`description` text,
	`origin` text NOT NULL,
	`catalog_schema_version` integer NOT NULL,
	`refreshed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	-- `origin` discriminates WHICH store owns this row's money+wire: 'shipped' (pinned to the reviewed binary
	-- snapshot; a refresh rewrites only its pure-enrichment columns) vs 'refreshed' (a long-tail model admitted
	-- through the shared additive gate). CHECK'd here because this is an initial CREATE (unlike the ALTER-ADD
	-- `model_catalog.source`, which SQLite cannot carry a CHECK on).
	CONSTRAINT "model_metadata_origin_check" CHECK("model_metadata"."origin" in ('shipped', 'refreshed')),
	-- Money floor AT REST. A 'refreshed' long-tail row MUST be priced on both sides (the runtime gate refuses it
	-- otherwise; this is belt-and-suspenders). A 'shipped' row is whatever the reviewed snapshot says — a free
	-- shipped model (input 0) is legitimate and pinned — so the positivity check is scoped to refreshed rows. Cache
	-- rates stay NULLABLE and are NEVER coerced to 0 (ADR-0071 §10): NULL means "no discount data", 0 means "free".
	CONSTRAINT "model_metadata_refreshed_base_price_positive" CHECK("model_metadata"."origin" = 'shipped' OR ("model_metadata"."input_cost_per_mtok_microcents" > 0 AND "model_metadata"."output_cost_per_mtok_microcents" > 0))
);
--> statement-breakpoint
CREATE INDEX `idx_model_metadata_provider` ON `model_metadata` (`provider`);--> statement-breakpoint
-- Picker visibility (ADR-0072 point 4) — a HARD filter above ADR-0064 §6's "dim, never hide" availability rule,
-- ORTHOGONAL to `is_active`. Constant `1` default: every existing row is visible until the user hides it via
-- `/settings > /models`. Every write path that rewrites a row must PRESERVE this by read-modify-write.
ALTER TABLE `model_catalog` ADD `visible` integer DEFAULT 1 NOT NULL;