import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for the local SQLite dialect. `pnpm db:generate` diffs
 * `src/schema.ts` against the migration history in `./drizzle` and emits the next
 * migration. The schema/column names are kept dialect-identical so the Phase-2
 * Postgres port (ADR-0005) is a `dialect` change, not a rewrite.
 *
 * This file is loaded by drizzle-kit's own bundler (not `tsc`); it is excluded from
 * the package build and ESLint-ignored as a `*.config.*` tooling file.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
