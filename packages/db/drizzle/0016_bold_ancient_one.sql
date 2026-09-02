ALTER TABLE `model_catalog` ADD `token_rates_stated` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- WHY A SECOND "STATED" FLAG, AND WHY NOW ([ADR-0089](../../../docs/decisions/0089-media-correctness-four-boundaries.md) §4).
--
-- Exactly the migration-0011 problem, on the other two money columns. `input_cost_per_mtok_microcents` and
-- `output_cost_per_mtok_microcents` are `NOT NULL DEFAULT 0`, so a row that never stated them is byte-identical
-- to one that stated free — and SQLite cannot drop a NOT NULL constraint with ALTER (the only route is a table
-- rebuild, and `model_catalog.id` is an FK target from five tables). So the FACT of the statement gets its own
-- column, additively, exactly as `cached_input_stated` did.
--
-- It was not needed until now because `models pricing` REQUIRED `--input` and `--output` together, so a
-- `source='user'` row could not exist without real values. ADR-0089 §4(c) makes a MEDIA-ONLY invocation legal —
-- it is how a user satisfies a `strict_cost_cap` refusal on a model the catalog already prices for tokens —
-- and without this flag that write lands `0`/`0`, the user row outranks the catalog, and every token on that
-- model bills at nothing, permanently and silently. That is the `CR-55` defect (a `0` the governor cannot tell
-- from "nothing to charge") reintroduced by its own remedy, on the dominant cost axis.
--
-- THE BACKFILL IS UNAMBIGUOUS, unlike 0011's. Every existing `source='user'` row was necessarily written by a
-- command that demanded both flags, so every one of them stated its token rates — including any that state a
-- legitimate `0`. There is no "may have been the default" case to err about.
UPDATE `model_catalog` SET `token_rates_stated` = 1 WHERE `source` = 'user';
