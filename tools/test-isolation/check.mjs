/**
 * Test-isolation guard — a repo-local SECOND checkout must never be collected by a root run (`CR-90`).
 *
 * The defect this closes was live, not theoretical. Measured 2026-08-10: a root `vitest list` discovered
 * **472** test files, **234** of them under `.claude/worktrees/<id>/packages/...` — a full agent-tooling
 * checkout of this same repo. A repo-wide run was therefore executing a foreign tree's tests, and
 * `pnpm coverage` was counting that tree's sources as 0%-covered files against the engine floor. It hid well:
 * `.claude/worktrees/` is excluded through `.git/info/exclude`, which is LOCAL and untracked, so `git status`
 * stayed clean and a fresh clone never even carried the rule.
 *
 * The fix is `REPO_LOCAL_CHECKOUTS` in `vitest.config.ts`. This is its regression, and it exists as a tools
 * check rather than a `*.test.ts` for a reason worth stating: a test running INSIDE Vitest cannot observe
 * which files Vitest chose to collect. Only a subprocess can.
 *
 * **Two assertions, and the second is the one that keeps the fix honest.** A fixture placed in an excluded
 * location must NOT be collected — and every real test file must still BE collected. Without the second, the
 * cheapest way to pass is an over-broad exclude that quietly drops the repo's own suites, which is a far worse
 * failure than the one being prevented.
 *
 * Exits non-zero so CI fails loudly. Run from the repo root:
 *   node tools/test-isolation/check.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the synthetic checkout is planted. A SYNTHETIC fixture, deliberately, not a real `git worktree`:
 * a real one depends on git state and on the working directory being a repo at all, which is exactly the
 * non-determinism this check is about. What matters is the SHAPE — a nested directory holding a workspace
 * layout with its own test and source file — and that is reproducible anywhere.
 *
 * `.worktrees/` is one of the excluded names; the fixture goes there so the check exercises a pattern that is
 * NOT the one that actually bit us (`.claude/`), which keeps the list honest rather than tautological.
 */
const FIXTURE_ROOT = '.worktrees/__test_isolation_fixture__';
const FIXTURE_PKG = join(FIXTURE_ROOT, 'packages', 'probe', 'src');

/** A file every real run must find, so an over-broad exclude cannot pass this check. */
const CANARY = 'packages/shared/src/run-event.test.ts';

function plantFixture() {
  mkdirSync(FIXTURE_PKG, { recursive: true });
  writeFileSync(join(FIXTURE_PKG, 'probe.ts'), 'export const probe = 1;\n');
  writeFileSync(
    join(FIXTURE_PKG, 'probe.test.ts'),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { probe } from './probe.js';",
      '',
      // If the exclusion regresses, this runs in the root suite and its message says why.
      "describe('__test_isolation_fixture__', () => {",
      "  it('MUST NOT be collected by a root run — see tools/test-isolation', () => {",
      '    expect(probe).toBe(1);',
      '  });',
      '});',
      '',
    ].join('\n'),
  );
}

function collectedFiles() {
  // `--filesOnly` keeps this cheap: Vitest resolves the file set without importing a single test module.
  const out = execFileSync('npx', ['vitest', 'list', '--filesOnly'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.test.ts') || line.endsWith('.test.tsx'));
}

let files;
try {
  plantFixture();
  files = collectedFiles();
} finally {
  // Always, even on a throw — a lingering fixture would be collected by the NEXT run and turn a clean tree
  // into a confusing red.
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
}

const leaked = files.filter((f) => f.includes('__test_isolation_fixture__'));
if (leaked.length > 0) {
  console.error(
    `✖ a repo-local checkout leaked into the root test run (${leaked.length} file(s)):\n` +
      leaked.map((f) => `    ${f}`).join('\n') +
      `\n  Add its directory to REPO_LOCAL_CHECKOUTS in vitest.config.ts.` +
      `\n  A root run must see this repo's tests and nothing else — a second checkout's suites are not ours` +
      `\n  to run, and its sources are not ours to count against the coverage floor.`,
  );
  process.exit(1);
}

if (!files.includes(CANARY)) {
  console.error(
    `✖ the canary test file was NOT collected: ${CANARY}` +
      `\n  REPO_LOCAL_CHECKOUTS (vitest.config.ts) is excluding real tests. That is worse than the leak it` +
      `\n  prevents: the suite goes green by not running. Narrow the pattern.` +
      `\n  Collected ${files.length} file(s).`,
  );
  process.exit(1);
}

console.log(
  `✓ test isolation holds: ${files.length} file(s) collected, none from a repo-local checkout.`,
);
