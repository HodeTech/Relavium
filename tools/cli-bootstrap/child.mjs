import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnBounded, stopBoundedChildren } from './process.mjs';
import { maxWitnessBytes } from './policy.mjs';

function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      entries.push([
        relative(root, path),
        info.mode,
        info.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'directory',
      ]);
      if (info.isDirectory()) visit(path);
    }
  }
  visit(root);
  return entries;
}

/** Every fixture root a running control still owns. */
const liveFixtures = new Set();

/**
 * For a caller that an interrupt ends before `withFixture` can remove its own root: synchronously kill
 * every bounded child, then remove every fixture root still in use. One root that cannot be removed
 * neither keeps the children alive nor the other roots in place; the first failure is rethrown after.
 */
export function abandonFixtures() {
  stopBoundedChildren();
  let failure;
  for (const root of liveFixtures) {
    try {
      // Retries absorb a killed child that was still finishing a write.
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      failure ??= error;
    }
  }
  liveFixtures.clear();
  if (failure !== undefined) throw failure;
}

/** Each child receives a synthetic HOME/cwd, no ambient credentials or Node preload. */
export async function withFixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-bootstrap-')));
  liveFixtures.add(root);
  try {
    const home = join(root, 'home'),
      workspace = join(root, 'workspace'),
      temporary = join(root, 'temporary');
    mkdirSync(temporary);
    for (const dir of [join(home, '.relavium', 'catalog'), join(workspace, '.relavium')])
      mkdirSync(dir, { recursive: true });
    const poison = 'synthetic-bootstrap-file-canary-5631\n[[invalid TOML JSON YAML';
    for (const path of [
      join(home, '.relavium', 'config.toml'),
      join(home, '.relavium', 'catalog', 'models-dev.json'),
      join(workspace, '.relavium', 'config.toml'),
      join(workspace, 'relavium.toml'),
      join(workspace, '.relavium.yaml'),
    ])
      writeFileSync(path, poison);
    const absentRoot = join(root, 'absent-grant');
    const protectedRoots = [home, workspace, temporary, absentRoot];
    const before = protectedRoots.slice(0, 3).map(snapshot);
    const fixture = {
      root,
      home,
      workspace,
      temporary,
      absentRoot,
      async child(args, { failRuntimeUrl, debug = false, bounds } = {}) {
        const witness = join(root, `witness-${fixture.count++}.ndjson`);
        writeFileSync(witness, '');
        const env = {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          NO_COLOR: '1',
          RELAVIUM_BOOTSTRAP_WITNESS_OPTIONS: JSON.stringify({
            witness,
            protectedRoots,
            failRuntimeUrl,
          }),
        };
        for (const key of ['PATH', 'SystemRoot', 'WINDIR'])
          if (process.env[key] !== undefined) env[key] = process.env[key];
        if (debug) env.RELAVIUM_DEBUG = '1';
        const result = await spawnBounded(
          ['--import', new URL('./preload.mjs', import.meta.url).href, ...args],
          { cwd: workspace, env },
          bounds,
        );
        assert.equal(result.joined, true);
        assert.equal(result.timedOut, false, 'bootstrap child timed out');
        assert.equal(result.outputExceeded, false, 'bootstrap child exceeded output bound');
        assert.equal(result.spawnError, undefined);
        const body = readFileSync(witness);
        assert.ok(body.length <= maxWitnessBytes, 'bootstrap witness exceeded bound');
        const events = body
          .toString('utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return { ...result, events };
      },
      count: 0,
    };
    const result = await run(fixture);
    assert.deepEqual(
      protectedRoots.slice(0, 3).map(snapshot),
      before,
      'application files or directories changed',
    );
    assert.equal(
      readdirSync(root).includes('absent-grant'),
      false,
      'meta path minted a grant directory',
    );
    return result;
  } finally {
    // This exact mkdtemp-owned directory is the sole cleanup target, including failing controls.
    liveFixtures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
}

export const toEntryUrl = (entry) => pathToFileURL(entry).href;
