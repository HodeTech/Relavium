import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpCapability } from '@relavium/core';
import { createClient, runMigrations } from '@relavium/db';
import { buildServerToolDefs } from '@relavium/mcp';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEngine } from './build-engine.js';
import { createCliHost } from './host.js';

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
});
