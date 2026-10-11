/** Installed byte identity for an offline SDK control; not a provider or lockfile attestation. */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import {
  captureDependencies,
  digest,
  sourceState,
} from '../usage-coverage-controls/source-graph.mjs';

export function packageEvidence(manifest, root) {
  const pkg = manifest.packages.find((item) => item.root === root);
  assert.ok(pkg, 'Installed SDK package is absent from the physical dependency inventory');
  const files = manifest.files
    .filter((item) => item.packageRoot === root)
    .map((item) => ({
      path: relative(root, item.path).split(sep).join('/'),
      bytes: item.bytes,
      sha256: item.sha256,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.ok(files.length > 0, 'Installed SDK package has no captured bytes');
  return {
    name: pkg.name,
    version: pkg.version,
    packageSha256: pkg.packageSha256,
    files: files.length,
    bytes: files.reduce((sum, item) => sum + item.bytes, 0),
    sourceSha256: digest(JSON.stringify(files)),
  };
}
export function captureWireProvenance(repository) {
  const source = sourceState(repository);
  const dependencies = captureDependencies(repository);
  const require = createRequire(join(repository, 'packages/llm/package.json'));
  const sdks = ['@anthropic-ai/sdk', 'openai', '@google/genai'].map((name) => {
    const directory = (require.resolve.paths(name) ?? [])
      .map((base) => join(base, name))
      .find((path) => existsSync(join(path, 'package.json')));
    assert.ok(directory, 'Installed SDK cannot be resolved from the LLM workspace');
    return packageEvidence(dependencies, realpathSync(directory));
  });
  // The SDK matrix consumes the built shared seam. Pin those actual support bytes too;
  // CI builds first, and a developer invocation must do the same.
  const sharedRoot = realpathSync(join(repository, 'packages/shared/dist'));
  const sharedEntry = realpathSync(require.resolve('@relavium/shared'));
  assert.equal(
    dirname(sharedEntry),
    sharedRoot,
    'Wire shared support must resolve to its built workspace',
  );
  const sharedFiles = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        assert.ok(lstatSync(path).isFile(), 'Shared support must have physical owned bytes');
        const bytes = readFileSync(path);
        sharedFiles.push({
          path: relative(sharedRoot, path).split(sep).join('/'),
          bytes: bytes.length,
          sha256: digest(bytes),
        });
      }
    }
  }
  visit(sharedRoot);
  sharedFiles.sort((a, b) => a.path.localeCompare(b.path));
  const toolFiles = [
    'tools/wire-conformance/check.mjs',
    'tools/wire-conformance/provenance.mjs',
    'tools/acceptance-evidence/export.mjs',
  ].map((path) => ({ path, sha256: digest(readFileSync(join(repository, path))) }));
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sourceHead: source.head,
    sourceSha256: digest(JSON.stringify(source)),
    lockSha256: digest(readFileSync(join(repository, 'pnpm-lock.yaml'))),
    dependencySha256: digest(JSON.stringify(dependencies)),
    sdks,
    sharedSupport: { files: sharedFiles.length, sha256: digest(JSON.stringify(sharedFiles)) },
    toolFiles,
  };
}
