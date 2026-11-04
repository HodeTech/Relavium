/** Filesystem inventory for the ADR-0111 emitted graph guard. Never follows a link. */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BundleClosureError } from './closure.mjs';

/** POSIX modes are actual evidence only where the platform exposes them. */
export const MODE_EVIDENCE = process.platform === 'win32' ? 'not-observable-windows' : 'posix';

/**
 * Inventory every emitted JS file below `<packageDirectory>/dist`. A map, an unknown file kind or a
 * private build file other than the named ones refuses: an ordinary build is map-free, and a
 * finalized candidate has already moved its maps and build metadata out of the package.
 * @param {string} packageDirectory
 * @param {{privateFiles?: readonly string[]}} [options] dist-root files that may remain unpublished
 * @returns {Record<string, {contents: string, mode?: number, kind: string}>}
 */
export function emittedInventory(packageDirectory, { privateFiles = [] } = {}) {
  const files = {};
  const root = join(packageDirectory, 'dist');
  function visit(directory) {
    if (!lstatSync(directory).isDirectory()) {
      throw new BundleClosureError('OUTPUT_KIND', 'dist inventory must use ordinary directories');
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(packageDirectory, path).split(sep).join('/');
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) {
        // Never follow a link that could hide runtime chunks.
        throw new BundleClosureError('OUTPUT_KIND', 'dist contains a symbolic link');
      } else if (/\.(?:js|mjs|cjs)$/iu.test(entry.name)) {
        const stat = lstatSync(path);
        files[key] = {
          contents: entry.isFile() ? readFileSync(path, 'utf8') : '',
          ...(MODE_EVIDENCE === 'posix' ? { mode: stat.mode & 0o7777 } : {}),
          kind: entry.isFile() ? 'file' : 'other',
        };
      } else if (/\.map$/iu.test(entry.name)) {
        throw new BundleClosureError('MAP_OUTPUT', `dist contains a source map: ${key}`);
      } else if (!(directory === root && privateFiles.includes(entry.name))) {
        throw new BundleClosureError('EXTRA_OUTPUT', `dist contains an unreviewed file: ${key}`);
      }
    }
  }
  visit(root);
  return files;
}
