/**
 * The release workflow's publish-job entry point for the interim publication guard
 * (`release-guard-core.mjs`; Wave 3 Step 9a.1, the Interim release guard ruling of 2026-10-19).
 *
 * It refuses before it evaluates anything: the exit code is 1 from the first statement, so a module
 * that fails to load, an unexpected throw or a guard that returned would still refuse, and nothing
 * about how the script is invoked (a symlinked or relative path) can skip the refusal. Until Step 9d's
 * custody validator replaces it, no artifact passes. It prints one fixed line and never artifact
 * contents.
 */
import { resolve } from 'node:path';

process.exitCode = 1;
let code = 'GUARD_FAILURE';
try {
  const { ReleaseGuardError, requireReleaseCandidate } = await import('./release-guard-core.mjs');
  try {
    if (process.argv.length !== 3) throw new ReleaseGuardError('USAGE');
    requireReleaseCandidate(resolve(process.argv[2]));
  } catch (error) {
    if (error instanceof ReleaseGuardError) code = error.code;
  }
} catch {
  // A guard that cannot load its rule still refuses.
}
console.error(`::error::CLI publication refused: ${code}`);
