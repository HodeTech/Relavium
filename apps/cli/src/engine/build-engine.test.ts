import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createInMemoryHost,
  parseWorkflow,
  type McpCapability,
  type RunHandle,
} from '@relavium/core';
import { estimateResolvedNextCost, type LlmRequest } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import { buildServerToolDefs } from '@relavium/mcp';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEngine } from './build-engine.js';
import { createCliHost } from './host.js';
import { createHistoryCheckpointer } from './checkpointer.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';

describe('buildEngine configured output fallback (ADR-0101)', () => {
  it.each([undefined, 17])(
    'binds the fallback into real workflow admission without inventing a wire cap (%s)',
    async (maxTokensEstimate) => {
      const model = 'gpt-5.4-mini';
      const low = estimateResolvedNextCost(model, 100, 17);
      const high = estimateResolvedNextCost(model, 100, 4096);
      const cap = Math.round((low + high) / 2);
      const requests: LlmRequest[] = [];
      const resolver = scriptedResolver([textTurn('done')], 'openai');
      const p = resolver.resolveProvider('openai');
      if (p === undefined) throw new Error('missing provider');
      const engine = await buildEngine({
        host: createInMemoryHost(),
        ...(maxTokensEstimate === undefined ? {} : { maxTokensEstimate }),
        providers: {
          ...resolver,
          resolveProvider: (id) =>
            id === 'openai'
              ? {
                  ...p,
                  stream: (request, key) => {
                    requests.push(request);
                    return p.stream(request, key);
                  },
                }
              : undefined,
        },
      });
      const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: configured-admission
  budget: { max_cost_microcents: ${cap}, on_exceed: fail }
  agents:
    - { id: worker, model: ${model}, provider: openai, system_prompt: inspect }
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: worker, prompt_template: go }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }
`);
      const handle = engine.start({ workflow });
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(requests).toHaveLength(maxTokensEstimate === undefined ? 0 : 1);
      expect(events.some((event) => event.type === 'run:completed')).toBe(
        maxTokensEstimate !== undefined,
      );
      expect(events.some((event) => event.type === 'run:failed')).toBe(
        maxTokensEstimate === undefined,
      );
      if (maxTokensEstimate !== undefined) expect(requests[0]?.maxTokens).toBeUndefined();
    },
  );
});

/**
 * Wiring-level coverage for the 2.S media deps `buildEngine` threads into `AgentRunnerDeps`
 * (`resolveMediaSurface` / `resolveForEgress` / `mediaCostEstimate`). The DEEP generative routing
 * behavior — a `'generative'` surface routing an agent node to `generateMedia`, the de-inline to a
 * handle, and the per-modality cost addend — is exercised at the engine level in
 * `packages/core/src/engine/agent-runner.test.ts`; the full `relavium run` end-to-end is the 2.S
 * acceptance fixture (the run-path caller wiring). Here we assert the assembler accepts + binds the deps.
 */
describe('buildEngine media wiring (2.S)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it('binds the media deps when a media host + routing/cost options are given (resolveForEgress ← host CAS)', async () => {
    const casRoot = mkdtempSync(join(tmpdir(), 'relavium-cas-'));
    const client = createClient(':memory:');
    cleanups.push(
      () => client.sqlite.close(),
      () => rmSync(casRoot, { recursive: true, force: true }),
    );
    runMigrations(client.db);
    const host = createCliHost(undefined, { media: { casRoot, referenceDb: client.db } });
    // The media deps thread through without error; `resolveForEgress` binds to the single `host.mediaStore`
    // CAS (one store backs both the de-inline and the failover re-materialization, ADR-0042).
    const engine = await buildEngine({
      host,
      resolveMediaSurface: () => 'generative',
      mediaCostEstimate: { image: 1 },
    });
    expect(engine).toBeDefined();
  });

  it('builds a text-only engine when no media options/host are given (the deps stay absent, no throw)', async () => {
    const engine = await buildEngine();
    expect(engine).toBeDefined();
  });
});

/**
 * Wiring-level coverage for the 2.R `options.mcp` arm (composes the discovered ToolDefs into the registry +
 * `AgentRunnerDeps.tools` and the `McpCapability` onto `ToolHost.mcp`). Note the registry `tools` and
 * `AgentRunnerDeps.tools` are assembled from the SAME `tools` const, so they cannot structurally diverge. The
 * deep behavior — a granted MCP tool surfacing to the LLM and routing a `tools/call` — is the `relavium run`
 * acceptance e2e (`commands/run.test.ts`); here we assert the assembler accepts + binds the option without throw.
 */
describe('buildEngine MCP wiring (2.R)', () => {
  it('accepts the mcp option (discovered ToolDefs + capability) and binds without throwing', async () => {
    const { defs } = buildServerToolDefs('fs', [{ name: 'read', inputSchema: { type: 'object' } }]);
    const capability: McpCapability = {
      call: () => Promise.resolve({ content: [], isError: false }),
    };
    const engine = await buildEngine({ mcp: { toolDefs: defs, capability } });
    expect(engine).toBeDefined();
  });

  it('actually COMPOSES the discovered ToolDefs into the registry — a duplicate id is rejected (proves the option is not ignored)', async () => {
    // WorkflowEngine is opaque (private fields), so observe the wiring indirectly: createToolRegistry throws on a
    // duplicate tool id, and the mcp toolDefs reach it ONLY if `options.mcp` is honored. Passing the SAME def
    // twice therefore MUST reject — if the option were silently dropped, this would build cleanly.
    const { defs } = buildServerToolDefs('fs', [{ name: 'read', inputSchema: { type: 'object' } }]);
    const capability: McpCapability = {
      call: () => Promise.resolve({ content: [], isError: false }),
    };
    await expect(
      buildEngine({ mcp: { toolDefs: [...defs, ...defs], capability } }),
    ).rejects.toThrow(/duplicate tool id/);
  });

  it('keeps the mcp toolDefs in the registry when toolEnv is ALSO set (the mcp option is not dropped, ADR-0055)', async () => {
    // The prior bug REPLACED the host with `{ mcp }`, dropping a sibling fs/process arm. The duplicate-id
    // rejection firing here proves the mcp toolDefs reach the SAME registry when `toolEnv` is also present (the
    // mcp option is not silently dropped). It does NOT prove the fs/process ARMS survive at dispatch time —
    // WorkflowEngine is opaque to its host. That end-to-end host-merge proof lives in session-host.test.ts
    // ("MERGE-not-replace: a session with MCP keeps the fs arm too"), which dispatches read_file via host.fs AND
    // an MCP tool via host.mcp in one session and asserts both succeed.
    const { defs } = buildServerToolDefs('fs', [{ name: 'read', inputSchema: { type: 'object' } }]);
    const capability: McpCapability = {
      call: () => Promise.resolve({ content: [], isError: false }),
    };
    const toolEnv = { workspaceDir: tmpdir(), fsScopeTier: 'sandboxed' as const };
    await expect(
      buildEngine({ toolEnv, mcp: { toolDefs: defs, capability } }),
    ).resolves.toBeDefined();
    await expect(
      buildEngine({ toolEnv, mcp: { toolDefs: [...defs, ...defs], capability } }),
    ).rejects.toThrow(/duplicate tool id/);
  });
});

describe('native SQLite parallel gate handoff', () => {
  it.each([false, true])(
    'a fresh owner can immediately reject a parked parallel budget gate (ordinary=%s)',
    async (ordinary) => {
      const client = createClient(':memory:');
      runMigrations(client.db);
      const model = 'gpt-5.4-mini';
      const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: parallel-pause-ownership
  budget: {max_cost_microcents: 1, on_exceed: pause_for_approval, strict_cost_cap: true}
  agents:
    - {id: worker, model: ${model}, provider: openai, system_prompt: inspect}
  nodes:
    - {id: first, type: agent, agent_ref: worker, prompt_template: hello, max_tokens: 64}
    - {id: second, type: agent, agent_ref: worker, prompt_template: hello, max_tokens: 64}
${ordinary ? '    - {id: ordinary, type: human_gate, gate_type: approval}\n' : ''}    - {id: out, type: output}
  edges:
    - {from: first, to: out}
    - {from: second, to: out}
${ordinary ? '    - {from: ordinary, to: out}\n' : ''}`);
      const store = createRunHistoryStore(client.db, {
        uuid: randomUUID,
        now: Date.now,
        workflow: {
          slug: workflow.workflow.id,
          name: workflow.workflow.id,
          definitionJson: JSON.stringify(workflow),
        },
      });
      const leases = createRunLeasePort(store);
      let keys = 0;
      let calls = 0;
      const resolver = scriptedResolver([textTurn('unused')], 'openai');
      const provider = resolver.resolveProvider('openai');
      if (provider === undefined) throw new Error('missing provider');
      const providers = {
        ...resolver,
        keyFor: () => {
          keys++;
          return 'offline-key';
        },
        resolveProvider: () => ({
          ...provider,
          stream: (...args: Parameters<typeof provider.stream>) => {
            calls++;
            return provider.stream(...args);
          },
        }),
      };
      const original = await buildEngine({
        host: createCliHost(store, { runLeases: leases }),
        providers,
      });
      const handle = original.start({ workflow });
      let resumed: RunHandle | undefined;
      let gateId: string | undefined;
      let companions = 0;
      let reachedPause = () => {};
      const paused = new Promise<void>((resolve) => {
        reachedPause = resolve;
      });
      const drained = (async () => {
        for await (const event of handle.events) {
          if (
            event.type === 'budget:authorization' &&
            event.authorization.state === 'paused' &&
            gateId === undefined
          )
            gateId = event.gateId;
          if (event.type === 'human_gate:paused') companions++;
          if (event.type === 'run:paused') reachedPause();
        }
      })();
      try {
        await paused;
        expect(companions).toBe(ordinary ? 3 : 2);
        if (gateId === undefined) throw new Error('missing actual frozen gate');
        expect(await handle.depart()).toEqual({
          kind: 'detached',
          moneyDurability: 'durable',
          effectNeedsAttention: false,
        });
        await drained;
        expect(await leases.read(handle.runId)).toBeUndefined();
        const fresh = await buildEngine({
          host: createCliHost(store, {
            runLeases: leases,
            checkpointer: createHistoryCheckpointer(store),
          }),
          providers,
        });
        resumed = await fresh.resumeFromCheckpoint({
          runId: handle.runId,
          workflow,
          gateId,
          decision: { decision: 'rejected', decidedBy: 'offline' },
        });
        const events: RunEvent[] = [];
        for await (const event of resumed.events) events.push(event);
        expect((await resumed.depart()).kind).toBe('closed');
        expect(events.at(-1)).toMatchObject({
          type: 'run:failed',
          error: { code: 'budget_exceeded' },
        });
        expect(resumed.durability()).toBe('durable');
        expect(keys).toBe(0);
        expect(calls).toBe(0);
        expect(await leases.read(handle.runId)).toBeUndefined();
      } finally {
        handle.cancel();
        await drained;
        await handle.depart();
        if (resumed !== undefined) {
          resumed.cancel();
          await resumed.depart();
        }
        client.sqlite.close();
      }
    },
  );
});
