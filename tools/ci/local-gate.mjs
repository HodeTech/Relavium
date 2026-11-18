#!/usr/bin/env node
// The local gate, run in parallel: `pnpm gate [--profile safe|fast] [--keep-going] [--with-ci-owned] [--only <step,step>] [--step-timeout <minutes>] [--out <dir>]`.
//
// `pnpm run ci` is the serial reference: one script, every step one after the other, about 94 minutes on a developer
// machine. Five steps are nearly all of that time (the secrets, filesystem, usage and wire causal controls and, in the
// separate coverage job, the enforced coverage run), and they do not depend on each other. This runner reads the
// SAME steps from the root `ci` script — it keeps no second list that could drift (the #312 divergence) — and runs them in
// three phases:
//   1. every ordinary step, in the script's order, serially and stopping at the first failure (fast feedback), then the
//      workspace tests once more under the CI environment (`CI=true GITHUB_ACTIONS=true`, forced past the Turbo cache),
//      which `pnpm run ci` does not do;
//   2. the causal-control families in parallel lanes, cut into the SAME shards CI runs (`--shard i/n`, round-robin, every
//      control in exactly one shard): each lane is its own single-worker process on an isolated copy, so the lanes only READ
//      the repository;
//   3. the enforced coverage run, alone (`safe`, default: it is the step most sensitive to load) or as one more lane
//      (`fast`).
// What it does not run: `smoke:cli-package` and `check:map-controls` need every platform's native component and are CI's
// (`--with-ci-owned` runs them anyway). Nothing is weakened: every control, phase and case runs as in `pnpm run ci`.
//
// The tree must stay still while the gate runs (a gate over a moving tree is not evidence): it is fingerprinted before and
// after, and a change fails the run. Each step writes its own log; a failure prints the tail of its log. A step that runs
// longer than `--step-timeout` minutes (default 120) is stopped, and an interrupt (Ctrl-C, SIGTERM) stops every running step
// (on POSIX the whole process group of each, so no test pool is orphaned; on Windows only the step's own process).
// The evidence-export bound (RELAVIUM_ACCEPTANCE_EVIDENCE) is a CI-only check, as it is for `pnpm run ci`: the gate runs the
// same controls in the same shards but does not export their evidence.
//
// pnpm and its scripts are started through the interpreter that is running this file and pnpm's own entry point
// (`npm_execpath`), never through a shell or a PATH search — which is why it must be started as `pnpm gate`. git is the one
// program found on the PATH, and only outside the repository (see `resolveGit`).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Steps of the root `ci` script this runner leaves to CI: they need the native component of every platform. */
export const CI_OWNED = new Set(['pnpm smoke:cli-package', 'pnpm check:map-controls']);

/**
 * The causal-control families that run as parallel lanes, with the number of shards CI cuts each into
 * (`.github/workflows/ci.yml`; a test keeps the two equal). `1` is one lane, whole.
 */
export const LANES = new Map([
  ['check:secrets-mutations', 3],
  ['check:fs-mutations', 2],
  ['check:usage-mutations', 1],
  ['check:wire-mutations', 1],
]);

/** The environment CI gives a job; set on the steps that need it and on no others (a half-set GitHub environment is refused). */
export const CI_ENV = Object.freeze({ CI: 'true', GITHUB_ACTIONS: 'true' });

const PROFILES = new Set(['safe', 'fast']);

function nameOf(text) {
  return text
    .replace(/^(pnpm|turbo)\s+/u, '')
    .replace(/[^a-z0-9]+/giu, '-')
    .replace(/^-|-$/gu, '');
}

/** `pnpm <script> …` runs as typed; a bare `turbo …` (the `ci` script runs it with node_modules/.bin on its PATH) as `pnpm exec turbo …`. */
function parseStep(text) {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  if (words[0] === 'pnpm' && words.length >= 2) return { args: words.slice(1), script: words[1] };
  if (words[0] === 'turbo' && words.length >= 2)
    return { args: ['exec', ...words], script: undefined };
  throw new Error(
    `The root ci script has a step this runner cannot classify: ${JSON.stringify(text)}`,
  );
}

/**
 * The plan for a `ci` script: `serial` steps in order, parallel `lanes`, and steps that run `after` the lanes.
 * An unknown step form throws, so a step added to the script cannot silently go unrun.
 */
export function planGate(ciScript, { profile = 'safe', includeCiOwned = false } = {}) {
  if (!PROFILES.has(profile))
    throw new Error(`Unknown profile ${JSON.stringify(profile)}; use safe or fast.`);
  const serial = [];
  const lanes = [];
  const skipped = [];
  for (const raw of ciScript.split(' && ')) {
    const text = raw.trim();
    if (text.length === 0) continue;
    if (CI_OWNED.has(text) && !includeCiOwned) {
      skipped.push(text);
      continue;
    }
    const { args, script } = parseStep(text);
    const shards = script === undefined ? undefined : LANES.get(script);
    if (shards === undefined) {
      serial.push({ name: nameOf(text), args, env: {} });
    } else if (shards === 1) {
      lanes.push({ name: nameOf(text), args, env: {} });
    } else {
      for (let index = 1; index <= shards; index++) {
        lanes.push({
          name: `${nameOf(text)}-${index}of${shards}`,
          args: [...args, '--shard', `${index}/${shards}`],
          env: {},
        });
      }
    }
  }
  serial.push({
    name: 'workspace-tests-ci-env',
    args: ['exec', 'turbo', 'run', 'test', '--concurrency=1', '--force'],
    env: CI_ENV,
  });
  const coverage = { name: 'coverage', args: ['coverage:enforced'], env: CI_ENV };
  return profile === 'fast'
    ? { serial, lanes: [...lanes, coverage], after: [], skipped }
    : { serial, lanes, after: [coverage], skipped };
}

/** The plan restricted to the named steps (to re-run one that failed); a name that is no step throws, and the order is kept. */
export function selectSteps(plan, names) {
  const known = [...plan.serial, ...plan.lanes, ...plan.after].map((step) => step.name);
  for (const name of names) {
    if (!known.includes(name))
      throw new Error(`No step named ${JSON.stringify(name)}. Steps: ${known.join(', ')}`);
  }
  const keep = (steps) => steps.filter((step) => names.includes(step.name));
  return { ...plan, serial: keep(plan.serial), lanes: keep(plan.lanes), after: keep(plan.after) };
}

/** pnpm's own entry point, which `pnpm gate` hands down; anything else (`npm run`, a bare `node`) is refused. */
export function resolvePnpmEntry(env = process.env) {
  const entry = env.npm_execpath;
  if (
    typeof entry !== 'string' ||
    !basename(entry).toLowerCase().startsWith('pnpm') ||
    !existsSync(entry)
  ) {
    throw new Error(
      'Start the local gate as `pnpm gate` (it needs pnpm’s entry point from npm_execpath).',
    );
  }
  return entry;
}

/**
 * The git executable: the first one on the PATH that is NOT inside `repository`. pnpm puts every `node_modules/.bin` of the
 * workspace at the front of the PATH of the scripts it runs, so a bare `git` could be a binary a dependency installed there; a
 * relative or empty entry (the current directory) is refused for the same reason, and a link that leads into the repository
 * counts as being in it. The program is returned as the PATH entry spells it: only the test for "inside" follows links.
 */
export function resolveGit(env = process.env, repository = root) {
  const inside = realpathSync(repository);
  for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      const real = realpathSync(candidate);
      if (real === inside || real.startsWith(`${inside}${sep}`)) continue;
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  throw new Error(
    'git was not found on the PATH outside the repository, so the tree cannot be fingerprinted (the gate refuses a git installed under node_modules/.bin or the current directory).',
  );
}

/** A short digest of everything that makes up the working tree: HEAD, the index, the diff and every untracked file. */
export function treeFingerprint(cwd) {
  const executable = resolveGit();
  // A git that cannot answer would give the same digest before and after, and the check would pass over any change: refuse.
  const git = (args) => {
    const result = spawnSync(executable, args, { cwd, maxBuffer: 1 << 30 });
    if (result.error !== undefined || result.status !== 0) {
      const reason = result.error?.message ?? String(result.stderr ?? '').trim();
      throw new Error(
        `git ${args[0]} failed in ${cwd}, so the tree cannot be fingerprinted: ${reason}`,
      );
    }
    return result.stdout;
  };
  const hash = createHash('sha256');
  for (const args of [
    ['rev-parse', 'HEAD'],
    ['status', '--porcelain=v1', '-z'],
    ['diff', '--binary'],
    ['diff', '--cached', '--binary'],
  ]) {
    hash.update(git(args));
  }
  const untracked = git(['ls-files', '-o', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const file of untracked) {
    hash.update(file);
    try {
      hash.update(readFileSync(join(cwd, file)));
    } catch {
      hash.update('unreadable');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

const running = new Set();

/** Stop a step: on POSIX its whole process group (each step is its own group leader), elsewhere its own process. */
function killStep(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** Stop every step that is running (an interrupt, or a test). */
export function terminateAll(signal = 'SIGTERM') {
  for (const child of running) killStep(child, signal);
}

/**
 * Run one step through pnpm's entry, its output in `logFile`; resolves once, with the exit code (a signal or a start failure
 * counts as a failure). A step still running after `timeoutMs` is stopped and says so in its log.
 */
export function spawnStep(step, logFile, { entry, cwd = root, env = process.env, timeoutMs } = {}) {
  return new Promise((resolveStep) => {
    const started = Date.now();
    const out = openSync(logFile, 'w');
    let child;
    let settled = false;
    let timer;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child !== undefined) running.delete(child);
      closeSync(out);
      resolveStep({ code, seconds: Math.round((Date.now() - started) / 1000) });
    };
    try {
      child = spawn(process.execPath, [entry, ...step.args], {
        cwd,
        env: { ...env, ...step.env },
        stdio: ['ignore', out, out],
        detached: process.platform !== 'win32',
      });
    } catch {
      done(1);
      return;
    }
    running.add(child);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        appendFileSync(
          logFile,
          `\n[local gate] ${step.name} ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped\n`,
        );
        killStep(child, 'SIGTERM');
        setTimeout(() => killStep(child, 'SIGKILL'), 10_000).unref();
      }, timeoutMs);
    }
    child.on('error', () => done(1));
    child.on('close', (code) => done(code ?? 1));
  });
}

/**
 * Run a plan: the serial steps in order (stopping at the first failure unless `keepGoing`), then the lanes together, then the
 * steps `after`. `execute(step, logFile)` runs one step. Returns every step's result and whether all of them passed.
 */
export async function runGate(
  plan,
  { execute, outDir, log = () => {}, keepGoing = false, sampleMs = 60_000 },
) {
  /** @type {{ name: string, code: number | undefined, seconds: number }[]} */
  const results = [];
  const run = async (step) => {
    const result = { name: step.name, ...(await execute(step, join(outDir, `${step.name}.log`))) };
    results.push(result);
    log(`${result.code === 0 ? '✓' : '✗'} ${step.name} (${result.seconds}s)`);
    return result.code === 0;
  };
  let proceed = true;
  for (const step of plan.serial) {
    if (!proceed) {
      results.push({ name: step.name, code: undefined, seconds: 0 });
      continue;
    }
    if (!(await run(step)) && !keepGoing) proceed = false;
  }
  if (proceed && plan.lanes.length > 0) {
    log(`… ${plan.lanes.length} lanes in parallel (load ${loadavg()[0].toFixed(1)})`);
    // The causal controls give each phase a fixed deadline, so a machine that stalls fails lanes together: the load, sampled
    // while they run, is the evidence for telling that from a defect.
    const sampler = setInterval(() => log(`· load ${loadavg()[0].toFixed(1)}`), sampleMs);
    try {
      await Promise.all(plan.lanes.map((step) => run(step)));
    } finally {
      clearInterval(sampler);
    }
  } else {
    for (const step of plan.lanes) results.push({ name: step.name, code: undefined, seconds: 0 });
  }
  for (const step of plan.after) {
    if (proceed) await run(step);
    else results.push({ name: step.name, code: undefined, seconds: 0 });
  }
  return { results, ok: results.every((result) => result.code === 0) };
}

function parseArguments(argv) {
  const options = {
    profile: 'safe',
    keepGoing: false,
    includeCiOwned: false,
    out: undefined,
    only: undefined,
    stepTimeoutMinutes: 120,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--profile') options.profile = argv[++index];
    else if (argument === '--keep-going') options.keepGoing = true;
    else if (argument === '--with-ci-owned') options.includeCiOwned = true;
    else if (argument === '--out') options.out = argv[++index];
    else if (argument === '--only') options.only = String(argv[++index]).split(',');
    else if (argument === '--step-timeout') options.stepTimeoutMinutes = Number(argv[++index]);
    else
      throw new Error(
        `Unknown argument ${JSON.stringify(argument)}. Usage: pnpm gate [--profile safe|fast] [--keep-going] [--with-ci-owned] [--only <step,step>] [--step-timeout <minutes>] [--out <dir>]`,
      );
  }
  if (!Number.isFinite(options.stepTimeoutMinutes) || options.stepTimeoutMinutes <= 0) {
    throw new Error('--step-timeout takes a positive number of minutes.');
  }
  return options;
}

/** An interrupt stops every running step (their whole process groups) and then the gate, instead of orphaning them. */
function stopOnInterrupt(log) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      log(`${signal}: stopping every running step`);
      terminateAll('SIGTERM');
      setTimeout(() => {
        terminateAll('SIGKILL');
        process.exit(130);
      }, 3000);
    });
  }
}

/** The real path of a path that may not exist yet: its nearest existing ancestor is resolved, the rest appended. */
function realPath(path) {
  const missing = [];
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...missing);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const entry = resolvePnpmEntry();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const planned = planGate(manifest.scripts.ci, options);
  const plan = options.only === undefined ? planned : selectSteps(planned, options.only);
  const outDir =
    options.out === undefined
      ? mkdtempSync(join(tmpdir(), 'relavium-gate-'))
      : resolve(options.out);
  const repository = realpathSync(root);
  const logs = realPath(outDir);
  if (logs === repository || logs.startsWith(`${repository}${sep}`)) {
    throw new Error(
      'Choose a log directory outside the repository: logs written into it would change the tree the gate fingerprints.',
    );
  }
  mkdirSync(outDir, { recursive: true });
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const log = (line) => console.log(`${stamp()} ${line}`);
  log(`local gate, profile ${options.profile}; logs in ${outDir}`);
  stopOnInterrupt(log);
  for (const text of plan.skipped)
    log(`- ${text} is CI's (needs every platform's native component); --with-ci-owned runs it`);
  const before = treeFingerprint(root);
  const started = Date.now();
  const { results, ok } = await runGate(plan, {
    execute: (step, logFile) =>
      spawnStep(step, logFile, { entry, timeoutMs: options.stepTimeoutMinutes * 60_000 }),
    outDir,
    log,
    keepGoing: options.keepGoing,
  });
  const after = treeFingerprint(root);
  log(`done in ${Math.round((Date.now() - started) / 60000)} min`);
  for (const result of results) {
    if (result.code === undefined) log(`· ${result.name} did not run`);
    else if (result.code !== 0) {
      log(
        `✗ ${result.name} exited ${result.code}; the end of ${join(outDir, `${result.name}.log`)}:`,
      );
      const text = readFileSync(join(outDir, `${result.name}.log`), 'utf8')
        .trimEnd()
        .split('\n');
      console.log(text.slice(-40).join('\n'));
    }
  }
  if (before !== after) {
    log(
      '✗ the working tree changed while the gate ran, so its result proves nothing; run it again on a still tree',
    );
    process.exit(2);
  }
  if (!ok) log('✗ the local gate failed');
  else if (options.only !== undefined)
    log(
      `✓ the selected steps passed (${options.only.join(', ')}); that is a partial gate, not the whole gate`,
    );
  else log('✓ the local gate passed');
  process.exit(ok ? 0 : 1);
}

/**
 * Whether this file is the program being run. The module URL is the real path, so the path the process was given is resolved
 * first: compared as given, a repository reached through a symbolic link (macOS's /var → /private/var) would never match, and a
 * gate that silently does nothing would report success.
 */
function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
