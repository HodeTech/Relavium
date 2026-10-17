import { register } from 'node:module';

process.send?.({ phase: 'loader-entry' });

// register() is available at the supported Node 22.13 floor; registerHooks() is not.
// A causal child inherits the phase runtime and must use the same pinned source/dependency
// loader as its Vitest parent. Ordinary native tests keep the floor-compatible fixture loader.
if (process.env['RELAVIUM_USAGE_RUNTIME'] === undefined)
  register('./media-temporary-loader.ts', import.meta.url);
else {
  // eslint-disable-next-line no-restricted-syntax -- this exact local tools register is a causal-only source fence, not a provider module
  await import(
    new URL('../../../../tools/usage-coverage-controls/register.mjs', import.meta.url).href
  );
}
