// Loader hook of the symbolication preload (frame-capture.mjs): the packed CLI's keyring binding is
// replaced by a module that refuses every use, so the run loads no native module and reads no secret.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@napi-rs/keyring')
    return {
      url: new URL('./frame-capture-keyring.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  if (specifier.startsWith('@napi-rs/keyring-')) throw new Error('Native keyring import refused');
  return nextResolve(specifier, context);
}
