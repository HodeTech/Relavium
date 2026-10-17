import { record } from './guard-log.mjs';

// Node 22.0 supports module.register. Keep the installed engine and SDK bytes untouched.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@napi-rs/keyring')
    return { url: new URL('./keyring-denied.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier.startsWith('@napi-rs/keyring-'))
    throw new Error('Native keyring API import refused');
  const resolved = await nextResolve(specifier, context);
  if (specifier === 'openai' || specifier === 'better-sqlite3')
    record({ operation: 'external-module', specifier, url: resolved.url });
  return resolved;
}
