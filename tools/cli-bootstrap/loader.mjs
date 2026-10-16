import { appendFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { isServiceSpecifier, importFailureCanary } from './policy.mjs';

let options;
let bytes = 0;
function record(event) {
  const line = `${JSON.stringify(event)}\n`;
  bytes += Buffer.byteLength(line);
  if (bytes > 1024 * 1024) throw new Error('bootstrap loader witness exceeded limit');
  appendFileSync(options.witness, line);
}
export function initialize(data) {
  options = data;
}

export async function resolve(specifier, context, nextResolve) {
  const denied = isServiceSpecifier(specifier);
  record({ kind: 'resolve', specifier, parent: context.parentURL ?? null, denied });
  if (denied) throw new Error('synthetic bootstrap service import refused');
  return await nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const denied = options.failRuntimeUrl === url;
  record({ kind: 'load', url, denied, runtimeFailure: denied });
  if (denied) throw new Error(importFailureCanary);
  return await nextLoad(url, context);
}
