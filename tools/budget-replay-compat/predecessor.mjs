import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as shared from '@relavium/shared';
import * as core from '@relavium/core';
import { root, epochMs, record, digest, deferred } from './producer-common.mjs';
import { createClient, runMigrations } from './frozen/packages/db/src/client.ts';
import {
  createRunHistoryStore,
  createRunLeasePort,
  UnreadableRunEventLogError,
} from './frozen/packages/db/src/run-history-store.ts';
import { createHistoryCheckpointer } from './frozen/apps/cli/src/engine/checkpointer.ts';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const errorJson = (e) => ({
  name: e.name,
  code: e.code,
  message: e.message,
  skippedSequenceNumbers: e.skippedSequenceNumbers,
});
let fetches = 0;
globalThis.fetch = () => {
  fetches += 1;
  throw new Error('Network forbidden');
};

async function setup(label, rawLines, workflow) {
  const client = createClient(
    resolve(root, `databases/${process.env.COMPAT_LABEL}-${label}.sqlite`),
  );
  try {
    runMigrations(client.db, { dbPath: client.path });
    let next = 0;
    const store = createRunHistoryStore(client.db, {
      uuid: () => uuid(++next),
      now: () => epochMs,
      workflow: {
        slug: workflow.workflow.id,
        name: workflow.workflow.name ?? workflow.workflow.id,
        definitionJson: JSON.stringify(workflow),
      },
      projectRoot: root,
    });
    const raw = rawLines.map((line) => JSON.parse(line));
    const runId = raw[0].runId;
    const workflowId = await store.resolveWorkflowId(workflow.workflow.id);
    assert.equal(workflowId, raw[0].workflowId);
    // Seed the known run projection using the actual old writer, then retain exact producer bytes.
    await store.persistEvent(raw[0], { expectedLastSequenceNumber: -1 });
    client.sqlite
      .prepare('UPDATE run_events SET payload_json=? WHERE run_id=? AND seq=?')
      .run(rawLines[0], runId, raw[0].sequenceNumber);
    for (let i = 1; i < raw.length; i += 1)
      client.sqlite
        .prepare(
          'INSERT INTO run_events (id,run_id,seq,event_type,payload_json,ts) VALUES (?,?,?,?,?,?)',
        )
        .run(
          uuid(++next),
          runId,
          raw[i].sequenceNumber,
          raw[i].type,
          rawLines[i],
          Date.parse(raw[i].timestamp),
        );
    assert.deepEqual(
      client.sqlite
        .prepare('SELECT payload_json FROM run_events WHERE run_id=? ORDER BY seq')
        .all(runId)
        .map((row) => row.payload_json),
      rawLines,
    );
    return { client, store, runId, raw, workflow, label };
  } catch (error) {
    client.sqlite.close();
    throw error;
  }
}

function observedEngine({ store }) {
  const calls = {
    acquire: 0,
    release: 0,
    strictRead: 0,
    checkpointLoad: 0,
    storeResolve: 0,
    storeSnapshot: 0,
    persist: 0,
    timerArm: 0,
    abortCreate: 0,
    execute: 0,
    providerResolve: 0,
    keyResolve: 0,
    providerCall: 0,
    effectRead: 0,
  };
  const sequence = [];
  const leaseTrace = [];
  const mark = (name) => {
    calls[name] += 1;
    sequence.push(name);
  };
  const leases = createRunLeasePort(store);
  const runLeases = {
    acquire: async (...args) => {
      mark('acquire');
      const lease = await leases.acquire(...args);
      leaseTrace.push({ operation: 'acquired', runId: args[0], lease });
      return lease;
    },
    release: async (...args) => {
      mark('release');
      leaseTrace.push({ operation: 'release', runId: args[0], lease: args[1] });
      await leases.release(...args);
    },
    heartbeat: leases.heartbeat,
    read: leases.read,
  };
  const strictStore = {
    ...store,
    loadRunEventLogForReplay: (id) => {
      mark('strictRead');
      assert.ok(store.leases.read(id), 'strict read must have acquired lease');
      return store.loadRunEventLogForReplay(id);
    },
  };
  const realCheckpointer = createHistoryCheckpointer(strictStore);
  const checkpointer = {
    load: async (id) => {
      mark('checkpointLoad');
      return realCheckpointer.load(id);
    },
  };
  const observedStore = {
    ...store,
    resolveWorkflowId: (...args) => {
      mark('storeResolve');
      return store.resolveWorkflowId(...args);
    },
    readWorkflowSnapshot: (...args) => {
      mark('storeSnapshot');
      return store.readWorkflowSnapshot(...args);
    },
    persistEvent: (...args) => {
      mark('persist');
      return store.persistEvent(...args);
    },
  };
  const base = core.createInMemoryHost({
    store: observedStore,
    checkpointer,
    runLeases,
    baseEpochMs: epochMs,
  });
  const host = {
    ...base,
    newAbortController: () => {
      mark('abortCreate');
      return base.newAbortController();
    },
    setTimer: (...args) => {
      mark('timerArm');
      return base.setTimer(...args);
    },
  };
  const provider = {
    id: 'openai',
    generate: () => {
      mark('providerCall');
      throw new Error('Offline provider forbidden');
    },
    stream: () => {
      mark('providerCall');
      throw new Error('Offline provider forbidden');
    },
  };
  const agent = core.createAgentNodeExecutor({
    registry: core.createToolRegistry({ tools: [], host: {} }),
    tools: [],
    resolveProvider: () => {
      mark('providerResolve');
      return provider;
    },
    keyFor: () => {
      mark('keyResolve');
      throw new Error('Offline key forbidden');
    },
    sleep: async () => undefined,
  });
  const dispatcher = core.createDispatchingNodeExecutor({
    agent,
    output: core.createOutputNodeExecutor(),
    human_in_the_loop: core.createHumanGateNodeExecutor(),
  });
  const executor = {
    execute: (ctx) => {
      mark('execute');
      return dispatcher.execute(ctx);
    },
  };
  const engine = new core.WorkflowEngine({
    host,
    executor,
    effectResume: {
      unresolvedForRun: async () => {
        mark('effectRead');
        return [];
      },
      markNeedsAttention: async () => undefined,
    },
  });
  return { engine, host, calls, sequence, leaseTrace };
}

async function checkPrefix(capture) {
  const bytes = readFileSync(resolve(root, capture.path));
  assert.equal(digest(bytes), capture.sha256);
  const lines = bytes.toString('utf8').trim().split('\n');
  const workflow = core.parseWorkflow(readFileSync(resolve(root, capture.workflowPath), 'utf8'));
  const fixture = await setup(`${capture.label}-${capture.cut}`, lines, workflow);
  try {
    const { client, store, runId, raw } = fixture;
    const unknown = raw.filter((e) => e.type === 'budget:authorization');
    assert.ok(unknown.length > 0);
    for (const event of unknown) assert.equal(shared.parseStoredRunEvent(event), undefined);
    const display = store.loadRunEventLog(runId);
    const skipped = unknown.map((e) => ({ sequenceNumber: e.sequenceNumber, type: e.type }));
    assert.deepEqual(display.skipped, skipped);
    assert.deepEqual(
      display.events.map((e) => e.sequenceNumber),
      raw.filter((e) => e.type !== 'budget:authorization').map((e) => e.sequenceNumber),
    );
    const directParsed = raw
      .map((e) => shared.parseStoredRunEvent(e))
      .filter((e) => e !== undefined);
    assert.deepEqual(display.events, directParsed);
    let strictError;
    let checkpointError;
    let engineError;
    assert.throws(
      () => store.loadRunEventLogForReplay(runId),
      (e) => {
        strictError = errorJson(e);
        return e instanceof UnreadableRunEventLogError && e.code === 'unreadable_run_event_log';
      },
    );
    await assert.rejects(createHistoryCheckpointer(store).load(runId), (e) => {
      checkpointError = errorJson(e);
      return e instanceof UnreadableRunEventLogError;
    });
    const observed = observedEngine(fixture);
    const gateId = capture.gateId ?? raw.find((e) => e.type === 'budget:authorization').gateId;
    const input = {
      runId,
      workflow,
      gateId,
      decision: { decision: capture.decision ?? 'approved', decidedBy: 'offline-predecessor' },
    };
    const before = client.sqlite.prepare('SELECT payload_json FROM run_events ORDER BY seq').all();
    await assert.rejects(observed.engine.resumeFromCheckpoint(input), (e) => {
      engineError = errorJson(e);
      return e instanceof UnreadableRunEventLogError;
    });
    const callsAtRefusal = { ...observed.calls };
    assert.deepEqual(observed.sequence, ['acquire', 'checkpointLoad', 'strictRead', 'release']);
    assert.deepEqual(observed.leaseTrace[0].lease, observed.leaseTrace[1].lease);
    assert.ok(observed.leaseTrace[0].lease);
    assert.equal(store.leases.read(runId), undefined);
    for (const name of [
      'storeResolve',
      'storeSnapshot',
      'persist',
      'timerArm',
      'abortCreate',
      'execute',
      'providerResolve',
      'keyResolve',
      'providerCall',
      'effectRead',
    ])
      assert.equal(observed.calls[name], 0);
    assert.equal(observed.host.armedCount(), 0);
    assert.equal(observed.host.livenessCount(), 0);
    assert.equal(observed.host.deadlineCount(), 0);
    await assert.rejects(
      observed.engine.resume(runId, gateId, { decision: 'approved', decidedBy: 'offline' }),
      (e) => e instanceof core.EngineStateError && e.code === 'unknown_run',
    );
    assert.throws(
      () => observed.engine.cancel(runId),
      (e) => e instanceof core.EngineStateError && e.code === 'unknown_run',
    );
    await assert.rejects(observed.engine.resumeFromCheckpoint(input), UnreadableRunEventLogError);
    assert.deepEqual(observed.sequence, [
      'acquire',
      'checkpointLoad',
      'strictRead',
      'release',
      'acquire',
      'checkpointLoad',
      'strictRead',
      'release',
    ]);
    assert.equal(store.leases.read(runId), undefined);
    assert.deepEqual(
      client.sqlite.prepare('SELECT payload_json FROM run_events ORDER BY seq').all(),
      before,
    );
    // Historical display-only observation. This tolerant fold is never handed to engine replay.
    const historicalDisplayFold = core.reconstructCheckpointState(display.events);
    return {
      capture,
      parserReturnedUndefined: unknown.map((e) => e.sequenceNumber),
      display: {
        knownEvents: display.events.map((e) => ({
          type: e.type,
          sequenceNumber: e.sequenceNumber,
        })),
        skipped,
        historicalOnlyAgentFold: historicalDisplayFold?.nodeStates.get('agent'),
      },
      strictError,
      checkpointError,
      engineError,
      callsAtRefusal,
      sequence: observed.sequence,
      leaseTrace: observed.leaseTrace,
      publicRegistrationProbe: 'resume and cancel both unknown_run',
      leaseAfterRefusal: null,
      rawRowsPreserved: true,
      databaseClosed: true,
    };
  } finally {
    fixture.client.sqlite.close();
  }
}

async function legacyBudgetPositiveControl() {
  const lines = readFileSync(resolve(root, 'raw/legacy-paused.ndjson'), 'utf8').trim().split('\n');
  const workflow = core.parseWorkflow(readFileSync(resolve(root, 'raw/workflow.json'), 'utf8'));
  const fixture = await setup('positive-legacy-budget-reject', lines, workflow);
  try {
    const { store, runId, raw } = fixture;
    assert.deepEqual(store.loadRunEventLog(runId).skipped, []);
    assert.equal(store.loadRunEventLogForReplay(runId).length, raw.length);
    const observed = observedEngine(fixture);
    const handle = await observed.engine.resumeFromCheckpoint({
      runId,
      workflow,
      gateId: raw.find((e) => e.type === 'budget:paused').gateId,
      decision: { decision: 'rejected', decidedBy: 'legacy-positive' },
    });
    const events = [];
    for await (const event of handle.events) events.push(event);
    assert.equal(events.at(-1).type, 'run:failed');
    assert.equal(events.at(-1).error.code, 'budget_exceeded');
    assert.ok(observed.calls.abortCreate > 0);
    assert.ok(observed.calls.timerArm > 0);
    assert.ok(observed.calls.persist > 0);
    for (let i = 0; i < 8 && store.leases.read(runId) !== undefined; i += 1)
      await new Promise((done) => setImmediate(done));
    assert.equal(store.leases.read(runId), undefined);
    assert.equal(observed.calls.keyResolve, 0);
    assert.equal(observed.calls.providerCall, 0);
    return {
      label: 'actual-legacy-budget-rejection-positive-control',
      skipped: [],
      events,
      calls: observed.calls,
      leaseAfterCompletion: null,
      databaseClosed: true,
    };
  } finally {
    fixture.client.sqlite.close();
  }
}

async function ordinaryGatePositiveControl() {
  const workflow = core.parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'ordinary-positive',
        nodes: [
          {
            id: 'gate',
            type: 'human_gate',
            gate_type: 'approval',
            message_template: 'offline ordinary control',
          },
          { id: 'out', type: 'output' },
        ],
        edges: [{ from: 'gate', to: 'out' }],
      },
    }),
  );
  const store = new core.InMemoryRunStore();
  const host = core.createInMemoryHost({ store, baseEpochMs: epochMs });
  const dispatcher = core.createDispatchingNodeExecutor({
    human_in_the_loop: core.createHumanGateNodeExecutor(),
    output: core.createOutputNodeExecutor(),
  });
  const engine = new core.WorkflowEngine({ host, executor: dispatcher });
  const paused = deferred();
  const handle = engine.start({ workflow });
  const drained = (async () => {
    for await (const event of handle.events) if (event.type === 'run:paused') paused.resolve();
  })();
  await paused.promise;
  const raw = store.eventsFor(handle.runId);
  const lines = raw.map((e) => JSON.stringify(e));
  writeFileSync(resolve(root, 'raw/ordinary-legacy-gate.ndjson'), `${lines.join('\n')}\n`);
  record('raw/ordinary-workflow.json', workflow);
  handle.cancel();
  await drained;
  const fixture = await setup('positive-ordinary-gate', lines, workflow);
  try {
    const observed = observedEngine(fixture);
    const resumed = await observed.engine.resumeFromCheckpoint({
      runId: fixture.runId,
      workflow,
      gateId: raw.find((e) => e.type === 'human_gate:paused').gateId,
      decision: { decision: 'approved', decidedBy: 'ordinary-positive' },
    });
    const events = [];
    for await (const event of resumed.events) events.push(event);
    assert.equal(events.at(-1).type, 'run:completed');
    assert.equal(observed.calls.execute, 1);
    assert.ok(observed.calls.abortCreate > 0);
    assert.ok(observed.calls.timerArm > 0);
    for (let i = 0; i < 8 && fixture.store.leases.read(fixture.runId) !== undefined; i += 1)
      await new Promise((done) => setImmediate(done));
    assert.equal(fixture.store.leases.read(fixture.runId), undefined);
    assert.equal(observed.calls.keyResolve, 0);
    assert.equal(observed.calls.providerCall, 0);
    return {
      label: 'actual-ordinary-legacy-gate-positive-control',
      rawPath: 'raw/ordinary-legacy-gate.ndjson',
      skipped: [],
      events,
      calls: observed.calls,
      leaseAfterCompletion: null,
      databaseClosed: true,
    };
  } finally {
    fixture.client.sqlite.close();
  }
}

const result = {
  baselineCommit: '1b3f8d70c05c9152043dcc476eaa1afaaa87381d',
  producerVersion: JSON.parse(readFileSync(resolve(root, 'producer-version.json'), 'utf8')),
  cases: [],
  controls: [],
  completed: false,
};
try {
  const captures = JSON.parse(
    readFileSync(resolve(root, 'results/producer-cases.json'), 'utf8'),
  ).cases;
  for (const capture of captures) result.cases.push(await checkPrefix(capture));
  result.controls.push(await legacyBudgetPositiveControl());
  result.controls.push(await ordinaryGatePositiveControl());
  assert.equal(fetches, 0);
  result.fetches = fetches;
  result.completed = true;
  record('results/predecessor-evidence.json', result);
  console.log(
    JSON.stringify({
      completed: true,
      strictRefusals: result.cases.length,
      positiveControls: result.controls.length,
      fetches,
    }),
  );
} catch (error) {
  result.failure = { ...errorJson(error), stack: error.stack };
  record(`results/${process.env.COMPAT_LABEL}-failed.json`, result);
  throw error;
}
