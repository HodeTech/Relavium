/** Path containment shared by the producer, the candidate tree, the finalizer and the consumer. */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/**
 * Whether `child` is `parent` or lies inside it, decided by path segments: a child whose first segment
 * merely starts with `..` (`..private`, `...`) is inside, while `..` and `../x` are not.
 * @param {string} parent @param {string} child
 */
export function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Whether the existing `child` lies inside the existing `parent`, decided on the real paths and the
 * letter case the filesystem stores (`realpathSync.native`), so neither a link nor another letter case
 * of the same directory passes for elsewhere.
 * @param {string} parent @param {string} child
 */
export function placedWithin(parent, child) {
  return within(realpathSync.native(parent), realpathSync.native(child));
}
