/** Parser controls, not native-execution evidence. Actual CI owns the target executions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NODE_LIFECYCLE_CASES, rustPopulation } from './profile-catalog.mjs';
import { parseRustListing, parseRustResults, validateProfileEvidence } from './profile.mjs';
for (const platform of ['darwin', 'linux', 'win32']) {
  test(`native profile population refuses missing, duplicated, ignored or failed ${platform} cases`, () => {
    const population = rustPopulation(platform);
    const names = [...population.passed, ...population.ignored];
    const listing = names.map((name) => `${name}: test`).join('\n');
    assert.deepEqual(parseRustListing(listing, platform), population);
    assert.throws(() =>
      parseRustListing(
        names
          .slice(1)
          .map((name) => `${name}: test`)
          .join('\n'),
        platform,
      ),
    );
    assert.throws(() => parseRustListing(listing + `\n${names[0]}: test`, platform));
    const results = [
      ...population.passed.map((name) => `test ${name} ... ok`),
      ...population.ignored.map((name) => `test ${name} ... ignored, owned child fixture`),
    ].join('\n');
    assert.deepEqual(parseRustResults(results, platform), population);
    assert.throws(() => parseRustResults(results.replace(' ... ok', ' ... FAILED'), platform));
    assert.throws(() => parseRustResults(results.replace(' ... ok', ' ... ignored'), platform));
    assert.throws(() => parseRustResults(results + `\ntest ${names[0]} ... ok`, platform));
    const evidence = {
      version: 1,
      rustPassed: population.passed,
      rustIgnored: population.ignored,
      nodeCases: [...NODE_LIFECYCLE_CASES],
      requiresCreationMaskProbe: false,
    };
    validateProfileEvidence(evidence, platform);
    for (const mutate of [
      (value) => {
        delete value.requiresCreationMaskProbe;
      },
      (value) => {
        value.requiresCreationMaskProbe = 'false';
      },
      (value) => value.nodeCases.pop(),
      (value) => value.nodeCases.push(value.nodeCases[0]),
      (value) => value.rustPassed.pop(),
      (value) => value.rustIgnored.push('unreviewed ignored test'),
      (value) => {
        value.version = 2;
      },
    ]) {
      const value = JSON.parse(JSON.stringify(evidence));
      mutate(value);
      assert.throws(() => validateProfileEvidence(value, platform));
    }
  });
}

test('joined Rust parent completion is required even when owned subprocess fixture output interleaves', async () => {
  const { parseSingleRustResult } = await import('./profile.mjs');
  const text =
    'test parent::case ... \nrunning 1 test\ntest child::fixture ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 3 filtered out\nok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 23 filtered out\n';
  assert.equal(parseSingleRustResult(text, 'parent::case'), 'parent::case');
  assert.throws(() => parseSingleRustResult(text, 'other::case'));
  assert.throws(() =>
    parseSingleRustResult(
      text.replace('1 passed; 0 failed; 0 ignored; 23', '0 passed; 0 failed; 1 ignored; 23'),
      'parent::case',
    ),
  );
  assert.throws(() =>
    parseSingleRustResult(text + 'test result: FAILED. 0 passed; 1 failed\n', 'parent::case'),
  );
});
