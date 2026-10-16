import { createFileCatalogSeed } from './file-catalog-seed.js';
import { InvocationRegistry, type InvocationClock } from './invocation-registry.js';
import {
  createInvocationFiniteExit,
  type InvocationFiniteExit,
  type FiniteExitPorts,
} from './invocation-finite-exit.js';

export interface CliInvocation {
  readonly registry: InvocationRegistry;
  readonly finiteExit: InvocationFiniteExit;
  readonly seedFileCatalogOnce: () => Promise<void>;
}

/** Created once before guarded imports; authority is explicitly threaded, never module-global. */
export function createCliInvocation(finitePorts?: FiniteExitPorts): CliInvocation {
  const clock: InvocationClock = {
    now: () => performance.now(),
    schedule: (milliseconds, fire) => {
      const timer = setTimeout(fire, milliseconds);
      return () => clearTimeout(timer);
    },
  };
  const registry = new InvocationRegistry(clock);
  return Object.freeze({
    registry,
    finiteExit: createInvocationFiniteExit(
      registry,
      clock,
      finitePorts ?? {
        setExitCode: (code) => {
          process.exitCode = code;
        },
        exit: (code) => process.exit(code),
      },
    ),
    seedFileCatalogOnce: createFileCatalogSeed(async () => {
      const { seedFileCatalog } = await import('../engine/catalog-seed.js');
      seedFileCatalog();
    }),
  });
}
