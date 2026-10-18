import type { Readable } from 'node:stream';

/**
 * Inject at an actual completed native removal. Older Node 22 streams do not emit
 * removeListener, so that event cannot be the cross-runtime fault-injection authority.
 */
export function injectPostRemoval(input: Readable) {
  const callbacks: Array<(event: string | symbol, listener: unknown) => void> = [];
  const native = input.removeListener.bind(input);
  input.removeListener = (event, listener) => {
    const result = native(event, listener);
    for (const callback of callbacks) callback(event, listener);
    return result;
  };
  return (callback: (event: string | symbol, listener: unknown) => void): void => {
    callbacks.push(callback);
  };
}
