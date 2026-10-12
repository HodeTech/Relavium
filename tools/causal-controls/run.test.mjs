/** Two bounded actual coordinators: each passes fixed/red/restored before a distinct real failure. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnJoined } from './process.mjs';
import { ownedTools } from './provenance.mjs';
import { verifyRetainedStdio } from './retention.mjs';
import { sourceState, digest } from '../usage-coverage-controls/source-graph.mjs';
const repository = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const target = 'tools/causal-controls/fixture.mjs';
const files = ['tools/causal-controls/fixture.cases.mjs'];
const scratchNames = () =>
  readdirSync(realpathSync(tmpdir()))
    .filter((name) => /^relavium-(?:filesystem|secrets)-controls-/.test(name))
    .sort();

test(
  'actual shared coordinators preserve inventory/hash restoration and clean scratch after assertion/import/export failures',
  { timeout: 120000 },
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'causal-integration-')));
    const before = sourceState(repository),
      sourceHash = digest(readFileSync(join(repository, target)));
    const roots = ['tools/causal-controls', 'tools/fs-policy-controls', 'tools/secrets-controls'];
    const tooling = ownedTools(repository, roots);
    const scratches = scratchNames();
    try {
      for (const [kind, failure] of [
        ['filesystem', 'assertion'],
        ['secrets', 'import'],
      ]) {
        const family = kind === 'filesystem' ? 'fs-policy-controls' : 'secrets-controls';
        const success = {
          id: 'synthetic-success',
          path: target,
          before: 'export const admitted = true;',
          after: 'export const admitted = false;',
          files,
          expectedTests: 2,
          target: 'CAUSAL_SYNTHETIC_DECLARED',
          marker: 'CAUSAL_SYNTHETIC_DECLARED',
        };
        const refusal = {
          ...success,
          id: `synthetic-${failure}`,
          ...(failure === 'assertion'
            ? { marker: 'CAUSAL_SYNTHETIC_ABSENT' }
            : {
                after:
                  "throw new Error('synthetic fixture import refused');\nexport const admitted = false;",
              }),
        };
        const entry = join(directory, `${kind}.mjs`);
        writeFileSync(
          entry,
          `import { runControls } from ${JSON.stringify(pathToFileURL(join(repository, 'tools/causal-controls/run.mjs')).href)};\nawait runControls(${JSON.stringify({ repository, evidenceKind: kind, toolRoots: ['tools/causal-controls', `tools/${family}`], mutations: [success, refusal] })});\n`,
        );
        const evidence = join(directory, 'evidence');
        mkdirSync(evidence, { recursive: true });
        // The import run also forces export refusal, proving that it cannot mask the earlier error.
        const child = await spawnJoined(
          process.execPath,
          [entry],
          {
            cwd: repository,
            env: {
              ...process.env,
              RELAVIUM_ACCEPTANCE_EVIDENCE: failure === 'import' ? repository : evidence,
            },
          },
          90000,
        );
        assert.equal(child.spawnError, undefined);
        assert.equal(child.timedOut, false);
        assert.equal(child.outputExceeded, false);
        assert.equal(child.signal, null);
        assert.equal(child.joined, true);
        assert.equal(child.code, 1);
        const start = child.stdout.indexOf('{\n  "version": 1,');
        assert.ok(start >= 0, 'Coordinator must emit completed failure metadata');
        const report = JSON.parse(child.stdout.slice(start));
        assert.equal(report.complete, false);
        assert.equal(report.mechanisms.length, 1);
        const accepted = report.mechanisms[0];
        assert.equal(accepted.id, 'synthetic-success');
        assert.equal(accepted.fixed.tests, 2);
        assert.equal(accepted.mutated.failed.length, 1);
        assert.match(child.stdout, /synthetic-success\/mutated: 1 passed; 1 failed cases/);
        assert.doesNotMatch(child.stdout, /named semantic failures/);
        assert.equal(accepted.restored.tests, 2);
        assert.deepEqual(accepted.fixed.inventory, accepted.mutated.inventory);
        assert.deepEqual(accepted.fixed.inventory, accepted.restored.inventory);
        assert.equal(accepted.fixedSha256, accepted.restoredSha256);
        assert.notEqual(accepted.fixedSha256, accepted.mutatedSha256);
        assert.ok(
          accepted.fixed.targetEvaluations > 0 &&
            accepted.mutated.targetEvaluations > 0 &&
            accepted.restored.targetEvaluations > 0,
        );
        assert.equal(report.restorations.length, 2);
        assert.ok(
          report.restorations.every(
            (entry) => entry.fixedSha256 === sourceHash && entry.restoredSha256 === sourceHash,
          ),
        );
        assert.match(
          report.failure.message,
          failure === 'assertion'
            ? /missing declared named assertion CAUSAL_SYNTHETIC_ABSENT/
            : /Setup or collection error/,
        );
        assert.ok(
          !child.stderr.includes('Evidence must be outside'),
          'Secondary export failure must preserve the actual primary',
        );
        assert.deepEqual(scratchNames(), scratches, 'Actual coordinator leaked scratch');
        assert.equal(digest(readFileSync(join(repository, target))), sourceHash);
        if (failure === 'assertion') {
          const retained = JSON.parse(readFileSync(join(evidence, kind, 'summary.json'), 'utf8'));
          assert.deepEqual(retained, report);
          assert.equal(existsSync(join(evidence, kind, 'graph')), false);
          const stdio = verifyRetainedStdio(join(evidence, kind));
          const acceptedStdio = stdio.filter(({ control }) => control === 'synthetic-success');
          assert.equal(acceptedStdio.length, 3);
          assert.deepEqual(acceptedStdio.map(({ phase }) => phase).sort(), [
            'fixed',
            'mutated',
            'restored',
          ]);
          for (const phase of ['fixed', 'mutated', 'restored']) {
            const phaseRoot = join(evidence, kind, 'synthetic-success', phase);
            assert.equal(existsSync(join(phaseRoot, 'cases.json')), false);
            assert.equal(existsSync(join(phaseRoot, 'stdout.log')), false);
            assert.equal(existsSync(join(phaseRoot, 'stderr.log')), false);
            assert.equal(existsSync(join(phaseRoot, 'stdio.bin')), true);
            const vitest = JSON.parse(readFileSync(join(phaseRoot, 'vitest.json'), 'utf8'));
            assert.equal(vitest.numTotalTests, accepted[phase].tests);
            assert.deepEqual(
              vitest.testResults
                .flatMap((file) => file.assertionResults.map((entry) => entry.fullName))
                .sort(),
              accepted[phase].inventory.map((entry) => entry.split(':').at(-1)).sort(),
            );
          }
        }
      }
      assert.deepEqual(
        sourceState(repository),
        before,
        'Actual failure path changed developer source/HEAD/index',
      );
      assert.deepEqual(
        ownedTools(repository, roots),
        tooling,
        'Actual failure path changed developer tooling',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('a stale later anchor stops every selected control before any fixed phase', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'causal-anchor-preflight-')));
  const before = sourceState(repository),
    scratches = scratchNames();
  try {
    const entry = join(directory, 'run.mjs');
    const good = {
      id: 'first-valid',
      path: target,
      before: 'export const admitted = true;',
      after: 'export const admitted = false;',
      files,
      expectedTests: 2,
      target: 'CAUSAL_SYNTHETIC_DECLARED',
      marker: 'CAUSAL_SYNTHETIC_DECLARED',
    };
    writeFileSync(
      entry,
      `import { runControls } from ${JSON.stringify(pathToFileURL(join(repository, 'tools/causal-controls/run.mjs')).href)};\nawait runControls(${JSON.stringify({ repository, evidenceKind: 'filesystem', toolRoots: ['tools/causal-controls', 'tools/fs-policy-controls'], mutations: [good, { ...good, id: 'later-stale', before: 'absent anchor' }] })});\n`,
    );
    const evidence = join(directory, 'evidence');
    mkdirSync(evidence);
    const child = await spawnJoined(
      process.execPath,
      [entry],
      {
        cwd: repository,
        env: { ...process.env, RELAVIUM_ACCEPTANCE_EVIDENCE: evidence },
      },
      30000,
    );
    assert.equal(child.joined, true);
    assert.equal(child.timedOut, false);
    assert.equal(child.code, 1);
    const retained = JSON.parse(readFileSync(join(evidence, 'filesystem', 'summary.json'), 'utf8'));
    assert.equal(retained.complete, false);
    assert.deepEqual(retained.mechanisms, []);
    assert.deepEqual(retained.restorations, []);
    assert.match(retained.failure.message, /later-stale: exact source anchor drift/);
    assert.equal(existsSync(join(evidence, 'filesystem', 'first-valid')), false);
    assert.deepEqual(scratchNames(), scratches);
    assert.deepEqual(sourceState(repository), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'physical phases refuse effective case and configured hook overrides above fifteen seconds',
  { timeout: 90000 },
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'causal-timeout-phase-')));
    const before = sourceState(repository);
    try {
      for (const mode of ['case', 'config']) {
        const entry = join(directory, `${mode}.mjs`);
        const control = {
          id: `timeout-${mode}`,
          path: target,
          before: 'export const admitted = true;',
          after: 'export const admitted = false;',
          files: ['tools/causal-controls/timeout.cases.mjs'],
          expectedTests: 1,
          target: 'never-certify',
          marker: 'never-certify',
        };
        writeFileSync(
          entry,
          `import { runControls } from ${JSON.stringify(pathToFileURL(join(repository, 'tools/causal-controls/run.mjs')).href)};\nawait runControls(${JSON.stringify({ repository, evidenceKind: 'filesystem', toolRoots: ['tools/causal-controls', 'tools/fs-policy-controls'], mutations: [control] })});\n`,
        );
        const evidence = join(directory, mode);
        mkdirSync(evidence);
        const child = await spawnJoined(
          process.execPath,
          [entry],
          {
            cwd: repository,
            env: {
              ...process.env,
              RELAVIUM_ACCEPTANCE_EVIDENCE: evidence,
              RELAVIUM_CAUSAL_TIMEOUT_FIXTURE: mode,
            },
          },
          30000,
        );
        assert.equal(child.joined, true);
        assert.equal(child.timedOut, false);
        assert.equal(child.code, 1);
        const root = join(evidence, 'filesystem');
        const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
        assert.equal(summary.complete, false);
        assert.deepEqual(summary.mechanisms, []);
        const report = readFileSync(join(root, control.id, 'fixed', 'vitest.json'), 'utf8');
        assert.match(report, /CAUSAL_TIMEOUT_BUDGET/);
        assert.deepEqual(sourceState(repository), before);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
