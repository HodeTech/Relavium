/**
 * The deep tier contacts nothing it did not name ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8, MVP-11 §5.4 rule 14): in a chat its MCP rows only REPORT the session's already-connected servers and skipped tools. A manager and a
 * transport that throw on any touch, a spy on every way to start a process, and a recording fetch under the provider seam and in place of the
 * global one: after a whole deep run, nothing touched the MCP objects, nothing was spawned, and every origin a request went to is one the
 * consent line named.
 */
import type { ToolHost } from '@relavium/core';
import type { ProviderId } from '@relavium/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const refuse = (name: string) => (): never => {
    spawned.calls.push(name);
    throw new Error(`the doctor must not start a process (${name})`);
  };
  return {
    ...actual,
    spawn: refuse('spawn'),
    spawnSync: refuse('spawnSync'),
    exec: refuse('exec'),
    execFile: refuse('execFile'),
    execFileSync: refuse('execFileSync'),
    fork: refuse('fork'),
  };
});

import { assembleDoctorProbes } from '../chat/doctor-host.js';
import { createProviderResolver } from '../engine/providers.js';
import type { FetchLike } from '../engine/validated-fetch.js';
import { CONSENT_MCP, DOCTOR_STEP } from './doctor-popup.js';
import { CTRL, doctorRig, settleWork } from './doctor.test-support.js';

const KEY = ['sk', 'proj', 'mcp', 'ABCDEF123456'].join('-');

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An object that throws on any touch, recording what was touched: a manager or a transport the doctor must never use. */
function untouchable(name: string, touched: string[]): object {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.push(`${name}.${String(property)}`);
        throw new Error(`the doctor touched ${name}.${String(property)}`);
      },
      has: (_target, property) => {
        touched.push(`${name} has ${String(property)}`);
        throw new Error(`the doctor touched ${name}`);
      },
      apply: () => {
        touched.push(`${name}()`);
        throw new Error(`the doctor called ${name}`);
      },
    },
  );
}

describe('the deep tier in a chat reports MCP and contacts only what its line named', () => {
  it('a throwing manager and transport, a spawn spy and a recording fetch: nothing touched, nothing spawned, origins within the line', async () => {
    const touched: string[] = [];
    const manager = untouchable('manager', touched);
    const transport = untouchable('transport', touched);
    const requested: string[] = [];
    const recording = (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(new URL(url).origin);
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    vi.stubGlobal('fetch', recording);
    const row = (id: ProviderId, baseUrl: string) => ({
      id: `synthetic-${id}`,
      name: id,
      displayName: id,
      baseUrl,
      defaultHeaders: {},
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const resolver = createProviderResolver({ RELAVIUM_OPENAI_API_KEY: KEY }, undefined, {
      providerStore: { list: () => [row('openai', 'https://gateway.example/v1')] },
      validatedFetch: vi.fn<FetchLike>(recording),
    });
    const probes = assembleDoctorProbes({
      noticeSurface: 'tui',
      cwd: '/tmp/doctor-mcp',
      resolver,
      agentMcpServers: [{ id: 'files' }],
      mcpSkipped: [{ server: 'files', name: 'delete', reason: 'not in allowlist' }],
    });
    const r = doctorRig();
    r.open({
      probes: {
        ...probes,
        // The session's MCP objects as close as they can be: the manager as the tool host's MCP arm, a transport as its egress arm. The doctor
        // may see that an arm is there (`checkTools` reads presence only), and must never touch either. A throwing proxy stands in for each
        // (the one documented cast: a real manager or transport would connect, which is what this test must not need).
        toolHost: {
          ...probes.toolHost,
          mcp: manager as unknown as NonNullable<ToolHost['mcp']>,
          egress: transport as unknown as NonNullable<ToolHost['egress']>,
        },
        keychain: () => undefined,
        config: () => undefined,
      },
      surface: 'home-chat',
      resultKey: 'session',
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    const line = r.words();
    expect(line).toContain('  https://gateway.example');
    expect(line).toContain(CONSENT_MCP);
    r.show();
    r.clock.advance(1000);
    r.press('y', CTRL);
    await vi.waitFor(() => expect(r.content(DOCTOR_STEP.checks).kind).toBe('list'));
    // The MCP rows are the session's report: its declared server and the tool its manager skipped.
    expect(r.words()).toContain('ok files connected');
    expect(r.words()).toContain('files/delete');
    expect(touched).toEqual([]);
    expect(spawned.calls).toEqual([]);
    expect(requested.length).toBeGreaterThan(0);
    for (const origin of requested) expect(line).toContain(`  ${origin}`);
  });
});
