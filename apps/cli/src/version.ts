/**
 * CLI version. `tsup` replaces `__RELAVIUM_CLI_VERSION__` with the `package.json` version at build time
 * (see tsup.config.ts `define`); a source run (tsx/vitest — no define) falls back to a dev sentinel, since an
 * unbundled process has no published version. `typeof` keeps the source path from a ReferenceError. (2.L, ADR-0051.)
 */
declare const __RELAVIUM_CLI_VERSION__: string | undefined;
export const CLI_VERSION =
  typeof __RELAVIUM_CLI_VERSION__ === 'string' ? __RELAVIUM_CLI_VERSION__ : '0.0.0-dev';
