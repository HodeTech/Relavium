import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let rawCase: Promise<void> | undefined;
let currentSignal: AbortSignal | undefined;
beforeEach((context) => {
  currentSignal = context.signal;
});
afterEach(async () => {
  await rawCase?.catch(() => undefined);
  rawCase = undefined;
});
beforeAll(async () => {
  // Warm source transformation, never a command/service, outside the native case budget.
  await Promise.all([
    import('./run.js'),
    import('./gate.js'),
    import('./chat.js'),
    import('./agent-run.js'),
    import('../home/drive-home.js'),
    import('../engine/pricing-overlay.js'),
  ]);
});

const surfaces = ['run', 'gate', 'chat', 'chat-resume', 'home', 'agent', 'pricing'] as const;

describe('original surface custody of partially opened SQLite', () => {
  it.each([
    ...surfaces.flatMap((surface) =>
      [false, true].map((closeFails) => ({ surface, closeFails, closeRecovers: false })),
    ),
    { surface: 'pricing' as const, closeFails: true, closeRecovers: true },
  ])(
    '$surface preserves partial acquisition; close failure=$closeFails; later release=$closeRecovers',
    ({ surface, closeFails, closeRecovers }) => {
      const signal = currentSignal;
      if (signal === undefined) throw new Error('Synthetic case context was not captured');
      rawCase = (async () => {
        const root = mkdtempSync(join(tmpdir(), 'relavium-surface-db-'));
        let sealed = false;
        const assertCurrent = (): void => {
          signal.throwIfAborted();
          if (sealed) throw new Error('Synthetic surface case no longer admits work');
        };
        let native: ReturnType<typeof import('@relavium/db').createClient> | undefined;
        const nativeDisposals = new Set<() => void>();
        let primary: { readonly cause: unknown } | undefined;
        const failures: unknown[] = [];
        let disposeCommand: (() => Promise<void>) | undefined;
        try {
          const actual = await import('@relavium/db');
          assertCurrent();
          let faultEnabled = !['chat', 'agent'].includes(surface);
          let attempts = 0;
          const primary = new Error('synthetic migration refusal');
          const secondary = new Error('synthetic native close refusal');
          vi.stubEnv('HOME', root);
          vi.stubEnv('USERPROFILE', root);
          writeFileSync(join(root, 'config.toml'), '');
          const agent = join(root, 'synthetic.agent.yaml');
          writeFileSync(
            agent,
            'id: synthetic\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: Synthetic test.\ntools: []\n',
          );
          const workflow = join(root, 'synthetic.relavium.yaml');
          writeFileSync(
            workflow,
            `schema_version: '1.0'
workflow:
  id: synthetic
  nodes:
    - { id: start, type: input }
    - { id: end, type: output }
  edges:
    - { from: start, to: end }
`,
          );
          vi.doMock('@relavium/db', () => ({
            ...actual,
            createClient: (...args: Parameters<typeof actual.createClient>) => {
              assertCurrent();
              const opened = actual.createClient(...args);
              if (faultEnabled) {
                native = opened;
                const nativeClose = opened.sqlite.close.bind(opened.sqlite);
                nativeDisposals.add(() => {
                  if (opened.sqlite.open) nativeClose();
                });
                opened.sqlite.close = () => {
                  attempts++;
                  if (closeFails && (!closeRecovers || attempts === 1)) throw secondary;
                  return nativeClose();
                };
              }
              return opened;
            },
            runMigrations: (...args: Parameters<typeof actual.runMigrations>) => {
              if (faultEnabled) throw primary;
              return actual.runMigrations(...args);
            },
          }));
          vi.resetModules();
          const signals = await import('../process/signals.js');
          assertCurrent();
          const removeSignals = vi.fn();
          vi.spyOn(signals, 'defaultSubscribeSignals').mockReturnValue(removeSignals);
          const { invocationFixture } = await import('../process/invocation.test-support.js');
          assertCurrent();
          const { captureIo } = await import('../test-support.js');
          assertCurrent();
          const { scriptedResolver } = await import('../chat/test-support.js');
          assertCurrent();
          const session = await import('../history/session-open.js');
          assertCurrent();
          const nativeOpen = session.openSessionStore;
          vi.spyOn(session, 'openSessionStore').mockImplementation((home, captureClose) => {
            faultEnabled = true;
            return nativeOpen(home, captureClose);
          });
          const openSessionStore = session.openSessionStore;
          const f = invocationFixture();
          const captured = captureIo();
          const common = {
            invocation: f.invocation,
            io: { ...captured.io, stdin: Readable.from(['synthetic prompt']) },
            global: {
              cwd: root,
              configPath: join(root, 'config.toml'),
              json: true,
              color: false,
              verbosity: 'normal' as const,
            },
            providers: scriptedResolver([]),
          };
          const drive = async () => {
            switch (surface) {
              case 'run': {
                const { runCommand } = await import('./run.js');
                const { openHistoryStore } = await import('../history/open.js');
                assertCurrent();
                return runCommand(
                  { workflow, input: [], allowMcpStdio: [] },
                  { ...common, openRunStore: openHistoryStore },
                );
              }
              case 'gate': {
                const { gateCommand } = await import('./gate.js');
                assertCurrent();
                return gateCommand({ runId: 'synthetic-run', approve: true }, common);
              }
              case 'chat': {
                const { chatCommand } = await import('./chat.js');
                assertCurrent();
                return chatCommand({ agent }, { ...common, openSessionStore });
              }
              case 'chat-resume': {
                const { chatResumeCommand } = await import('./chat.js');
                assertCurrent();
                return chatResumeCommand(
                  { sessionId: 'synthetic-session' },
                  { ...common, openSessionStore },
                );
              }
              case 'home': {
                const { driveHome } = await import('../home/drive-home.js');
                assertCurrent();
                return driveHome({ ...common, openSessionStore });
              }
              case 'agent': {
                const { agentRunCommand } = await import('./agent-run.js');
                assertCurrent();
                return agentRunCommand({ agent, input: [], allowMcpStdio: [] }, common);
              }
              case 'pricing': {
                const { loadUserPricingOverlay } = await import('../engine/pricing-overlay.js');
                assertCurrent();
                return loadUserPricingOverlay(root, captured.io, f.invocation);
              }
            }
          };
          let settled = false;
          const result = drive().then(
            (value) => {
              settled = true;
              return value;
            },
            (cause: unknown) => {
              settled = true;
              return cause;
            },
          );
          disposeCommand = async () => {
            void f.registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
            f.advance(3_000);
            // Before a failed native close exists, join the full import/preparation root.
            // Otherwise the deliberately unacknowledged product result remains pending.
            if (!native?.sqlite.open) await result;
          };
          await vi.waitFor(() =>
            expect(attempts, 'ACTUAL_SURFACE_REACHED_SQLITE_SETUP').toBeGreaterThan(0),
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(captured.out()).toBe('');
          expect(f.registry.observations.exitCode()).toBe(9);
          expect(f.registry.budget.deadline()).toBe(3_000);
          if (closeFails && !closeRecovers) {
            expect(native?.sqlite.open).toBe(true);
            expect(attempts, 'PARTIAL_SURFACE_RETAINS_NATIVE_CLOSE_CAPABILITY').toBe(2);
            expect(f.registry.activeOwners).toBe(1);
            expect(removeSignals).not.toHaveBeenCalled();
            // A synchronous transient operation rejects immediately while its native obligation stays owned.
            expect(settled).toBe(surface === 'pricing');
            if (surface === 'pricing')
              expect(await result).toMatchObject({ code: 'cli_internal', exitCode: 9 });
            f.advance(3_000);
            expect(await f.invocation.finiteExit.exited).toBe(9);
            expect(native?.sqlite.open).toBe(true);
            expect(f.registry.activeOwners).toBe(1);
          } else {
            expect(await result).toMatchObject({ code: 'cli_internal', exitCode: 9 });
            expect(native?.sqlite.open).toBe(false);
            expect(attempts).toBe(closeRecovers ? 2 : 1);
            expect(f.registry.observations.hasInfrastructureFailure()).toBe(true);
            expect(f.registry.activeOwners).toBe(0);
          }
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
          throw new AggregateError(failures, 'Synthetic surface fixture cleanup failed');
      })();
      return rawCase;
    },
  );
});
