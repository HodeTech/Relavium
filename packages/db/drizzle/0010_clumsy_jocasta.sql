DROP INDEX `idx_session_costs_session_model`;--> statement-breakpoint
ALTER TABLE `session_costs` ADD `is_legacy` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_costs_session_model` ON `session_costs` (`session_id`,`model`,`is_legacy`);--> statement-breakpoint
-- FLAG THE ALREADY-BACKFILLED ROWS (ADR-0070 §4) — hand-appended DML; drizzle-kit emits DDL only.
--
-- Why this is a SECOND migration and not an edit to 0009: 0009 had already been applied to real databases (the
-- maintainer's `~/.relavium/history.db`, carrying real sessions) before review found the collision. Rewriting an
-- applied migration changes its hash, so drizzle would replay it and `CREATE TABLE session_costs` would fail against
-- the table it had itself created — taking a real chat history down with it. 0009 stays exactly as it shipped; the
-- discriminator arrives additively here, and a database at 0008 and a database at 0009 both converge on the same
-- schema.
--
-- 0009's backfill wrote its aggregate rows with `call_count = 0`, which no real egress can produce (every
-- `recordSessionCost` inserts with `call_count = 1` and increments from there). That makes the predicate exact.
--
-- One residue this cannot repair: if a user had ALREADY resumed a legacy session and spent on a custom model named
-- literally `(pre-2.6.C)`, 0009's `(session_id, model)` index merged that spend INTO the legacy row (call_count >= 1),
-- and the two are no longer separable. Such a row keeps `is_legacy = 0` and renders as a real model row carrying the
-- commingled cost — wrong in its label, right in its total. The invariant still holds. From 0010 on, the merge is
-- impossible.
UPDATE `session_costs` SET `is_legacy` = 1 WHERE `model` = '(pre-2.6.C)' AND `call_count` = 0;
