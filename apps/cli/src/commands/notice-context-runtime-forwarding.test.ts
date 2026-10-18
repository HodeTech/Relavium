import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeAll, expect, it, vi } from 'vitest';

import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import { dbFaultAcquisitionCases } from './db-fault-acquisition.test-support.js';

const runCase = dbFaultAcquisitionCases();
beforeAll(async () => {
  // Transform the production surfaces before entering the per-case native custody budget.
  await Promise.all([
    import('./chat.js'),
    import('./agent-run.js'),
    import('../home/drive-home.js'),
    import('./dispatch.js'),
  ]);
});

const cases = [
  ...(['chat', 'chat-resume', 'home'] as const).flatMap((surface) =>
    [false, true].map((owned) => ({ surface, owned })),
  ),
  ...(
    [
      'agent',
      'pricing',
      'dispatch-resolver',
      'dispatch-models',
      'dispatch-provider',
      'dispatch-pricing',
    ] as const
  ).map((surface) => ({ surface, owned: true })),
];

it.each(cases)(
  '$surface forwards its captured notice context and partial-close capability; owned=$owned',
  ({ surface, owned }) =>
    runCase({ prefix: 'relavium-notice-runtime-', closeFails: false }, async (fixture) => {
      const { root, assertCurrent } = fixture;
      const { invocationFixture } = await import('../process/invocation.test-support.js');
      assertCurrent();
      const { captureIo } = await import('../test-support.js');
      assertCurrent();
      const { scriptedResolver } = await import('../chat/test-support.js');
      assertCurrent();
      const signals = await import('../process/signals.js');
      assertCurrent();
      vi.spyOn(signals, 'defaultSubscribeSignals').mockReturnValue(() => undefined);
      const { CliError } = await import('../process/cli-error.js');
      assertCurrent();
      const { CommandLifetime } = await import('../process/command-lifetime.js');
      assertCurrent();
      const pricing = await import('../engine/pricing-overlay.js');
      assertCurrent();
      const local = await import('../db/open.js');
      assertCurrent();
      const session = await import('../history/session-open.js');
      assertCurrent();

      const f = invocationFixture();
      const captured = captureIo();
      const command =
        surface.startsWith('dispatch-') && surface !== 'dispatch-resolver'
          ? new CommandLifetime(f.invocation, captured.io, () => () => undefined)
          : undefined;
      const io = command?.io ?? { ...captured.io, stdin: Readable.from(['synthetic prompt']) };
      const refusal = new CliError('invalid_invocation', 'Synthetic notice hook stop');
      const close = vi.fn();
      let seen: LocalDbNoticeContext | undefined;
      let seenCapture: ((close: () => void) => void) | undefined;
      const observe = vi.fn(
        (capture: typeof seenCapture, context?: LocalDbNoticeContext): never => {
          seenCapture = capture;
          seen = context;
          capture?.(close);
          throw refusal;
        },
      );
      const openSessionStore = (
        _home: string,
        capture?: (close: () => void) => void,
        context?: LocalDbNoticeContext,
      ): never => observe(capture, context);
      // Keep optional pricing acquisition separate from each authoritative session-store call.
      const overlay =
        surface === 'pricing'
          ? undefined
          : vi.spyOn(pricing, 'loadUserPricingOverlay').mockReturnValue(undefined);
      if (surface === 'agent')
        vi.spyOn(session, 'openSessionStore').mockImplementation(openSessionStore);
      if (surface === 'pricing' || surface.startsWith('dispatch-')) {
        vi.spyOn(local, 'openLocalDb').mockImplementation((_home, _options, capture, context) =>
          observe(capture, context),
        );
      }
      const common = {
        io,
        ...(owned ? { invocation: f.invocation } : {}),
        ...(command === undefined ? {} : { commandLifetime: command }),
        subscribeSignals: () => () => undefined,
        global: {
          cwd: root,
          configPath: join(root, 'config.toml'),
          json: true,
          color: false,
          verbosity: 'normal' as const,
        },
        providers: scriptedResolver([]),
      };
      const agent = join(root, 'notice.agent.yaml');
      writeFileSync(
        agent,
        'id: notice\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: Synthetic test.\ntools: []\n',
      );
      const invoke = async () => {
        switch (surface) {
          case 'chat': {
            const { chatCommand } = await import('./chat.js');
            assertCurrent();
            return chatCommand({ agent }, { ...common, openSessionStore });
          }
          case 'chat-resume': {
            const { chatResumeCommand } = await import('./chat.js');
            assertCurrent();
            return chatResumeCommand({ sessionId: 'synthetic' }, { ...common, openSessionStore });
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
          case 'pricing':
            return pricing.loadUserPricingOverlay(root, io, f.invocation);
          default: {
            const { executeCommand } = await import('./dispatch.js');
            assertCurrent();
            const route = {
              'dispatch-resolver': { id: 'chat', positionals: [], options: {} },
              'dispatch-models': { id: 'models', positionals: [], options: {} },
              'dispatch-provider': { id: 'provider.list', positionals: [], options: {} },
              'dispatch-pricing': {
                id: 'models.pricing',
                positionals: ['synthetic-model'],
                options: { provider: 'anthropic', clear: true },
              },
            }[surface];
            return executeCommand(route.id, route, common);
          }
        }
      };
      const outcome = await (
        command === undefined
          ? invoke()
          : command.execute(async () => {
              await invoke();
              return 0;
            })
      ).catch((cause: unknown) => cause);
      expect(outcome).toBe(refusal);
      expect(observe).toHaveBeenCalledOnce();
      // Agent output is owned by its surface. Its pricing port witnesses that same captured writer.
      const expectedIo = surface === 'agent' ? overlay?.mock.calls[0]?.[1] : io;
      expect(expectedIo).toBeDefined();
      expect(seen?.io, 'DATABASE_NOTICE_USES_CAPTURED_IO').toBe(expectedIo);
      expect(seen?.invocation, 'DATABASE_NOTICE_USES_ORIGINAL_INVOCATION').toBe(
        owned ? f.invocation : undefined,
      );
      if (owned) {
        expect(seenCapture, 'DATABASE_OPENER_CAPTURES_PARTIAL_CLOSE').toBeTypeOf('function');
        expect(close, 'DATABASE_PARTIAL_CLOSE_REMAINS_OWNED').toHaveBeenCalledOnce();
      } else {
        expect(seenCapture).toBeUndefined();
        expect(close).not.toHaveBeenCalled();
      }
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.hasInfrastructureFailure()).toBe(false);
      expect(f.exit).not.toHaveBeenCalled();
      expect(captured.out()).toBe('');
    }),
);
