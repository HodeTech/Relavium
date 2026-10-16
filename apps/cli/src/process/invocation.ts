import { createFileCatalogSeed } from './file-catalog-seed.js';
import { InvocationRegistry } from './invocation-registry.js';

export interface CliInvocation {
  readonly registry: InvocationRegistry;
  readonly seedFileCatalogOnce: () => Promise<void>;
}

/** Created once before guarded imports; authority is explicitly threaded, never module-global. */
export function createCliInvocation(): CliInvocation {
  return Object.freeze({
    registry: new InvocationRegistry({
      now: () => performance.now(),
      schedule: (milliseconds, fire) => {
        const timer = setTimeout(fire, milliseconds);
        return () => clearTimeout(timer);
      },
    }),
    seedFileCatalogOnce: createFileCatalogSeed(async () => {
      const { seedFileCatalog } = await import('../engine/catalog-seed.js');
      seedFileCatalog();
    }),
  });
}
