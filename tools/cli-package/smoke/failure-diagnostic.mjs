import { Buffer } from 'node:buffer';
import { writeSync } from 'node:fs';
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
