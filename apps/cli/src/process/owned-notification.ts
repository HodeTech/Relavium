/** A passive producer may recover; the original invocation must first observe its sink failure. */
interface NotificationOwner {
  readonly signal: AbortSignal;
  readonly assertAdmitting: () => void;
  readonly failure: (cause: unknown) => void;
}

export function ownNotification<Args extends unknown[]>(
  owner: NotificationOwner | undefined,
  consume: (...args: Args) => void,
): (...args: Args) => void {
  if (owner === undefined) return consume;
  let stopped = false;
  return (...args) => {
    if (stopped || owner.signal.aborted) return;
    try {
      owner.assertAdmitting();
      consume(...args);
    } catch (cause) {
      stopped = true;
      owner.failure(cause);
    }
  };
}
