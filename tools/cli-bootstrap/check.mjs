import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { withFixture, toEntryUrl } from './child.mjs';
import { metaCases, grammarCases, BOOTSTRAP_CONTROL_COUNT } from './inventory.mjs';
import { assertWitness, importFailureCanary } from './policy.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export async function runBootstrap(packageRoot = join(repository, 'apps/cli')) {
  const dist = join(packageRoot, 'dist');
  const entry = join(dist, 'index.js');
  function artifactInventory() {
    return readdirSync(dist)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => ({
        name,
        sha256: createHash('sha256')
          .update(readFileSync(join(dist, name)))
          .digest('hex'),
      }));
  }
  const artifact = artifactInventory();
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  function runtimeChunk(prefix) {
    const files = readdirSync(dist).filter(
      (name) => name.startsWith(`${prefix}-`) && name.endsWith('.js'),
    );
    assert.equal(files.length, 1, `one real ${prefix} runtime chunk is required`);
    return toEntryUrl(resolve(dist, files[0]));
  }
  const runtimeUrl = runtimeChunk('run');
  const dispatchUrl = runtimeChunk('dispatch');
  const records = [];
  const observed = new Map();
  function retainEvents(events, fixture) {
    for (const event of events) {
      const normalized = JSON.parse(
        JSON.stringify(event).replaceAll(fixture.root, '<synthetic-fixture>'),
      );
      observed.set(JSON.stringify(normalized), normalized);
    }
  }

  await withFixture(async (fixture) => {
    for (const [name, args] of metaCases) {
      let referenceOutput;
      for (const json of [false, true])
        for (const rootGrant of [false, true]) {
          const globals = [
            ...(json ? ['--json'] : []),
            ...(rootGrant
              ? [
                  '--allow-fs-root',
                  fixture.absentRoot,
                  '--cwd',
                  fixture.workspace,
                  '--config',
                  join(fixture.home, '.relavium', 'config.toml'),
                ]
              : []),
          ];
          const started = performance.now();
          const result = await fixture.child([entry, ...globals, ...args]);
          retainEvents(result.events, fixture);
          assertWitness(result.events, toEntryUrl(entry));
          assert.equal(result.code, 0, `${name}: ${result.stderr}`);
          assert.equal(result.stderr, '', name);
          if (name.includes('version')) assert.equal(result.stdout, `${version}\n`, name);
          else assert.match(result.stdout, /^Usage: relavium/, name);
          // Same current artifact/runtime supplies the byte comparison; no historical timing threshold.
          referenceOutput ??= result.stdout;
          assert.equal(
            result.stdout,
            referenceOutput,
            `${name}: global flags changed existing human meta bytes`,
          );
          records.push({
            name,
            json,
            absentAbsoluteRoot: rootGrant,
            exitCode: result.code,
            imports: result.events.filter((event) => event.kind === 'load').length,
            filesystemCalls: result.events.filter((event) => event.kind === 'fs').length,
            milliseconds: Math.round(performance.now() - started),
          });
        }
    }
    for (const [name, args, nonEcho] of grammarCases(fixture.absentRoot)) {
      for (const json of [false, true]) {
        const result = await fixture.child([entry, ...(json ? ['--json'] : []), ...args]);
        retainEvents(result.events, fixture);
        assertWitness(result.events, toEntryUrl(entry));
        assert.equal(result.code, 2, `${name}: ${result.stderr}`);
        assert.equal(result.stdout, '', name);
        assert.notEqual(result.stderr, '', name);
        if (nonEcho !== undefined)
          assert.ok(!result.stderr.includes(nonEcho), `${name}: unsafe argument echoed`);
        records.push({ name, json, exitCode: result.code });
      }
    }

    // An actual execution reaches native grant admission. A swallowed refusal still leaves
    // the witness, and a service import ahead of that native check fails this ordering proof.
    const admission = await fixture.child([entry, 'chat', '--allow-fs-root', fixture.workspace]);
    retainEvents(admission.events, fixture);
    assert.notEqual(admission.code, 0);
    const firstDenied = admission.events.find((event) => event.denied);
    assert.equal(
      firstDenied?.kind,
      'fs',
      'real execution did not reach filesystem admission before services',
    );
    assert.ok(firstDenied.paths.some((path) => path === fixture.workspace));
    records.push({
      name: 'real-execution-fs-before-service',
      exitCode: admission.code,
      witness: firstDenied.method,
    });

    // Refuse actual emitted chunks in human and JSON mode; native activation owns exit 9.
    for (const [name, failRuntimeUrl, args] of [
      ['entry-runtime-load-failure', runtimeUrl, ['run', 'synthetic-absent.yaml']],
      ['dispatcher-load-failure', dispatchUrl, ['provider', 'list']],
    ]) {
      for (const json of [false, true]) {
        const result = await fixture.child([entry, ...(json ? ['--json'] : []), ...args], {
          failRuntimeUrl,
        });
        retainEvents(result.events, fixture);
        assert.ok(
          result.events.some(
            (event) =>
              event.kind === 'load' && event.url === failRuntimeUrl && event.runtimeFailure,
          ),
        );
        assert.equal(result.code, 9, name);
        assert.equal(result.stdout, '', name);
        if (json) {
          const lines = result.stderr.trim().split('\n');
          assert.equal(lines.length, 1, name);
          const error = JSON.parse(lines[0]);
          assert.equal(error.type, 'error', name);
          assert.equal(error.code, 'cli_internal', name);
          assert.match(error.message, /Inspect existing work/, name);
        } else {
          assert.match(result.stderr, /^relavium: An unexpected CLI failure occurred\./, name);
          assert.match(result.stderr, /Inspect existing work/, name);
        }
        assert.ok(!result.stderr.includes(importFailureCanary), name);
        assert.doesNotMatch(result.stderr, /\n\s+at |file:\/\/|Error: synthetic/, name);
        assert.equal(
          result.events.filter((event) => event.denied && !event.runtimeFailure).length,
          0,
          name,
        );
        records.push({ name, json, exitCode: result.code, refusedUrl: failRuntimeUrl });
      }
    }
  });
  assert.deepEqual(
    artifactInventory(),
    artifact,
    'compiled graph changed during bootstrap controls',
  );
  assert.equal(records.length, BOOTSTRAP_CONTROL_COUNT, 'complete bootstrap control inventory');
  return {
    kind: 'compiled-cli-bootstrap',
    node: process.version,
    platform: process.platform,
    entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
    artifact,
    scope: 'untouched selected CLI artifact on the actual reported runtime and OS',
    controls: records.length,
    records,
    observed: [...observed.values()],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, 'use the exported tooling runner for installed artifacts');
  console.log(JSON.stringify(await runBootstrap()));
}
