/** Contributor-only Linux image-layer integration fixture; never shipped with the CLI. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUILTIN_TOOLS,
  createAbortController,
  createInMemoryEffectJournal,
  createToolRegistry,
} from '@relavium/core';
import { createNodeFsCapability } from './fs.js';

const root = '/relavium-native-lower';
assert.equal(process.platform, 'linux');
assert.equal(process.env['RELAVIUM_TEST_LOWER_ROOT'], root);
assert.equal((await statfs(root)).type, 0x794c7630, 'fixture must be overlayfs');
const fs = createNodeFsCapability({
  tier: 'sandboxed',
  workspaceDir: root,
  operatorHomeDir: '/fixture',
  readOnly: false,
});
const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: { fs } });

for (const scenario of [
  'host-success',
  'host-append',
  'host-changed',
  'host-cancel',
  'host-publish-cancel',
  'host-committed-cancel',
] as const) {
  const path = join(root, scenario);
  assert.equal(await readFile(path, 'utf8'), 'before');
  const before = await stat(path, { bigint: true });
  const isAppend = scenario === 'host-append';
  const expected = isAppend ? 'beforeé🙂' : 'after';
  const effects = createInMemoryEffectJournal({
    kind: 'run',
    runId: scenario,
    nodeId: 'n',
    attempt: 1,
  });
  const controller = createAbortController();
  let observedPublished = false;
  // Cancellation is triggered only after the actual published target becomes visible.
  // The underlying controller supplies the real listener semantics used by the native host.
  const signal =
    scenario === 'host-publish-cancel'
      ? {
          get aborted() {
            if (!controller.signal.aborted && readFileSync(path, 'utf8') === 'after') {
              assert.equal(effects.rows()[0]?.state, 'prepared');
              observedPublished = true;
              controller.abort();
            }
            return controller.signal.aborted;
          },
          addEventListener: (type: 'abort', listener: () => void) =>
            controller.signal.addEventListener(type, listener),
          removeEventListener: (type: 'abort', listener: () => void) =>
            controller.signal.removeEventListener(type, listener),
        }
      : controller.signal;
  let approved = false;
  const dispatch = registry.dispatch(
    {
      type: 'tool_call',
      id: 'provider',
      name: 'write_file',
      args: { path: scenario, content: isAppend ? 'é🙂' : 'after', append: isAppend },
    },
    {
      nodeId: 'n',
      grantedToolIds: new Set(['write_file']),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effectSlot: 0,
      effectAttempt: { providerAttempt: 1, toolCallId: 'call' },
      effects,
      signal,
      beforeDispatch: () => {
        assert.equal(effects.rows()[0]?.state, 'prepared');
      },
      approval: {
        confirm: async (_request, _signal, live) => {
          assert.deepEqual(effects.rows(), []);
          assert.equal(live?.preview.diff?.before, 'before');
          assert.equal(live?.preview.diff?.after, expected);
          const reviewed = await stat(path, { bigint: true });
          for (const key of [
            'dev',
            'ino',
            'mode',
            'uid',
            'gid',
            'nlink',
            'size',
            'mtimeNs',
            'ctimeNs',
          ] as const)
            assert.equal(reviewed[key], before[key], `preparation changed ${key}`);
          assert.equal(await readFile(path, 'utf8'), 'before');
          if (scenario === 'host-changed') await writeFile(path, 'other!');
          if (scenario === 'host-cancel') controller.abort();
          approved = true;
          return scenario === 'host-committed-cancel'
            ? { outcome: 'approve', onDispatchSucceeded: () => controller.abort() }
            : { outcome: 'approve' };
        },
      },
    },
  );
  if (scenario === 'host-success' || scenario === 'host-append') {
    await dispatch;
    assert.equal(await readFile(path, 'utf8'), expected);
    assert.equal(effects.rows()[0]?.state, 'committed');
    assert.equal(effects.rows()[0]?.tier, 3);
  } else {
    await assert.rejects(dispatch, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal('retryable' in error && error.retryable, false);
      if (
        scenario === 'host-cancel' ||
        scenario === 'host-publish-cancel' ||
        scenario === 'host-committed-cancel'
      )
        assert.equal('code' in error && error.code, 'cancelled');
      else assert.equal('runErrorCode' in error && error.runErrorCode, 'tool_failed');
      return true;
    });
    assert.equal(
      await readFile(path, 'utf8'),
      scenario === 'host-changed'
        ? 'other!'
        : scenario === 'host-committed-cancel' || scenario === 'host-publish-cancel'
          ? 'after'
          : 'before',
    );
    if (scenario === 'host-cancel') assert.deepEqual(effects.rows(), []);
    else
      assert.equal(
        effects.rows()[0]?.state,
        scenario === 'host-committed-cancel'
          ? 'committed'
          : scenario === 'host-publish-cancel'
            ? 'prepared'
            : 'ambiguous',
      );
  }
  assert.equal(approved, true);
  if (scenario === 'host-publish-cancel') assert.equal(observedPublished, true);
}
process.stdout.write('real host/native lower-layer registry fixture passed (in-memory journal)\n');
