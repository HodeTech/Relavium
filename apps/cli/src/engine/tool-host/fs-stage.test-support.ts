/** Synthetic index fixture only: this is not the native durable staging producer. */
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function createSyntheticPinnedStage(
  operatorHomeDir: string,
  parentDir: string,
): Promise<{ readonly stage: string; readonly payload: string }> {
  if (typeof process.geteuid !== 'function') throw new Error('POSIX fixture required');
  const nonce = randomUUID().replaceAll('-', '');
  const parent = resolve(parentDir);
  const stage = join(parent, `.relavium-fs-stage-v1.${process.pid}.${nonce}`);
  const payload = join(stage, 'payload');
  const index = join(operatorHomeDir, '.relavium-fs-private-v1', 'fs-staging-v1');
  await mkdir(index, { recursive: true, mode: 0o700 });
  await mkdir(stage, { mode: 0o700 });
  await writeFile(payload, '', { flag: 'wx', mode: 0o600 });
  const id = async (path: string) => {
    const info = await stat(path, { bigint: true });
    return { dev: String(info.dev), ino: String(info.ino) };
  };
  const owner = Buffer.from(String(process.geteuid()));
  const locator = Buffer.from(stage);
  const record = Buffer.alloc(176 + owner.length + locator.length);
  record.write('RVSTG001', 0, 'ascii');
  record[8] = 1;
  record.writeUInt32LE(process.pid, 16);
  record.writeUInt16LE(owner.length, 20);
  record.writeUInt16LE(locator.length, 22);
  record.write(nonce, 24, 'ascii');
  owner.copy(record, 56);
  locator.copy(record, 56 + owner.length);
  let offset = 56 + owner.length + locator.length;
  for (const path of [parent, stage, payload]) {
    const identity = await id(path);
    record.writeBigUInt64LE(BigInt(identity.dev), offset);
    record.writeBigUInt64LE(BigInt(identity.ino), offset + 8);
    record.writeBigUInt64LE(BigInt(identity.dev), offset + 24);
    record.writeBigUInt64LE(BigInt(identity.ino), offset + 32);
    offset += 40;
  }
  await writeFile(join(index, `${nonce}.record`), record, { flag: 'wx', mode: 0o600 });
  await writeFile(payload, 'synthetic');
  return { stage, payload };
}
