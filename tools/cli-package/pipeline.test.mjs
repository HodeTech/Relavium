import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CANDIDATE_TSC_ARGS, emitFreshPackage } from './pipeline.mjs';

const BUILT = 'ESM Build start\nESM Build success\n';
const FINALIZED = '✓ CLI candidate finalized: 3 output(s), 3 private map(s), 2 upstream map(s)\n';

function fixture(failAt, stdout = `${BUILT}${FINALIZED}`) {
  const repository = join(process.cwd(), 'synthetic-owned-candidate');
  const destination = join(process.cwd(), 'synthetic-public-output');
  const staging = join(process.cwd(), 'synthetic-private-staging');
  const calls = [];
  let commands = 0;
  return {
    calls,
    repository,
    destination,
    staging,
    env: { HOME: 'synthetic' },
    async removeBuildState(path) {
      calls.push({ remove: path });
    },
    async pnpm(args, options) {
      calls.push({ args, cwd: options.cwd, env: options.env });
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

test('fresh pipeline orders five mapped dependency emits before the sole candidate prepack and seal', async () => {
  const ports = fixture();
  assert.equal(await emitFreshPackage(ports), 'actual inspected receipt');
  const commands = ports.calls.filter((call) => call.args);
  const packages = ['shared', 'llm', 'core', 'db', 'mcp'].map((name) =>
    join(ports.repository, 'packages', name),
  );
  assert.deepEqual(
    commands.map((call) => call.cwd),
    [...packages, join(ports.repository, 'apps/cli')],
  );
  assert.deepEqual(
    ports.calls.filter((call) => call.remove).map((call) => call.remove),
    packages,
  );
  assert.deepEqual(
    commands.slice(0, 5).map((call) => call.args),
    Array.from({ length: 5 }, () => [
      'exec',
      'tsc',
      '-p',
      'tsconfig.build.json',
      '--sourceMap',
      'true',
      '--inlineSources',
      'false',
      '--incremental',
      'false',
    ]),
  );
  assert.deepEqual(CANDIDATE_TSC_ARGS, commands[0].args);
  // Each package's build state goes immediately before that package compiles, never after.
  assert.deepEqual(
    ports.calls
      .slice(0, 10)
      .map((call) => (call.remove ? `remove ${call.remove}` : `exec ${call.cwd}`)),
    packages.flatMap((path) => [`remove ${path}`, `exec ${path}`]),
  );
  // Only the sole prepack learns the private staging directory.
  assert.ok(commands.slice(0, 5).every((call) => call.env === ports.env));
  assert.deepEqual(commands[5].args, ['pack', '--pack-destination', ports.destination]);
  assert.deepEqual(commands[5].env, {
    HOME: 'synthetic',
    RELAVIUM_CLI_CANDIDATE_STAGING: ports.staging,
  });
  assert.deepEqual(ports.calls.at(-1), { seal: ports.destination });
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

for (const stdout of ['', `${BUILT}${BUILT}${FINALIZED}`, FINALIZED])
  test(`missing/duplicate observed prepack build refuses before seal: ${JSON.stringify(stdout)}`, async () => {
    const ports = fixture(undefined, stdout);
    await assert.rejects(emitFreshPackage(ports), /SOLE_PREPACK_BUILD_REQUIRED/);
    assert.equal(
      ports.calls.some((call) => call.seal),
      false,
    );
  });

for (const stdout of [BUILT, `${BUILT}${FINALIZED}${FINALIZED}`, `${BUILT}  ${FINALIZED}`])
  test(`missing/duplicate candidate finalization refuses before seal: ${JSON.stringify(stdout)}`, async () => {
    const ports = fixture(undefined, stdout);
    await assert.rejects(emitFreshPackage(ports), /CANDIDATE_FINALIZATION_REQUIRED/);
    assert.equal(
      ports.calls.some((call) => call.seal),
      false,
    );
  });

test('the shipped prepack lifecycle is the sole orchestrated build and closure gate', () => {
  const metadata = JSON.parse(
    readFileSync(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'),
  );
  assert.equal(metadata.scripts.prepack, 'node ../../tools/cli-package/prepack.mjs');
  assert.equal(metadata.scripts.build, 'tsup');
});
