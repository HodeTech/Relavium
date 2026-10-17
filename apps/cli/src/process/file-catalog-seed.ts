/** One invocation attempt, including concurrent/reentrant callers and failed or missing cache reads. */
export function createFileCatalogSeed(load: () => void | Promise<void>): () => Promise<void> {
  let attempted: Promise<void> | undefined;
  return () => {
    attempted ??= Promise.resolve()
      .then(load)
      .catch(() => {
        // Optional offline cache seeding is total. The shipped floor remains authoritative on failure.
      });
    return attempted;
  };
}
