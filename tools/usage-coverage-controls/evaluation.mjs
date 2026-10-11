/** Called from source bodies; the exact native-test loader helper is preparation, not product runtime. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

export function recordEvaluation(metadata) {
  const control = JSON.parse(readFileSync(process.env.RELAVIUM_USAGE_RUNTIME, 'utf8'));
  const path = realpathSync(metadata.physicalPath);
  const bytes = readFileSync(path);
  assert.equal(path, metadata.physicalPath, 'USAGE_EVALUATION_PATH_CHANGED');
  assert.equal(bytes.length, metadata.bytes, 'USAGE_EVALUATION_SIZE_CHANGED');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    metadata.rawSha256,
    'USAGE_EVALUATION_SHA_CHANGED',
  );
  assert.equal(
    metadata.manifestSha256,
    control.manifestSha256,
    'USAGE_EVALUATION_MANIFEST_CHANGED',
  );
  const loaderPreparation =
    metadata.relativePath === 'apps/cli/src/engine/fixtures/ts-resolve-hook.mjs' && threadId !== 0;
  appendFileSync(
    join(
      control.evaluationDirectory,
      `${process.pid}-${threadId}${loaderPreparation ? '.loader-preparation' : ''}.jsonl`,
    ),
    `${JSON.stringify({
      ...metadata,
      stage: loaderPreparation ? 'loader-helper-body-entry' : 'module-body-entry',
      pid: process.pid,
      ppid: process.ppid,
      threadId,
    })}\n`,
  );
}
