/** Owned reporter for the installed Vitest Reporter.onTestRunEnd API (3.2.6). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reporter = 'tools/causal-controls/runtime-reporter.mjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export default class RuntimeReporter {
  onInit() {
    this.runtimePath = process.env.RELAVIUM_USAGE_RUNTIME;
    assert.ok(this.runtimePath, 'Runner reporter runtime missing');
    const bytes = readFileSync(this.runtimePath);
    const runtime = JSON.parse(bytes.toString('utf8'));
    const manifestBytes = readFileSync(runtime.manifestPath);
    assert.equal(digest(manifestBytes), runtime.manifestSha256, 'Runner reporter manifest changed');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const pin = manifest.files.find(({ path }) => path === reporter);
    assert.ok(pin, 'Runner reporter not source-owned');
    this.sourcePath = fileURLToPath(import.meta.url);
    assert.equal(
      this.sourcePath,
      realpathSync(join(manifest.sourceRoot, reporter)),
      'Runner reporter source redirected',
    );
    const source = readFileSync(this.sourcePath);
    assert.equal(source.length, pin.bytes);
    assert.equal(digest(source), pin.sha256, 'Runner reporter source changed');
    this.identity = {
      phase: runtime.phase,
      mutationId: runtime.mutationId,
      runtimeSha256: digest(bytes),
      reporter,
      reporterSha256: pin.sha256,
      pid: process.pid,
    };
    this.receiptPath = join(dirname(this.runtimePath), 'runner-completion.receipt');
    writeFileSync(this.receiptPath, '{"complete":false}\n', { flag: 'wx' });
    this.started = false;
    this.ended = false;
  }

  onTestRunStart() {
    writeFileSync(this.receiptPath, '{"complete":false}\n');
    assert.equal(this.started, false, 'Runner reporter duplicate run');
    this.started = true;
  }

  onTestRunEnd(_testModules, unhandledErrors, reason) {
    // Invalidate first: a repeated callback or any later check/write failure cannot
    // leave an earlier successful receipt standing for a now-incomplete run.
    writeFileSync(this.receiptPath, '{"complete":false}\n');
    assert.equal(this.started, true, 'Runner reporter never started');
    assert.equal(this.ended, false, 'Runner reporter duplicate completion');
    this.ended = true;
    assert.ok(Array.isArray(unhandledErrors), 'Runner reporter errors missing');
    assert.ok(
      ['passed', 'failed', 'interrupted'].includes(reason),
      'Runner reporter reason missing',
    );
    assert.equal(
      digest(readFileSync(this.runtimePath)),
      this.identity.runtimeSha256,
      'Runner reporter runtime changed',
    );
    assert.equal(
      digest(readFileSync(this.sourcePath)),
      this.identity.reporterSha256,
      'Runner reporter source changed',
    );
    const receipt = {
      version: 1,
      event: 'onTestRunEnd',
      complete: true,
      ...this.identity,
      unhandledErrors: unhandledErrors.length,
      reason,
    };
    // The terminal write is the callback's last operation; no asynchronous tail.
    writeFileSync(this.receiptPath, `${JSON.stringify(receipt)}\n`);
  }
}
