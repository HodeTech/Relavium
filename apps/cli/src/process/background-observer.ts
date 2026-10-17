import type { DiagnosticPolicy } from './diagnostic-policy.js';
import type { ExitObservations } from './exit-observations.js';
import { formatFixedDiagnostic } from './fixed-diagnostic.js';

export interface BackgroundObserverPorts {
  readonly observations: ExitObservations;
  readonly policy: DiagnosticPolicy;
  readonly readExitCode: () => string | number | null | undefined;
  readonly setExitCode: (code: number) => void;
  readonly write: (text: string) => Promise<void>;
  readonly outputFailed: () => void;
}

/** Inert successor to the legacy net. Process listeners are installed only by the native adapter. */
export function createBackgroundObserver(ports: BackgroundObserverPorts): {
  readonly observe: (reason: unknown) => void;
  readonly occurred: () => boolean;
} {
  let count = 0;
  return Object.freeze({
    occurred: () => count > 0,
    observe: () => {
      // Saturated finite state, even with an unlimited stream of rejections. Never inspect the reason.
      if (count < 6) {
        count++;
        const kind = count === 6 ? 'background_suppressed' : 'background_failure';
        try {
          void ports.write(formatFixedDiagnostic(kind, ports.policy)).catch(ports.outputFailed);
        } catch {
          ports.outputFailed();
        }
      }
      ports.observations.observeBackgroundFailure();
      const previous = ports.readExitCode();
      if (previous === undefined || previous === null || previous === 0) ports.setExitCode(9);
    },
  });
}
