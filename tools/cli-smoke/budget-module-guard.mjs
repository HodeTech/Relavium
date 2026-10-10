// Loader-worker hook; provider-key imports resolve to a throw-on-use fixture before evaluation.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@napi-rs/keyring') {
    return {
      url: new URL('./budget-keyring-denied.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
