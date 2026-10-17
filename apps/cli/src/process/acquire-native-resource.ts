import { toUserFacing } from './errors.js';

interface NativeResourceCustody {
  readonly assertAdmitting: () => void;
  readonly captureClose: (close: () => void) => void;
  readonly cleanupUncertain: (cause: unknown) => void;
  readonly isStoppedFailure?: (cause: unknown) => boolean;
}

/** Transfer partial acquisition to its existing owner; this helper never creates or retires an owner. */
export function acquireNativeResource<Resource extends { readonly close: () => void }>(
  factory: (captureClose: (close: () => void) => void) => Resource,
  custody: NativeResourceCustody,
): Resource {
  custody.assertAdmitting();
  const captured = new Set<() => void>();
  const captureClose = (close: () => void): void => {
    if (captured.has(close)) return;
    custody.captureClose(close);
    captured.add(close);
  };
  let resource: Resource;
  try {
    resource = factory(captureClose);
    // A legacy injected factory has no partial-handoff protocol. Preserve its receiver on return.
    // An early handoff already owns the native connection; a returned wrapper is not a second resource.
    if (captured.size === 0) {
      const nativeClose = resource.close;
      captureClose(() => Reflect.apply(nativeClose, resource, []));
    }
  } catch (cause) {
    const code = toUserFacing(cause).code;
    if (
      captured.size === 0 &&
      custody.isStoppedFailure?.(cause) !== true &&
      (code === 'cli_internal' || code === 'output_unavailable')
    )
      custody.cleanupUncertain(cause);
    throw cause;
  }
  custody.assertAdmitting();
  return resource;
}
