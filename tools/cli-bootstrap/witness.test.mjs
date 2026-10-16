import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withFixture, toEntryUrl } from './child.mjs';
import { assertWitness, importFailureCanary, servicePackages } from './policy.mjs';
import { spawnBounded } from './process.mjs';

function fixtureModule(fixture, body, name = 'fixture.mjs') {
  const path = join(fixture.root, name);
  writeFileSync(path, body);
  return path;
}
test('native loader observes untouched ESM entry and tolerates Node loader reads', async () => {
  await withFixture(async (fixture) => {
    const entry = fixtureModule(
      fixture,
      "import { readFileSync } from 'node:fs'; console.log(typeof readFileSync);",
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    assertWitness(result.events, toEntryUrl(entry));
    assert.equal(result.stdout, 'function\n');
  });
});
test('production child retains file-URL semantics for a preload path with URL metacharacters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-bootstrap-url-'));
  try {
    const directory = join(root, 'loader # with %');
    mkdirSync(directory);
    // Relocate the actual implementation unchanged, so converting its preload URL
    // to a native path breaks this control on POSIX as well as Windows.
    for (const name of ['child.mjs', 'process.mjs', 'policy.mjs', 'preload.mjs', 'loader.mjs'])
      copyFileSync(new URL(name, import.meta.url), join(directory, name));
    // eslint-disable-next-line no-restricted-syntax -- Exact copied tooling module in this test-owned directory; URL metacharacters are the regression.
    const relocated = await import(pathToFileURL(join(directory, 'child.mjs')).href);
    await relocated.withFixture(async (fixture) => {
      const entry = fixtureModule(fixture, "console.log('loaded with URL semantics');");
      const result = await fixture.child([entry]);
      assert.equal(result.code, 0, result.stderr);
      assertWitness(result.events, toEntryUrl(entry));
      assert.equal(result.stdout, 'loaded with URL semantics\n');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('each denied ESM package/subpath is witnessed even when the application swallows it', async () => {
  await withFixture(async (fixture) => {
    const specifiers = servicePackages.flatMap((name) => [name, `${name}/synthetic-subpath`]);
    const entry = fixtureModule(
      fixture,
      `for (const specifier of ${JSON.stringify(specifiers)}) { try { await import(specifier); } catch {} }`,
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.events.filter((event) => event.denied).map((event) => event.specifier),
      specifiers,
    );
    assert.throws(() => assertWitness(result.events, toEntryUrl(entry)), /guarded boundaries/);
  });
});
test('CommonJS require cannot bypass the native ESM service witness', async () => {
  await withFixture(async (fixture) => {
    const entry = fixtureModule(
      fixture,
      "import { createRequire } from 'node:module'; try { createRequire(import.meta.url)('better-sqlite3'); } catch {}",
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      result.events.some(
        (event) => event.kind === 'require' && event.specifier === 'better-sqlite3' && event.denied,
      ),
    );
    assert.throws(() => assertWitness(result.events, toEntryUrl(entry)), /guarded boundaries/);
  });
});
test('sync, promises, named builtin imports, streams and root-stat calls remain observable after swallowed failure', async () => {
  await withFixture(async (fixture) => {
    const config = join(fixture.home, '.relavium', 'config.toml');
    const entry = fixtureModule(
      fixture,
      `
      import fs, { readFileSync, createReadStream, realpathSync } from 'node:fs';
      import { stat } from 'node:fs/promises';
      const calls = [() => readFileSync(${JSON.stringify(config)}),
        () => fs.existsSync(${JSON.stringify(config)}),
        () => stat(${JSON.stringify(fixture.absentRoot)}),
        () => realpathSync(${JSON.stringify(fixture.workspace)}),
        () => realpathSync.native(${JSON.stringify(fixture.workspace)}),
        () => createReadStream(${JSON.stringify(config)})];
      for (const call of calls) { try { await call(); } catch {} }
    `,
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.events
        .filter((event) => event.kind === 'fs' && event.denied)
        .map((event) => event.method),
      [
        'readFileSync',
        'existsSync',
        'stat',
        'realpathSync',
        'realpathSync.native',
        'createReadStream',
      ],
    );
    assert.throws(() => assertWitness(result.events, toEntryUrl(entry)), /guarded boundaries/);
  });
});
test('native network and subprocess methods throw before dispatch and remain witnessed if swallowed', async () => {
  await withFixture(async (fixture) => {
    const entry = fixtureModule(
      fixture,
      `
      import { connect } from 'node:net';
      import { request } from 'node:https';
      import { lookup } from 'node:dns/promises';
      import { spawn } from 'node:child_process';
      for (const call of [() => connect(1), () => request('https://synthetic.invalid'),
        () => lookup('synthetic.invalid'), () => spawn('synthetic-not-a-command')]) {
        try { await call(); } catch {}
      }
    `,
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.events.filter((event) => event.kind === 'service').map((event) => event.category),
      ['net', 'https', 'dns-promises', 'child-process'],
    );
    assert.throws(() => assertWitness(result.events, toEntryUrl(entry)), /guarded boundaries/);
  });
});
test('protected descendants beginning with two dots are denied while similarly named siblings remain allowed', async () => {
  await withFixture(async (fixture) => {
    const protectedPath = join(fixture.home, '..cache', 'config.toml');
    const siblingPath = join(fixture.root, 'home-sibling-config.toml');
    writeFileSync(siblingPath, 'synthetic-sibling');
    const entry = fixtureModule(
      fixture,
      `
      import { readFileSync } from 'node:fs';
      try { readFileSync(${JSON.stringify(protectedPath)}); } catch {}
      console.log(readFileSync(${JSON.stringify(siblingPath)}, 'utf8'));
    `,
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'synthetic-sibling\n');
    assert.deepEqual(
      result.events
        .filter((event) => event.kind === 'fs' && event.denied)
        .map((event) => event.paths),
      [[protectedPath]],
    );
    assert.ok(
      result.events.some(
        (event) => event.kind === 'fs' && !event.denied && event.paths.includes(siblingPath),
      ),
    );
  });
});
test('dynamic chunk refusal is real native load failure and carries the synthetic raw canary', async () => {
  await withFixture(async (fixture) => {
    const target = fixtureModule(
      fixture,
      "throw new Error('this source must never evaluate');",
      'runtime.mjs',
    );
    const entry = fixtureModule(
      fixture,
      `try { await import(${JSON.stringify(toEntryUrl(target))}); } catch (error) { console.log(error.message); }`,
    );
    const result = await fixture.child([entry], { failRuntimeUrl: toEntryUrl(target) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${importFailureCanary}\n`);
    assert.ok(
      result.events.some(
        (event) =>
          event.kind === 'load' && event.url === toEntryUrl(target) && event.runtimeFailure,
      ),
    );
  });
});
test('missing preload or missing actual entry observations cannot pass', () => {
  assert.throws(() => assertWitness([], 'file:///entry'), /preload/);
  assert.throws(() => assertWitness([{ kind: 'preload-ready' }], 'file:///entry'), /entry/);
});
test('native child is killed and joined at finite timeout', async () => {
  const result = await spawnBounded(['-e', 'setInterval(() => {}, 1000)'], {}, { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.joined, true);
  assert.equal(result.signal, 'SIGKILL');
});
test('output cap counts UTF-8 bytes and joins the killed child', async () => {
  const result = await spawnBounded(
    ['-e', "process.stdout.write('😀'.repeat(100000)); setInterval(() => {}, 1000)"],
    {},
    { outputBytes: 4096 },
  );
  assert.equal(result.outputExceeded, true);
  assert.equal(result.joined, true);
  assert.equal(result.signal, 'SIGKILL');
});
