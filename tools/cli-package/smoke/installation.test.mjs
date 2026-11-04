import assert from 'node:assert/strict';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import { installedModulesOwner } from './installation.mjs';

const root = parse(process.cwd()).root;
const path = (...parts) => join(root, ...parts);

test('a pnpm virtual-store installation is owned by the node_modules that holds the store', () => {
  const home = path('tmp', 'consumer');
  const installed = join(
    home,
    'node_modules',
    '.pnpm',
    'relavium@0.1.1',
    'node_modules',
    'relavium',
  );
  // The nearest node_modules is the store's per-package directory; dependencies resolve beside it.
  assert.equal(installedModulesOwner(installed), join(home, 'node_modules'));
});

test('an unrelated node_modules above the installation never owns it', () => {
  const home = path('work', 'node_modules', 'scratch', 'consumer');
  assert.equal(
    installedModulesOwner(
      join(home, 'node_modules', '.pnpm', 'relavium@0.1.1', 'node_modules', 'relavium'),
    ),
    join(home, 'node_modules'),
  );
  assert.equal(
    installedModulesOwner(join(home, 'node_modules', 'relavium')),
    join(home, 'node_modules'),
  );
});

test('a flat installation is owned by its nearest node_modules; none is no owner', () => {
  assert.equal(
    installedModulesOwner(path('tmp', 'consumer', 'node_modules', 'relavium')),
    path('tmp', 'consumer', 'node_modules'),
  );
  assert.equal(installedModulesOwner(path('tmp', 'consumer', 'relavium')), undefined);
});
