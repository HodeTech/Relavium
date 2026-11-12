import assert from 'node:assert/strict';
import { chmodSync, statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExit, invoke, ndjson, poll, startOwned } from './process.mjs';

const workflow = (id, nodes, edges, extra = {}) =>
  JSON.stringify({ schema_version: '1.0', workflow: { id, nodes, edges, ...extra } });
const edge = (from, to) => ({ from, to });
export async function assertInstalledWorkflows(context) {
  const { root, Database, cli, environment, calls } = context;
  const checkpoint = context.workflowCheckpoint ?? (() => {});
  checkpoint('start');
  const home = join(root, 'workflow-home');
  mkdirSync(home);
  const invokeCli = async (args, code, input = '', extra = {}, keyringAttempts = 0) => {
    const before = calls().length;
    const result = await invoke(cli(args), { cwd: home, env: environment(home, extra) }, input);
    assertExit(result, code);
    const observed = calls().slice(before);
    assert.equal(
      observed.filter((call) => call.operation === 'keyring.Entry').length,
      keyringAttempts,
    );
    assert.equal(
      observed.filter((call) => call.denied && call.operation !== 'keyring.Entry').length,
      0,
      'Offline workflow attempted a forbidden service',
    );
    return result;
  };
  const dbPath = join(home, '.relavium/history.db');
  const query = (sql, ...params) => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  };
  const snapshot = () => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
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
  checkpoint('sequential');
  const sequential = join(home, 'sequential.relavium.yaml');
  writeFileSync(
    sequential,
    workflow(
      'packaged-sequential',
      [
        { id: 'start', type: 'input' },
        { id: 'double', type: 'transform', transform: '({ doubled: inputs.n * 2 })' },
        { id: 'out', type: 'output' },
      ],
      [edge('start', 'double'), edge('double', 'out')],
      { inputs: [{ name: 'n', type: 'number' }] },
    ),
  );
  const sequentialResult = await invokeCli(['run', sequential, '--input', 'n=21', '--json'], 0);
  const sequentialEvents = ndjson(sequentialResult.stdout);
  const completed = sequentialEvents.find((event) => event.type === 'run:completed');
  assert.ok(completed, 'Real workflow terminal missing');
  assert.ok(
    JSON.stringify(completed).includes('42'),
    'Compiled expression sandbox must return actual doubled input',
  );
  assert.equal(
    query('SELECT count(*) AS n FROM __drizzle_migrations')[0].n > 0,
    true,
    'Installed drizzle migrations must execute',
  );

  checkpoint('human-gate');
  const human = join(home, 'human.relavium.yaml');
  writeFileSync(
    human,
    workflow(
      'packaged-human',
      [
        { id: 'start', type: 'input' },
        { id: 'gate', type: 'human_gate', gate_type: 'approval' },
        { id: 'out', type: 'output' },
      ],
      [edge('start', 'gate'), edge('gate', 'out')],
    ),
  );
  const pause = await invokeCli(['run', human, '--json'], 3);
  const paused = ndjson(pause.stdout).find((event) => event.type === 'human_gate:paused');
  assert.ok(paused?.runId && paused.gateId);
  const list = await invokeCli(['gate', 'list', paused.runId, '--json'], 0);
  assert.ok(list.stdout.includes(paused.gateId));
  const status = await invokeCli(['status', '--json'], 0);
  assert.ok(status.stdout.includes(paused.gateId));
  const resume = await invokeCli(
    ['gate', paused.runId, '--gate', paused.gateId, '--approve', '--json'],
    0,
  );
  const resumeEvents = ndjson(resume.stdout);
  assert.ok(resumeEvents.some((event) => event.type === 'human_gate:resumed'));
  assert.ok(
    resumeEvents.some((event) => event.type === 'run:completed' && event.runId === paused.runId),
  );
  const history = await invokeCli(['logs', paused.runId, '--json'], 0);
  assert.ok(ndjson(history.stdout).some((event) => event.type === 'run:completed'));

  checkpoint('budget-pause');
  const budget = join(home, 'budget.relavium.yaml');
  writeFileSync(
    budget,
    workflow(
      'packaged-budget',
      [
        {
          id: 'agent',
          type: 'agent',
          agent_ref: 'worker',
          prompt_template: 'synthetic budget prompt',
          max_tokens: 64,
        },
      ],
      [],
      {
        budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval', strict_cost_cap: true },
        agents: [
          {
            id: 'worker',
            model: 'gpt-4o-mini',
            provider: 'openai',
            system_prompt: 'Synthetic budget control.',
            tools: [],
          },
        ],
      },
    ),
  );
  const budgetPause = await invokeCli(
    ['run', budget, '--json'],
    3,
    '',
    { RELAVIUM_OPENAI_API_KEY: 'sk-relavium-synthetic-package-smoke' },
    1,
  );
  const authorization = ndjson(budgetPause.stdout).find(
    (event) => event.type === 'budget:authorization' && event.authorization?.state === 'paused',
  );
  assert.ok(authorization?.gateId && authorization.runId);
  const allowance = authorization.authorization.allowance;
  assert.equal(allowance.kind, 'frozen');
  assert.equal(allowance.quote.kind, 'quoted');
  assert.equal(allowance.quote.quote.amount.kind, 'representable');
  const amount = allowance.quote.quote.amount.microcents;
  assert.ok(Number.isSafeInteger(amount) && amount > 1);
  const budgetStatus = JSON.parse((await invokeCli(['status', '--json'], 0)).stdout);
  assert.ok(budgetStatus.pendingBudgetGates.some((gate) => gate.gateId === authorization.gateId));
  checkpoint('budget-decisions');
  const before = snapshot();
  for (const invalid of ['-1', '1.5', '9007199254740992', String(amount + 1)]) {
    const refusal = await invokeCli(
      [
        'budget',
        'resume',
        authorization.runId,
        '--gate',
        authorization.gateId,
        '--approve-amount',
        invalid,
        '--json',
      ],
      2,
    );
    assert.equal(refusal.stdout, '');
    assert.deepEqual(snapshot(), before, 'Invalid amount changed durable rows');
  }
  const abortArgs = [
    'budget',
    'resume',
    authorization.runId,
    '--gate',
    authorization.gateId,
    '--abort',
    '--json',
  ];
  const aborted = await invokeCli(abortArgs, 1);
  assert.ok(
    ndjson(aborted.stdout).some(
      (event) => event.type === 'run:failed' && event.error.code === 'budget_exceeded',
    ),
  );
  const afterAbort = snapshot();
  const repeat = await invokeCli(abortArgs, 0);
  assert.equal(repeat.stdout, '');
  assert.ok(repeat.stderr.includes('nothing to resume'));
  assert.deepEqual(snapshot(), afterAbort);

  // Exercise the shipped, documented agent-run cassette seam and the real tool policy.
  // No product implementation is substituted; a noninteractive governed write must be refused.
  checkpoint('denied-effect');
  const agent = join(home, 'effects.agent.yaml'),
    cassette = join(home, 'effects.json');
  writeFileSync(
    agent,
    'id: packaged-effects\nprovider: openai\nmodel: gpt-4o-mini\nsystem_prompt: Synthetic denied effect.\ntools: [write_file]\nmax_tokens: 64\n',
  );
  writeFileSync(
    cassette,
    JSON.stringify({
      schema_version: '2.0',
      provider: 'openai',
      model: 'gpt-4o-mini',
      calls: [
        [
          { type: 'tool_call_start', id: 'synthetic-write', name: 'write_file' },
          {
            type: 'tool_call_delta',
            id: 'synthetic-write',
            argsJsonDelta: JSON.stringify({
              path: 'must-not-exist.txt',
              content: 'synthetic denied write',
            }),
          },
          { type: 'tool_call_end', id: 'synthetic-write' },
          {
            type: 'stop',
            stopReason: 'tool_use',
            usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
          },
        ],
      ],
    }),
  );
  const effectRows = query('SELECT * FROM run_effects');
  const deniedWrite = await invokeCli(
    ['agent', 'run', agent, '--fixture', cassette, '--json'],
    1,
    'synthetic effect prompt\n',
  );
  assert.ok(
    ndjson(deniedWrite.stdout).some(
      (event) => event.type === 'session:turn_completed' && event.error?.code === 'tool_denied',
    ),
  );
  assert.equal(existsSync(join(home, 'must-not-exist.txt')), false);
  assert.deepEqual(
    query('SELECT * FROM run_effects'),
    effectRows,
    'Denied effect must not dispatch or create effect journal rows',
  );
  // Real installed CLI -> compiled AgentNodeExecutor -> native host -> durable effect journal.
  // Only the already source-owned SDK transport is scripted; no product approval or loader is replaced.
  checkpoint('native-start');
  const nativeWorkflow = join(home, 'native-write.relavium.yaml');
  const nativeTarget = join(home, 'native-write-target.txt');
  const nativePrompt = 'packaged native write prompt';
  writeFileSync(nativeTarget, 'installed native original bytes\n');
  if (process.platform !== 'win32') chmodSync(nativeTarget, 0o640);
  const nativePolicy = statSync(nativeTarget, { bigint: true });
  writeFileSync(
    nativeWorkflow,
    workflow(
      'packaged-native-write',
      [
        {
          id: 'writer',
          type: 'agent',
          agent_ref: 'writer-agent',
          prompt_template: nativePrompt,
          max_tokens: 256,
        },
      ],
      [],
      {
        agents: [
          {
            id: 'writer-agent',
            provider: 'openai',
            model: 'gpt-4o-mini',
            system_prompt: 'Synthetic offline native write fixture.',
            tools: ['write_file'],
          },
        ],
      },
    ),
  );
  const nativeCallsBefore = calls().length;
  const barrier = join(home, 'native-sdk-barrier');
  const ownedNative = startOwned(cli(['run', nativeWorkflow, '--json']), {
    cwd: home,
    env: environment(home, {
      RELAVIUM_OPENAI_API_KEY: 'sk-relavium-synthetic-package-smoke',
      RELAVIUM_PACKAGE_SMOKE_PROMPT: nativePrompt,
      RELAVIUM_PACKAGE_SMOKE_REPLY: 'packaged native write complete',
      RELAVIUM_PACKAGE_SMOKE_WRITE: '1',
      RELAVIUM_PACKAGE_SMOKE_WRITE_BARRIER: barrier,
    }),
  });
  let nativeCompleted;
  try {
    checkpoint('native-barrier');
    await poll(
      () => {
        assert.equal(ownedNative.isSettled(), false, ownedNative.output().stderr);
        return existsSync(barrier + '.ready');
      },
      20_000,
      'Installed SDK did not reach its post-tool response barrier',
    );
    const started = ndjson(ownedNative.output().stdout).find(
      (event) => event.type === 'run:started',
    );
    assert.ok(started?.runId);
    checkpoint('native-bytes');
    assert.equal(readFileSync(nativeTarget, 'utf8'), 'installed native reviewed bytes 🙂\n');
    checkpoint('native-metadata');
    const nativeAfter = statSync(nativeTarget, { bigint: true });
    if (process.platform !== 'win32') {
      for (const field of ['uid', 'gid']) assert.equal(nativeAfter[field], nativePolicy[field]);
      assert.equal(nativeAfter.mode & 0o7777n, nativePolicy.mode & 0o7777n);
    }
    checkpoint('native-journal');
    const nativeEffects = query(
      'SELECT * FROM run_effects WHERE scope = ?',
      `run:${started.runId}:writer`,
    );
    assert.equal(
      nativeEffects.length,
      1,
      'Installed native publication must have one durable effect before terminal retention',
    );
    assert.equal(nativeEffects[0].state, 'committed');
    assert.equal(nativeEffects[0].tool_id, 'write_file');
    checkpoint('native-release');
    writeFileSync(barrier + '.release', '', { flag: 'wx', mode: 0o600 });
    ownedNative.child.stdin.end();
    checkpoint('native-terminal');
    const result = await ownedNative.result();
    assertExit(result, 0);
    nativeCompleted = ndjson(result.stdout).find((event) => event.type === 'run:completed');
    assert.equal(nativeCompleted?.runId, started.runId);
    checkpoint('native-sweep');
    assert.equal(
      query('SELECT * FROM run_effects WHERE scope = ?', `run:${started.runId}:writer`).length,
      0,
      'Terminal non-resumable run must sweep its committed effect',
    );
    checkpoint('native-observations');
    const observed = calls().slice(nativeCallsBefore);
    assert.equal(observed.filter((call) => call.operation === 'keyring.Entry').length, 3);
    assert.equal(
      observed.filter((call) => call.denied && call.operation !== 'keyring.Entry').length,
      0,
    );
  } finally {
    await ownedNative.close();
  }
  checkpoint('native-observations');
  const nativeSdkCalls = calls()
    .slice(nativeCallsBefore)
    .filter((call) => call.operation === 'sdk-fetch');
  assert.equal(nativeSdkCalls.length, 2);
  assert.equal(nativeSdkCalls[1].body.messages.at(-1).role, 'tool');
  checkpoint('complete');
  return {
    workflow: {
      terminal: completed,
      eventTypes: sequentialEvents.map((event) => event.type),
      migrations: query('SELECT count(*) AS count FROM __drizzle_migrations')[0].count,
    },
    gate: {
      runId: paused.runId,
      gateId: paused.gateId,
      discovered: true,
      resumedInFreshProcess: true,
      eventTypes: resumeEvents.map((event) => event.type),
    },
    budget: {
      runId: authorization.runId,
      gateId: authorization.gateId,
      amount,
      syntheticPreflightKeyringDenied: 1,
      providerDispatches: 0,
      invalidDecisionsUnchanged: 4,
      aborted: true,
      repeatUnchanged: true,
    },
    effects: {
      realGovernedWriteRefused: true,
      targetAbsent: true,
      journalUnchanged: true,
      installedNativeWrite: {
        runId: nativeCompleted.runId,
        exactBytes: true,
        existingMetadataPreserved: process.platform !== 'win32',
        committedEffectsBeforeTerminal: 1,
        terminalRetentionSweep: true,
        sdkFixtureDispatches: 2,
        realNetworkDispatches: 0,
      },
    },
  };
}

export async function assertInstalledMcp(context, expectedVersion) {
  const { root, cli, environment, calls } = context;
  const home = join(root, 'mcp-home');
  mkdirSync(home);
  const fixture = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
  const mcpLog = join(root, 'mcp.ndjson');
  const path = join(home, 'mcp.relavium.yaml');
  writeFileSync(
    path,
    workflow(
      'packaged-mcp',
      [
        { id: 'gate', type: 'human_gate', gate_type: 'approval' },
        { id: 'out', type: 'output' },
      ],
      [edge('gate', 'out')],
      {
        agents: [
          {
            id: 'worker',
            model: 'gpt-4o-mini',
            provider: 'openai',
            system_prompt: 'not reached',
            tools: [],
            mcp_servers: [
              {
                id: 'fixture',
                transport: 'stdio',
                command: process.execPath,
                args: [fixture],
                env: { RELAVIUM_PACKAGE_SMOKE_MCP_LOG: mcpLog },
              },
            ],
          },
        ],
      },
    ),
  );
  const before = calls().length;
  const env = environment(home, { RELAVIUM_PACKAGE_SMOKE_MCP: fixture });
  let observations = [];
  let nativeJoined = false;
  try {
    const refusal = await invoke(cli(['run', path, '--json']), { cwd: home, env });
    assertExit(refusal, 2);
    assert.equal(existsSync(mcpLog), false, 'Consent refusal must precede actual native spawn');
    const digest = /\bv1:[0-9a-f]{64}\b/.exec(refusal.stderr)?.[0];
    assert.ok(
      digest,
      `Actual consent refusal must publish its declaration digest: ${refusal.stderr}`,
    );
    const result = await invoke(cli(['run', path, '--json', '--allow-mcp-stdio', digest]), {
      cwd: home,
      env,
    });
    assertExit(result, 3);
    observations = ndjson(readFileSync(mcpLog, 'utf8'));
    const initializes = observations.filter((value) => value.operation === 'initialize');
    assert.equal(initializes.length, 1);
    assert.deepEqual(initializes[0].params.clientInfo, {
      name: 'relavium',
      version: expectedVersion,
    });
    assert.equal(observations.filter((value) => value.operation === 'tools/list').length, 1);
    assert.ok(
      observations.some((value) => value.operation === 'closed'),
      'Actual MCP stdin owner must close',
    );
    const pid = observations.find((value) => value.operation === 'started')?.pid;
    assert.ok(Number.isSafeInteger(pid));
    await poll(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error.code === 'ESRCH') return true;
          throw error;
        }
      },
      5000,
      'Actual MCP fixture process survived its CLI owner',
    );
    nativeJoined = true;
    const observed = calls().slice(before);
    assert.equal(observed.filter((call) => call.operation === 'mcp-spawn').length, 1);
    assert.equal(observed.filter((call) => call.denied).length, 0);
    return {
      version: expectedVersion,
      actualInitialize: initializes[0].params,
      nativeChildJoined: true,
      dispatches: 1,
    };
  } finally {
    // A failing assertion still owns the exact fixture PIDs it created. No process-table search.
    if (existsSync(mcpLog)) observations = ndjson(readFileSync(mcpLog, 'utf8'));
    if (!nativeJoined)
      for (const value of observations.filter((value) => value.operation === 'started')) {
        await reapFixture(value.pid);
      }
  }
}

async function reapFixture(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  await poll(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === 'ESRCH') return true;
        throw error;
      }
    },
    5000,
    'Owned MCP fixture did not join after cleanup',
  );
}
