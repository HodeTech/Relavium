import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertDeclaredHookTimeouts } from './timeout-policy.mjs';

test('selected hook declarations admit fifteen seconds and refuse overlong or dynamic budgets', () => {
  const graph = realpathSync(mkdtempSync(join(tmpdir(), 'causal-timeout-policy-')));
  const path = 'selected.test.ts';
  try {
    for (const source of ['beforeEach(() => undefined, 15_000);', 'afterAll(() => undefined);']) {
      writeFileSync(join(graph, path), source);
      assert.doesNotThrow(() => assertDeclaredHookTimeouts(graph, [path]));
    }
    for (const source of [
      'beforeEach(() => undefined, 15_001);',
      'afterAll(() => undefined, chosenTimeout);',
      "import { beforeAll as setup } from 'vitest'; setup(() => undefined, 15_001);",
    ]) {
      writeFileSync(join(graph, path), source);
      assert.throws(() => assertDeclaredHookTimeouts(graph, [path]), /CAUSAL_TIMEOUT_BUDGET/);
    }
  } finally {
    rmSync(graph, { recursive: true, force: true });
  }
});
