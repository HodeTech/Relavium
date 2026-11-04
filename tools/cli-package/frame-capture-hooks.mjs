// Resolution hook of the symbolication preload (frame-capture.mjs), registered in-thread with
// `module.registerHooks` so that it sees `require` as well as `import`. The packed CLI's keyring
// binding is replaced by a module that refuses every use, so the run loads no native module and reads
// no secret. And no module may resolve outside the candidate: an optional `require` such as ws's
// `bufferutil` would otherwise fall through to a `node_modules` directory above the candidate, which
// another local user can create in a shared temporary directory. (The preload's own modules are
// loaded before the hook is registered, and the stand-in is returned without resolving.)
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYRING = new URL('./frame-capture-keyring.mjs', import.meta.url).href;

/**
 * A synchronous resolve hook confined to the candidate `root` (a real path).
 * @param {string} root
 */
export function confinedResolve(root) {
  return function resolve(specifier, context, nextResolve) {
    if (specifier === '@napi-rs/keyring') return { url: KEYRING, shortCircuit: true };
    if (specifier.startsWith('@napi-rs/keyring-')) throw new Error('Native keyring import refused');
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith('file:')) {
      const path = realpathSync.native(fileURLToPath(resolved.url));
      if (path !== root && !path.startsWith(`${root}${sep}`)) {
        throw new Error('The symbolication run refuses a module outside the candidate');
      }
    }
    return resolved;
  };
}
