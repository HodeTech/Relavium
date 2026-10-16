import { CliError } from './cli-error.js';

/** Pure explicit signal ownership; owner counts and listener inspection grant no authority. */
export class SignalCustody {
  #claimed = false;

  get claimed(): boolean {
    return this.#claimed;
  }

  claim(): () => void {
    if (this.#claimed) throw new CliError('cli_internal', '');
    this.#claimed = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#claimed = false;
    };
  }
}

/** The existing actual surface net takes custody before registration and keeps it through removal. */
export function subscribeWithSignalCustody(
  custody: SignalCustody | undefined,
  subscribe: (listener: (signo: number) => void) => () => void,
  listener: (signo: number) => void,
): () => void {
  const release = custody?.claim();
  let remove: () => void;
  try {
    remove = subscribe(listener);
  } catch (cause) {
    release?.();
    throw cause;
  }
  return () => {
    remove(); // A failed native removal cannot certify transfer back to the bootstrap.
    release?.();
  };
}
