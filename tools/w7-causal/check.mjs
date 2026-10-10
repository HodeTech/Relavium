/** Optional offline diagnosis: project only twelve files; never edit the repository or rebuild history. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const owned = mkdtempSync(join(tmpdir(), 'relavium-w7-causal-'));
console.log(`W7 scoped causal evidence: ${owned}`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lanes = [
  [
    'CR-71',
    'packages/core/src/export/serializer.ts',
    'packages/core/src/export/serializer.test.ts',
    'const tools = [...new Set(turn.messages.flatMap((message) => toolsUsedIn(message.content)))];',
    'const tools: string[] = [];',
  ],
  [
    'CR-72',
    'packages/core/src/engine/turn-messages.ts',
    'packages/core/src/engine/turn-messages.test.ts',
    "else if (memory?.type === 'window')",
    "else if (false && memory?.type === 'window')",
  ],
  [
    'CR-98',
    'packages/llm/src/request-estimator.ts',
    'packages/llm/src/request-estimator.test.ts',
    '  return tokens;',
    '  return 0;',
  ],
  [
    'CR-94',
    'packages/core/src/engine/dispatch-allowance.ts',
    'packages/core/src/engine/dispatch-allowance.test.ts',
    '    if (estimate !== undefined) owner.remaining -= estimate;',
    '    // Diagnostic mutation: debit omitted.',
  ],
  [
    'CR-96',
    'packages/core/src/engine/checkpoint.ts',
    'packages/core/src/engine/budget-authorization-replay.test.ts',
    '    acc.nodeStates.delete(gate.nodeId);',
    "    acc.nodeStates.set(gate.nodeId, { status: 'completed', output: { decision: 'approved' } });",
  ],
  [
    'CR-97',
    'packages/core/src/engine/execution-host.ts',
    'packages/core/src/engine/session-effect-journal.test.ts',
    "correlation.kind === 'session' || result === undefined",
    'result === undefined',
  ],
];
const paths = [...new Set(lanes.flatMap((lane) => lane.slice(1, 3)))];
const original = new Map(),
  inventory = [];
for (const path of paths) {
  const bytes = readFileSync(join(repository, path));
  const projected = bytes
    .toString('utf8')
    .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_match, start, specifier, end) => {
      const target = resolve(dirname(join(repository, path)), specifier).replace(/\.js$/, '.ts');
      const local = relative(repository, target);
      return `${start}${paths.includes(local) ? join(owned, local) : target}${end}`;
    });
  original.set(path, projected);
  inventory.push({ path, sourceSha256: digest(bytes), projectedSha256: digest(projected) });
  mkdirSync(dirname(join(owned, path)), { recursive: true });
  writeFileSync(join(owned, path), projected);
}
const requireRoot = createRequire(join(repository, 'package.json'));
const requireCore = createRequire(join(repository, 'packages/core/package.json'));
const vitestPackage = dirname(requireRoot.resolve('vitest/package.json'));
writeFileSync(join(owned, 'package.json'), '{"type":"module"}\n');
writeFileSync(
  join(owned, 'vitest.config.mjs'),
  `export default ${JSON.stringify({
    root: owned,
    resolve: {
      alias: {
        '@relavium/shared': join(repository, 'packages/shared/src/index.ts'),
        '@relavium/llm': join(repository, 'packages/llm/src/index.ts'),
        yaml: requireCore.resolve('yaml'),
        vitest: join(vitestPackage, 'dist/index.js'),
      },
    },
    test: { include: ['packages/**/*.test.ts'], environment: 'node', cache: false },
  })};\n`,
);
writeFileSync(
  join(owned, 'source-manifest.json'),
  `${JSON.stringify(
    {
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }),
      files: inventory,
    },
    null,
    2,
  )}\n`,
);
const results = [];
function run(label, tests) {
  const args = [
    join(vitestPackage, 'vitest.mjs'),
    'run',
    '--configLoader',
    'native',
    '--config',
    join(owned, 'vitest.config.mjs'),
    ...tests,
  ];
  const start = Date.now();
  const child = spawnSync(process.execPath, args, {
    cwd: repository,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const log = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  writeFileSync(join(owned, `${label}.log`), log);
  const result = {
    label,
    argv: [process.execPath, ...args],
    exitCode: child.status,
    signal: child.signal,
    seconds: (Date.now() - start) / 1000,
    log: `${label}.log`,
  };
  results.push(result);
  writeFileSync(join(owned, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  assert.equal(child.error, undefined, `${label}: child launch/timeout failed`);
  assert.equal(child.signal, null, `${label}: interrupted child`);
  return { result, log };
}
try {
  for (const [label, path, test, before, after] of lanes) {
    const source = original.get(path);
    assert.equal(source.split(before).length - 1, 1, `${label}: intervention anchor drifted`);
    const mutant = source.replace(before, after);
    try {
      writeFileSync(join(owned, path), mutant);
      const { result, log } = run(label, [test]);
      assert.notEqual(result.exitCode, 0, `${label}: intervention did not break its regression`);
      assert.match(
        log,
        /AssertionError:/,
        `${label}: expected a real assertion failure, not fixture/import failure`,
      );
      result.mutationSha256 = digest(mutant);
    } finally {
      writeFileSync(join(owned, path), source);
    }
  }
  const { result } = run('restored', []);
  assert.equal(result.exitCode, 0, 'restored scoped current-source suites must pass');
} finally {
  for (const file of inventory)
    assert.equal(
      digest(readFileSync(join(repository, file.path))),
      file.sourceSha256,
      `repository source changed: ${file.path}`,
    );
  writeFileSync(join(owned, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}
console.log(
  'Six scoped interventions refused; restored current-source suites passed. No historical full build claimed.',
);
