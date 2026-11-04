import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { placedWithin, within } from './paths.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-paths-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('containment is decided by whole path segments', () => {
  assert.equal(within('/a/b', '/a/b'), true);
  assert.equal(within('/a/b', '/a/b/c'), true);
  // A segment that merely starts with two dots is inside.
  assert.equal(within('/a/b', '/a/b/..c'), true);
  assert.equal(within('/a/b', '/a'), false);
  assert.equal(within('/a/b', '/a/c'), false);
  assert.equal(within('/a/b', '/a/bc'), false);
});

test('placement compares the real paths and stored letter case of existing directories', () => {
  const checkout = join(scratch, 'checkout');
  const inside = join(checkout, 'tmp');
  const outside = join(scratch, 'elsewhere');
  for (const directory of [inside, outside]) mkdirSync(directory, { recursive: true });
  assert.equal(placedWithin(checkout, inside), true);
  assert.equal(placedWithin(checkout, outside), false);
  // A link to the checkout is the checkout.
  const alias = join(scratch, 'alias');
  symlinkSync(checkout, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(placedWithin(checkout, join(alias, 'tmp')), true);
  assert.equal(placedWithin(alias, inside), true);
  // On a case-insensitive filesystem, another letter case of the checkout is the checkout.
  const variant = join(dirname(checkout), basename(checkout).toUpperCase());
  if (existsSync(variant)) {
    assert.equal(placedWithin(checkout, join(variant, 'tmp')), true);
    assert.equal(placedWithin(variant, inside), true);
  }
});
