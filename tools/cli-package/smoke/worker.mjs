import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REQUIRED_SMOKE_CASES } from './cases.mjs';
import { assertInstalledChat } from './chat.mjs';
import { assertInstalledMcp, assertInstalledWorkflows } from './workflows.mjs';
import { assertExit, explicitEnvironment, invoke, ndjson } from './process.mjs';
import { assertInstalledNativeProcesses, InstalledNativeControlError } from './native-process.mjs';
import { emitInstalledWorkerFailure } from './failure-diagnostic.mjs';
import { installedModulesOwner } from './installation.mjs';
import { INSTALLED_SMOKE_ROOT_PREFIX } from './index.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../..');
const within = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const snapshot = (packageRoot) =>
  Object.fromEntries(
    readdirSync(join(packageRoot, 'dist'))
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => [name, digest(readFileSync(join(packageRoot, 'dist', name)))]),
  );

/** Native addons remain in this worker until its actual process closes. */
async function exerciseInstalledSmoke({ packageRoot, supportRoot, artifactSha256, source }) {
  assert.ok(
    isAbsolute(packageRoot) && isAbsolute(supportRoot),
    'Explicit absolute installed/support roots required',
  );
  assert.match(artifactSha256, /^[a-f0-9]{64}$/, 'Exact artifact SHA-256 required');
  assert.notEqual(source, undefined, 'Explicit source identity required');
  packageRoot = realpathSync(packageRoot);
  assert.equal(
    within(repository, packageRoot),
    false,
    'Installed package must be outside the workspace',
  );
  mkdirSync(supportRoot, { recursive: true, mode: 0o700 });
  supportRoot = realpathSync(supportRoot);
  assert.equal(
    within(packageRoot, supportRoot),
    false,
    'Test support must remain outside the shipped package',
  );
  const require = createRequire(join(packageRoot, 'package.json'));
  const entry = join(packageRoot, 'dist/index.js');
  const before = snapshot(packageRoot);
  const installedModules = installedModulesOwner(packageRoot);
  assert.ok(installedModules, 'Installed package must have an explicit node_modules owner');
  const root = mkdtempSync(join(supportRoot, INSTALLED_SMOKE_ROOT_PREFIX));
  const log = join(root, 'guard.ndjson');
  const report = {
    schemaVersion: 1,
    artifactSha256,
    source,
    packageRoot,
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    parentPid: process.ppid,
    cases: [],
    success: false,
  };
  const calls = () => (existsSync(log) ? ndjson(readFileSync(log, 'utf8')) : []);
  const environment = (home, extra = {}) =>
    explicitEnvironment(home, root, { RELAVIUM_PACKAGE_SMOKE_LOG: log, ...extra });
  const cli = (args) => [
    '--import',
    pathToFileURL(join(directory, 'preload.mjs')).href,
    entry,
    ...args,
  ];
  async function runCase(name, operation) {
    const started = Date.now();
    try {
      const evidence = await operation();
      report.cases.push({ id: name, passed: true, elapsedMs: Date.now() - started, evidence });
    } catch (error) {
      report.cases.push({
        id: name,
        passed: false,
        elapsedMs: Date.now() - started,
        error:
          error instanceof InstalledNativeControlError
            ? error.primaryFailure
            : String(error.stack ?? error),
        ...(error instanceof InstalledNativeControlError ? { evidence: error.evidence } : {}),
      });
    }
  }
  try {
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(metadata.name, 'relavium');
    const dependencies = {};
    for (const name of [
      'better-sqlite3',
      'openai',
      '@napi-rs/keyring',
      '@modelcontextprotocol/sdk',
      '@google/genai',
    ]) {
      const resolved = realpathSync(
        require.resolve(
          name === '@modelcontextprotocol/sdk' ? '@modelcontextprotocol/sdk/client/index.js' : name,
        ),
      );
      assert.equal(within(repository, resolved), false, `Workspace dependency leakage: ${name}`);
      assert.equal(
        within(installedModules, resolved),
        true,
        `Dependency escaped installed consumer: ${name}`,
      );
      let metadataPath = dirname(resolved),
        dependencyMetadata;
      for (;;) {
        const candidate = join(metadataPath, 'package.json');
        if (existsSync(candidate)) {
          const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
          if (parsed.name === name) {
            dependencyMetadata = parsed;
            break;
          }
        }
        assert.notEqual(
          metadataPath,
          dirname(metadataPath),
          `Dependency metadata missing: ${name}`,
        );
        metadataPath = dirname(metadataPath);
      }
      dependencies[name] = {
        entry: resolved,
        packageRoot: metadataPath,
        version: dependencyMetadata.version,
      };
    }
    report.dependencies = dependencies;
    const Database = require('better-sqlite3');
    const context = { root, Database, cli, environment, calls };
    await runCase('native-addon-load-only', async () => {
      const result = await invoke([join(directory, 'native-load.mjs'), packageRoot], {
        cwd: root,
        env: environment(root),
      });
      assertExit(result, 0);
      const evidence = JSON.parse(result.stdout);
      for (const path of [evidence.keyring, evidence.sqlite, ...evidence.nativeModules]) {
        assert.equal(within(repository, realpathSync(path)), false);
        assert.equal(within(installedModules, realpathSync(path)), true);
      }
      return evidence;
    });
    let version;
    await runCase('installed-version', async () => {
      const result = await invoke(cli(['--version']), { cwd: root, env: environment(root) });
      assertExit(result, 0);
      version = result.stdout.trim();
      assert.equal(version, metadata.version);
      assert.equal(calls().length, 0, 'Version must not load/use external services');
      return { version, outputBytes: result.bytes };
    });
    await runCase('installed-provider-list', async () => {
      const home = join(root, 'provider-list-home');
      mkdirSync(home);
      const before = calls().length;
      const result = await invoke(cli(['provider', 'list']), { cwd: home, env: environment(home) });
      assertExit(result, 0);
      assert.ok(
        result.stdout.trim().length > 0,
        'Installed provider list produced no human listing',
      );
      const guardedKeychainOrNetworkAttempts = calls()
        .slice(before)
        .filter((call) => call.denied || call.operation === 'sdk-fetch').length;
      assert.equal(
        guardedKeychainOrNetworkAttempts,
        0,
        'Offline provider listing attempted keychain/network access',
      );
      return { exit: result.code, outputBytes: result.bytes, guardedKeychainOrNetworkAttempts };
    });
    await runCase('installed-unknown-logs', async () => {
      const home = join(root, 'unknown-logs-home');
      mkdirSync(home);
      const before = calls().length;
      const result = await invoke(cli(['logs', 'nope']), { cwd: home, env: environment(home) });
      assertExit(result, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /no run found with id nope/);
      const guardedKeychainOrNetworkAttempts = calls()
        .slice(before)
        .filter((call) => call.denied || call.operation === 'sdk-fetch').length;
      assert.equal(
        guardedKeychainOrNetworkAttempts,
        0,
        'Unknown-run lookup attempted keychain/network access',
      );
      return { exit: result.code, outputBytes: result.bytes, guardedKeychainOrNetworkAttempts };
    });
    await runCase('workflow-gate-budget-effects', () => assertInstalledWorkflows(context));
    await runCase('real-sdk-chat-persistence-resume', () => assertInstalledChat(context));
    await runCase('actual-mcp-initialize-version', async () => {
      assert.ok(version, 'Installed version control must pass before version comparison');
      return assertInstalledMcp(context, version);
    });
    await runCase('actual-media-cas-iterator-cleanup', async () => {
      const fixture = join(
        repository,
        'tools/fs-policy-controls/fixtures/media-native-packaging.mjs',
      );
      const result = await invoke([fixture, entry], {
        cwd: root,
        env: environment(root),
        timeout: 30000,
      });
      assertExit(result, 0);
      assert.ok(
        result.stdout.includes(
          'actual CLI bundled native registration/consumption joined after owned-file cleanup',
        ),
      );
      return {
        actualInstalledEntry: entry,
        nativeJoinAndOwnedCasCleanup: true,
        outputBytes: result.bytes,
      };
    });
    await runCase('actual-native-process-owner', () => assertInstalledNativeProcesses(context));
    await runCase('actual-native-bootstrap-lifecycle', () =>
      assertInstalledNativeProcesses(context, { bootstrap: true }),
    );
    report.guardCalls = calls();
    for (const call of report.guardCalls.filter((value) => value.operation === 'external-module')) {
      const resolved = realpathSync(fileURLToPath(call.url));
      assert.equal(
        within(repository, resolved),
        false,
        'Actual SDK/SQLite dispatch resolved through workspace',
      );
      assert.equal(
        within(installedModules, resolved),
        true,
        'Actual SDK/SQLite dispatch escaped installed consumer',
      );
      assert.equal(
        within(dependencies[call.specifier].packageRoot, resolved),
        true,
        'Actual dispatch used another dependency instance',
      );
    }
    assert.ok(
      report.guardCalls.some(
        (call) => call.operation === 'external-module' && call.specifier === 'openai',
      ),
      'Actual installed SDK resolution witness missing',
    );
    assert.ok(
      report.guardCalls.some(
        (call) => call.operation === 'external-module' && call.specifier === 'better-sqlite3',
      ),
      'Actual installed SQLite resolution witness missing',
    );
    assert.deepEqual(
      report.cases.map((test) => test.id).sort(),
      [...REQUIRED_SMOKE_CASES].sort(),
      'Required installed case inventory mismatch',
    );
    report.success = report.cases.every((test) => test.passed);
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    try {
      const after = snapshot(packageRoot);
      report.compiledUnchanged = JSON.stringify(before) === JSON.stringify(after);
      report.compiledDigests = after;
    } catch (error) {
      report.compiledUnchanged = false;
      report.immutabilityError = String(error);
    }
    if (!report.compiledUnchanged) report.success = false;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      report.cleanupError = String(error);
    }
    report.ownedTempRemoved = !existsSync(root);
    if (!report.ownedTempRemoved) report.success = false;
    const json = JSON.stringify(report, null, 2) + '\n';
    assert.ok(Buffer.byteLength(json) <= 2097152, 'Installed smoke evidence byte ceiling exceeded');
    writeFileSync(join(supportRoot, 'installed-smoke.json'), json, { mode: 0o600 });
  }
  return report;
}

assert.equal(process.argv.length, 6, 'installed package, support, artifact and source required');
const report = await exerciseInstalledSmoke({
  packageRoot: process.argv[2],
  supportRoot: process.argv[3],
  artifactSha256: process.argv[4],
  source: process.argv[5],
});
if (!report.success) {
  process.exitCode = 1;
  emitInstalledWorkerFailure(report);
}
