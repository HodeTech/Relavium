import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emitFreshPackage } from './pipeline.mjs';

function fixture(failAt, stdout = 'ESM Build start\nESM Build success') {
  const repository = join(process.cwd(), 'synthetic-owned-checkout');
  const destination = join(process.cwd(), 'synthetic-public-output');
  const calls = [];
  let commands = 0;
  return {
    calls,
    repository,
    destination,
    env: { HOME: 'synthetic' },
    async removeDist(path) {
      calls.push({ remove: path });
    },
    async pnpm(args, options) {
      calls.push({ args, cwd: options.cwd });
      commands += 1;
      if (commands === failAt) throw new Error('synthetic dependency or prepack failure');
      return { stdout };
    },
    async seal(path) {
      calls.push({ seal: path });
      return 'actual inspected receipt';
    },
  };
}

test('fresh pipeline orders five dependency emits before the sole prepack and independent seal', async () => {
  const ports = fixture();
  assert.equal(await emitFreshPackage(ports), 'actual inspected receipt');
  const commands = ports.calls.filter((call) => call.args);
  assert.deepEqual(
    commands.map((call) => call.cwd),
    [
      ...['shared', 'llm', 'core', 'db', 'mcp'].map((name) =>
        join(ports.repository, 'packages', name),
      ),
      join(ports.repository, 'apps/cli'),
    ],
  );
  assert.deepEqual(
    commands.slice(0, 5).map((call) => call.args),
    Array.from({ length: 5 }, () => [
      'exec',
      'tsc',
      '-p',
      'tsconfig.build.json',
      '--incremental',
      'false',
    ]),
  );
  assert.deepEqual(commands[5].args, ['pack', '--pack-destination', ports.destination]);
  assert.deepEqual(ports.calls.at(-1), { seal: ports.destination });
  assert.equal(ports.calls.filter((call) => call.remove).length, 5);
  assert.ok(commands.every((call) => !call.args.includes('turbo') && !call.args.includes('build')));
});

for (const failAt of [1, 2, 3, 4, 5, 6])
  test(`failure at emission ${failAt} prevents later work and seal`, async () => {
    const ports = fixture(failAt);
    await assert.rejects(emitFreshPackage(ports), /synthetic dependency or prepack failure/);
    assert.equal(ports.calls.filter((call) => call.args).length, failAt);
    assert.equal(
      ports.calls.some((call) => call.seal),
      false,
    );
  });

for (const stdout of ['', 'ESM Build start\nESM Build start\n'])
  test(`missing/duplicate observed prepack build refuses before seal: ${JSON.stringify(stdout)}`, async () => {
    const ports = fixture(undefined, stdout);
    await assert.rejects(emitFreshPackage(ports), /SOLE_PREPACK_BUILD_REQUIRED/);
    assert.equal(
      ports.calls.some((call) => call.seal),
      false,
    );
  });

test('the shipped prepack lifecycle has exactly one build and runs its closure gate', () => {
  const metadata = JSON.parse(
    readFileSync(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'),
  );
  assert.equal(metadata.scripts.prepack, 'tsup && pnpm -w run lint:bundle-closure');
});
