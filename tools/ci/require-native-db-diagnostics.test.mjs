import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireNativeDbDiagnostics } from './require-native-db-diagnostics.mjs';

const FAILURE = 'Native DB execution diagnostics are missing or invalid.';
const setup = {
  stage: 'ci-invocation',
  node: 'v24.8.0',
  platform: 'linux',
  arch: 'x64',
  availableParallelism: 2,
  workspaceTestConcurrency: 1,
};

// Independently authored protocol expectations: parent observes and joins actual child barriers.
const cuts = [
  ['import-start'],
  ['import-complete'],
  ['open-start'],
  ['open-complete'],
  ['transaction-start'],
  ['barrier-write', { kind: 'CUT' }],
];
const committed = [
  ...cuts.slice(0, -1),
  ['transaction-complete'],
  ['barrier-write', { kind: 'CUT' }],
];
const locked = [...cuts.slice(0, -1), ['barrier-write', { kind: 'LOCKED' }]];
const released = [...locked, ['transaction-complete'], ['database-close']];
const waiting = [...cuts.slice(0, 4), ['not-ready', { kind: 'WAITING' }]];
const cohorts = [
  ['lock-release', released, 'LOCKED', 0, null],
  ['readiness-timeout-control', waiting, 'WAITING', null, 'SIGKILL'],
  ['pending-before-ack', cuts, 'CUT', null, 'SIGKILL'],
  ['pending-after-ack', cuts, 'CUT', null, 'SIGKILL'],
  ['pending-after-commit', committed, 'CUT', null, 'SIGKILL'],
  ['before-ack', cuts, 'CUT', null, 'SIGKILL'],
  ['after-ack', cuts, 'CUT', null, 'SIGKILL'],
  ['after-commit', committed, 'CUT', null, 'SIGKILL'],
  ['lock-release', released, 'LOCKED', 0, null],
  ['lock-hold', locked, 'LOCKED', null, 'SIGKILL'],
];

function journal() {
  const events = [{ ...setup }];
  for (const [index, [mode, stages, kind, code, signal]] of cohorts.entries()) {
    const common = {
      callerPid: 100,
      pid: 200 + index,
      mode,
      elapsedMs: 0,
      atMs: 1000,
      cpuUserMs: 0.5,
      cpuSystemMs: 0.25,
    };
    const runtime = {
      node: setup.node,
      platform: setup.platform,
      arch: setup.arch,
      availableParallelism: setup.availableParallelism,
    };
    // A child may append startup data before the parent's spawn diagnostic; source order is retained.
    events.push({ ...common, source: 'child', stage: stages[0][0], ...runtime });
    events.push({
      ...common,
      source: 'parent',
      stage: 'spawn',
      ...runtime,
      readinessDeadlineMs: 5000,
    });
    const barrierIndex = stages.findIndex(
      ([stage]) => stage === 'barrier-write' || stage === 'not-ready',
    );
    for (const [stage, detail] of stages.slice(1, barrierIndex + 1))
      events.push({ ...common, source: 'child', stage, ...detail });
    events.push({
      ...common,
      source: 'parent',
      stage: kind === 'WAITING' ? 'not-ready' : 'barrier',
      kind,
    });
    if (kind === 'WAITING')
      events.push({ ...common, source: 'parent', stage: 'readiness-timeout' });
    for (const [stage, detail] of stages.slice(barrierIndex + 1))
      events.push({ ...common, source: 'child', stage, ...detail });
    events.push({
      ...common,
      source: 'parent',
      stage: 'close',
      code,
      signal,
      state: kind === 'WAITING' ? 'failed' : 'ready',
      stdoutCharacters: 7,
      stderrCharacters: 0,
    });
  }
  return events;
}

function withFile(body) {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-native-db-diagnostics-'));
  try {
    return body(join(directory, 'events.jsonl'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeJournal(path, events) {
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

function refuses(path) {
  assert.throws(
    () => requireNativeDbDiagnostics(path),
    (error) => error instanceof Error && error.message === FAILURE && error.cause === undefined,
  );
}

test('accepts a full joined native cohort across independently ordered parent and child records', () => {
  withFile((path) => {
    writeJournal(path, journal());
    assert.deepEqual(requireNativeDbDiagnostics(path), { workers: 10, modes: 9 });
  });
});

for (const [name, alter] of [
  ['setup only', () => [setup]],
  ['empty file', () => []],
  ['missing child records', (events) => events.filter((event) => event.source !== 'child')],
  ['missing parent records', (events) => events.filter((event) => event.source !== 'parent')],
  [
    'missing joined close',
    (events) => events.filter((event) => !(event.pid === 202 && event.stage === 'close')),
  ],
  ['missing whole mode', (events) => events.filter((event) => event.mode !== 'lock-hold')],
  ['missing second release case', (events) => events.filter((event) => event.pid !== 208)],
  [
    'wrong child parent PID',
    (events) =>
      events.map((event) =>
        event.pid === 202 && event.source === 'child' ? { ...event, callerPid: 101 } : event,
      ),
  ],
  [
    'wrong child PID',
    (events) =>
      events.map((event) =>
        event.pid === 202 && event.source === 'child' ? { ...event, pid: 999 } : event,
      ),
  ],
  [
    'mismatched mode',
    (events) =>
      events.map((event) =>
        event.pid === 202 && event.source === 'child' ? { ...event, mode: 'after-ack' } : event,
      ),
  ],
  [
    'missing import completion',
    (events) => events.filter((event) => !(event.pid === 202 && event.stage === 'import-complete')),
  ],
  [
    'missing native open',
    (events) => events.filter((event) => !(event.pid === 202 && event.stage === 'open-complete')),
  ],
  [
    'missing transaction',
    (events) =>
      events.filter((event) => !(event.pid === 202 && event.stage === 'transaction-start')),
  ],
  [
    'wrong child barrier',
    (events) =>
      events.map((event) =>
        event.pid === 202 && event.stage === 'barrier-write' ? { ...event, kind: 'LOCKED' } : event,
      ),
  ],
  [
    'timeout lacks deadline observation',
    (events) => events.filter((event) => event.stage !== 'readiness-timeout'),
  ],
  [
    'release lacks database close',
    (events) => events.filter((event) => !(event.pid === 200 && event.stage === 'database-close')),
  ],
  [
    'release not successful',
    (events) =>
      events.map((event) =>
        event.pid === 200 && event.stage === 'close' ? { ...event, code: 1 } : event,
      ),
  ],
  [
    'killed child not joined by signal',
    (events) =>
      events.map((event) =>
        event.pid === 202 && event.stage === 'close' ? { ...event, signal: null } : event,
      ),
  ],
  [
    'extended readiness deadline',
    (events) =>
      events.map((event) =>
        event.stage === 'spawn' ? { ...event, readinessDeadlineMs: 6000 } : event,
      ),
  ],
  [
    'foreign runtime',
    (events) =>
      events.map((event) =>
        event.pid === 202 && event.stage === 'import-start'
          ? { ...event, node: 'v22.13.0' }
          : event,
      ),
  ],
  [
    'parent barrier precedes child write',
    (events) => {
      const from = events.findIndex(
        (event) => event.pid === 202 && event.source === 'parent' && event.stage === 'barrier',
      );
      const to = events.findIndex((event) => event.pid === 202 && event.stage === 'barrier-write');
      const [barrier] = events.splice(from, 1);
      events.splice(to, 0, barrier);
      return events;
    },
  ],
  [
    'parent close precedes child finish',
    (events) => {
      const from = events.findIndex(
        (event) => event.pid === 200 && event.source === 'parent' && event.stage === 'close',
      );
      const to = events.findIndex((event) => event.pid === 200 && event.stage === 'database-close');
      const [close] = events.splice(from, 1);
      events.splice(to, 0, close);
      return events;
    },
  ],
  [
    'unknown source',
    (events) =>
      events.map((event) =>
        event.pid === 202 && event.stage === 'import-start' ? { ...event, source: 'other' } : event,
      ),
  ],
  [
    'invalid CPU observation',
    (events) => events.map((event) => (event.pid === 202 ? { ...event, cpuUserMs: -1 } : event)),
  ],
  ['unknown stage', (events) => [...events, { ...events[1], stage: 'opaque-private-payload' }]],
  ['duplicate spawn', (events) => [...events, { ...events[2] }]],
  ['reversed stage order', (events) => [events[0], ...events.slice(1).reverse()]],
  ['unexpected extra context', (events) => [...events, setup]],
]) {
  test(`refuses ${name} without promoting journal content`, () => {
    withFile((path) => {
      writeJournal(path, alter(journal()));
      refuses(path);
    });
  });
}

for (const [name, body] of [
  ['malformed JSON', '{"private":"SENTINEL_SECRET"\n{}\n'],
  ['truncated final line', JSON.stringify(setup)],
  ['array record', '[]\n{}\n'],
  ['null record', 'null\n{}\n'],
  ['blank record', '\n{}\n'],
  ['zero-byte file', ''],
  ['oversized file', 'x'.repeat(256 * 1024 + 1)],
  [
    'oversized individual line',
    JSON.stringify({ ...setup, private: 'SENTINEL_SECRET'.repeat(400) }) + '\n{}\n',
  ],
  ['too many records', '{}\n'.repeat(257)],
  ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
]) {
  test(`refuses ${name} with a fixed bounded diagnostic`, () => {
    withFile((path) => {
      writeFileSync(path, body);
      refuses(path);
    });
  });
}

test('missing path, file and directory refuse without exposing native path or error text', () => {
  refuses(undefined);
  withFile((path) => {
    refuses(path);
    refuses(join(path, '..'));
  });
});

test('actual validator command fails safely and succeeds only on a full journal', () => {
  withFile((path) => {
    const command = fileURLToPath(new URL('./require-native-db-diagnostics.mjs', import.meta.url));
    const run = () =>
      spawnSync(process.execPath, [command], {
        env: { ...process.env, RELAVIUM_DB_NATIVE_DIAGNOSTICS: path },
        encoding: 'utf8',
        timeout: 10_000,
      });
    writeFileSync(path, '{"private":"SENTINEL_SECRET"\n{}\n');
    const bad = run();
    assert.equal(bad.error, undefined);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    assert.equal(bad.stderr, `${FAILURE}\n`);
    writeJournal(path, journal());
    const good = run();
    assert.equal(good.error, undefined);
    assert.equal(good.status, 0);
    assert.equal(good.stdout, 'Native DB execution diagnostics verified.\n');
    assert.equal(good.stderr, '');
  });
});
