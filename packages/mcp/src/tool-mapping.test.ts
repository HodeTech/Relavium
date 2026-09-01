import { unwiredEffectJournal } from '@relavium/core';
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
    // The LOUD unwired journal (ADR-0080): an MCP tool is permanently tier 3, so a fixture that did
    // dispatch one must journal it — a silent no-op here would hide exactly that.
    effects: unwiredEffectJournal(),
    effectSlot: 0,
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

describe('every discovered MCP tool is permanently tier 3 (ADR-0080 §5)', () => {
  it('declares effect 3 and never claims its duplicates are benign', () => {
    // The claim is that tier 3 is TERMINAL for MCP, not a placeholder pending richer metadata: a server's
    // own annotations are attacker-controlled bytes from the very party the hostile-MCP class defends
    // against, so they may never RAISE trust. `effect` is optional on `ToolDef`, so dropping this
    // declaration is both type-legal and — until this test — invisible: every dispatch to a hostile or
    // buggy MCP server would silently stop being journaled.
    const { defs } = buildServerToolDefs('fs', [
      { name: 'read', inputSchema: { type: 'object', properties: {} } },
    ]);
    const def = defs[0];
    expect(def?.effect?.({})).toBe(3);
    // …and `duplicationBenign` is first-party-only. A server that could set it would journal nothing.
    expect(def?.duplicationBenign).toBeUndefined();
  });
});

describe('tool DEFINITIONS are untrusted content (#202, ADR-0088 §7.1)', () => {
  /**
   * `packages/core`'s `Untrusted<T>` brand covers tool RESULTS. A server's `description` and `inputSchema` are
   * equally attacker-controlled and reach the model in the tool spec itself, never passing that boundary —
   * the real-world "MCP tool poisoning" channel. They are NOT routed through the brand, and §7.2 says why:
   * the brand's guarantee is that a value cannot reach prompt assembly without an explicit unwrap, and a tool
   * definition's whole purpose is to reach the model. Sanitization at discovery plus a stated provenance is
   * the honest mechanism; a brand here would imply a structural property that does not exist.
   */
  const withSchema = (
    name: string,
    description: string,
    inputSchema: unknown = {
      type: 'object',
      properties: {},
    },
  ): DiscoveredTool => ({
    name,
    description,
    inputSchema: inputSchema as DiscoveredTool['inputSchema'],
  });

  it('SANITIZES a description carrying ANSI escapes, rather than dropping the tool', () => {
    // A description is presentation text: stripping it changes nothing else, and the tool stays usable.
    const shaped = buildServerToolDefs('s', [
      withSchema('ok', 'reads a file\u001b[31m\u001b]0;pwned\u0007 and returns it'),
    ]);
    expect(shaped.defs).toHaveLength(1);
    expect(shaped.defs[0]?.description).toBe('reads a file and returns it');
  });

  it('SANITIZES a description carrying Trojan-Source bidi controls', () => {
    // The bytes that reorder how a terminal renders a line — a description that displays as one thing and
    // reads as another is the whole point of the attack.
    const shaped = buildServerToolDefs('s', [withSchema('ok', 'safe\u202Ednegrous\u202C')]);
    expect(shaped.defs[0]?.description).not.toMatch(/[\u202A-\u202E]/);
  });

  it('DROPS a tool whose NAME carries a control byte — a name cannot be rewritten', () => {
    // Rewriting it would desynchronise the model-visible id, the routing closure and the wire contract.
    const shaped = buildServerToolDefs('s', [withSchema('read\u001b[31m', 'fine')]);
    expect(shaped.defs).toHaveLength(0);
    expect(shaped.skipped[0]?.reason).toMatch(/tool name contains a terminal-control/);
  });

  it('SANITIZES the skipped-tool DIAGNOSTIC — the path a hostile server actually takes', () => {
    // **The half the drop above left open.** §7.1 sanitizes an ADMITTED tool's description because a poisoned
    // string otherwise reaches a log, an approval prompt and the provider before anyone strips it. A REFUSED
    // tool's name and reason are the same bytes from the same source, and they were carried raw all the way
    // to `client.skipped` — the record every host renders when a server misbehaves. The tool above is dropped
    // for its name; that name is then quoted straight back into the diagnostic.
    const shaped = buildServerToolDefs('s', [withSchema('read\u001b[31m\u202Eevil', 'fine')]);
    expect(shaped.defs).toHaveLength(0);
    // Compared to the exact expected string, so the assertion names the whole result rather than probing it
    // with a control-character class the linter (rightly) refuses in a regex.
    expect(shaped.skipped[0]?.name).toBe('readevil'); // ANSI and bidi both gone
  });

  it('refuses a control-bearing SCHEMA before the compiler can quote the server into a reason', () => {
    // **Why the reason arm of that boundary is not currently a live channel, pinned rather than assumed.**
    // The compiler's own refusals DO interpolate server text (`unsupported JSON-Schema construct: "<key>"`),
    // which would put a hostile key into the diagnostic. It cannot happen today only because
    // `semanticControlByte` runs FIRST and drops any schema carrying a control byte anywhere, answering with
    // a fixed string of ours. That ordering is the whole guarantee, so it gets a test: move the compile ahead
    // of the walker and this reason turns into the server's bytes.
    // An unsupported `type` VALUE, because that is the refusal that quotes the server verbatim. The first
    // attempt used a hostile schema KEY and did not discriminate at all: the compiler tolerates an unknown
    // root key, so the walker answered under both orderings and the test passed against its own mutation.
    const shaped = buildServerToolDefs('s', [
      withSchema('ok', 'fine', { type: 'weird\u001b[31m' }),
    ]);
    expect(shaped.defs).toHaveLength(0);
    expect(shaped.skipped[0]?.reason).toBe(
      'inputSchema contains a terminal-control or bidi character',
    );
    // Compile-first, the reason becomes `unsupported JSON-Schema type: "weird…"` — the server's own bytes.
    expect(shaped.skipped[0]?.reason).not.toMatch(/weird/);
  });

  it('DROPS a tool whose SCHEMA hides a control byte, wherever in it', () => {
    // A property name, a `const`, a nested description — all reach the provider inside `llmVisibleParams`,
    // and all are semantic in the sense that matters: the validator and the server agree on them.
    for (const schema of [
      { type: 'object', properties: { ['bad\u001b[31m']: { type: 'string' } } },
      { type: 'object', properties: { a: { const: 'x\u0007y' } } },
      { type: 'object', properties: { a: { type: 'string', description: 'hidden\u202E' } } },
    ]) {
      const shaped = buildServerToolDefs('s', [withSchema('ok', 'fine', schema)]);
      expect(shaped.defs).toHaveLength(0);
      expect(shaped.skipped[0]?.reason).toMatch(/inputSchema contains a terminal-control/);
    }
  });

  it('admits a DEEPLY NESTED but clean schema — the walk must not refuse what the compiler accepts', () => {
    // **A review measured this failing.** The walk's first budget was a depth ceiling "mirroring the
    // compiler's MAX_DEPTH", but a JS walk also descends through each `properties` container, so its depth
    // grows twice as fast: a control-byte-free schema at semantic depth 8 — well inside the compiler's
    // budget — was reported "unsafe" and the tool was dropped with a message naming a defect it did not have.
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 12; i += 1) {
      schema = { type: 'object', properties: { nested: schema } };
    }
    const shaped = buildServerToolDefs('s', [withSchema('deep', 'fine', schema)]);
    expect(shaped.skipped).toEqual([]);
    expect(shaped.defs).toHaveLength(1);
  });

  it('still refuses a control byte hidden at the BOTTOM of a deep schema', () => {
    // The negative control for the test above: raising the bound must not have stopped it looking.
    let schema: Record<string, unknown> = { const: 'payload\u001b[31m' };
    for (let i = 0; i < 12; i += 1) {
      schema = { type: 'object', properties: { nested: schema } };
    }
    const shaped = buildServerToolDefs('s', [withSchema('deep', 'fine', schema)]);
    expect(shaped.defs).toHaveLength(0);
    expect(shaped.skipped[0]?.reason).toMatch(/inputSchema contains a terminal-control/);
  });

  it('leaves an ordinary tool completely untouched', () => {
    // The negative control: a strip that mangled legitimate text would be worse than no strip, and every
    // refusal test above would still pass against it.
    const shaped = buildServerToolDefs('s', [
      withSchema(
        'read_file',
        'Reads a file. Accepts a path — returns UTF-8 text, or an error.\nUse it.',
      ),
    ]);
    expect(shaped.defs).toHaveLength(1);
    expect(shaped.defs[0]?.description).toBe(
      'Reads a file. Accepts a path — returns UTF-8 text, or an error.\nUse it.',
    );
  });
});
