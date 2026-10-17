import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const surfaces = ['run', 'gate', 'chat', 'chat-resume', 'home', 'agent', 'pricing'] as const;

describe('original surface custody of partially opened SQLite', () => {
  it.each([
    ...surfaces.flatMap((surface) =>
      [false, true].map((closeFails) => ({ surface, closeFails, closeRecovers: false })),
    ),
    { surface: 'pricing' as const, closeFails: true, closeRecovers: true },
  ])(
    '$surface preserves partial acquisition; close failure=$closeFails; later release=$closeRecovers',
    async ({ surface, closeFails, closeRecovers }) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-surface-db-'));
      const actual = await import('@relavium/db');
      let faultEnabled = !['chat', 'agent'].includes(surface);
      let native: ReturnType<typeof actual.createClient> | undefined;
      let dispose: (() => void) | undefined;
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
          const opened = actual.createClient(...args);
          if (faultEnabled) {
            native = opened;
            const nativeClose = opened.sqlite.close.bind(opened.sqlite);
            dispose = () => {
              nativeClose();
            };
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
      try {
        const signals = await import('../process/signals.js');
        const removeSignals = vi.fn();
        vi.spyOn(signals, 'defaultSubscribeSignals').mockReturnValue(removeSignals);
        const { invocationFixture } = await import('../process/invocation.test-support.js');
        const { captureIo } = await import('../test-support.js');
        const { scriptedResolver } = await import('../chat/test-support.js');
        const session = await import('../history/session-open.js');
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
              return runCommand(
                { workflow, input: [], allowMcpStdio: [] },
                { ...common, openRunStore: openHistoryStore },
              );
            }
            case 'gate': {
              const { gateCommand } = await import('./gate.js');
              return gateCommand({ runId: 'synthetic-run', approve: true }, common);
            }
            case 'chat': {
              const { chatCommand } = await import('./chat.js');
              return chatCommand({ agent }, { ...common, openSessionStore });
            }
            case 'chat-resume': {
              const { chatResumeCommand } = await import('./chat.js');
              return chatResumeCommand(
                { sessionId: 'synthetic-session' },
                { ...common, openSessionStore },
              );
            }
            case 'home': {
              const { driveHome } = await import('../home/drive-home.js');
              return driveHome({ ...common, openSessionStore });
            }
            case 'agent': {
              const { agentRunCommand } = await import('./agent-run.js');
              return agentRunCommand({ agent, input: [], allowMcpStdio: [] }, common);
            }
            case 'pricing': {
              const { loadUserPricingOverlay } = await import('../engine/pricing-overlay.js');
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
      } finally {
        if (native?.sqlite.open) dispose?.(); // Test disposal supplies no product retirement ACK.
        vi.restoreAllMocks();
        vi.doUnmock('@relavium/db');
        vi.resetModules();
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
