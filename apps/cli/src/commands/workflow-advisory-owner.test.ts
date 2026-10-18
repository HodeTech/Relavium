import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runEvents,
  runMigrations,
} from '@relavium/db';
import { expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { CliError, toUserFacing } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { gateCommand } from './gate.js';
import { runCommand } from './run.js';

const cases = (['run', 'gate'] as const).flatMap((surface) =>
  (['unpriced', 'effort'] as const).flatMap((notice) =>
    [false, true].map((json) => ({ surface, notice, json })),
  ),
);

it.each(cases)(
  '$surface $notice json=$json owns advisory failure before provider entry',
  async ({ surface, notice, json }) => {
    for (const faulted of [false, true]) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-workflow-notice-')));
      const client = createClient(':memory:');
      runMigrations(client.db);
      const f = invocationFixture();
      const captured = captureIo();
      const cause = new CliError('output_unavailable', '');
      const providers = scriptedResolver([textTurn('WORKFLOW_NOTICE_REPLY')]);
      const provider = providers.resolveProvider('anthropic');
      if (provider === undefined) throw new Error('Expected offline provider.');
      const stream = vi.spyOn(provider, 'stream');
      const source = JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'notice-owner',
          budget: { max_cost_microcents: 10000000, on_exceed: 'warn' },
          agents: [
            {
              id: 'a',
              provider: 'anthropic',
              model: notice === 'unpriced' ? 'synthetic-uncatalogued' : 'claude-haiku-4-5',
              system_prompt: 'offline',
              ...(notice === 'effort' ? { reasoning_effort: 'high' } : {}),
            },
          ],
          nodes: [
            ...(surface === 'gate'
              ? [{ id: 'approval', type: 'human_gate', gate_type: 'approval' }]
              : []),
            { id: 'work', type: 'agent', agent_ref: 'a', prompt_template: 'hello', max_tokens: 10 },
          ],
          edges: surface === 'gate' ? [{ from: 'approval', to: 'work' }] : [],
        },
      });
      const path = join(dir, 'workflow.relavium.yaml');
      writeFileSync(path, source);
      let closes = 0;
      let warnings = 0;
      let durableTypes: string[] = [];
      const storeFor = (def: WorkflowDefinition) =>
        createRunHistoryStore(client.db, {
          uuid: randomUUID,
          now: Date.now,
          projectRoot: dir,
          workflow: {
            slug: def.workflow.id,
            name: def.workflow.id,
            definitionJson: JSON.stringify(def),
          },
        });
      const close = () => {
        durableTypes = client.db
          .select({ type: runEvents.eventType })
          .from(runEvents)
          .all()
          .map((row) => row.type);
        closes++;
        client.sqlite.close();
      };
      const deps = {
        invocation: f.invocation,
        subscribeSignals: () => () => {},
        providers,
        io: {
          ...captured.io,
          writeErr: (text: string) => {
            if (text.startsWith('warning:')) {
              warnings++;
              if (faulted) throw cause;
            }
            captured.io.writeErr(text);
          },
        },
        global: {
          cwd: dir,
          json,
          color: false,
          configPath: join(dir, 'absent.toml'),
          verbosity: 'normal' as const,
        },
      };
      try {
        let result: number;
        if (surface === 'run') {
          result = await runCommand(
            { workflow: path, input: [], allowMcpStdio: [] },
            {
              ...deps,
              openRunStore: (def, _home, _cwd, captureClose) => {
                captureClose?.(close);
                return {
                  db: client.db,
                  store: storeFor(def),
                  close,
                  terminalOutboxPath: join(dir, 'terminal-outbox.ndjson'),
                };
              },
            },
          ).catch((failure: unknown) => toUserFacing(failure).exitCode);
        } else {
          const def = parseWorkflow(source, { source: 'advisory-fixture' });
          const store = storeFor(def);
          const engine = await buildEngine({
            providers,
            host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
          });
          const handle = engine.start({ workflow: def, inputs: {} });
          for await (const event of handle.events) if (event.type === 'run:paused') break;
          expect(stream).not.toHaveBeenCalled();
          result = await gateCommand(
            { runId: handle.runId, approve: true },
            {
              ...deps,
              openDb: (_home, captureClose) => {
                captureClose?.(close);
                return { db: client.db, close };
              },
            },
          ).catch((failure: unknown) => toUserFacing(failure).exitCode);
        }
        expect(result, 'WORKFLOW_ADVISORY_ORIGINAL_OWNER').toBe(faulted ? 9 : 0);
        expect(warnings).toBe(1);
        expect(stream, 'WORKFLOW_ADVISORY_REFUSES_PAID_ENTRY').toHaveBeenCalledTimes(
          faulted ? 0 : 1,
        );
        expect(f.registry.observations.exitCode()).toBe(faulted ? 9 : 0);
        expect(f.registry.termination !== undefined).toBe(faulted);
        expect(f.registry.activeOwners).toBe(0);
        expect(closes).toBe(1);
        expect(client.sqlite.open).toBe(false);
        expect(
          durableTypes.filter((type) =>
            ['run:completed', 'run:cancelled', 'run:failed'].includes(type),
          ),
        ).toEqual([faulted ? 'run:cancelled' : 'run:completed']);
        if (!faulted)
          expect(captured.err()).toContain(
            notice === 'unpriced' ? 'has no price' : 'needs a larger max_tokens',
          );
      } finally {
        stream.mockRestore();
        if (client.sqlite.open) client.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
