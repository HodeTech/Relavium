import { Buffer } from 'node:buffer';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

const FAILURE = 'Native DB execution diagnostics are missing or invalid.';
const MAX_BYTES = 256 * 1024;
const MAX_LINES = 256;
const MAX_LINE_BYTES = 4096;
const COUNTS = new Map([
  ['lock-release', 2],
  ['readiness-timeout-control', 1],
  ['pending-before-ack', 1],
  ['pending-after-ack', 1],
  ['pending-after-commit', 1],
  ['before-ack', 1],
  ['after-ack', 1],
  ['after-commit', 1],
  ['lock-hold', 1],
]);

function requireCondition(condition) {
  if (!condition) throw new Error(FAILURE);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Read at most the ceiling plus one refusal byte, including a file growing after its stat. */
function readJournal(path) {
  requireCondition(typeof path === 'string' && path.length > 0);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    requireCondition(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES);
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    requireCondition(length > 0 && length <= MAX_BYTES);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    requireCondition(text.endsWith('\n'));
    const lines = text.slice(0, -1).split('\n');
    requireCondition(lines.length > 1 && lines.length <= MAX_LINES);
    return lines.map((line) => {
      requireCondition(line.length > 0 && Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES);
      const value = JSON.parse(line);
      requireCondition(record(value));
      return value;
    });
  } finally {
    closeSync(fd);
  }
}

function sameStages(events, stages) {
  requireCondition(
    events.length === stages.length &&
      events.every((event, index) => event.stage === stages[index]),
  );
  for (let index = 1; index < events.length; index++) {
    requireCondition(events[index].elapsedMs >= events[index - 1].elapsedMs);
  }
}

/** Validate the actual current session-usage native fixture cohort, never the setup record alone. */
function validateJournal(events) {
  const [context, ...workers] = events;
  requireCondition(
    context.stage === 'ci-invocation' &&
      context.source === undefined &&
      context.workspaceTestConcurrency === 1 &&
      typeof context.node === 'string' &&
      /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(context.node) &&
      typeof context.platform === 'string' &&
      /^[a-z0-9_-]{1,32}$/.test(context.platform) &&
      typeof context.arch === 'string' &&
      /^[a-z0-9_-]{1,32}$/.test(context.arch) &&
      positiveInteger(context.availableParallelism),
  );
  const groups = new Map();
  for (const event of workers) {
    requireCondition(
      (event.source === 'parent' || event.source === 'child') &&
        typeof event.stage === 'string' &&
        COUNTS.has(event.mode) &&
        positiveInteger(event.callerPid) &&
        positiveInteger(event.pid) &&
        event.callerPid !== event.pid &&
        Number.isSafeInteger(event.elapsedMs) &&
        event.elapsedMs >= 0 &&
        positiveInteger(event.atMs) &&
        nonnegative(event.cpuUserMs) &&
        nonnegative(event.cpuSystemMs),
    );
    const key = `${event.callerPid}:${event.pid}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { mode: event.mode, parent: [], child: [] };
      groups.set(key, group);
    }
    requireCondition(group.mode === event.mode);
    group[event.source].push(event);
  }
  requireCondition(groups.size === 10);
  const actualCounts = new Map();
  for (const { mode, parent, child } of groups.values()) {
    actualCounts.set(mode, (actualCounts.get(mode) ?? 0) + 1);
    const timeout = mode === 'readiness-timeout-control';
    const lock = mode === 'lock-release' || mode === 'lock-hold';
    sameStages(
      parent,
      timeout
        ? ['spawn', 'not-ready', 'readiness-timeout', 'close']
        : ['spawn', 'barrier', 'close'],
    );
    const childStages = ['import-start', 'import-complete', 'open-start', 'open-complete'];
    if (timeout) childStages.push('not-ready');
    else {
      childStages.push('transaction-start');
      if (mode.endsWith('after-commit')) childStages.push('transaction-complete');
      childStages.push('barrier-write');
      if (mode === 'lock-release') childStages.push('transaction-complete', 'database-close');
    }
    sameStages(child, childStages);
    for (const event of [parent[0], child[0]]) {
      requireCondition(
        event.node === context.node &&
          event.platform === context.platform &&
          event.arch === context.arch &&
          positiveInteger(event.availableParallelism),
      );
    }
    requireCondition(parent[0].readinessDeadlineMs === 5000);
    const parentBarrier = parent[1];
    const childBarrier = child.find(
      (event) => event.stage === (timeout ? 'not-ready' : 'barrier-write'),
    );
    const expectedKind = timeout ? 'WAITING' : lock ? 'LOCKED' : 'CUT';
    requireCondition(parentBarrier.kind === expectedKind && childBarrier?.kind === expectedKind);
    const close = parent.at(-1);
    requireCondition(
      workers.indexOf(childBarrier) < workers.indexOf(parentBarrier) &&
        workers.indexOf(child.at(-1)) < workers.indexOf(close),
    );
    if (mode === 'lock-release') {
      const commit = child.find((event) => event.stage === 'transaction-complete');
      requireCondition(workers.indexOf(parentBarrier) < workers.indexOf(commit));
    }
    requireCondition(
      close.state === (timeout ? 'failed' : 'ready') &&
        (mode === 'lock-release'
          ? close.code === 0 && close.signal === null
          : close.code === null && close.signal === 'SIGKILL') &&
        Number.isSafeInteger(close.stdoutCharacters) &&
        close.stdoutCharacters >= 0 &&
        close.stdoutCharacters <= 4096 &&
        Number.isSafeInteger(close.stderrCharacters) &&
        close.stderrCharacters >= 0 &&
        close.stderrCharacters <= 4096,
    );
  }
  for (const [mode, count] of COUNTS) requireCondition(actualCounts.get(mode) === count);
  return { workers: 10, modes: COUNTS.size };
}

/** All refusals are fixed and content-free, including native I/O and JSON/UTF-8 decoding faults. */
export function requireNativeDbDiagnostics(path) {
  try {
    return validateJournal(readJournal(path));
  } catch {
    throw new Error(FAILURE);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireNativeDbDiagnostics(process.env.RELAVIUM_DB_NATIVE_DIAGNOSTICS);
    process.stdout.write('Native DB execution diagnostics verified.\n');
  } catch {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  }
}
