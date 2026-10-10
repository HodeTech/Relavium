// Runs after build against the shipped CLI and public compiled package APIs.
// Refusal/abort/status checks are offline: the preload rejects every keychain or network attempt.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function assertBudgetResumeBinary(repoRoot, sandboxHome) {
  const Database = createRequire(join(repoRoot, 'apps/cli/package.json'))('better-sqlite3');
  const guard = join(repoRoot, 'tools/cli-smoke/budget-offline-guard.mjs');
  const bundle = join(repoRoot, 'apps/cli/dist/index.js');
  const producer = join(repoRoot, 'tools/cli-smoke/budget-paused-producer.mjs');
  const fixtures = join(sandboxHome, 'budget-resume');
  mkdirSync(fixtures, { recursive: true, mode: 0o700 });
  const environment = (home) => ({
    PATH: process.env.PATH,
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    LANG: 'en_US.UTF-8',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    RELAVIUM_SMOKE_GUARD_LOG: join(home, 'offline-guard.jsonl'),
  });
  const assertOffline = (home) => {
    const log = join(home, 'offline-guard.jsonl');
    assert.equal(
      existsSync(log) ? readFileSync(log, 'utf8') : '',
      '',
      'Budget smoke attempted keychain/network access',
    );
  };
  const invoke = (home, executable, args) => {
    const result = spawnSync(process.execPath, ['--import', guard, executable, ...args], {
      cwd: home,
      env: environment(home),
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined, 'Budget smoke child execution failed');
    assert.equal(result.signal, null, 'Budget smoke child was killed or timed out');
    assertOffline(home);
    return result;
  };
  const seeded = (label, fixture) => {
    const home = join(fixtures, label);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const result = invoke(home, producer, fixture === undefined ? [home] : [home, fixture]);
    assert.equal(result.status, 0, result.stderr);
    return { home, ...JSON.parse(result.stdout) };
  };
  const snapshot = (home) => {
    const db = new Database(join(home, '.relavium/history.db'));
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      return Object.fromEntries(
        tables.map(({ name }) => [
          name,
          db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
        ]),
      );
    } finally {
      db.close();
    }
  };
  const helpHome = join(fixtures, 'help');
  mkdirSync(helpHome, { recursive: true, mode: 0o700 });
  const help = invoke(helpHome, bundle, ['budget', 'resume', '--help']);
  assert.equal(help.status, 0, help.stderr);
  for (const flag of [
    '--approve-amount',
    '--abort',
    '--gate',
    '--secret-stdin',
    '--allow-mcp-stdio',
  ]) {
    assert.ok(help.stdout.includes(flag), `Compiled budget help omitted ${flag}`);
  }
  for (const [label, amount] of [
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['overflow', '9007199254740992'],
    ['wrong', undefined],
  ]) {
    const fixture = seeded(label);
    const before = snapshot(fixture.home);
    const result = invoke(fixture.home, bundle, [
      'budget',
      'resume',
      fixture.runId,
      '--gate',
      fixture.gateId,
      '--approve-amount',
      amount ?? String(fixture.amount + 1),
      '--json',
    ]);
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.equal(result.stdout, '', 'Refusal stdout must remain an event stream');
    assert.deepEqual(snapshot(fixture.home), before, 'Invalid decision changed durable rows');
  }
  const aborted = seeded('abort');
  const status = invoke(aborted.home, bundle, ['status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  const statusJson = JSON.parse(status.stdout);
  assert.deepEqual(statusJson.pendingGates, []);
  assert.deepEqual(statusJson.pendingBudgetGates, [
    {
      gateId: aborted.gateId,
      nodeId: 'agent',
      allowance: { kind: 'amount', microcents: aborted.amount },
    },
  ]);
  assert.ok(!status.stdout.includes('provenance') && !status.stdout.includes('gpt-5.4-mini'));
  const abort = invoke(aborted.home, bundle, [
    'budget',
    'resume',
    aborted.runId,
    '--gate',
    aborted.gateId,
    '--abort',
    '--json',
  ]);
  assert.equal(abort.status, 1, abort.stderr);
  const events = abort.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(
    events.some((event) => event.type === 'run:failed' && event.error.code === 'budget_exceeded'),
  );
  const afterAbort = snapshot(aborted.home);
  const repeat = invoke(aborted.home, bundle, [
    'budget',
    'resume',
    aborted.runId,
    '--gate',
    aborted.gateId,
    '--abort',
    '--json',
  ]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stdout, '');
  assert.ok(repeat.stderr.includes('nothing to resume'));
  assert.deepEqual(snapshot(aborted.home), afterAbort);
  const corrupt = seeded('corrupt-authority');
  const corruptDb = new Database(join(corrupt.home, '.relavium/history.db'));
  try {
    const row = corruptDb
      .prepare(
        "SELECT id, payload_json FROM run_events WHERE run_id = ? AND event_type = 'budget:authorization'",
      )
      .get(corrupt.runId);
    assert.ok(row, 'Producer did not persist native authorization');
    const payload = JSON.parse(row.payload_json);
    payload.authorization.unexpectedNativeField = true;
    corruptDb
      .prepare('UPDATE run_events SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(payload), row.id);
  } finally {
    corruptDb.close();
  }
  const beforeCorrupt = snapshot(corrupt.home);
  const refused = invoke(corrupt.home, bundle, [
    'budget',
    'resume',
    corrupt.runId,
    '--gate',
    corrupt.gateId,
    '--approve-amount',
    String(corrupt.amount),
    '--json',
  ]);
  // Existing damaged-history transport is internal/exit 1; it must not become a tolerant legacy resume.
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stdout, '');
  assert.deepEqual(snapshot(corrupt.home), beforeCorrupt);
  const corruptStatus = invoke(corrupt.home, bundle, ['status', '--json']);
  assert.equal(corruptStatus.status, 0, corruptStatus.stderr);
  const unavailable = JSON.parse(corruptStatus.stdout);
  assert.equal(unavailable.gatesUnavailable, true);
  assert.equal(unavailable.gatesUnavailableReason, 'corrupt_event_log');
  assert.deepEqual(unavailable.pendingBudgetGates, []);
  assert.deepEqual(unavailable.pendingGates, []);

  // An actual stdio child stays inside initialize, so Ctrl-C happens before ownership/decision recording.
  const silent = join(repoRoot, 'packages/mcp/test-fixtures/silent-mcp-server.mjs');
  const fixture = seeded('mcp-connect-interrupt', silent);
  const args = [
    'budget',
    'resume',
    fixture.runId,
    '--gate',
    fixture.gateId,
    '--approve-amount',
    String(fixture.amount),
    '--json',
  ];
  const before = snapshot(fixture.home);
  const refusal = invoke(fixture.home, bundle, args);
  assert.equal(refusal.status, 2, refusal.stderr);
  assert.equal(refusal.stdout, '');
  assert.deepEqual(snapshot(fixture.home), before);
  const digest = /\bv1:[0-9a-f]{64}\b/.exec(refusal.stderr)?.[0];
  assert.ok(digest, 'Noninteractive MCP refusal omitted the declaration consent digest');
  const children = () => {
    const ps = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,args='], {
      encoding: 'utf8',
    });
    assert.equal(ps.status, 0, 'Cannot inspect actual MCP child process table');
    return ps.stdout
      .split('\n')
      .filter((line) => line.includes(silent))
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
        assert.ok(match);
        return { pid: Number(match[1]), ppid: Number(match[2]) };
      });
  };
  const host = spawn(
    process.execPath,
    ['--import', guard, bundle, ...args, '--allow-mcp-stdio', digest],
    {
      cwd: fixture.home,
      env: environment(fixture.home),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  host.stdin.end();
  let stdout = '';
  let stderr = '';
  host.stdout.on('data', (data) => {
    stdout += data;
  });
  host.stderr.on('data', (data) => {
    stderr += data;
  });
  let exited = false;
  const exit = new Promise((resolve, reject) => {
    host.once('error', reject);
    host.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const owned = new Set();
  try {
    assert.ok(
      await waitFor(() => {
        for (const child of children()) if (child.ppid === host.pid) owned.add(child.pid);
        return owned.size > 0;
      }, 15_000),
      'No actual MCP child spawned; interruption scenario proved nothing',
    );
    host.kill('SIGINT');
    assert.ok(await waitFor(() => exited, 15_000), 'Interrupted budget host did not terminate');
    const result = await exit;
    assert.equal(result.signal, null);
    assert.equal(result.code, 1, stderr);
    assert.equal(stdout, '', 'Pre-claim interruption must not emit run events');
    assert.ok(stderr.includes('resume interrupted before a decision was recorded'));
    assert.ok(
      await waitFor(() => children().every((child) => !owned.has(child.pid)), 10_000),
      'Owned MCP child survived Ctrl-C',
    );
    assert.deepEqual(snapshot(fixture.home), before, 'Connect interruption changed durable rows');
    assertOffline(fixture.home);
  } finally {
    if (!exited) host.kill('SIGKILL');
    for (const child of children()) {
      if (!owned.has(child.pid) && child.ppid !== host.pid) continue;
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* owned child already exited */
      }
    }
    await exit;
  }
}

async function waitFor(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}
