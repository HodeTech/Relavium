import { Buffer } from 'node:buffer';
import { lstatSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_SMOKE_CASES } from './cases.mjs';
import { nativeSignalCode } from './native-signal-diagnostic.mjs';

export const MAX_WORKER_FAILURE_BYTES = 8192;
const modes = new Set([
  'injected-error',
  'exit-fallback',
  'facility-refusal',
  'leader-exit',
  'bootstrap-fatal',
  'bootstrap-background',
  'bootstrap-output',
]);
const signals = new Set([
  'SIGKILL',
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGABRT',
  'SIGSEGV',
  'SIGILL',
  'SIGBUS',
  'SIGFPE',
  'SIGPIPE',
  'SIGTRAP',
  'SIGSYS',
  'SIGXCPU',
  'SIGXFSZ',
]);
const operations = new Set([
  'native-target-spawn',
  'native-helper-spawn',
  'native-fixture-root',
  'native-fixture-descendant',
  'native-fixture-descendant-ready',
  'native-target-error',
  'native-helper-error',
  'native-target-actual-close',
  'native-helper-actual-close',
  'native-target-close-delivered',
  'native-helper-close-delivered',
  'native-exit-listener-released',
  'native-synthetic-error-injected',
  'native-captured-exit-reap-invoked',
  'native-witness-gate-timeout',
  'native-witness-readiness-refused',
  'native-facility-access-refused',
  'native-bootstrap-fatal-injected',
  'native-bootstrap-background-injected',
  'native-bootstrap-output-injected',
  'native-signal-observed',
  'native-uncaught-exception-observed',
  'native-signal-diagnostics-complete',
]);
export const NATIVE_LOAD_DIAGNOSTIC_PREFIX = 'RELAVIUM_NATIVE_LOAD_DIAGNOSTIC:';
export const NATIVE_LOAD_STAGES = new Set([
  'child-invoke',
  'keyring-load',
  'keyring-export',
  'sqlite-load',
  'metadata-loader',
  'metadata-load',
  'metadata-protocol',
  'sqlite-open',
  'sqlite-query',
  'native-cache',
  'child-json',
  'protocol-check',
  'repository-boundary',
  'installation-boundary',
  'complete',
]);
export const WORKFLOW_STAGES = new Set([
  'start',
  'sequential',
  'human-gate',
  'budget-pause',
  'budget-decisions',
  'denied-effect',
  'native-start',
  'native-barrier',
  'native-bytes',
  'native-metadata',
  'native-journal',
  'native-release',
  'native-terminal',
  'native-sweep',
  'native-observations',
  'complete',
]);
const ASSETS = Object.freeze({
  loader: 'loader.cjs',
  manifest: 'native-assets.json',
  notices: 'THIRD_PARTY_NOTICES.txt',
  darwinArm64: 'aarch64-apple-darwin.node',
  darwinX64: 'x86_64-apple-darwin.node',
  windowsArm64: 'aarch64-pc-windows-msvc.node',
  windowsX64: 'x86_64-pc-windows-msvc.node',
  linuxArm64Gnu: 'aarch64-unknown-linux-gnu.node',
  linuxX64Gnu: 'x86_64-unknown-linux-gnu.node',
  linuxArm64Musl: 'aarch64-unknown-linux-musl.node',
  linuxX64Musl: 'x86_64-unknown-linux-musl.node',
});
const linkStates = new Set(['one', 'multiple', 'unavailable']);
const loaderStates = new Set(['not-attempted', 'success', 'refusal', 'other']);
/** Fixed package-relative files only; never serialize their paths or link counts. */
export function nativeAssetLinks(packageRoot) {
  return Object.fromEntries(
    Object.entries(ASSETS).map(([key, name]) => {
      try {
        const value = lstatSync(join(packageRoot, 'dist', 'native-fs', name), { bigint: true });
        let state = 'unavailable';
        if (value.isFile() && value.nlink === 1n) state = 'one';
        else if (value.isFile() && value.nlink > 1n) state = 'multiple';
        return [key, state];
      } catch {
        return [key, 'unavailable'];
      }
    }),
  );
}
/** Read only the owned child's one bounded fixed-prefix receipt; never relay its stderr. */
export function parseNativeLoadDiagnostic(stderr) {
  if (typeof stderr !== 'string' || stderr.length > 524288) return undefined;
  const lines = stderr.split('\n').filter((line) => line.startsWith(NATIVE_LOAD_DIAGNOSTIC_PREFIX));
  if (lines.length !== 1 || lines[0].length > 2048) return undefined;
  try {
    const value = JSON.parse(lines[0].slice(NATIVE_LOAD_DIAGNOSTIC_PREFIX.length));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return nativeLoadEvidence(value);
  } catch {
    return undefined;
  }
}
const object = (value) => (value !== null && typeof value === 'object' ? value : {});
const list = (value, maximum) => (Array.isArray(value) ? value.slice(0, maximum) : []);
const bool = (value) => (typeof value === 'boolean' ? value : undefined);
const pid = (value) => (Number.isSafeInteger(value) && value > 0 ? value : undefined);
const code = (value) =>
  value === null || (Number.isSafeInteger(value) && Math.abs(value) <= 0xffffffff)
    ? value
    : undefined;
const signal = (value) => (value === null || signals.has(value) ? value : undefined);
const identity = (value, pattern) =>
  typeof value === 'string' && value.length <= 128 && pattern.test(value) ? value : 'unavailable';
// Assertion messages may contain raw child stderr, argv or other fixture text. Only
// the presence of a private failure is public; structured native facts use the
// separate closed projections below. Text shape is never evidence of safe origin.
function privateFailure(value) {
  return typeof value === 'string' ? 'Failure detail retained in private report.' : undefined;
}

function observation(raw) {
  const value = object(raw);
  if (!operations.has(value.operation)) return undefined;
  return {
    operation: value.operation,
    pid: pid(value.pid),
    parentPid: pid(value.parentPid),
    code: code(value.code),
    signal: value.signal === 0 ? 0 : signal(value.signal),
    detached: bool(value.detached),
    shell: bool(value.shell),
    synthetic: bool(value.synthetic),
    error: privateFailure(value.reason),
    ...(value.operation === 'native-signal-observed'
      ? {
          owned: bool(value.owned),
          target: value.owned === true && value.target !== 0 ? code(value.target) : undefined,
          outcome: ['returned', 'threw'].includes(value.outcome) ? value.outcome : undefined,
          returned: bool(value.returned),
          nativeCode: value.outcome === 'threw' ? nativeSignalCode(value.nativeCode) : undefined,
          errno:
            Number.isSafeInteger(value.errno) && Math.abs(value.errno) <= 10000
              ? value.errno
              : undefined,
        }
      : {}),
    ...(value.operation === 'native-signal-diagnostics-complete'
      ? {
          complete: bool(value.complete),
          observations:
            Number.isSafeInteger(value.observations) &&
            value.observations >= 0 &&
            value.observations <= 64
              ? value.observations
              : undefined,
        }
      : {}),
    milliseconds:
      Number.isFinite(value.milliseconds) && value.milliseconds >= 0 && value.milliseconds <= 1e12
        ? value.milliseconds
        : undefined,
  };
}
function nativeLoadEvidence(raw) {
  const value = object(raw),
    assets = object(value.assets);
  return {
    stage: NATIVE_LOAD_STAGES.has(value.stage) ? value.stage : 'unavailable',
    loaderOutcome: loaderStates.has(value.loaderOutcome) ? value.loaderOutcome : 'unavailable',
    assets: Object.fromEntries(
      Object.keys(ASSETS).map((key) => [
        key,
        linkStates.has(assets[key]) ? assets[key] : 'unavailable',
      ]),
    ),
  };
}
function workflowEvidence(raw) {
  const value = object(raw);
  return { stage: WORKFLOW_STAGES.has(value.stage) ? value.stage : 'unavailable' };
}

function nativeMode(raw) {
  const value = object(raw),
    cleanup = object(value.cleanup),
    cli = object(value.cli);
  if (!modes.has(value.mode)) return undefined;
  const observed = Array.isArray(value.observed) ? value.observed : [];
  const sampled =
    observed.length > 16 ? [...observed.slice(0, 8), ...observed.slice(-8)] : observed;
  return {
    mode: value.mode,
    passed: bool(value.passed),
    gate: ['target', 'helper', 'none'].includes(value.gate) ? value.gate : undefined,
    watchdogFired: bool(value.watchdogFired),
    cli: { code: code(cli.code), signal: signal(cli.signal) },
    observed: sampled.map(observation).filter(Boolean),
    observationsTruncated: observed.length > 16,
    cleanup: {
      releaseWritten: bool(cleanup.releaseWritten),
      cliActualCloseObserved: bool(cleanup.cliActualCloseObserved),
      native: list(cleanup.native, 8).map((raw) => {
        const item = object(raw);
        return { pid: pid(item.pid), absenceObserved: bool(item.absenceObserved) };
      }),
      sentinel: {
        pid: pid(object(cleanup.sentinel).pid),
        actualCloseObserved: bool(object(cleanup.sentinel).actualCloseObserved),
        watchdogFired: bool(object(cleanup.sentinel).watchdogFired),
      },
      failures: list(cleanup.failures, 3)
        .map((value) => privateFailure(value))
        .filter(Boolean),
    },
  };
}

/** Strict synthetic-test projection; no report spread, paths, argv, env, transcript or child output. */
export function formatInstalledWorkerFailure(raw) {
  const report = object(raw);
  if (report.success === true) return undefined;
  const cases = list(report.cases, REQUIRED_SMOKE_CASES.length * 2);
  const diagnostic = {
    type: 'installed-cli-worker-failure',
    source: identity(report.source, /^[a-f0-9]{40}$/u),
    artifactSha256: identity(report.artifactSha256, /^[a-f0-9]{64}$/u),
    runtime: identity(report.runtime, /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u),
    platform: ['linux', 'darwin', 'win32'].includes(report.platform)
      ? report.platform
      : 'unavailable',
    workerPid: pid(report.pid),
    parentPid: pid(report.parentPid),
    error: privateFailure(report.error),
    cleanupError: privateFailure(report.cleanupError),
    immutabilityError: privateFailure(report.immutabilityError),
    compiledUnchanged: bool(report.compiledUnchanged),
    ownedTempRemoved: bool(report.ownedTempRemoved),
    cases: REQUIRED_SMOKE_CASES.flatMap((id) => {
      const item = cases.find((value) => object(value).id === id);
      if (item?.passed === true) return [];
      return [
        {
          id,
          status: item === undefined ? 'missing' : 'failed',
          error: privateFailure(item?.error),
          ...(id === 'native-addon-load-only' && item?.evidence?.diagnostic !== undefined
            ? { nativeLoad: nativeLoadEvidence(item.evidence.diagnostic) }
            : {}),
          ...(id === 'workflow-gate-budget-effects' && item?.evidence?.diagnostic !== undefined
            ? { workflow: workflowEvidence(item.evidence.diagnostic) }
            : {}),
          ...(['actual-native-process-owner', 'actual-native-bootstrap-lifecycle'].includes(id)
            ? {
                native: list(object(item?.evidence).outcomes, 6)
                  .map(nativeMode)
                  .filter(Boolean)
                  .slice(0, 3),
              }
            : {}),
        },
      ];
    }),
  };
  let line = JSON.stringify(diagnostic) + '\n';
  if (Buffer.byteLength(line) > MAX_WORKER_FAILURE_BYTES) {
    diagnostic.truncated = true;
    for (const item of diagnostic.cases) {
      if ((item.native?.length ?? 0) > 2) {
        item.native = [item.native[0], item.native.at(-1)];
        item.nativeModesTruncated = true;
      }
      for (const mode of item.native ?? []) {
        if (mode.observed.length > 4)
          mode.observed = [...mode.observed.slice(0, 2), ...mode.observed.slice(-2)];
        mode.observationsTruncated = true;
        mode.cleanup.failures = mode.cleanup.failures.slice(0, 1);
      }
    }
    line = JSON.stringify(diagnostic) + '\n';
  }
  // The compact fixed inventory fits well below this bound even with the complete required failure inventory.
  if (Buffer.byteLength(line) > MAX_WORKER_FAILURE_BYTES)
    throw new Error('Worker failure diagnostic bound exceeded');
  return line;
}

/** Failure reporting is secondary: fd2 refusal never replaces the primary or falls back to stdout. */
export function emitInstalledWorkerFailure(report, write = (line) => writeSync(2, line)) {
  try {
    const line = formatInstalledWorkerFailure(report);
    if (line !== undefined) write(line);
  } catch {
    // The caller has already latched its failed exit; actual worker join/cleanup still belongs to its owner.
  }
}
