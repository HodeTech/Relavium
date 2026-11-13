/** Contributor-only copy-up probe: fixed container file, no mounts/network or data writes. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const recipe = readFileSync(new URL('./musl.Dockerfile', import.meta.url), 'utf8');
const image = /^FROM (node@sha256:[a-f0-9]{64}) AS node$/mu.exec(recipe)?.[1];
if (image === undefined) throw new Error('Pinned Node probe image is unavailable');
const program = String.raw`
const fs = require('node:fs');
const path = '/etc/passwd';
const reader = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let writer;
let current;
try {
  const before = fs.fstatSync(reader, { bigint: true });
  if (before.size > 65536n || !before.isFile()) throw new Error('Unsupported probe input');
  const bytes = fs.readFileSync(reader);
  writer = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  current = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const after = fs.fstatSync(current, { bigint: true });
  const result = {
    probe: 'non-truncating-overlay-access',
    bytesUnchanged: bytes.equals(fs.readFileSync(current)),
    identityStable: before.dev === after.dev && before.ino === after.ino,
    ctimeChanged: before.ctimeNs !== after.ctimeNs,
    mtimeUnchanged: before.mtimeNs === after.mtimeNs,
    securityModeOwnerUnchanged: before.mode === after.mode && before.uid === after.uid && before.gid === after.gid,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.bytesUnchanged || !result.mtimeUnchanged || !result.securityModeOwnerUnchanged)
    process.exitCode = 1;
} finally {
  if (current !== undefined) fs.closeSync(current);
  if (writer !== undefined) fs.closeSync(writer);
  fs.closeSync(reader);
}
`;
const child = spawnSync(
  'docker',
  ['run', '--rm', '--pull=never', '--network=none', '--cap-drop=ALL', image, 'node', '-e', program],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] },
);
if (child.error || child.signal || child.status !== 0)
  throw new Error('Overlay probe could not complete with the cached pinned image');
const result = JSON.parse(child.stdout);
if (
  result.probe !== 'non-truncating-overlay-access' ||
  Object.keys(result).length !== 6 ||
  Object.entries(result).some(([key, value]) => key !== 'probe' && typeof value !== 'boolean')
)
  throw new Error('Overlay probe returned an invalid observation');
process.stdout.write(JSON.stringify({ image, ...result }) + '\n');
