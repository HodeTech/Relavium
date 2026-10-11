/** A loader trace is preparation; this synchronous call executes in the tested module body. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function recordEvaluation(metadata) {
  const path = realpathSync(metadata.physicalPath);
  assert.equal(path, metadata.physicalPath, 'Evaluated source must retain physical ownership');
  const bytes = readFileSync(path);
  assert.equal(bytes.length, metadata.bytes, 'Evaluated source byte count changed');
  assert.equal(digest(bytes), metadata.rawSha256, 'Evaluated source digest changed');
  assert.equal(digest(readFileSync(metadata.manifestPath)), metadata.manifestSha256);
  if (metadata.supplementManifestPath)
    assert.equal(
      digest(readFileSync(metadata.supplementManifestPath)),
      metadata.supplementManifestSha256,
    );
  appendFileSync(
    join(metadata.directory, `${process.pid}.ndjson`),
    `${JSON.stringify({ ...metadata, phase: 'module-body-entry', executionPhase: metadata.executionPhase, pid: process.pid, ppid: process.ppid, threadId })}\n`,
  );
}
