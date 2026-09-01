#!/usr/bin/env node
// Execute the COMPILED CLI bundle — the artifact that actually ships.
//
// Shared by `.github/workflows/ci.yml`'s required job and the root `ci` script, so the local gate and the
// real gate cannot drift on this check the way they did on `lint:tools` and the migration-sync check (#312).
// Nothing in the required gate ran the binary before (#294): a bundle that compiled but could not boot
// merged green.
//
// The `run --json` leg is load-bearing beyond "it boots": it opens `history.db`, which proves the drizzle
// migrations resolved beside the bundle. That is the failure `apps/cli/drizzle/**` becoming a declared turbo
// output (#315) exists to prevent — a cache-hit replay leaving `dist/` fresh next to a missing `drizzle/`.
//
// HERMETIC BY CONSTRUCTION. `history.db` lives at `~/.relavium/history.db` (`db/open.ts` → `paths.ts`
// → `os.homedir()`), and there is no config override for that root — so a naive smoke run opens and MIGRATES
// the developer's real database, the hazard already tracked in deferred-tasks.md. `os.homedir()` honours
// `$HOME` on POSIX and `%USERPROFILE%` on Windows, so pointing both at a throwaway directory is the one
// lever that isolates it. Setting `cwd` would NOT: the path is home-relative, not cwd-relative.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(repoRoot, 'apps/cli/dist/index.js');
const FIXTURE = join(repoRoot, 'apps/cli/src/harness/fixtures/sequential.relavium.yaml');
const STEP_TIMEOUT_MS = 120_000;

/** `const` arrow declarations are not hoisted, so this sits above every helper that awaits it. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(BUNDLE)) {
  console.error(`✗ ${BUNDLE} is missing — run \`pnpm turbo run build\` first.`);
  process.exit(1);
}

const sandboxHome = mkdtempSync(join(tmpdir(), 'relavium-smoke-'));

const steps = [
  { label: '--version', args: ['--version'] },
  { label: '--help', args: ['--help'] },
  {
    label: 'run --json (opens history.db → proves the migrations resolve)',
    args: ['run', FIXTURE, '--input', 'n=21', '--json'],
  },
];

try {
  for (const { label, args } of steps) {
    const r = spawnSync(process.execPath, [BUNDLE, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
    });

    // A hung CLI must fail this check, not sit until the CI job's own timeout kills the whole run with no
    // usable signal. `spawnSync` reports a timeout kill via `signal`, and surfaces spawn faults via `error`.
    if (r.error !== undefined) {
      console.error(`✗ compiled CLI failed to run: ${label} — ${r.error.message}`);
      process.exit(1);
    }
    if (r.signal !== null) {
      console.error(
        `✗ compiled CLI was killed (${r.signal}) on: ${label} — likely the ${STEP_TIMEOUT_MS} ms timeout.`,
      );
      if (r.stderr) console.error(r.stderr.trim());
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`✗ compiled CLI failed: ${label} (exit ${r.status})`);
      if (r.stderr) console.error(r.stderr.trim());
      process.exit(1);
    }
  }
  // Awaited: the `finally` below removes `sandboxHome`, and this check runs a real process out of it.
  await assertNoMcpOrphanOnSignal(sandboxHome);
  console.log(
    '✓ compiled CLI smoke passed (boots, renders help, runs a workflow against an isolated DB, reaps its MCP child on a signal).',
  );
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}

/**
 * Signal a real `agent run` DURING its MCP connect and assert the spawned child does not survive it
 * ([ADR-0088](../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.3, §11).
 *
 * **It lives here rather than in vitest because it needs the BUNDLE.** `turbo run test` declares
 * `dependsOn: ["^build"]`, which builds a package's dependencies and not the package itself, so a vitest e2e
 * reaching for `apps/cli/dist/index.js` would pass or skip depending on what was built earlier. This harness
 * already runs after `build` in both the root `ci` script and the required CI job.
 *
 * **And it needs a real process**, which is the whole finding. The in-process tests drive `guardMcpTeardown`
 * with an injected `exit`, so none of them exercises the ordering that actually failed: the guard's exit net
 * being removed by the build's own `.catch` before `process.exit` ran. Measured with this exact scenario
 * before the fix — host exit 143, child alive at `ppid 1` — and 0 orphans in four runs after it.
 */
async function assertNoMcpOrphanOnSignal(home) {
  const fixture = join(repoRoot, 'packages/mcp/test-fixtures/silent-mcp-server.mjs');
  const agentPath = join(home, 'orphan-probe.agent.yaml');
  // The fixture spawns and never completes `initialize`, so the connect stays open for the whole window.
  writeFileSync(
    agentPath,
    [
      'id: orphan-probe',
      'model: claude-sonnet-4-6',
      'provider: anthropic',
      'system_prompt: probe',
      'tools: []',
      'mcp_servers:',
      '  - id: silent',
      '    transport: stdio',
      `    command: ${process.execPath}`,
      `    args: ["${fixture}"]`,
      '',
    ].join('\n'),
  );

  // **`/bin/ps`, not `ps`.** Resolving the name through `PATH` lets whatever is first on it decide what this
  // check reads the process table with — and a check whose whole job is to prove a hostile-boundary guarantee
  // should not itself depend on a mutable lookup. `/bin/ps` is a fixed location on macOS and Linux alike.
  const survivors = () =>
    spawnSync('/bin/ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((line) => line.includes('silent-mcp-server.mjs'))
      .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
      .filter((pid) => Number.isInteger(pid));

  const before = new Set(survivors());
  // The consent gate (ADR-0084) refuses a non-interactive spawn and PRINTS the declaration digest; feed it
  // back rather than hard-coding a hash that changes with this machine's node path.
  const refusal = spawnSync(process.execPath, [BUNDLE, 'agent', 'run', agentPath], {
    cwd: home,
    encoding: 'utf8',
    input: 'hi\n',
    timeout: STEP_TIMEOUT_MS,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const digest = /\bv1:[0-9a-f]{64}\b/.exec(`${refusal.stdout}${refusal.stderr}`)?.[0];
  if (digest === undefined) {
    console.error('✗ MCP orphan check: could not read the consent digest from the refusal output.');
    console.error(`${refusal.stdout}${refusal.stderr}`.trim());
    process.exit(1);
  }

  const host = spawn(
    process.execPath,
    [BUNDLE, 'agent', 'run', agentPath, '--allow-mcp-stdio', digest],
    {
      cwd: home,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    },
  );
  host.stdin.end('hi\n');

  const exited = new Promise((resolve) => host.once('exit', resolve));
  // Long enough for the SDK to spawn the child inside `transport.start()`; the assertion below fails loudly
  // rather than silently passing if it did not, so a scenario that proves nothing cannot go green.
  await waitFor(() => survivors().some((pid) => !before.has(pid)), 20_000);
  const spawned = survivors().filter((pid) => !before.has(pid));
  if (spawned.length === 0) {
    console.error('✗ MCP orphan check: no child was spawned — the scenario proved nothing.');
    process.exit(1);
  }
  host.kill('SIGTERM');
  await exited;
  // The SDK's close ladder against a signal-trapping child runs ~4 s; the guard exits before it finishes, so
  // what must reap the child here is the synchronous exit net. Budgeted past both.
  const left = (await waitFor(() => survivors().every((pid) => before.has(pid)), 15_000))
    ? []
    : survivors().filter((pid) => !before.has(pid));
  if (left.length > 0) {
    for (const pid of left) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // best-effort cleanup of the orphan this check just proved exists
      }
    }
    console.error(
      `✗ MCP orphan check: ${left.length} child process(es) survived a signalled \`agent run\` (ppid 1).`,
    );
    process.exit(1);
  }
}

/** Poll until `predicate` holds or the budget runs out; returns whether it held. */
async function waitFor(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}
