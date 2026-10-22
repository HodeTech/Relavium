import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withFixture, toEntryUrl } from './child.mjs';
import { assertWitness, importFailureCanary, servicePackages } from './policy.mjs';
import { spawnBounded, stopBoundedChildren } from './process.mjs';
import { BOOTSTRAP_CONTROL_COUNT, controlName, grammarCases, metaCases } from './inventory.mjs';
import ts from 'typescript';

// Pinned independently of the policy so deleting a boundary cannot delete its own control.
// Commander alone belongs to the permitted compiled meta-operation grammar.
const requiredServicePackages = [
  'better-sqlite3',
  '@napi-rs/keyring',
  '@anthropic-ai/sdk',
  'openai',
  '@google/genai',
  '@modelcontextprotocol/sdk',
  'drizzle-orm',
  'ink',
  'react',
  '@clack/prompts',
  'yaml',
  'smol-toml',
  'string-width',
  'zod',
  'quickjs-emscripten-core',
  '@jitl/quickjs-singlefile-mjs-release-sync',
];
test('bootstrap service boundaries retain their independently pinned inventory', () => {
  assert.deepEqual([...servicePackages].sort(), [...requiredServicePackages].sort());
  const manifest = JSON.parse(
    readFileSync(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(
    Object.keys(manifest.dependencies)
      .filter((name) => name !== 'commander')
      .sort(),
    [...requiredServicePackages].sort(),
    'Every declared runtime service except the meta grammar must have a boundary',
  );
});

// Inspect the actual assertion operands: a copied test regex could pass after either
// acceptance runner regressed. Parsing never imports or executes the native harness.
for (const [path, markers] of [
  ['./check.mjs', ['file://', 'Error: synthetic']],
  ['../cli-package/smoke/native-process.mjs', ['file://', 'PRIVATE_INSTALLED_']],
]) {
  test(`${path}: actual failure-output guard stays within each stack line`, () => {
    const source = ts.createSourceFile(
      path,
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const literals = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'assert.doesNotMatch' &&
        node.arguments[0]?.getText(source) === 'result.stderr'
      ) {
        assert.ok(ts.isRegularExpressionLiteral(node.arguments[1]));
        literals.push(node.arguments[1].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(literals.length, 1, 'the real stderr assertion must remain present');
    const literal = literals[0];
    const end = literal.lastIndexOf('/');
    const guard = new RegExp(literal.slice(1, end), literal.slice(end + 1));
    for (const frame of ['\n    at fn (synthetic:1:1)', '\n\tat fn', '\r\n \tat fn'])
      assert.match(`diagnostic${frame}\ntrailer`, guard);
    for (const marker of markers) assert.match(`prefix ${marker} suffix`, guard);
    for (const text of [
      '{"code":"cli_internal","message":"fixed diagnostic"}\n',
      '\n\nat unindented text',
      '\n \n\tat-without-space',
      '\n'.repeat(16_384) + 'ordinary diagnostic',
      '\n' + ' '.repeat(16_384) + 'ordinary diagnostic',
    ])
      assert.doesNotMatch(text, guard);
  });
}

test('package binding expects the complete human/JSON native-failure cohort', () => {
  assert.equal(BOOTSTRAP_CONTROL_COUNT, 177);
  const names = metaCases.flatMap(([name]) =>
    [false, true].flatMap((json) => [false, true].map((root) => controlName(name, json, root))),
  );
  names.push(
    ...grammarCases('/synthetic-absent').flatMap(([name]) =>
      [false, true].map((json) => controlName(name, json)),
    ),
    'real-execution-fs-before-service',
    ...['entry-runtime-load-failure', 'dispatcher-load-failure'].flatMap((name) =>
      [false, true].map((json) => controlName(name, json)),
    ),
  );
  assert.equal(names.length, 177);
  assert.equal(new Set(names).size, 177);
});

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
    const specifiers = requiredServicePackages.flatMap((name) => [
      name,
      `${name}/synthetic-subpath`,
    ]);
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

test('copy/link APIs protect both operands in callback, sync and promise forms, including Buffer paths', async () => {
  await withFixture(async (fixture) => {
    const protectedPath = join(fixture.home, '.relavium', 'config.toml');
    const siblingPath = join(fixture.root, 'sibling-config.toml');
    writeFileSync(siblingPath, 'synthetic-sibling');
    const scenarios = ['cp', 'symlink', 'link'].flatMap((method) =>
      ['callback', 'sync', 'promise'].flatMap((form) =>
        ['string', 'buffer', 'url'].flatMap((format) => [
          { method, form, format, paths: [siblingPath, protectedPath] },
          { method, form, format, paths: [protectedPath, siblingPath] },
        ]),
      ),
    );
    const entry = fixtureModule(
      fixture,
      `
      import fs from 'node:fs';
      import promises from 'node:fs/promises';
      import { Buffer } from 'node:buffer';
      import { pathToFileURL } from 'node:url';
      for (const {method, form, format, paths} of ${JSON.stringify(scenarios)}) {
        const args = paths.map(path => format === 'buffer' ? Buffer.from(path) : format === 'url' ? pathToFileURL(path) : path);
        try {
          if (form === 'sync') fs[method + 'Sync'](...args);
          else if (form === 'promise') await promises[method](...args);
          else await new Promise((resolve, reject) => fs[method](...args, error => error ? reject(error) : resolve()));
        } catch {}
      }
      try { fs.readFileSync(Buffer.from(${JSON.stringify(relative(fixture.workspace, protectedPath))})); } catch {}
      try { fs.symlinkSync('../home/.relavium/config.toml', ${JSON.stringify(join(fixture.root, 'links', 'ref'))}); } catch {}
    `,
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    const refused = result.events.filter((event) => event.kind === 'fs' && event.denied);
    assert.equal(refused.length, scenarios.length + 2);
    assert.deepEqual(
      refused.slice(0, scenarios.length).map((event) => event.paths),
      scenarios.map(({ paths }) => paths),
    );
    assert.deepEqual(refused.at(-2).paths, [protectedPath]);
    assert.equal(refused.at(-1).paths[0], protectedPath);
    assert.throws(() => assertWitness(result.events, toEntryUrl(entry)), /guarded boundaries/);
  });
});

test('bootstrap denies WebSocket construction even when the refusal is swallowed', async () => {
  await withFixture(async (fixture) => {
    const entry = fixtureModule(
      fixture,
      "try { new WebSocket('wss://synthetic.invalid'); } catch {}",
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.events.filter((event) => event.kind === 'service'),
      [{ kind: 'service', category: 'websocket', method: 'WebSocket', denied: true }],
    );
    assert.throws(() => assertWitness(result.events, toEntryUrl(entry)), /guarded boundaries/);
  });
});

test('all child temporary-directory selectors stay in a protected owned fixture', async () => {
  await withFixture(async (fixture) => {
    const entry = fixtureModule(
      fixture,
      `
      import { tmpdir } from 'node:os';
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      console.log(JSON.stringify([tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP]));
      try { writeFileSync(join(tmpdir(), 'forbidden-bootstrap-temporary'), 'synthetic'); } catch {}
    `,
    );
    const result = await fixture.child([entry]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), Array(4).fill(fixture.temporary));
    assert.ok(
      result.events.some(
        (event) =>
          event.kind === 'fs' &&
          event.denied &&
          event.paths[0] === join(fixture.temporary, 'forbidden-bootstrap-temporary'),
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
test(
  'an interrupted caller abandons a running control: its bounded process group is killed, its fixture removed',
  { skip: process.platform === 'win32' },
  async (t) => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-bootstrap-abandon-')));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const pidFiles = ['child.pid', 'grandchild.pid'].map((name) => join(temporary, name));
    const url = (name) => JSON.stringify(new URL(name, import.meta.url).href);
    // The bounded child and a grandchild in its process group keep writing into the fixture, as a
    // running control's processes do, and outlive the fixture's removal unless they are killed.
    const writer = (pidFile) =>
      `const { writeFileSync } = require('node:fs');` +
      `const { join } = require('node:path');` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `let n = 0; setInterval(() => { try { writeFileSync(join(process.env.TMPDIR, 'f' + n++), 'x'); } catch {} }, 5);`;
    const bounded =
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
        writer(pidFiles[1]),
      )}], { stdio: 'ignore' });` + writer(pidFiles[0]);
    const script = `
import { abandonFixtures, withFixture } from ${url('./child.mjs')};
import { spawnBounded } from ${url('./process.mjs')};
process.on('SIGINT', () => {
  abandonFixtures();
  process.exit(130);
});
await withFixture((fixture) =>
  spawnBounded(['-e', ${JSON.stringify(bounded)}], { env: { TMPDIR: fixture.temporary } }, {
    timeoutMs: 60_000,
  }),
);
`;
    const caller = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH, TMPDIR: temporary },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const tree = [];
    try {
      for (const file of pidFiles) {
        for (let waited = 0; !existsSync(file) || readFileSync(file, 'utf8') === ''; waited += 25) {
          assert.ok(waited < 20_000, 'the bounded control never started');
          await delay(25);
        }
        tree.push(Number(readFileSync(file, 'utf8')));
      }
      assert.equal(
        readdirSync(temporary).filter((name) => name.startsWith('relavium-bootstrap-')).length,
        1,
      );
      const exited = new Promise((resolve) =>
        caller.once('exit', (code, signal) => resolve([code, signal])),
      );
      caller.kill('SIGINT');
      assert.deepEqual(await exited, [130, null]);
      // The whole process group goes, not only the process spawnBounded started.
      for (let waited = 0; tree.some(alive); waited += 25) {
        assert.ok(waited < 5_000, 'part of the bounded control outlived its abandonment');
        await delay(25);
      }
      assert.deepEqual(
        readdirSync(temporary).filter((name) => name.startsWith('relavium-bootstrap-')),
        [],
      );
    } finally {
      if (caller.exitCode === null && caller.signalCode === null) caller.kill('SIGKILL');
      for (const pid of tree) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  },
);
test(
  'a closed bounded child leaves nothing for an interrupted caller to kill',
  { skip: process.platform === 'win32' },
  async (t) => {
    // A closed child's process group may be recycled; abandoning must never signal it.
    assert.equal((await spawnBounded(['-e', ''], {})).code, 0);
    assert.equal(
      (await spawnBounded(['-e', 'setInterval(() => {}, 1000)'], {}, { timeoutMs: 100 })).timedOut,
      true,
    );
    const kill = t.mock.method(process, 'kill', () => true);
    stopBoundedChildren();
    assert.equal(kill.mock.callCount(), 0);
  },
);
