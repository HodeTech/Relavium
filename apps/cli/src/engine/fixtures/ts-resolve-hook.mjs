/**
 * A module-resolution hook that lets a plain `node` child import this app's TypeScript source.
 *
 * `--experimental-strip-types` compiles a `.ts` file, but it does not rewrite the `.js` specifiers our
 * NodeNext source is written with, so `../render/sanitize.js` resolves to a file that only exists after a
 * bundle. The CLI bundles to a single `dist/index.js` with no per-module entry point, so there is nothing for
 * a child to import instead — and hand-copying the store's append protocol into a fixture would test the
 * copy, not the code.
 *
 * Used only by the two-process grant-log test
 * ([ADR-0084](../../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §10.13). Workspace
 * packages still resolve to their built `dist`, exactly as they would for any consumer.
 */

/* global URL -- a Node module-resolution hook (not TS source); it uses only this Node global. */

import { existsSync } from 'node:fs';

export function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const asTypeScript = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, context.parentURL);
    if (existsSync(asTypeScript)) return next(asTypeScript.href, context);
  }
  return next(specifier, context);
}
