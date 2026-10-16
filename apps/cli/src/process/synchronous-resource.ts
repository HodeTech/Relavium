import { CliError, toUserFacing } from './errors.js';
import type { CliInvocation } from './invocation.js';
import type { OwnerRetirement } from './invocation-registry.js';

/**
 * Short trusted native acquisitions remain synchronous: their positive close precedes the
 * next open. A failed close retains the exact resource capability, rather than a warning ACK.
 */
export function withSynchronousResource<Resource extends { readonly close: () => void }, Result>(
  invocation: CliInvocation | undefined,
  acquire: () => Resource,
  use: (resource: Resource) => Result,
): Result {
  if (invocation === undefined) {
    const resource = acquire();
    try {
      return use(resource);
    } finally {
      resource.close();
    }
  }
  let complete: (facts: OwnerRetirement) => void = () => undefined;
  const retired = new Promise<OwnerRetirement>((resolve) => {
    complete = resolve;
  });
  let resource: Resource | undefined;
  let close: (() => void) | undefined;
  let active = true;
  let attempted = false;
  let uncertain = false;
  const release = (): void => {
    if (active || attempted || uncertain) return;
    attempted = true;
    try {
      close?.();
      close = undefined;
      resource = undefined;
      complete({ kind: 'settled' });
    } catch (cause) {
      uncertain = true;
      invocation.finiteExit.fail('cli_internal');
      throw new CliError('cli_internal', '', { cause });
    }
  };
  invocation.finiteExit.activateFallback();
  invocation.registry.register({
    kind: 'command',
    retired,
    stop: () => undefined, // This entered synchronous scope cannot be preempted; later entry is guarded.
    join: release,
    classifyFailure: () => 'cli_internal',
  });
  let outcome:
    | { readonly kind: 'value'; readonly value: Result }
    | { readonly kind: 'error'; readonly cause: unknown };
  try {
    invocation.registry.assertAdmitting();
    try {
      resource = acquire();
      const acquired = resource;
      const nativeClose = acquired.close;
      close = () => Reflect.apply(nativeClose, acquired, []);
    } catch (cause) {
      // Trusted owned acquisition adapters either return their close capability or classify
      // a cleaned-up refusal. Unknown partial construction never certifies resource retirement.
      if (
        toUserFacing(cause).code === 'cli_internal' ||
        toUserFacing(cause).code === 'output_unavailable'
      ) {
        uncertain = true;
        invocation.finiteExit.fail('cli_internal');
      }
      throw cause;
    }
    invocation.registry.assertAdmitting();
    outcome = { kind: 'value', value: use(resource) };
  } catch (cause) {
    outcome = { kind: 'error', cause };
  } finally {
    active = false;
  }
  try {
    release();
  } catch (cause) {
    // The stronger fixed infrastructure observation is already sticky; preserve a primary refusal.
    if (outcome.kind === 'value') outcome = { kind: 'error', cause };
  }
  if (outcome.kind === 'error') throw outcome.cause;
  return outcome.value;
}
