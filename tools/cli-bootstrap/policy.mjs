/** External packages whose evaluation is outside the compiled meta-operation graph. */
export const servicePackages = Object.freeze([
  'better-sqlite3',
  '@napi-rs/keyring',
  '@anthropic-ai/sdk',
  'openai',
  '@google/genai',
  '@modelcontextprotocol/sdk',
  'drizzle-orm',
  'ink',
  'react',
  '@clack/prompts',
  'yaml',
  'smol-toml',
  'string-width',
  'zod',
  'quickjs-emscripten-core',
  '@jitl/quickjs-singlefile-mjs-release-sync',
]);

export function isServiceSpecifier(specifier) {
  return servicePackages.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

export const importFailureCanary = 'synthetic-bootstrap-import-canary-9173';
export const maxWitnessBytes = 2 * 1024 * 1024;

export function assertWitness(witness, entryUrl) {
  if (!witness.some((event) => event.kind === 'preload-ready')) {
    throw new Error('bootstrap preload did not initialize');
  }
  if (!witness.some((event) => event.kind === 'load' && event.url === entryUrl)) {
    throw new Error('untouched compiled entry was not loaded');
  }
  const forbidden = witness.filter((event) => event.denied === true);
  if (forbidden.length !== 0)
    throw new Error(`bootstrap crossed ${forbidden.length} guarded boundaries`);
}
