/**
 * Test-only USTAR writer: the exact archive shape the inspector accepts (pnpm's layout), so a test
 * can build a package tarball from an in-memory inventory. `package/dist/index.js` is 0755, every
 * other entry 0644. The dialect itself is `ustar.mjs`'s.
 */
import { ustarEntry, writeChecksum, writeUstar } from './ustar.mjs';

const packageMode = (path) => (path === 'package/dist/index.js' ? 0o755 : 0o644);

export { writeChecksum as checksum };

/** @param {string} path @param {Uint8Array} bytes */
export function entry(path, bytes) {
  return ustarEntry(path, bytes, packageMode(path));
}

/** @param {Map<string, Uint8Array>} files */
export function ustar(files) {
  return writeUstar(files, packageMode);
}
