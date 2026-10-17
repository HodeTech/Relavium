import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import { dbFaultAcquisitionCases } from './db-fault-acquisition.test-support.js';

const runCase = dbFaultAcquisitionCases();

it.each(['run', 'gate', 'logs', 'status', 'chat-list', 'chat-export'] as const)(
  '%s supplies captured notice I/O and its original invocation to the database hook',
  (surface) =>
    runCase({ prefix: 'relavium-notice-context-', closeFails: false }, async (fixture) => {
      const { root, assertCurrent } = fixture;
      const { invocationFixture } = await import('../process/invocation.test-support.js');
      assertCurrent();
      const { captureIo } = await import('../test-support.js');
      assertCurrent();
      const { CommandLifetime } = await import('../process/command-lifetime.js');
      assertCurrent();
      const [run, gate, logs, status, chatList, chatExport] = await Promise.all([
        import('./run.js'),
        import('./gate.js'),
        import('./logs.js'),
        import('./status.js'),
        import('./chat-list.js'),
        import('./chat-export.js'),
      ]);
      assertCurrent();
      const { CliError } = await import('../process/cli-error.js');
      assertCurrent();
      const f = invocationFixture();
      const captured = captureIo();
      const command =
        surface === 'run' || surface === 'gate'
          ? undefined
          : new CommandLifetime(f.invocation, captured.io, () => () => undefined);
      const io = command?.io ?? captured.io;
      const refusal = new CliError('invalid_invocation', 'Synthetic notice hook stop');
      let seen: LocalDbNoticeContext | undefined;
      const observe = vi.fn((context: LocalDbNoticeContext | undefined): never => {
        seen = context;
        throw refusal;
      });
      const openDb = (
        _home: string,
        _capture?: (close: () => void) => void,
        context?: LocalDbNoticeContext,
      ): never => observe(context);
      const common = {
        io,
        invocation: f.invocation,
        ...(command === undefined ? {} : { commandLifetime: command }),
        subscribeSignals: () => () => undefined,
        global: {
          cwd: root,
          configPath: join(root, 'config.toml'),
          json: true,
          color: false,
          verbosity: 'normal' as const,
        },
      };
      const workflow = join(root, 'notice.relavium.yaml');
      writeFileSync(
        workflow,
        `schema_version: '1.0'
workflow:
  id: notice-context
  nodes:
    - {id: start, type: input}
    - {id: end, type: output}
  edges:
    - {from: start, to: end}
`,
      );
      const invoke = () => {
        switch (surface) {
          case 'run':
            return run.runCommand(
              { workflow, input: [], allowMcpStdio: [] },
              {
                ...common,
                openRunStore: (_definition, _home, _cwd, _close, context) => observe(context),
              },
            );
          case 'gate':
            return gate.gateCommand({ runId: 'synthetic', approve: true }, { ...common, openDb });
          case 'logs':
            return logs.logsCommand({ runId: 'synthetic' }, { ...common, openDb });
          case 'status':
            return status.statusCommand({ ...common, openDb });
          case 'chat-list':
            return chatList.chatListCommand({ ...common, openSessionStore: openDb });
          case 'chat-export':
            return chatExport.chatExportCommand(
              { sessionId: 'synthetic', force: false },
              {
                ...common,
                openSessionStore: openDb,
              },
            );
        }
      };
      const outcome = await (
        command === undefined
          ? Promise.resolve().then(invoke)
          : command.execute(() => Promise.resolve().then(invoke))
      ).catch((cause: unknown) => cause);
      expect(outcome).toBe(refusal);
      expect(observe).toHaveBeenCalledOnce();
      expect(seen?.io, 'DATABASE_NOTICE_USES_CAPTURED_IO').toBe(io);
      expect(seen?.invocation, 'DATABASE_NOTICE_USES_ORIGINAL_INVOCATION').toBe(f.invocation);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.hasInfrastructureFailure()).toBe(false);
      expect(f.exit).not.toHaveBeenCalled();
      expect(captured.out()).toBe('');
    }),
);
