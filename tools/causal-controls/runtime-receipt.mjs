/** Bounded, phase-owned completion evidence from Vitest's runner-level callback. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../usage-coverage-controls/source-graph.mjs';

export const maxRuntimeReceiptBytes = 4096;
export const runtimeReporterPath = 'tools/causal-controls/runtime-reporter.mjs';

export function readRuntimeReceipt(path) {
  const info = lstatSync(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path,
    'Runner receipt redirected',
  );
  assert.ok(info.size > 0 && info.size <= maxRuntimeReceiptBytes, 'Runner receipt byte bound');
  const bytes = readFileSync(path);
  assert.equal(bytes.length, info.size, 'Runner receipt changed while reading');
  const raw = bytes.toString('utf8');
  assert.ok(Buffer.from(raw, 'utf8').equals(bytes), 'Runner receipt UTF-8');
  return raw;
}

/** Validate identity and completion even for a refused phase retained for diagnosis. */
export function decodeRuntimeReceipt(raw, expected) {
  assert.ok(
    typeof raw === 'string' &&
      Buffer.byteLength(raw) > 0 &&
      Buffer.byteLength(raw) <= maxRuntimeReceiptBytes,
    'Missing or oversized runner receipt',
  );
  const receipt = JSON.parse(raw);
  assert.equal(
    raw,
    `${JSON.stringify(receipt)}\n`,
    'Runner receipt incomplete/noncanonical/duplicate fields',
  );
  assert.ok(
    receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt),
    'Malformed runner receipt',
  );
  assert.deepEqual(
    new Set(Object.keys(receipt)),
    new Set([
      'version',
      'event',
      'complete',
      'phase',
      'mutationId',
      'runtimeSha256',
      'reporter',
      'reporterSha256',
      'pid',
      'unhandledErrors',
      'reason',
    ]),
    'Runner receipt fields',
  );
  assert.equal(receipt.version, 1, 'Runner receipt version');
  assert.equal(receipt.event, 'onTestRunEnd', 'Runner receipt event');
  assert.equal(receipt.complete, true, 'Incomplete runner receipt');
  assert.ok(['fixed', 'mutated', 'restored'].includes(receipt.phase), 'Runner receipt phase');
  assert.equal(receipt.phase, expected.phase, 'Runner receipt wrong phase');
  assert.equal(receipt.mutationId, expected.mutationId, 'Runner receipt wrong control');
  assert.match(receipt.runtimeSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.runtimeSha256, expected.runtimeSha256, 'Runner receipt wrong runtime');
  assert.equal(receipt.reporter, runtimeReporterPath, 'Runner receipt wrong reporter');
  assert.match(receipt.reporterSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    receipt.reporterSha256,
    expected.reporterSha256,
    'Runner receipt reporter source differs',
  );
  assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0, 'Runner receipt PID');
  assert.equal(receipt.pid, expected.pid, 'Runner receipt wrong process');
  assert.ok(
    Number.isSafeInteger(receipt.unhandledErrors) && receipt.unhandledErrors >= 0,
    'Runner receipt error count',
  );
  assert.ok(['passed', 'failed', 'interrupted'].includes(receipt.reason), 'Runner receipt reason');
  return receipt;
}

export function runtimeReceiptIdentity(runtimeBytes, manifest, pid) {
  const runtime = JSON.parse(runtimeBytes.toString('utf8'));
  const reporter = manifest.files.find(({ path }) => path === runtimeReporterPath);
  assert.ok(reporter, 'Runner reporter absent from source manifest');
  assert.ok(
    runtime.infrastructure?.some(
      (entry) =>
        entry.path === join(manifest.sourceRoot, runtimeReporterPath) &&
        entry.bytes === reporter.bytes &&
        entry.sha256 === reporter.sha256,
    ),
    'Runner reporter absent from runtime infrastructure',
  );
  return {
    phase: runtime.phase,
    mutationId: runtime.mutationId,
    runtimeSha256: digest(runtimeBytes),
    reporterSha256: reporter.sha256,
    pid,
  };
}
