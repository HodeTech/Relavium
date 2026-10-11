/** Execute the actual old reader/engine before asserting the new ordinary-gate barrier. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers';
import * as shared from '@relavium/shared';
import * as core from '@relavium/core';
import { createHistoryCheckpointer } from './frozen/apps/cli/src/engine/checkpointer.ts';
import { UnreadableRunEventLogError } from './frozen/packages/db/src/run-history-store.ts';
import { setup, observedEngine, ordinaryGatePositiveControl } from './predecessor.mjs';
import { root, record, digest } from './producer-common.mjs';

const capture = JSON.parse(
  readFileSync(resolve(root, 'results/ordinary-gate-producer.json'), 'utf8'),
).cases[0];
const bytes = readFileSync(resolve(root, capture.path));
assert.equal(digest(bytes), capture.sha256);
const lines = bytes.toString('utf8').trim().split('\n');
const raw = lines.map((line) => JSON.parse(line));
const workflow = core.parseWorkflow(readFileSync(resolve(root, capture.workflowPath), 'utf8'));
const fixture = await setup('bounded-current-ordinary-gate', lines, workflow);
const outcome = {
  capture,
  parserUnknownSequences: raw
    .filter((event) => shared.parseStoredRunEvent(event) === undefined)
    .map((event) => event.sequenceNumber),
};
const refusal = (error) => {
  if (!(error instanceof UnreadableRunEventLogError)) throw error;
  return {
    name: error.name,
    code: error.code,
    skippedSequenceNumbers: error.skippedSequenceNumbers,
  };
};
try {
  const { store, runId, client } = fixture;
  outcome.display = store.loadRunEventLog(runId);
  try {
    outcome.strictRead = {
      status: 'fulfilled',
      rows: store.loadRunEventLogForReplay(runId).length,
    };
  } catch (error) {
    outcome.strictRead = { status: 'refused', error: refusal(error) };
  }
  try {
    await createHistoryCheckpointer(store).load(runId);
    outcome.checkpoint = { status: 'fulfilled' };
  } catch (error) {
    outcome.checkpoint = { status: 'refused', error: refusal(error) };
  }
  const observed = observedEngine(fixture);
  const before = client.sqlite.prepare('SELECT payload_json FROM run_events ORDER BY seq').all();
  try {
    const handle = await observed.engine.resumeFromCheckpoint({
      runId,
      workflow,
      gateId: capture.gateId,
      decision: { decision: 'approved', decidedBy: 'bounded-predecessor' },
    });
    const events = [];
    for await (const event of handle.events) events.push(event);
    outcome.engine = { status: 'resumed', events };
  } catch (error) {
    outcome.engine = { status: 'refused', error: refusal(error) };
  }
  for (let i = 0; i < 8 && store.leases.read(runId) !== undefined; i += 1)
    await new Promise((done) => setImmediate(done));
  outcome.calls = { ...observed.calls };
  outcome.sequence = observed.sequence;
  outcome.leaseTrace = observed.leaseTrace;
  outcome.leaseAfter = store.leases.read(runId) ?? null;
  outcome.rawRowsPreserved =
    JSON.stringify(
      client.sqlite.prepare('SELECT payload_json FROM run_events ORDER BY seq').all(),
    ) === JSON.stringify(before);
  outcome.databaseClosed = true;
} finally {
  fixture.client.sqlite.close();
}
// Preserve actual behavior before either the expected refusal or producer basis count can fail.
record('results/ordinary-gate-observed.json', outcome);
const positive = await ordinaryGatePositiveControl();
const assertions = {
  parserRefusesNewBasis: outcome.parserUnknownSequences.length === 1,
  strictReadRefused: outcome.strictRead.status === 'refused',
  checkpointRefused: outcome.checkpoint.status === 'refused',
  engineRefused: outcome.engine.status === 'refused',
  exactLeaseReleased:
    outcome.leaseAfter === null &&
    outcome.leaseTrace.length === 2 &&
    JSON.stringify(outcome.leaseTrace[0].lease) === JSON.stringify(outcome.leaseTrace[1].lease),
  noSchedulingOrEgress: [
    'execute',
    'providerResolve',
    'keyResolve',
    'providerCall',
    'timerArm',
    'abortCreate',
    'persist',
    'effectRead',
  ].every((name) => outcome.calls[name] === 0),
  rawRowsPreserved: outcome.rawRowsPreserved,
};
const passed = Object.values(assertions).every(Boolean);
record('results/ordinary-gate-predecessor.json', {
  completed: true,
  cases: [
    {
      id: 'current-ordinary-gate-refusal',
      status: passed ? 'passed' : 'failed',
      assertions,
      observation: outcome,
      ...(passed ? {} : { failure: 'USAGE_OWNER_BASIS_REPLAY_NOT_REFUSED' }),
    },
    {
      id: 'actual-ordinary-legacy-gate-positive-control',
      status: 'passed',
      assertions: {
        actualFrozenProducer: true,
        resumedToCompletion: positive.events.at(-1).type === 'run:completed',
        noProviderEgress: positive.calls.providerCall === 0,
      },
      observation: positive,
    },
  ],
});
assert.ok(passed, 'USAGE_OWNER_BASIS_REPLAY_NOT_REFUSED');
