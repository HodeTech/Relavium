/** Join raw runtime witnesses to native worker closure and exact captured source manifests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function auditRequiredEvaluations(owned, processes) {
  const context = JSON.parse(readFileSync(join(owned, 'evaluation-context.json'), 'utf8'));
  const runtime = JSON.parse(readFileSync(join(owned, 'dependency-runtime.json'), 'utf8'));
  const toolFiles = new Map(
    runtime.files.filter((file) => file.workerTool).map((file) => [join(owned, file.path), file]),
  );
  const modes = new Map();
  for (const mode of ['producer', 'frozen']) {
    const path = join(
      owned,
      mode === 'producer' ? 'producer-source-manifest.json' : 'frozen/source-manifest.json',
    );
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const supplement =
      mode === 'frozen'
        ? JSON.parse(readFileSync(join(owned, 'session-source-supplement.json'), 'utf8')).files
        : [];
    modes.set(
      mode,
      new Map(
        [...(manifest.files ?? manifest), ...supplement].map((file) => [
          join(owned, mode, file.path),
          file,
        ]),
      ),
    );
  }
  const witnesses = [];
  for (const child of processes) {
    const path = join(context.directory, `${child.pid}.ndjson`);
    const records = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(records.length > 0);
    for (const record of records) {
      assert.equal(record.phase, 'module-body-entry');
      assert.equal(record.pid, child.pid);
      assert.equal(record.ppid, process.pid);
      assert.equal(record.threadId, 0, 'Loader thread is not product module execution');
      assert.equal(record.executionPhase, context.phase);
      assert.equal(record.mutationId, context.mutationId);
      assert.equal(
        record.sourceMode,
        record.sourceMode === 'worker-tool' ? 'worker-tool' : child.source,
      );
      const file = (record.sourceMode === 'worker-tool' ? toolFiles : modes.get(child.source)).get(
        record.physicalPath,
      );
      assert.ok(file, 'Evaluated source outside exact captured mode');
      assert.equal(record.rawSha256, file.sha256);
      assert.equal(record.bytes, file.bytes ?? file.size);
      assert.equal(digest(readFileSync(record.physicalPath)), file.sha256);
    }
    assert.ok(
      records.some(
        (record) =>
          record.sourceMode === 'worker-tool' &&
          record.relativePath === basename(child.command.at(-1)),
      ),
    );
    const required =
      child.stage === 'session-old'
        ? ['packages/db/src/session-store.ts']
        : child.stage.startsWith('session-')
          ? ['packages/db/src/index.ts', 'packages/db/src/session-usage-write.ts']
          : ['packages/core/src/engine/engine.ts'];
    if (child.stage === 'predecessor')
      required.push(
        'packages/db/src/run-history-store.ts',
        'apps/cli/src/engine/checkpointer.ts',
        'packages/shared/src/terminal-safe.ts',
      );
    if (child.stage === 'producer')
      required.push(
        'packages/shared/src/relavium-error.ts',
        'packages/shared/src/fs-root-limits.ts',
        'packages/shared/src/terminal-safe.ts',
        'packages/llm/src/scrub-secrets.ts',
        'packages/core/src/tools/dispatch-error.ts',
      );
    for (const target of required)
      assert.ok(
        records.some(
          (record) => record.sourceMode === child.source && record.relativePath === target,
        ),
        `Missing module-body runtime witness: ${child.stage}/${target}`,
      );
    witnesses.push({
      stage: child.stage,
      pid: child.pid,
      source: child.source,
      path,
      sha256: digest(readFileSync(path)),
      records: records.length,
      required,
    });
  }
  for (const files of modes.values())
    for (const [path, file] of files) {
      const bytes = readFileSync(path);
      assert.equal(bytes.length, file.bytes ?? file.size);
      assert.equal(digest(bytes), file.sha256);
    }
  for (const file of runtime.files) {
    const bytes = readFileSync(join(owned, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(digest(bytes), file.sha256);
  }
  const result = { completed: true, processes: witnesses, sourceAndDependencyBytesUnchanged: true };
  writeFileSync(join(owned, 'evaluation-inventory.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
