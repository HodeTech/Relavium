/**
 * Test-isolation guard — a repo-local SECOND checkout must never be collected by a root run (`CR-90`).
 *
 * The defect this closes was live, not theoretical. Measured 2026-08-10: a root `vitest list` discovered
 * **472** test files, **234** of them under `.claude/worktrees/<id>/packages/...` — a full agent-tooling
 * checkout of this same repo. A repo-wide run was therefore executing a foreign tree's tests, and the coverage
 * report was counting its sources: 48.85% lines against 96.95% once excluded.
 *
 * It hid well: `.claude/worktrees/` is excluded through `.git/info/exclude`, which is LOCAL and untracked, so
 * `git status` stayed clean and a fresh clone never even carried the rule. That is also why CI never saw it —
 * CI checks out clean. The `vitest.config.ts` exclusions defend a developer's tree; **this guard is what
 * defends CI**, by failing if those exclusions are ever weakened or removed.
 *
 * It is a tools check rather than a `*.test.ts` for a structural reason: a test running INSIDE Vitest cannot
 * observe which files Vitest chose to collect. Only a subprocess can.
 *
 * ## What it asserts, and why each one is load-bearing
 *
 * 1. **PRIMARY — no collected file lives in a second checkout, listed or not.** Consults no list: it walks the
 *    collected paths and fails on any whose ancestor carries its own `pnpm-workspace.yaml`. This is the only
 *    assertion that stays true when the exclusion list is itself the thing that is wrong, and it is here
 *    because assertion 2 alone was not enough — see below.
 * 2. **One fixture per `REPO_LOCAL_CHECKOUTS` entry, none collected.** The list is read out of
 *    `vitest.config.ts` (as text — this file is `.mjs` and the config is TypeScript, so it cannot be
 *    imported), so a new entry is probed the moment it is added. **But it proves only that every LISTED
 *    location is excluded, never that the list is COMPLETE**: because the fixtures are derived from the list,
 *    deleting `'**\/.claude\/**'` also deletes its probe, and the guard re-collects all 234 foreign suites
 *    while printing a green line. Measured, on the first version of this file. Hence assertion 1.
 * 3. **Every workspace still yields tests.** A single canary is not enough: the structural rule this repo
 *    rejected (`'**\/*\/{packages,apps,tools}\/**'`) drops exactly four real files under
 *    `packages/core/src/tools/`, and a canary in `packages/shared` never notices. Passing by not running is a
 *    worse failure than the leak.
 * 4. **The list reaches BOTH excludes.** `vitest list` observes `test.exclude` only, so every assertion above
 *    is blind to `coverage.exclude` — the half that keeps a foreign tree out of the coverage denominator. The
 *    phase doc's acceptance criterion names both, so the config text is checked directly.
 *
 * Exits non-zero so CI fails loudly. Run from anywhere:
 *   node tools/test-isolation/check.mjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(repoRoot, 'package.json'));

const CONFIG_PATH = join(repoRoot, 'vitest.config.ts');
const FIXTURE_DIR = '__test_isolation_fixture__';

/** Where the detector's own self-test plants its positive control. Deliberately NOT an excluded location. */
const PROBE_DIR = '__test_isolation_detector_probe__';

/**
 * Every workspace that holds at least one `*.test.ts` ON DISK — DERIVED, never hand-listed.
 *
 * A hardcoded array is the same shape the primary assertion was rebuilt to escape: it can only prove the
 * places someone remembered. If `packages/ui` gains its first test tomorrow, a static list silently stops
 * checking it. Walking the tree is non-circular — the filesystem says which workspaces have tests, and Vitest
 * must then have found them.
 */
function workspacesWithTests() {
  const roots = ['packages', 'apps'];
  const found = [];
  for (const root of roots) {
    const rootDir = join(repoRoot, root);
    if (!existsSync(rootDir)) continue;
    for (const name of readdirSync(rootDir)) {
      const src = join(rootDir, name, 'src');
      if (existsSync(src) && hasTestFile(src)) found.push(`${root}/${name}`);
    }
  }
  return found;
}

function hasTestFile(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (entry.isDirectory()) {
      if (hasTestFile(join(dir, entry.name))) return true;
    } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
      return true;
    }
  }
  return false;
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/**
 * The plantable directory for one exclusion pattern: `**\/.claude\/**` → `.claude`, `worktrees/**` →
 * `worktrees`. A pattern that does not reduce to a plain path is rejected rather than skipped — silently
 * dropping an entry is exactly how this guard went blind the first time.
 */
function plantableDir(pattern) {
  const stripped = pattern.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
  if (/[*?[\]{}]/.test(stripped) || stripped.length === 0) {
    fail(
      `REPO_LOCAL_CHECKOUTS entry ${JSON.stringify(pattern)} is not a plantable directory path, so this ` +
        `guard cannot prove it works.\n  Use a form like '**/<dir>/**' or '<dir>/**', or add an explicit ` +
        `fixture location here.`,
    );
  }
  return stripped;
}

// --- 1. Read the list from the config itself, so the two cannot drift -----------------------------

const configText = readFileSync(CONFIG_PATH, 'utf8');
const listMatch = /export const REPO_LOCAL_CHECKOUTS = \[([^\]]*)\]/.exec(configText);
if (listMatch === null) {
  fail(`cannot find \`export const REPO_LOCAL_CHECKOUTS\` in ${relative(repoRoot, CONFIG_PATH)}`);
}
const patterns = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (patterns.length === 0) {
  fail(
    `REPO_LOCAL_CHECKOUTS is EMPTY in ${relative(repoRoot, CONFIG_PATH)}.\n` +
      `  A repo-local second checkout would be collected by every root run and counted in coverage.`,
  );
}

// --- 2. The list must reach BOTH excludes (assertion 3) --------------------------------------------

const spreadCount = (configText.match(/\.\.\.REPO_LOCAL_CHECKOUTS/g) ?? []).length;
if (spreadCount < 2) {
  fail(
    `REPO_LOCAL_CHECKOUTS is spread ${spreadCount} time(s) in ${relative(repoRoot, CONFIG_PATH)}; both ` +
      `\`test.exclude\` and \`coverage.exclude\` need it.\n` +
      `  \`test.exclude\` stops a foreign tree's TESTS from running; \`coverage.exclude\` stops its SOURCES ` +
      `from entering the coverage denominator.\n  \`vitest list\` cannot see the second one, which is why it ` +
      `is checked here as text.`,
  );
}

// --- 3. Plant one fixture per entry, collect, assert ------------------------------------------------

const fixtures = patterns.map((pattern) => ({
  pattern,
  root: join(repoRoot, plantableDir(pattern), FIXTURE_DIR),
  parent: join(repoRoot, plantableDir(pattern)),
  parentExisted: existsSync(join(repoRoot, plantableDir(pattern))),
}));

/**
 * A SYNTHETIC checkout, deliberately, not a real `git worktree`: a real one depends on git state and on the
 * working directory being a repo at all, which is the exact non-determinism `CR-90` is about. What matters is
 * the SHAPE — a nested workspace layout with its own test and source file — and that is reproducible anywhere.
 */
function plant(fixture) {
  rmSync(fixture.root, { recursive: true, force: true }); // self-healing after a Ctrl-C'd earlier run
  const src = join(fixture.root, 'packages', 'probe', 'src');
  mkdirSync(src, { recursive: true });
  // The workspace marker too, so the fixture shape-matches a real second checkout for BOTH assertions: if an
  // exclusion breaks, the structural check fires alongside the leak check and the error names the cause twice.
  writeFileSync(join(fixture.root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(src, 'probe.ts'), 'export const probe = 1;\n');
  writeFileSync(
    join(src, 'probe.test.ts'),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { probe } from './probe.js';",
      '',
      `describe('${FIXTURE_DIR}', () => {`,
      "  it('MUST NOT be collected by a root run — see tools/test-isolation', () => {",
      '    expect(probe).toBe(1);',
      '  });',
      '});',
      '',
    ].join('\n'),
  );
}

function clear(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
  // Do not leave an empty `worktrees/` or `.worktrees/` behind that this guard itself created.
  if (
    !fixture.parentExisted &&
    existsSync(fixture.parent) &&
    readdirSync(fixture.parent).length === 0
  ) {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
}

/**
 * Resolve vitest through the module graph and spawn it with `process.execPath`, never a bare `npx`. Spawning
 * `npx` would search a writeable `PATH`, need `shell: true` for the Windows `.cmd` shim, and can reach for the
 * registry when it cannot resolve locally — the convention `tools/coverage-gate/run.mjs` documents.
 */
function collectedFiles() {
  let vitestEntry;
  try {
    const pkgPath = require.resolve('vitest/package.json');
    vitestEntry = join(dirname(pkgPath), require('vitest/package.json').bin.vitest);
  } catch (error) {
    // THROW, never `process.exit`, from anywhere inside the try/finally below. `process.exit` does not unwind
    // a `finally` in Node, so exiting here would leave all three fixtures on disk — and the `.claude/` one is
    // a SIBLING of `.claude/worktrees/`, so the `.gitignore` entries do not cover it. The next plain
    // `pnpm test` would then collect the leftover fixture: CR-90's own defect, self-inflicted by its guard's
    // crash path. Verified: `process.exit` inside a `try` skips the `finally` body.
    throw new Error(`cannot resolve the vitest entry point: ${error.message}`);
  }
  // `--json` returns absolute `file` paths, so nothing depends on the reporter's text layout (a `projects`
  // config prefixes `[name] `) or on the platform separator. `--filesOnly` keeps it cheap: the file set is
  // resolved without importing a single test module.
  const result = spawnSync(process.execPath, [vitestEntry, 'list', '--filesOnly', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`\`vitest list\` failed (exit ${result.status}):\n${result.stderr ?? ''}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`\`vitest list --json\` did not return JSON:\n${result.stdout.slice(0, 400)}`);
  }
  return parsed.map((entry) => relative(repoRoot, entry.file).split(sep).join('/'));
}

/**
 * A second checkout of a pnpm monorepo carries its own `pnpm-workspace.yaml` at its root. Any collected file
 * with such an ancestor BELOW the repo root is in a tree that is not ours.
 *
 * `i = 1`, not `0`, and that is load-bearing: `i = 0` yields `candidate = ''`, whose `pnpm-workspace.yaml` is
 * the repo's OWN — every file would report as nested inside itself.
 *
 * **Recorded limitation, not a property.** "A second checkout always carries one" holds for `git worktree
 * add`, `git clone` and a full copy — every case seen here — but NOT for a sparse checkout, a
 * `--no-checkout` worktree, or a partial rsync of `packages/**`. Those would be collected with nothing in
 * their ancestry to detect, and this assertion would pass in silence, leaving only the list-based checks
 * below. Nothing in this repo produces such a tree today; if that changes, this predicate needs a second
 * marker (a `package.json` whose `name` matches the root's would be the obvious one).
 */
function nestedCheckoutOf(fileRel) {
  const parts = fileRel.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const candidate = parts.slice(0, i).join('/');
    if (existsSync(join(repoRoot, candidate, 'pnpm-workspace.yaml'))) return candidate;
  }
  return undefined;
}

/**
 * Prove the detector above actually fires, BEFORE trusting it to pass.
 *
 * Without this, `nestedCheckoutOf`'s match branch is never executed by the guard: the listed fixtures are
 * (correctly) excluded from collection, so the structural walk only ever sees this repo's own paths and
 * returns `undefined` every time. The one demonstration that it works was a manual check against a real
 * worktree that happened to be present on one developer's machine — not repeatable, and absent on a fresh
 * clone or in CI. A refactor that broke the ancestor walk would have shipped green forever.
 *
 * A pure-function self-test rather than a second `vitest list`: it exercises the same walk, the same `i = 1`
 * boundary and the same marker file, for none of the cost.
 */
function selfTestDetector() {
  const probe = join(repoRoot, PROBE_DIR);
  try {
    mkdirSync(join(probe, 'packages', 'probe', 'src'), { recursive: true });
    writeFileSync(join(probe, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    const inside = `${PROBE_DIR}/packages/probe/src/probe.test.ts`;
    if (nestedCheckoutOf(inside) !== PROBE_DIR) {
      throw new Error(
        `the nested-checkout detector FAILED its own self-test: it did not flag ${inside}, which sits under a` +
          `\n  directory carrying its own pnpm-workspace.yaml. The primary assertion is not working, so a` +
          `\n  green result from this guard would mean nothing.`,
      );
    }
    // And it must not fire on our own tree — an over-eager detector would fail every run for the wrong reason.
    if (nestedCheckoutOf('packages/core/src/dag.test.ts') !== undefined) {
      throw new Error(
        "the nested-checkout detector flags this repo's OWN files. Check the `i = 1` loop bound.",
      );
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const cleanupAll = () => {
  for (const fixture of fixtures) clear(fixture);
};

let files;
try {
  selfTestDetector();
  for (const fixture of fixtures) plant(fixture);
  files = collectedFiles();
} catch (error) {
  // Explicit cleanup BEFORE reporting, rather than a `finally` plus a `process.exit` inside the try — Node
  // does not unwind a `finally` on `process.exit`, and a leaked fixture is CR-90's own defect self-inflicted.
  cleanupAll();
  fail(error instanceof Error ? error.message : String(error));
}
cleanupAll();

// --- 4. The PRIMARY assertion: no collected file may live in a second checkout, listed or not ------
//
// The fixture probes above prove that every LISTED location is excluded. They cannot prove the list is
// COMPLETE — and that distinction is not academic. Because the fixtures are derived from the list, deleting
// `'**/.claude/**'` also deletes its probe: the guard then re-collects all 234 foreign suites and reports
// green. Measured, on the first version of this file.
//
// So the real test is structural and runs against the filesystem rather than a glob (which is what makes it
// safe here — `vitest.config.ts` cannot express this, a script can). `nestedCheckoutOf` is defined above,
// beside the self-test that proves it fires.

const foreign = new Map();
for (const file of files) {
  const root = nestedCheckoutOf(file);
  if (root !== undefined) foreign.set(root, (foreign.get(root) ?? 0) + 1);
}
if (foreign.size > 0) {
  fail(
    `${[...foreign.values()].reduce((a, b) => a + b, 0)} collected file(s) belong to a SECOND checkout of ` +
      `this repo:\n` +
      [...foreign]
        .map(([root, n]) => `    ${root}/  (${n} file(s), has its own pnpm-workspace.yaml)`)
        .join('\n') +
      `\n  Add it to REPO_LOCAL_CHECKOUTS in vitest.config.ts.` +
      `\n  This check does not consult that list — it walks the collected paths — so it stays true even when` +
      `\n  the list is the thing that is wrong.`,
  );
}

const leaked = files.filter((f) => f.includes(FIXTURE_DIR));
if (leaked.length > 0) {
  const missed = fixtures
    .filter((fx) => leaked.some((f) => f.startsWith(`${plantableDir(fx.pattern)}/`)))
    .map((fx) => fx.pattern);
  fail(
    `a repo-local checkout leaked into the root test run (${leaked.length} file(s)):\n` +
      leaked.map((f) => `    ${f}`).join('\n') +
      `\n  Not excluded despite being listed: ${missed.map((p) => JSON.stringify(p)).join(', ')}` +
      `\n  A root run must see this repo's tests and nothing else — a second checkout's suites are not ours` +
      `\n  to run, and its sources are not ours to count against the coverage floor.`,
  );
}

const expected = workspacesWithTests();
const silent = expected.filter((ws) => !files.some((f) => f.startsWith(`${ws}/`)));
if (silent.length > 0) {
  fail(
    `these workspaces yielded NO test files: ${silent.join(', ')}` +
      `\n  REPO_LOCAL_CHECKOUTS (vitest.config.ts) is excluding real tests. That is worse than the leak it` +
      `\n  prevents: the suite goes green by not running. Narrow the pattern.` +
      `\n  Collected ${files.length} file(s) in total.`,
  );
}

console.log(
  `✓ test isolation holds: ${files.length} file(s) collected, none from a repo-local checkout ` +
    `(${patterns.length} location(s) probed, ${expected.length} workspaces with tests on disk all collected).`,
);
