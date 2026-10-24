/**
 * Test-only USTAR writer: the exact archive shape the inspector accepts (pnpm's layout), so a test
 * can build a package tarball from an in-memory inventory. `package/dist/index.js` is 0755, every
 * other entry 0644.
 */
import { Buffer } from 'node:buffer';

/** @param {Buffer} header */
export function checksum(header) {
  header.fill(32, 148, 156);
  header.write(
    header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0'),
    148,
  );
  header[154] = 0;
  header[155] = 32;
}

/** @param {string} path @param {Uint8Array} bytes */
export function entry(path, bytes) {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  for (const offset of [100, 108, 116, 329, 337]) header.write('000000 \0', offset);
  header.write(path === 'package/dist/index.js' ? '000755' : '000644', 100);
  header.write(bytes.length.toString(8).padStart(11, '0') + ' ', 124);
  header.write('00000000000 ', 136);
  header[156] = 48;
  header.write('ustar\0' + '00', 257);
  checksum(header);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}

/** @param {Map<string, Uint8Array>} files */
export function ustar(files) {
  return Buffer.concat([
    ...[...files].map(([path, bytes]) => entry(path, bytes)),
    Buffer.alloc(1024),
  ]);
}
