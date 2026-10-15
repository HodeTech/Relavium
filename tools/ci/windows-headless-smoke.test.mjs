import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const require = createRequire(new URL('apps/cli/package.json', root));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'));
const smoke = workflow.jobs['windows-concurrency'].steps.find((step) =>
  step.name?.startsWith('Headless no-TTY smoke'),
);
assert.ok(smoke, 'Windows workflow must retain its headless chat smoke');
assert.equal(smoke.shell, 'bash');
assert.match(
  readFileSync(new URL('apps/cli/src/process/exit-codes.ts', root), 'utf8'),
  /\bchatEnded:\s*4\s*,/,
  'the expected EOF status must agree with the canonical CLI code',
);

const fakeNode = `#!/usr/bin/env bash
printf '%s\\n' "$2" >> "$HEADLESS_FAKE_CALLS"
case "$2" in
  --help) exit "${'$'}{HEADLESS_HELP_EXIT:-0}" ;;
  chat)
    if [[ "${'$'}{HEADLESS_CHAT_STREAM:-stdout}" == stderr ]]; then
      printf '%s\\n' "${'$'}{HEADLESS_CHAT_OUTPUT:-plain chat ended}" >&2
    else
      printf '%s\\n' "${'$'}{HEADLESS_CHAT_OUTPUT:-plain chat ended}"
    fi
    exit "${'$'}{HEADLESS_CHAT_EXIT:-4}" ;;
  *) exit 97 ;;
esac
`;

function exercise({
  chatExit = 4,
  chatOutput = 'plain chat ended',
  chatStream = 'stdout',
  helpExit = 0,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-headless-smoke-'));
  try {
    const node = join(directory, 'node');
    const calls = join(directory, 'calls.txt');
    writeFileSync(node, fakeNode);
    chmodSync(node, 0o700);
    const result = spawnSync('bash', ['-c', smoke.run], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
        HEADLESS_FAKE_CALLS: calls,
        HEADLESS_CHAT_EXIT: String(chatExit),
        HEADLESS_CHAT_OUTPUT: chatOutput,
        HEADLESS_CHAT_STREAM: chatStream,
        HEADLESS_HELP_EXIT: String(helpExit),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readFileSync(calls, 'utf8').trimEnd().split('\n'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the actual Windows smoke accepts the canonical chat EOF exit 4', () => {
  const result = exercise();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /windows headless no-TTY smoke passed/);
  assert.deepEqual(result.calls, ['--help', 'chat']);
});

for (const chatExit of [0, 1, 2, 130]) {
  test(`the actual Windows smoke rejects chat exit ${chatExit}`, () => {
    const result = exercise({ chatExit, chatOutput: 'PRIVATE_CHILD_OUTPUT' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /expected 4/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /PRIVATE_CHILD_OUTPUT/);
    assert.deepEqual(result.calls, ['--help', 'chat']);
  });
}

for (const chatStream of ['stdout', 'stderr']) {
  test(`the actual Windows smoke rejects raw-mode output on ${chatStream} even with exit 4`, () => {
    const result = exercise({ chatStream, chatOutput: 'setRawMode failed' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /entered raw mode without a TTY/);
    assert.deepEqual(result.calls, ['--help', 'chat']);
  });
}

test('the actual Windows smoke propagates a failed bundle help check before chat', () => {
  const result = exercise({ helpExit: 73 });
  assert.equal(result.status, 73, result.stderr);
  assert.doesNotMatch(result.stdout, /smoke passed/);
  assert.deepEqual(result.calls, ['--help']);
});
