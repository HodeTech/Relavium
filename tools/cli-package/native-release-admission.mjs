/** ADR-0125 early build admission. Publication still requires the unchanged release-custody guard. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function requireNativeReleasePolicy(text, { eventName, ref }) {
  if (
    !['push', 'workflow_dispatch'].includes(eventName) ||
    typeof ref !== 'string' ||
    !ref.startsWith('refs/')
  )
    throw new Error('NATIVE_FS_RELEASE_EVENT');
  if (eventName === 'push') {
    if (!ref.startsWith('refs/tags/v')) throw new Error('NATIVE_FS_RELEASE_EVENT');
    const statuses = [...text.matchAll(/^- \*\*Status\*\*: ([A-Za-z]+)$/gmu)];
    if (statuses.length !== 1 || statuses[0][1] !== 'Accepted')
      throw new Error('NATIVE_FS_RELEASE_POLICY_NOT_ACCEPTED');
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('NATIVE_FS_RELEASE_USAGE');
    requireNativeReleasePolicy(
      readFileSync(
        new URL(
          '../../docs/decisions/0121-pre-1-0-releases-publish-the-smoke-verified-package-test-tarball.md',
          import.meta.url,
        ),
        'utf8',
      ),
      { eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF },
    );
  } catch {
    console.error(
      '::error::Native release build admission refused; the release policy must be accepted for a pushed release tag.',
    );
    process.exitCode = 1;
  }
}
