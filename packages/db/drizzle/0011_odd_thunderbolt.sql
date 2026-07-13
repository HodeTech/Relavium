ALTER TABLE `model_catalog` ADD `cached_input_stated` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- WHY A FLAG AND NOT A NULLABLE COLUMN (ADR-0071 §10).
--
-- `cached_input_cost_per_mtok_microcents` is `NOT NULL DEFAULT 0`, and SQLite cannot drop a NOT NULL constraint with
-- ALTER — the only route is a table rebuild, and `model_catalog.id` is an FK target from five tables. So the FACT of
-- the statement gets its own column instead, additively, and every existing row is correct at the default:
--
--   • A `source='user'` row written before this migration and carrying a NON-ZERO cache rate was, necessarily, one
--     the user stated — the old command only ever wrote the column when `--cached` was passed. The backfill below
--     records that.
--   • A row carrying `0` is genuinely ambiguous in the old schema: it may be "never mentioned" (overwhelmingly the
--     common case — the flag was optional and rarely used) or an explicit `--cached 0`. It stays `not stated`, which
--     resolves to the catalog's discount applied to the user's own input rate rather than to free tokens. Erring
--     toward billing is the only safe direction on a money column: the user can restate `--cached 0` and be believed.
UPDATE `model_catalog`
   SET `cached_input_stated` = 1
 WHERE `source` = 'user' AND `cached_input_cost_per_mtok_microcents` > 0;
