import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, workflow, root, record } from './producer-common.mjs';
import { RunEventSchema } from '@relavium/shared';
import { reconstructCheckpointState } from '@relavium/core';
import { createClient, runMigrations, createRunHistoryStore } from '@relavium/db';
let fetches = 0;
globalThis.fetch = () => {
  fetches += 1;
  throw new Error('Network forbidden');
};
const cases = [];
// Current checkpoint, admitted engine and both strict discovery stores must read the ACTUAL predecessor
// input decision as rejection. The source archive/producer are unchanged; no synthetic decision row.
const historicalLines = readFileSync(resolve(root, 'raw/legacy-input.ndjson'), 'utf8')
  .trim()
  .split('\n');
const historical = historicalLines.map((line) => RunEventSchema.parse(JSON.parse(line)));
const historicalGate = historical.find((event) => event.type === 'budget:paused');
assert.ok(historicalGate);
const checkpoint = reconstructCheckpointState(historical);
assert.deepEqual(checkpoint.budgetRejections, [
  { nodeId: historicalGate.nodeId, gateId: historicalGate.gateId },
]);
assert.equal(checkpoint.nodeStates.get(historicalGate.nodeId).error.code, 'budget_exceeded');
assert.equal(checkpoint.nodeStates.get(historicalGate.nodeId).output, undefined);
const historicalRun = fixture('historical-input-current', {
  initial: historical,
  suppressCapture: true,
});
for (const event of historical) await historicalRun.store.persistEvent(event);
const discovery = await historicalRun.store.listInterruptedRuns();
assert.equal(discovery.length, 1);
assert.equal(discovery[0].resumable, false);
const historicalHandle = await historicalRun.engine.resumeFromCheckpoint({
  runId: historical[0].runId,
  workflow,
  gateId: historicalGate.gateId,
  decision: { decision: 'rejected', decidedBy: 'offline-compat' },
});
await historicalRun.drain(historicalHandle);
assert.equal(historicalRun.publicEvents.at(-1).type, 'run:failed');
assert.equal(historicalRun.publicEvents.at(-1).error.code, 'budget_exceeded');
await historicalRun.finish();
const historicalClient = createClient(resolve(root, 'databases/historical-input-current.sqlite'));
try {
  runMigrations(historicalClient.db, { dbPath: historicalClient.path });
  let nextId = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;
  const store = createRunHistoryStore(historicalClient.db, {
    uuid,
    now: () => Date.parse(historical[0].timestamp),
    workflow: {
      slug: workflow.workflow.id,
      name: workflow.workflow.id,
      definitionJson: JSON.stringify(workflow),
    },
  });
  assert.equal(await store.resolveWorkflowId(workflow.workflow.id), historical[0].workflowId);
  await store.persistEvent(historical[0]);
  historicalClient.sqlite
    .prepare('UPDATE run_events SET payload_json=? WHERE run_id=? AND seq=?')
    .run(historicalLines[0], historical[0].runId, historical[0].sequenceNumber);
  for (let i = 1; i < historical.length; i += 1) {
    const event = historical[i];
    historicalClient.sqlite
      .prepare(
        'INSERT INTO run_events (id,run_id,seq,event_type,payload_json,ts) VALUES (?,?,?,?,?,?)',
      )
      .run(
        uuid(),
        event.runId,
        event.sequenceNumber,
        event.type,
        historicalLines[i],
        Date.parse(event.timestamp),
      );
  }
  assert.deepEqual(store.loadRunEventLogForReplay(historical[0].runId), historical);
  const interrupted = await store.listInterruptedRuns();
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].resumable, false);
  assert.deepEqual(
    historicalClient.sqlite
      .prepare('SELECT payload_json FROM run_events WHERE run_id=? ORDER BY seq')
      .all(historical[0].runId)
      .map((row) => row.payload_json),
    historicalLines,
  );
} finally {
  historicalClient.sqlite.close();
}
record('results/historical-input-current.json', {
  checkpointRejected: true,
  referenceDiscovery: true,
  sqliteDiscovery: true,
  admittedResumeRejected: true,
  producerPath: 'results/legacy-input-producer.json',
  rows: historical.length,
  counters: historicalRun.counters,
});
for (const decision of [undefined, 'approved', 'rejected']) {
  const label = decision ? `native-${decision}` : 'native-pause';
  const run = fixture(label, { holdDecisionCompanion: decision !== undefined });
  const handle = run.engine.start({ workflow });
  const drained = run.drain(handle);
  await run.paused.promise;
  const authority = run.store
    .eventsFor(handle.runId)
    .find((e) => e.type === 'budget:authorization');
  assert.equal(authority.authorization.state, 'paused');
  assert.equal(authority.authorization.allowance.kind, 'frozen');
  assert.equal(authority.authorization.allowance.quote.kind, 'quoted');
  const quote = authority.authorization.allowance.quote.quote;
  assert.equal(quote.amount.kind, 'representable');
  if (decision) {
    const resumed = run.engine.resume(handle.runId, authority.gateId, {
      decision,
      decidedBy: 'offline-compat',
      ...(decision === 'approved' ? { approvedAmountMicrocents: quote.amount.microcents } : {}),
    });
    await run.held.promise;
    assert.equal(run.counters.keyResolve, 0);
    assert.equal(run.counters.providerCall, 0);
    handle.cancel();
    run.release.resolve();
    await resumed;
  } else handle.cancel();
  await drained;
  await run.finish();
  const captures = run.captures.filter((capture) =>
    decision
      ? capture.cut === 'authority-decided' || capture.cut === 'human-gate-resumed-companion'
      : true,
  );
  cases.push(
    ...captures.map((capture) => ({
      ...capture,
      workflowPath: 'raw/workflow.json',
      producerMode: 'new-native',
      decision,
    })),
  );
}
const initial = readFileSync(resolve(root, 'raw/legacy-paused.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const legacyGate = initial.find((e) => e.type === 'budget:paused');
for (const decision of ['approved', 'rejected']) {
  const label = `legacy-${decision}`;
  const run = fixture(label, { initial, holdDecisionCompanion: true });
  for (const event of initial) await run.store.persistEvent(event);
  // The real resume call awaits its companion; cancel through the registered engine while held.
  const entering = run.engine.resumeFromCheckpoint({
    runId: initial[0].runId,
    workflow,
    gateId: legacyGate.gateId,
    decision: { decision, decidedBy: 'offline-compat' },
  });
  await run.held.promise;
  const decisionAuthority = run.store
    .eventsFor(initial[0].runId)
    .find((e) => e.type === 'budget:authorization');
  assert.equal(decisionAuthority.authorization.state, 'decided');
  assert.equal(decisionAuthority.authorization.allowance.kind, 'legacy_no_allowance');
  assert.equal(run.counters.keyResolve, 0);
  assert.equal(run.counters.providerCall, 0);
  run.engine.cancel(initial[0].runId);
  run.release.resolve();
  const handle = await entering;
  const drained = run.drain(handle);
  await drained;
  await run.finish();
  cases.push(
    ...run.captures
      .filter(
        (capture) =>
          capture.cut === 'authority-decided' || capture.cut === 'human-gate-resumed-companion',
      )
      .map((capture) => ({
        ...capture,
        workflowPath: 'raw/workflow.json',
        producerMode: 'new-decision-of-actual-legacy-gate',
        legacyOriginPath: 'results/legacy-producer.json',
        decision,
      })),
  );
}
assert.equal(fetches, 0);
for (const capture of cases) {
  const events = readFileSync(resolve(root, capture.path), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(
    events.some((e) => e.type === 'node:completed'),
    false,
  );
  assert.ok(events.some((e) => e.type === 'budget:authorization'));
}
record('results/producer-cases.json', {
  producerVersionPath: 'producer-version.json',
  producerManifestPath: 'producer-source-manifest.json',
  cases,
  fetches,
  providerCalls: 0,
  keyResolutions: 0,
  acceptanceScope: 'Actual authority and companion durable prefixes only; no whole-Step10 claim.',
});
console.log(
  JSON.stringify({
    completed: true,
    prefixes: cases.length,
    fetches,
    providerCalls: 0,
    keyResolutions: 0,
  }),
);
