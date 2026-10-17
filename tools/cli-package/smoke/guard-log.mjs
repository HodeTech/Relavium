import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, statSync } from 'node:fs';

export function record(value) {
  const path = process.env.RELAVIUM_PACKAGE_SMOKE_LOG;
  if (!path) throw new Error('Explicit package smoke log required');
  const line = JSON.stringify(value) + '\n';
  if (
    Buffer.byteLength(line) > 65536 ||
    (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > 262144)
  )
    throw new Error('Package smoke record byte ceiling exceeded');
  appendFileSync(path, line, { mode: 0o600 });
}
export const denied = (operation) => () => {
  record({ operation, denied: true });
  throw new Error(`Package smoke refuses ${operation}`);
};
