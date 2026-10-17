import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbFaultAcquisitionCases } from './db-fault-acquisition.test-support.js';

const runCase = dbFaultAcquisitionCases();
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
    ({ surface, closeFails, closeRecovers }) =>
      runCase(
        {
          prefix: 'relavium-surface-db-',
          closeFails,
          closeRecovers,
          initiallyEnabled: !['chat', 'agent'].includes(surface),
        },
        async (fixture) => {
          const { root, assertCurrent } = fixture;
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
          vi.spyOn(session, 'openSessionStore').mockImplementation(
            (home, captureClose, noticeContext) => {
              fixture.enableFault();
              return nativeOpen(home, captureClose, noticeContext);
            },
          );
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
          fixture.disposeCommand(async () => {
            void f.registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
            f.advance(3_000);
            // Before a failed native close exists, join the full import/preparation root.
            // Otherwise the deliberately unacknowledged product result remains pending.
            if (!fixture.native()?.sqlite.open) await result;
          });
          await vi.waitFor(() =>
            expect(fixture.closeAttempts(), 'ACTUAL_SURFACE_REACHED_SQLITE_SETUP').toBeGreaterThan(
              0,
            ),
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(captured.out()).toBe('');
          expect(f.registry.observations.exitCode()).toBe(9);
          expect(f.registry.budget.deadline()).toBe(3_000);
          if (closeFails && !closeRecovers) {
            expect(fixture.native()?.sqlite.open).toBe(true);
            expect(fixture.closeAttempts(), 'PARTIAL_SURFACE_RETAINS_NATIVE_CLOSE_CAPABILITY').toBe(
              2,
            );
            expect(f.registry.activeOwners).toBe(1);
            expect(removeSignals).not.toHaveBeenCalled();
            // A synchronous transient operation rejects immediately while its native obligation stays owned.
            expect(settled).toBe(surface === 'pricing');
            if (surface === 'pricing')
              expect(await result).toMatchObject({ code: 'cli_internal', exitCode: 9 });
            f.advance(3_000);
            expect(await f.invocation.finiteExit.exited).toBe(9);
            expect(fixture.native()?.sqlite.open).toBe(true);
            expect(f.registry.activeOwners).toBe(1);
          } else {
            expect(await result).toMatchObject({ code: 'cli_internal', exitCode: 9 });
            expect(fixture.native()?.sqlite.open).toBe(false);
            expect(fixture.closeAttempts()).toBe(closeRecovers ? 2 : 1);
            expect(f.registry.observations.hasInfrastructureFailure()).toBe(true);
            expect(f.registry.activeOwners).toBe(0);
          }
        },
      ),
  );
});
