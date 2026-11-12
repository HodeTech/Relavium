/** Content-free, bounded clues from Vitest's serialized unhandled errors. Not acceptance evidence. */
const names = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'AssertionError',
]);
const types = new Set([
  'Unhandled Error',
  'Unhandled Rejection',
  'Uncaught Exception',
  'Unhandled Reporter Error',
]);
const phases = new Set(['fixed', 'mutated', 'restored']);
const maxErrors = 8;
const maxStack = 32768;

function data(value, key) {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function frame(error, sourceRoot, owned) {
  const stack = data(error, 'stack');
  if (typeof stack !== 'string' || stack.length > maxStack) return null;
  const prefix = `${sourceRoot.replaceAll('\\', '/')}/`;
  for (const line of stack.replaceAll('\\', '/').split('\n').slice(1, 65)) {
    if (line.length > 4096) continue;
    const start = line.indexOf(prefix);
    if (start < 0) continue;
    const candidate = line.slice(start + prefix.length);
    const match = /^([^:\s()]+):(\d{1,7}):(\d{1,7})(?:\)|\s|$)/.exec(candidate);
    if (!match || !owned.has(match[1])) continue;
    const lineNumber = Number(match[2]);
    if (lineNumber < 1 || Number(match[3]) < 1) continue;
    return { path: match[1], line: lineNumber };
  }
  return null;
}

export function runtimeDiagnostic(errors, identity, sourceRoot, files) {
  try {
    if (!Array.isArray(errors)) return null;
  } catch {
    return null;
  }
  const count = data(errors, 'length');
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  if (
    !phases.has(identity.phase) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.mutationId) ||
    identity.mutationId.length > 128
  )
    return null;
  const owned = new Set(files.map((file) => file.path));
  const entries = Array.from({ length: Math.min(count, maxErrors) }, (_, index) => {
    const error = data(errors, String(index));
    const name = data(error, 'name');
    const type = data(error, 'type');
    return {
      kind: names.has(name) ? name : 'unknown',
      origin: types.has(type) ? type : 'unknown',
      reportedFrame: frame(error, sourceRoot, owned),
    };
  });
  return {
    version: 1,
    diagnostic: 'unhandled-runtime-errors',
    phase: identity.phase,
    mutationId: identity.mutationId,
    count,
    truncated: count > maxErrors,
    entries,
  };
}
