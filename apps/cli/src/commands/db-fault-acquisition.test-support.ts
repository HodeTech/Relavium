import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

type Client = ReturnType<typeof import('@relavium/db').createClient>;

interface DbFaultCase {
  readonly root: string;
  readonly assertCurrent: () => void;
  readonly enableFault: () => void;
  readonly native: () => Client | undefined;
  readonly closeAttempts: () => number;
  readonly disposeCommand: (dispose: () => Promise<void>) => void;
}

/** Per-file raw-case custody; Vitest's timeout is never the scenario's cleanup ACK. */
export function dbFaultAcquisitionCases() {
  let rawCase: Promise<void> | undefined;
  let currentSignal: AbortSignal | undefined;
  beforeEach((context) => {
    currentSignal = context.signal;
  });
  afterEach(async () => {
    await rawCase?.catch(() => undefined);
    rawCase = undefined;
  });

  return (
    options: {
      readonly prefix: string;
      readonly closeFails: boolean;
      readonly closeRecovers?: boolean;
      readonly initiallyEnabled?: boolean;
    },
    scenario: (fixture: DbFaultCase) => Promise<void>,
  ): Promise<void> => {
    const signal = currentSignal;
    if (signal === undefined) throw new Error('Synthetic case context was not captured');
    rawCase = (async () => {
      const root = mkdtempSync(join(tmpdir(), options.prefix));
      let sealed = false;
      const assertCurrent = (): void => {
        signal.throwIfAborted();
        if (sealed) throw new Error('Synthetic database case no longer admits work');
      };
      let native: Client | undefined;
      let attempts = 0;
      let faultEnabled = options.initiallyEnabled ?? true;
      let disposeCommand: (() => Promise<void>) | undefined;
      const nativeDisposals = new Set<() => void>();
      let primary: { readonly cause: unknown } | undefined;
      const failures: unknown[] = [];
      try {
        const actual = await import('@relavium/db');
        assertCurrent();
        const setupFailure = new Error('synthetic database setup failure');
        const closeFailure = new Error('synthetic native close failure');
        vi.stubEnv('HOME', root);
        vi.stubEnv('USERPROFILE', root);
        writeFileSync(join(root, 'config.toml'), '');
        vi.doMock('@relavium/db', () => ({
          ...actual,
          createClient: (...args: Parameters<typeof actual.createClient>) => {
            assertCurrent();
            const client = actual.createClient(...args);
            if (faultEnabled) {
              native = client;
              const nativeClose = client.sqlite.close.bind(client.sqlite);
              // Capture every exact handle; this administrative close grants no product ACK.
              nativeDisposals.add(() => {
                if (client.sqlite.open) nativeClose();
              });
              client.sqlite.close = () => {
                attempts++;
                if (options.closeFails && (!options.closeRecovers || attempts === 1))
                  throw closeFailure;
                return nativeClose();
              };
            }
            return client;
          },
          runMigrations: (...args: Parameters<typeof actual.runMigrations>) => {
            if (faultEnabled) throw setupFailure;
            return actual.runMigrations(...args);
          },
        }));
        vi.resetModules();
        await scenario({
          root,
          assertCurrent,
          enableFault: () => {
            faultEnabled = true;
          },
          native: () => native,
          closeAttempts: () => attempts,
          disposeCommand: (dispose) => {
            disposeCommand = dispose;
          },
        });
      } catch (cause) {
        primary = { cause };
      } finally {
        sealed = true;
        try {
          await disposeCommand?.();
        } catch (cause) {
          failures.push(cause);
        }
        for (const close of nativeDisposals) {
          try {
            close();
          } catch (cause) {
            failures.push(cause);
          }
        }
        for (const cleanup of [
          () => vi.restoreAllMocks(),
          () => vi.doUnmock('@relavium/db'),
          () => vi.resetModules(),
          () => vi.unstubAllEnvs(),
          () => rmSync(root, { recursive: true, force: true }),
        ]) {
          try {
            cleanup();
          } catch (cause) {
            failures.push(cause);
          }
        }
      }
      if (primary !== undefined) throw primary.cause;
      if (failures.length !== 0)
        throw new AggregateError(failures, 'Synthetic database fixture cleanup failed');
    })();
    return rawCase;
  };
}
