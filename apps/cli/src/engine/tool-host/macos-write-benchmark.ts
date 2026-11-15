/** Contributor-only controlled APFS host benchmark; never a model capability. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BUILTIN_TOOLS, createInMemoryEffectJournal, createToolRegistry } from '@relavium/core';
import { createNodeFsCapability } from './fs.js';
import { ApprovalCache, buildTurnPolicy, governedToolIds } from '../../chat/chat-mode.js';

assert.equal(process.platform, 'darwin');
const label = process.argv[2];
assert.ok(label === 'baseline' || label === 'corrected');
const root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-adr127-bench-')));
await chmod(root, 0o700);
const home = join(root, 'home');
await mkdir(home, { mode: 0o700 });
const before = `${'a'.repeat(64 * 1024 - 16)}old-marker\n`;
const after = before.replace('old-marker', 'new-marker');
const host = createNodeFsCapability({
  tier: 'sandboxed',
  workspaceDir: root,
  operatorHomeDir: home,
  readOnly: false,
});
const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: { fs: host } });
const policy = buildTurnPolicy('auto', {
  governed: governedToolIds(BUILTIN_TOOLS),
  cache: new ApprovalCache(),
  prompt: () => Promise.reject(new Error('benchmark unexpectedly requested interactive approval')),
});
assert.ok(policy.confirm);
const attributes =
  'import ctypes,os,sys\nl=ctypes.CDLL(None,use_errno=True)\nl.setxattr.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_size_t,ctypes.c_uint32,ctypes.c_int]\nfor i in range(64):\n r=l.setxattr(os.fsencode(sys.argv[1]),f"user.relavium.bench{i}".encode(),b"synthetic-value",15,0,0)\n assert r==0,ctypes.get_errno()';
const results = [];
let completed = false;
try {
  for (const cohort of ['ordinary', 'dense'] as const) {
    const parent = join(root, cohort);
    await mkdir(parent, { mode: 0o700 });
    const path = join(parent, 'target');
    if (cohort === 'dense') {
      execFileSync('python3', ['-c', attributes, parent]);
    }
    for (const operation of ['create', 'overwrite', 'append', 'edit'] as const) {
      const samples: number[] = [];
      let successes = 0;
      let failures = 0;
      for (let attempt = 0; attempt < 110; attempt++) {
        if (operation === 'create') await rm(path, { force: true });
        else {
          await writeFile(path, before, { mode: 0o600 });
          if (cohort === 'dense' && attempt === 0) {
            execFileSync('python3', ['-c', attributes, path]);
          }
        }
        const effects = createInMemoryEffectJournal({
          kind: 'run',
          runId: `${cohort}-${operation}-${attempt}`,
          nodeId: 'n',
          attempt: 1,
        });
        const context = {
          nodeId: 'n',
          grantedToolIds: new Set(['read_file', 'write_file', 'edit_file']),
          config: {},
          toolPolicy: {},
          fsScope: 'sandboxed' as const,
          gateApproved: false,
          effectSlot: 0,
          effectAttempt: { providerAttempt: 1, toolCallId: 'call' },
          effects,
          readScope: {},
          limits: { maxBytes: 128 * 1024, maxLines: 2000 },
          approval: { confirm: policy.confirm },
        };
        const started = performance.now();
        try {
          if (operation !== 'create') {
            await registry.dispatch(
              { type: 'tool_call', id: 'read', name: 'read_file', args: { path } },
              context,
            );
            host.promoteReadScope?.(context.readScope);
          }
          const expected = operation === 'append' ? `${before}é🙂` : after;
          const call =
            operation === 'edit'
              ? {
                  type: 'tool_call' as const,
                  id: 'write',
                  name: 'edit_file',
                  args: { path, old_string: 'old-marker', new_string: 'new-marker' },
                }
              : {
                  type: 'tool_call' as const,
                  id: 'write',
                  name: 'write_file',
                  args: {
                    path,
                    content: operation === 'append' ? 'é🙂' : after,
                    append: operation === 'append',
                  },
                };
          await registry.dispatch(call, context);
          const elapsed = performance.now() - started;
          assert.equal(await readFile(path, 'utf8'), expected);
          assert.equal(effects.rows().length, 1);
          assert.equal(effects.rows()[0]?.state, 'committed');
          if (attempt >= 10) {
            samples.push(elapsed);
            successes++;
          }
        } catch (error) {
          failures++;
          // Fail loudly, without forwarding raw native errors or metadata.
          process.stderr.write(`benchmark failed: ${label}/${cohort}/${operation}/${attempt}\n`);
          throw error;
        }
      }
      samples.sort((a, b) => a - b);
      results.push({
        cohort,
        operation,
        warmup: 10,
        attempts: 100,
        successes,
        failures,
        p50Ms: samples[Math.ceil(samples.length * 0.5) - 1],
        p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
        reviewedBytes: Buffer.byteLength(operation === 'append' ? `${before}é🙂` : after),
        denseCreate:
          operation === 'create' && cohort === 'dense'
            ? '64 parent attributes; OS-created file policy'
            : undefined,
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ label, sourceScope: 'production auto policy/host/registry; in-memory effect journal; warm nearest-rank; 64KiB-class UTF-8; sequential', results })}\n`,
  );
  completed = true;
} finally {
  if (completed) await rm(root, { recursive: true });
  else process.stderr.write(`Benchmark fixture retained for inspection: ${root}\n`);
}
