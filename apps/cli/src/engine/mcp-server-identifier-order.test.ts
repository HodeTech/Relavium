import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import type { McpClient } from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { connectWorkflowMcp, type ConnectWorkflowMcpOptions } from './mcp-servers.js';

const VALUE_CANARY = 'synthetic-private-env-value';
const REF_CANARY = '{{secrets.synthetic_private_ref}}';

function workflow(left: McpServerRef, right: McpServerRef): WorkflowDefinition {
  return parseWorkflow(
    `schema_version: '1.0'\nworkflow:\n  id: ordering\n  agents:\n    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [${JSON.stringify(left)}] }\n    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [${JSON.stringify(right)}] }\n  nodes:\n    - { id: s, type: input }\n    - { id: a, type: agent, agent_ref: scanner, prompt_template: go }\n    - { id: o, type: output }\n  edges:\n    - { from: s, to: a }\n    - { from: a, to: o }\n`,
  );
}

function server(overrides: Partial<McpServerRef> = {}): McpServerRef {
  return {
    id: 'fs',
    transport: 'stdio',
    command: 'fixture-server',
    args: ['first', 'second'],
    ...overrides,
  };
}

function fixture() {
  const close = vi.fn(() => Promise.resolve());
  const client: McpClient = {
    capability: { call: () => Promise.resolve({ content: [], isError: false }) },
    toolDefs: [],
    toolIdsByServer: new Map([['fs', ['mcp_fs_read']]]),
    childPids: [],
    skipped: [],
    close,
  };
  const consentGate = vi.fn<NonNullable<ConnectWorkflowMcpOptions['consentGate']>>(() =>
    Promise.resolve(new Map()),
  );
  const startMcpClient = vi.fn<NonNullable<ConnectWorkflowMcpOptions['startMcpClient']>>(() =>
    Promise.resolve(client),
  );
  return {
    close,
    consentGate,
    startMcpClient,
    options: { cwd: '/w', consentGate, startMcpClient } satisfies ConnectWorkflowMcpOptions,
  };
}

function expectGrants(def: WorkflowDefinition): void {
  for (const id of ['scanner', 'writer']) {
    const agent = def.workflow.agents?.find((entry) => 'id' in entry && entry.id === id);
    expect(agent, '[MCP-GRANT-POSITIVE] actual augmented inline agent is present').toBeDefined();
    if (agent !== undefined && 'id' in agent) expect(agent.tools).toEqual(['mcp_fs_read']);
  }
}

describe('actual workflow MCP private dedup identifier ordering', () => {
  it('[MCP-SET-IDENTITY] same env and allowlist sets in different insertion orders share one real runtime', async () => {
    const left = server({
      env: { Z_KEY: 'z', a_key: 'a', A_KEY: 'A' },
      tools_allowlist: ['a_b', 'a-b', 'a', 'Z'],
    });
    const right = server({
      env: { A_KEY: 'A', Z_KEY: 'z', a_key: 'a' },
      tools_allowlist: ['Z', 'a', 'a-b', 'a_b'],
    });
    const def = workflow(left, right);
    const h = fixture();
    const runtime = await connectWorkflowMcp(def, h.options);
    expect(runtime).toBeDefined();
    try {
      expect(h.startMcpClient).toHaveBeenCalledOnce();
      expect(h.startMcpClient.mock.calls[0]?.[0]).toHaveLength(1);
      expect(h.startMcpClient.mock.calls[0]?.[0][0]?.toolsAllowlist).toEqual([
        'a_b',
        'a-b',
        'a',
        'Z',
      ]);
      expect(h.consentGate).toHaveBeenCalledOnce();
      expect(h.consentGate.mock.calls[0]?.[0]).toHaveLength(1);
      if (runtime !== undefined) expectGrants(runtime.workflow);
    } finally {
      await runtime?.client.close();
    }
    expect(h.close).toHaveBeenCalledOnce();
  });

  for (const axis of ['env', 'allowlist']) {
    it(`[MCP-NO-AMBIENT-${axis.toUpperCase()}] actual dedup shares without ambient collation on this arm`, async () => {
      const left =
        axis === 'env'
          ? server({ env: { Z_KEY: 'z', a_key: 'a', A_KEY: 'A' }, tools_allowlist: ['read'] })
          : server({ env: {}, tools_allowlist: ['a_b', 'a-b', 'a', 'Z'] });
      const right =
        axis === 'env'
          ? server({ env: { A_KEY: 'A', Z_KEY: 'z', a_key: 'a' }, tools_allowlist: ['read'] })
          : server({ env: {}, tools_allowlist: ['Z', 'a', 'a-b', 'a_b'] });
      // Parse before observing the comparator: this isolates the production dedup join, not unrelated schema work.
      const def = workflow(left, right);
      const h = fixture();
      const collation = vi.spyOn(String.prototype, 'localeCompare');
      try {
        const runtime = await connectWorkflowMcp(def, h.options);
        expect(
          runtime,
          '[MCP-POSITIVE] sharing must reach a defined runtime, not an expected refusal',
        ).toBeDefined();
        expect(h.startMcpClient).toHaveBeenCalledOnce();
        expect(h.startMcpClient.mock.calls[0]?.[0]).toHaveLength(1);
        expect(h.consentGate).toHaveBeenCalledOnce();
        expect(
          collation,
          '[MCP-NO-AMBIENT] this independent fingerprint arm never invokes localeCompare',
        ).not.toHaveBeenCalled();
        if (runtime !== undefined) {
          expectGrants(runtime.workflow);
          await runtime.client.close();
        }
      } finally {
        collation.mockRestore();
      }
    });
  }

  const CONFLICTS: ReadonlyArray<{ label: string; left: McpServerRef; right: McpServerRef }> = [
    {
      label: 'env-value',
      left: server({ env: { A_KEY: VALUE_CANARY } }),
      right: server({ env: { A_KEY: REF_CANARY } }),
    },
    {
      label: 'allowlist-member',
      left: server({ tools_allowlist: ['Z', 'a'] }),
      right: server({ tools_allowlist: ['Z', 'a_b'] }),
    },
    { label: 'args-order', left: server(), right: server({ args: ['second', 'first'] }) },
  ];
  for (const conflict of CONFLICTS) {
    it(`[MCP-CONFLICT-${conflict.label.toUpperCase()}] real changed identity refuses before consent/start without values`, async () => {
      const def = workflow(conflict.left, conflict.right);
      const h = fixture();
      let rejection: unknown;
      try {
        await connectWorkflowMcp(def, h.options);
      } catch (error) {
        rejection = error;
      }
      expect(isCliError(rejection)).toBe(true);
      if (isCliError(rejection)) {
        expect(rejection.code).toBe('invalid_invocation');
        expect(rejection.message).toMatch(/fs.*conflicting settings|conflicting settings.*fs/);
        expect(rejection.message).not.toContain(VALUE_CANARY);
        expect(rejection.message).not.toContain('synthetic_private_ref');
      }
      expect(
        h.consentGate,
        '[MCP-CONFLICT-CUT] conflict precedes local-spawn consent',
      ).not.toHaveBeenCalled();
      expect(
        h.startMcpClient,
        '[MCP-CONFLICT-CUT] conflict starts no transport',
      ).not.toHaveBeenCalled();
    });
  }

  it('[MCP-EMPTY-PARSE-REFUSAL] authored empty allowlist is refused by the actual workflow parser', () => {
    expect(() => workflow(server(), server({ tools_allowlist: [] }))).toThrow(
      /writer.*tools_allowlist.*must name at least one tool/,
    );
    // Omission remains a real parser positive; it is the authored spelling for admitting all tools.
    expect(workflow(server(), server()).workflow.agents).toHaveLength(2);
  });

  it('[MCP-ALL-VERSUS-NONE-API] typed API-only empty sentinel conflicts with omitted allowlist before consent', async () => {
    const parsed = workflow(server(), server());
    // The public connect API can receive a typed definition directly. Empty arrays are deliberately
    // constructed here to preserve its private null-versus-[] fingerprint distinction; the separate
    // parser control above proves this does not claim an authored workflow can admit an empty list.
    const def: WorkflowDefinition = {
      ...parsed,
      workflow: {
        ...parsed.workflow,
        agents: (parsed.workflow.agents ?? []).map((entry) =>
          'id' in entry && entry.id === 'writer'
            ? { ...entry, mcp_servers: [server({ tools_allowlist: [] })] }
            : entry,
        ),
      },
    };
    const h = fixture();
    let rejection: unknown;
    try {
      await connectWorkflowMcp(def, h.options);
    } catch (error) {
      rejection = error;
    }
    expect(isCliError(rejection)).toBe(true);
    if (isCliError(rejection)) {
      expect(rejection.code).toBe('invalid_invocation');
      expect(rejection.message).toMatch(/fs.*conflicting settings/);
    }
    expect(h.consentGate).not.toHaveBeenCalled();
    expect(h.startMcpClient).not.toHaveBeenCalled();
  });
});
