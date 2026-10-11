import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageEvidence } from './provenance.mjs';
const root = '/installed/sdk';
const manifest = {
  packages: [
    { root, name: 'sdk', version: '1.2.3', packageSha256: 'package-digest' },
    { root: '/other/sdk', name: 'sdk', version: '9.0.0' },
  ],
  files: [
    { packageRoot: root, path: root + '/package.json', bytes: 10, sha256: 'a' },
    { packageRoot: root, path: root + '/index.js', bytes: 20, sha256: 'b' },
    { packageRoot: '/other/sdk', path: '/other/sdk/index.js', bytes: 100, sha256: 'other' },
  ],
};
test('SDK provenance selects the physically resolved package, with order-independent complete byte identity', () => {
  const evidence = packageEvidence(manifest, root);
  assert.equal(evidence.version, '1.2.3');
  assert.equal(evidence.name, 'sdk');
  assert.equal(evidence.packageSha256, 'package-digest');
  assert.equal(evidence.files, 2);
  assert.equal(evidence.bytes, 30);
  assert.deepEqual(
    packageEvidence({ ...manifest, files: [...manifest.files].reverse() }, root),
    evidence,
  );
  const changed = { ...manifest, files: manifest.files.map((file) => ({ ...file })) };
  changed.files[1].sha256 = 'mutated-byte-digest';
  assert.notEqual(packageEvidence(changed, root).sourceSha256, evidence.sourceSha256);
});
test('missing physical package or empty byte inventory cannot certify installed SDK identity', () => {
  assert.throws(() => packageEvidence(manifest, '/missing'), /absent/);
  assert.throws(() => packageEvidence({ ...manifest, files: [] }, root), /no captured bytes/);
});
