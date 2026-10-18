// The existing native resolver loads shipping TypeScript. These workflow paths additionally import TSX.
import { register } from 'node:module';
import process from 'node:process';
import { URL } from 'node:url';

if (process.env['RELAVIUM_USAGE_RUNTIME'] === undefined) {
  register('../../engine/fixtures/ts-resolve-hook.mjs', import.meta.url);
  register('./workflow-tsx-hook.mjs', import.meta.url);
} else {
  // eslint-disable-next-line no-restricted-syntax -- exact local causal-only source/dependency fence; no provider module or developer dist borrowing
  await import(
    new URL('../../../../../tools/usage-coverage-controls/register.mjs', import.meta.url).href
  );
}
