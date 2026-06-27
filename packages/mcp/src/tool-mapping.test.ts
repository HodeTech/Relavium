import type { McpCapability, ToolDispatchContext, ToolHost } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import type { DiscoveredTool } from './connection.js';
import { McpHostUnavailableError } from './errors.js';
import { buildServerToolDefs } from './tool-mapping.js';

/** A minimal valid dispatch context (dispatch only reads `ctx.signal`; the rest are required-but-inert). */
function ctx(signal?: ToolDispatchContext['signal']): ToolDispatchContext {
  return {
    nodeId: 'n1',
    grantedToolIds: new Set<string>(),
    config: {},
    toolPolicy: {},
    fsScope: 'sandboxed',
    gateApproved: false,
    ...(signal === undefined ? {} : { signal }),
  };
}

function tool(
  name: string,
  inputSchema: Record<string, unknown> = { type: 'object', properties: {} },
  description?: string,
): DiscoveredTool {
  return { name, inputSchema, ...(description === undefined ? {} : { description }) };
}

describe('buildServerToolDefs', () => {
  it('shapes a discovered tool into a namespaced mcp ToolDef (id, source, policy, description)', () => {
    const { defs, skipped } = buildServerToolDefs('github', [
      tool('create_issue', undefined, 'Open an issue'),
    ]);
    expect(skipped).toEqual([]);
    expect(defs).toHaveLength(1);
    const def = defs[0]!;
    expect(def.id).toBe('mcp_github_create_issue');
    expect(def.source).toBe('mcp');
    expect(def.description).toBe('Open an issue');
    expect(def.policy.egress).toBe('mcp');
    expect(def.policy.spawnsProcess).toBe(false);
  });

  it('parseArgs validates against the compiled inputSchema (the dispatch gate)', () => {
    const { defs } = buildServerToolDefs('s', [
      tool('t', { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }),
    ]);
    expect(defs[0]!.parseArgs({ x: 'ok' })).toEqual({ x: 'ok' });
    expect(() => defs[0]!.parseArgs({ x: 5 })).toThrow(); // wrong type
    expect(() => defs[0]!.parseArgs({})).toThrow(); // missing required
  });

  it('dispatch routes to host.mcp.call with the ORIGINAL server + tool name (not the sanitized id)', async () => {
    const calls: Array<{ input: unknown; signal: unknown }> = [];
    const mcp: McpCapability = {
      call: (input, signal) => {
        calls.push({ input, signal });
        return Promise.resolve({ ok: true });
      },
    };
    const host: ToolHost = { mcp };
    // A tool name with non-LLM-charset bytes is sanitized in the ID but preserved for routing.
    const { defs } = buildServerToolDefs('github', [tool('create-issue!')]);
    expect(defs[0]!.id).toBe('mcp_github_create-issue_'); // '!' → '_'
    await defs[0]!.dispatch({ a: 1 }, host, ctx());
    expect(calls).toEqual([
      { input: { server: 'github', tool: 'create-issue!', args: { a: 1 } }, signal: undefined },
    ]);
  });

  it('forwards the dispatch ctx.signal verbatim to host.mcp.call (the EXACT instance, not just undefined)', async () => {
    // The routing test above asserts `signal: undefined`; this pins the forwarding with a REAL AbortSignal, so a
    // regression that hard-coded `undefined` (dropping cancellation) would fail here.
    const seen: unknown[] = [];
    const host: ToolHost = {
      mcp: {
        call: (_input, signal) => {
          seen.push(signal);
          return Promise.resolve({ ok: true });
        },
      },
    };
    const realSignal = new AbortController().signal;
    const { defs } = buildServerToolDefs('s', [tool('t')]);
    await defs[0]!.dispatch({ a: 1 }, host, ctx(realSignal));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(realSignal); // the SAME instance, not a copy / not undefined
  });

  it('dispatch throws McpHostUnavailableError when the host MCP capability is not wired', () => {
    const { defs } = buildServerToolDefs('s', [tool('t')]);
    expect(() => defs[0]!.dispatch({}, {}, ctx())).toThrow(McpHostUnavailableError);
  });

  it('honors the per-server tools_allowlist (admits only listed tools)', () => {
    const { defs, skipped } = buildServerToolDefs('s', [tool('a'), tool('b')], ['a']);
    expect(defs.map((d) => d.id)).toEqual(['mcp_s_a']);
    expect(skipped).toEqual([{ name: 'b', reason: 'not in the server tools_allowlist' }]);
  });

  it('drops a tool whose inputSchema is outside the supported subset (fail closed)', () => {
    const { defs, skipped } = buildServerToolDefs('s', [
      tool('bad', { oneOf: [{ type: 'string' }] }),
    ]);
    expect(defs).toHaveLength(0);
    expect(skipped[0]!.name).toBe('bad');
    expect(skipped[0]!.reason).toMatch(/unsupported inputSchema/);
  });

  it('fails closed on a namespaced-id collision (two names sanitize to the same id)', () => {
    const { defs, skipped } = buildServerToolDefs('s', [tool('a.b'), tool('a_b')]); // both → mcp_s_a_b
    expect(defs.map((d) => d.id)).toEqual(['mcp_s_a_b']); // the first wins
    expect(skipped).toContainEqual({
      name: 'a_b',
      reason: 'namespaced id collides with another tool ("mcp_s_a_b")',
    });
  });

  it('drops a tool when the namespaced id is not a valid LLM tool id (unsafe serverId)', () => {
    const { defs, skipped } = buildServerToolDefs('bad server!', [tool('t')]);
    expect(defs).toHaveLength(0);
    expect(skipped[0]!.reason).toMatch(/not a valid LLM tool id/);
  });

  it('drops a tool with an empty / whitespace-only name (fail closed)', () => {
    const { defs, skipped } = buildServerToolDefs('s', [tool(''), tool('  '), tool('ok')]);
    expect(defs.map((d) => d.id)).toEqual(['mcp_s_ok']);
    expect(skipped).toEqual([
      { name: '', reason: 'empty tool name' },
      { name: '  ', reason: 'empty tool name' },
    ]);
  });

  it('shares a collision set across calls when one is passed (cross-server dedup)', () => {
    const seen = new Set<string>();
    const a = buildServerToolDefs('a', [tool('b_x')], undefined, seen); // → mcp_a_b_x
    const b = buildServerToolDefs('a_b', [tool('x')], undefined, seen); // → mcp_a_b_x (collision)
    expect(a.defs.map((d) => d.id)).toEqual(['mcp_a_b_x']);
    expect(b.defs).toHaveLength(0);
    expect(b.skipped[0]!.reason).toMatch(/collides with another tool/);
  });
});
