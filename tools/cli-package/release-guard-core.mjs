/**
 * Interim fail-closed publication guard (Wave 3 Step 9a.1, the Interim release guard ruling of 2026-10-19).
 *
 * npm publication requires a release candidate: the exact tarball, its original ciphertext and a
 * release binding receipt verified against the release custody contract
 * (docs/reference/cli/packaging.md). Wave 3 Step 9d implements that custody graph and Wave 4b
 * supplies the production recipient; until both exist no artifact can be a release candidate, so
 * this guard refuses every artifact. A package-test artifact is never promoted to a release.
 *
 * It depends on Node built-ins only (the publish job checks out nothing else) and reads directory
 * entry names only — never artifact contents. `release-guard.mjs` is the publish job's entry point.
 */
import { readdirSync } from 'node:fs';

export class ReleaseGuardError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`CLI publication refused: ${code}`);
    this.name = 'ReleaseGuardError';
    this.code = code;
  }
}

/**
 * @param {string} directory the downloaded artifact directory
 * @returns {never} until Step 9d's release custody validator replaces this interim guard
 * @throws {ReleaseGuardError} for every artifact
 */
export function requireReleaseCandidate(directory) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    throw new ReleaseGuardError('ARTIFACT_UNREADABLE');
  }
  if (!names.includes('release-binding-receipt.json')) {
    throw new ReleaseGuardError(
      names.includes('package-test-receipt.json')
        ? 'PACKAGE_TEST_ARTIFACT'
        : 'RELEASE_CANDIDATE_REQUIRED',
    );
  }
  // No release binding receipt is trusted before the Step 9d custody validator exists.
  throw new ReleaseGuardError('RELEASE_CUSTODY_UNAVAILABLE');
}
