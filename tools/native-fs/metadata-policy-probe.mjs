// Developer-only historical algorithm probe. This does not exercise FsCapability.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const quarantine = 'com.apple.quarantine';
const custom = 'com.relavium.metadata-probe';
const original = 'original\n';
const modified = 'original\nappended\n';
const quarantineValue = '0081;00000000;RelaviumProbe;';
const customValue = 'relavium-probe-value';

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {string} path */
function attributes(path) {
  const names = run('/usr/bin/xattr', [path]).split('\n').filter(Boolean).sort();
  return new Map(names.map((name) => [name, run('/usr/bin/xattr', ['-px', name, path])]));
}

/** @param {string} path */
function hasDenyAcl(path) {
  return /\beveryone deny\b[^\n]*\bwrite\b[^\n]*\bappend\b/.test(run('/bin/ls', ['-le', path]));
}

/** @param {boolean} condition */
function requireProbe(condition) {
  if (!condition) throw new Error('probe condition failed');
}

if (
  process.platform !== 'darwin' ||
  typeof process.getuid !== 'function' ||
  process.getuid() === 0
) {
  console.error('probe requires macOS and a non-root account');
  process.exitCode = 1;
} else {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-metadata-probe-'));
  const source = join(directory, 'source');
  const copied = join(directory, 'copied');
  const staging = join(directory, 'staging');
  let completed = false;
  let report = '';
  try {
    chmodSync(directory, 0o700);
    const dirStat = statSync(directory);
    requireProbe(dirStat.uid === process.getuid() && (dirStat.mode & 0o777) === 0o700);
    writeFileSync(source, original, { mode: 0o600, flag: 'wx' });
    chmodSync(source, 0o644);
    run('/usr/bin/xattr', ['-w', quarantine, quarantineValue, source]);
    run('/usr/bin/xattr', ['-w', custom, customValue, source]);
    run('/bin/chmod', ['+a', 'everyone deny write,append', source]);

    const before = statSync(source);
    const initialAttributes = attributes(source);
    const initialAcl = hasDenyAcl(source);
    requireProbe(
      (before.mode & 0o7777) === 0o644 &&
        before.uid === process.getuid() &&
        readFileSync(source, 'utf8') === original &&
        initialAcl &&
        initialAttributes.get(quarantine)?.replaceAll(/\s/g, '').toLowerCase() ===
          Buffer.from(quarantineValue).toString('hex') &&
        initialAttributes.get(custom)?.replaceAll(/\s/g, '').toLowerCase() ===
          Buffer.from(customValue).toString('hex'),
    );

    let appendDenied = false;
    try {
      appendFileSync(source, 'appended\n');
    } catch (error) {
      appendDenied =
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EACCES' || error.code === 'EPERM');
    }
    const afterAppend = statSync(source);
    requireProbe(
      appendDenied &&
        readFileSync(source, 'utf8') === original &&
        afterAppend.uid === before.uid &&
        afterAppend.gid === before.gid &&
        (afterAppend.mode & 0o7777) === (before.mode & 0o7777) &&
        hasDenyAcl(source) &&
        JSON.stringify([...attributes(source)]) === JSON.stringify([...initialAttributes]),
    );

    copyFileSync(source, copied, constants.COPYFILE_EXCL);
    const copyAttributes = attributes(copied);
    const copyAclDropped = !hasDenyAcl(copied);
    const copyQuarantineDropped = !copyAttributes.has(quarantine);
    const copyCustomDropped = !copyAttributes.has(custom);
    requireProbe(readFileSync(copied, 'utf8') === original);

    const fd = openSync(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      before.mode & 0o7777,
    );
    try {
      const temp = fstatSync(fd);
      if (temp.uid !== before.uid || temp.gid !== before.gid)
        fchownSync(fd, before.uid, before.gid);
      fchmodSync(fd, before.mode & 0o7777);
      writeFileSync(fd, modified);
      fchmodSync(fd, before.mode & 0o7777);
      const final = fstatSync(fd);
      requireProbe(
        final.uid === before.uid &&
          final.gid === before.gid &&
          (final.mode & 0o7777) === (before.mode & 0o7777),
      );
    } finally {
      closeSync(fd);
    }
    renameSync(staging, source);
    const afterAttributes = attributes(source);
    const replacementBytes = readFileSync(source, 'utf8') === modified;
    const replacementAclDropped = !hasDenyAcl(source);
    const replacementQuarantineDropped = !afterAttributes.has(quarantine);
    const replacementCustomDropped = !afterAttributes.has(custom);
    requireProbe(replacementBytes);
    report = JSON.stringify({
      probe: 'historical-node-algorithms',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      nonRoot: true,
      fixtureVerified: true,
      appendDenied,
      replacementBytes,
      replacementAclDropped,
      replacementQuarantineDropped,
      replacementCustomDropped,
      copyAclDropped,
      copyQuarantineDropped,
      copyCustomDropped,
    });
    completed = true;
  } catch {
    console.error('metadata probe failed');
    process.exitCode = 1;
  } finally {
    // ACL removal is confined to the probe's two fixed paths inside its owned tree.
    for (const path of [source, copied]) {
      try {
        run('/bin/chmod', ['-N', path]);
      } catch {
        /* absent or already removed */
      }
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      console.error('metadata probe cleanup failed');
      process.exitCode = 1;
    }
    if (!completed) process.exitCode = 1;
  }
  if (completed && process.exitCode !== 1) console.log(report);
}
