/** Path containment shared by the producer, the candidate tree and the finalizer. */
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
