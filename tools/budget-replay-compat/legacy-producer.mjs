import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, workflow, root, record, digest } from './producer-common.mjs';
let fetches = 0;
globalThis.fetch = () => {
  fetches += 1;
  throw new Error('Network forbidden');
};
const run = fixture('legacy-paused', { suppressCapture: true });
const handle = run.engine.start({ workflow });
const drained = run.drain(handle);
await run.paused.promise;
const pausedRows = [...run.rows];
const bytes = `${pausedRows.join('\n')}\n`;
const raw = pausedRows.map((row) => JSON.parse(row));
assert.equal(
  raw.some((e) => e.type === 'budget:authorization'),
  false,
);
const budget = raw.find((e) => e.type === 'budget:paused');
assert.ok(budget);
assert.equal(run.counters.keyResolve, 0);
assert.equal(run.counters.providerCall, 0);
writeFileSync(resolve(root, 'raw/legacy-paused.ndjson'), bytes);
record('raw/workflow.json', workflow);
record('results/legacy-producer.json', {
  sourceCommit: '1b3f8d70c05c9152043dcc476eaa1afaaa87381d',
  rawPath: 'raw/legacy-paused.ndjson',
  sha256: digest(bytes),
  bytes: Buffer.byteLength(bytes),
  rows: raw.length,
  runId: handle.runId,
  gateId: budget.gateId,
  workflowPath: 'raw/workflow.json',
  attribution:
    'Actual frozen pre-W7 WorkflowEngine + createAgentNodeExecutor budget pause with deterministic in-memory host; no handcrafted event.',
  counters: run.counters,
});
handle.cancel();
await drained;
await run.finish();
assert.equal(fetches, 0);
console.log(
  JSON.stringify({
    completed: true,
    legacyRows: raw.length,
    gateId: budget.gateId,
    providerCalls: 0,
    keyResolutions: 0,
    fetches,
  }),
);
