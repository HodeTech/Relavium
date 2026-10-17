import type { AbortSignalLike } from '@relavium/shared';

interface Subscription {
  readonly notify: () => void;
  readonly attached: Set<AbortSignalLike>;
  delivered: boolean;
  adding: boolean;
  removing: boolean;
  cleanupRequested: boolean;
}

/** Both inputs limit MCP startup; a foreign listener fault never suppresses cancellation.
 * The original invocation owns cleanup uncertainty, independently of consumer settlement. */
export function combineMcpConnectSignals(
  owner: AbortSignalLike,
  caller: AbortSignalLike,
  cleanupUncertain: (cause: unknown) => void,
): AbortSignalLike {
  const subscriptions = new Map<() => void, Subscription>();

  const unlink = (listener: () => void, entry: Subscription): void => {
    entry.cleanupRequested = true;
    // A foreign add may attach AFTER reentering notify; only remove after it returns.
    if (entry.adding || entry.removing) return;
    entry.removing = true;
    let failure: { readonly cause: unknown } | undefined;
    try {
      for (const source of [...entry.attached]) {
        try {
          source.removeEventListener('abort', entry.notify);
          entry.attached.delete(source);
        } catch (cause) {
          // Retain possible attachment, but attempt the other unlink independently.
          failure ??= { cause };
        }
      }
    } finally {
      entry.removing = false;
    }
    if (entry.attached.size === 0 && subscriptions.get(listener) === entry)
      subscriptions.delete(listener);
    // Reporting can synchronously stop the owner; all removals above were attempted.
    if (failure !== undefined) cleanupUncertain(failure.cause);
  };

  return {
    get aborted() {
      return owner.aborted || caller.aborted;
    },
    addEventListener: (_type, listener) => {
      if (subscriptions.has(listener) || owner.aborted || caller.aborted) return;
      const entry: Subscription = {
        attached: new Set(),
        delivered: false,
        adding: false,
        removing: false,
        cleanupRequested: false,
        notify: () => {
          if (entry.delivered) return;
          entry.delivered = true;
          try {
            listener();
          } catch (cause) {
            cleanupUncertain(cause);
          } finally {
            unlink(listener, entry);
          }
        },
      };
      subscriptions.set(listener, entry);
      try {
        for (const source of [owner, caller]) {
          if (entry.delivered || entry.cleanupRequested) break;
          // addEventListener may attach then throw: ownership begins before entry.
          entry.attached.add(source);
          entry.adding = true;
          try {
            source.addEventListener('abort', entry.notify);
          } finally {
            entry.adding = false;
            if (entry.cleanupRequested) unlink(listener, entry);
          }
          if (source.aborted) entry.notify();
        }
      } catch (cause) {
        entry.delivered = true;
        try {
          cleanupUncertain(cause);
        } finally {
          unlink(listener, entry);
        }
        throw cause;
      }
    },
    removeEventListener: (_type, listener) => {
      const entry = subscriptions.get(listener);
      if (entry === undefined) return;
      // A settled consumer has unsubscribed, even if an input retains its wrapper.
      entry.delivered = true;
      unlink(listener, entry);
    },
  };
}
