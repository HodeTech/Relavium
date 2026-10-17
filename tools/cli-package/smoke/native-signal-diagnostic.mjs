/** Passive native-edge evidence. Observation failure never changes a signal's result or throwable. */
import { performance } from 'node:perf_hooks';

const nativeCodes = new Set(['ESRCH', 'EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'EIO']);
export const nativeSignalCode = (value) => (nativeCodes.has(value) ? value : 'other');
export const SIGNAL_DIAGNOSTIC_OPERATIONS = new Set([
  'native-signal-observed',
  'native-uncaught-exception-observed',
  'native-signal-diagnostics-complete',
]);

export function createNativeSignalDiagnostic({ record, owns, now = () => performance.now() }) {
  let complete = true;
  let observations = 0;
  let finished = false;
  const write = (value) => {
    try {
      record(value);
    } catch {
      // The terminal marker (or its absence) makes this failed evidence unusable to the parent.
      complete = false;
    }
  };
  const observe = (operation, fields) => {
    try {
      if (finished) {
        complete = false;
        write({ operation: 'native-signal-diagnostics-complete', complete, observations });
        return;
      }
      if (observations >= 64) {
        complete = false;
        return;
      }
      const milliseconds = now();
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        complete = false;
        return;
      }
      observations++;
      write({ operation, milliseconds, ...fields });
    } catch {
      complete = false;
    }
  };
  return Object.freeze({
    wrap(signal) {
      return function (...args) {
        let returned;
        let failure;
        try {
          returned = Reflect.apply(signal, this, args);
          return returned;
        } catch (cause) {
          failure = { cause };
          throw cause;
        } finally {
          // No observer, clock, descriptor or journal failure may mask the native outcome.
          try {
            const target = args[0];
            const owned = Number.isSafeInteger(target) && owns(target) === true;
            const cause = failure?.cause;
            const own = (key) =>
              cause !== null && (typeof cause === 'object' || typeof cause === 'function')
                ? Object.getOwnPropertyDescriptor(cause, key)?.value
                : undefined;
            const code = own('code');
            const errno = own('errno');
            observe('native-signal-observed', {
              owned,
              ...(owned ? { target } : {}),
              signal: args[1] === 0 || args[1] === 'SIGKILL' ? args[1] : 'other',
              outcome: failure === undefined ? 'returned' : 'threw',
              ...(failure === undefined
                ? { returned: typeof returned === 'boolean' ? returned : 'other' }
                : {
                    nativeCode: nativeSignalCode(code),
                    ...(Number.isSafeInteger(errno) && Math.abs(errno) <= 10000 ? { errno } : {}),
                  }),
            });
          } catch {
            complete = false;
          }
        }
      };
    },
    uncaught() {
      // Occurrence only: no thrown message, name, stack, cause or handling authority.
      observe('native-uncaught-exception-observed', {});
    },
    finish() {
      if (finished) return;
      finished = true;
      write({ operation: 'native-signal-diagnostics-complete', complete, observations });
    },
  });
}

/** A terminal marker cannot certify evidence emitted by a later exit reaper. */
export function assertNativeSignalDiagnosticComplete(observed) {
  const last = observed.at(-1);
  if (
    last?.operation !== 'native-signal-diagnostics-complete' ||
    last.complete !== true ||
    last.observations !==
      observed.filter((item) =>
        ['native-signal-observed', 'native-uncaught-exception-observed'].includes(item.operation),
      ).length ||
    observed.filter((item) => item.operation === 'native-signal-diagnostics-complete').length !== 1
  )
    throw new Error('Native signal diagnostic evidence is incomplete');
}
