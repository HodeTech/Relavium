/**
 * QUARANTINED LINT FIXTURE — regression guard for the config-file ignore.
 *
 * A SOURCE file named `*.config.ts` must NOT escape the seam fence: the config-file ignore
 * is scoped to repo/package/app-root tooling configs only, never a `src/`-style source
 * file. `assert-fence.mjs` lints this file and asserts the seam rule still fires on it — if
 * the ignore is ever re-broadened to a global config glob, this file goes silent and the
 * check fails. The specifier intentionally does not resolve.
 */
import '@anthropic-ai/sdk';

export const x = 0;
