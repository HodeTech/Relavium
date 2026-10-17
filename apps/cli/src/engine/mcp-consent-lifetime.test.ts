import { parseWorkflow } from '@relavium/core';
import { expect, it, vi } from 'vitest';

import { SessionSurfaceLifetime } from '../chat/session-surface-lifetime.js';
import { WorkflowLifetime } from '../commands/workflow-lifetime.js';
import { CliError, toUserFacing } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import type { ResolvedStdioSpawn } from './mcp-consent.js';
import { connectAgentMcp, connectWorkflowMcp, type StdioConsentGate } from './mcp-servers.js';

const cases = (['workflow', 'agent'] as const).flatMap((surface) =>
  (['missing', 'refused', 'cancelled', 'empty'] as const).map((scenario) => ({
    surface,
    scenario,
  })),
);

it.each(cases)(
  'original $surface owner classifies $scenario MCP consent before native start',
  async ({ surface, scenario }) => {
    const f = invocationFixture();
    const start = vi.fn(() => {
      throw new Error('Unexpected native MCP entry.');
    });
    const refs = [{ id: 'private-server-id', transport: 'stdio' as const, command: 'node' }];
    const agent = {
      id: 'consent',
      provider: 'openai' as const,
      model: 'gpt-4o',
      system_prompt: 'offline',
      ...(scenario === 'empty' ? {} : { mcp_servers: refs }),
    };
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'consent',
          agents: [agent],
          nodes: [
            { id: 'input', type: 'input' },
            { id: 'agent', type: 'agent', agent_ref: 'consent' },
            { id: 'output', type: 'output' },
          ],
          edges: [
            { from: 'input', to: 'agent' },
            { from: 'agent', to: 'output' },
          ],
        },
      }),
    );
    const cancelled = new AbortController();
    if (scenario === 'cancelled') cancelled.abort();
    const gate: StdioConsentGate = () => {
      if (scenario === 'refused')
        return Promise.reject(new CliError('invalid_invocation', 'Consent was refused.'));
      return Promise.resolve(new Map<string, ResolvedStdioSpawn>());
    };
    const options = {
      cwd: process.cwd(),
      startMcpClient: start,
      ...(scenario === 'missing' || scenario === 'empty' ? {} : { consentGate: gate }),
      ...(scenario === 'cancelled' ? { connectSignal: cancelled.signal } : {}),
    };
    const lifetime =
      surface === 'workflow'
        ? new WorkflowLifetime(f.invocation, captureIo().io, () => () => {})
        : new SessionSurfaceLifetime(f.invocation, 'agent', () => () => {});
    let failed: { readonly cause: unknown } | undefined;
    const result = await lifetime
      .execute(async () => {
        if (surface === 'workflow') await connectWorkflowMcp(workflow, options);
        else await connectAgentMcp(scenario === 'empty' ? undefined : refs, options);
        return 0;
      })
      .catch((cause: unknown) => {
        failed = { cause };
        return toUserFacing(cause).exitCode;
      });
    const expected =
      scenario === 'missing' ? 9 : scenario === 'refused' ? 2 : scenario === 'cancelled' ? 1 : 0;
    expect(result, 'MISSING_CONSENT_ORIGINAL_OWNER_OUTCOME').toBe(expected);
    expect(f.registry.observations.exitCode()).toBe(expected);
    expect(f.registry.termination !== undefined).toBe(scenario === 'missing');
    expect(start).not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(0);
    if (scenario === 'missing') {
      expect(toUserFacing(failed?.cause)).toMatchObject({ code: 'cli_internal', exitCode: 9 });
      expect(toUserFacing(failed?.cause).message).not.toContain('private-server-id');
    }
  },
);
