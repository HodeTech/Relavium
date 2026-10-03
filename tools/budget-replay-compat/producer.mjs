import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, workflow, root, record } from './producer-common.mjs';
let fetches = 0;
globalThis.fetch = () => {
  fetches += 1;
  throw new Error('Network forbidden');
};
const cases = [];
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
