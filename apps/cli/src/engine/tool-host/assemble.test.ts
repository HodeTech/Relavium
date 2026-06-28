import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILTIN_TOOLS, ToolUnavailableError, type ToolDef, type ToolHost } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleToolEnv, wiredToolIds } from './assemble.js';

/**
 * The factory is the single seam both surfaces use (ADR-0055). These tests pin the two profiles' wired arms +
 * the read-only fail-close, and the advertise-filter's tool→arm mapping (the subtle MCP-vs-egress case).
 */

let workspace: string;
beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'relavium-env-')));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

describe('assembleToolEnv', () => {
  it('chat-read-only: fs reads a real file but write_file fail-closes as tool_unavailable; process is wired', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello');
    const { host, policy } = assembleToolEnv({
      profile: 'chat-read-only',
      fsScopeTier: 'sandboxed',
      workspaceDir: workspace,
    });
    expect(host.fs).toBeDefined();
    expect(host.process).toBeDefined();
    expect((await host.fs!.readFile('a.txt', {})).content).toBe('hello'); // the wired read actually works
    await expect(host.fs!.writeFile('b.txt', 'x', {})).rejects.toBeInstanceOf(ToolUnavailableError);
    expect(policy).toEqual({}); // chat default: empty allowlists ⇒ run_command denied, git_status pre-approved
  });

  it('workflow-read-write: fs can write', async () => {
    const { host } = assembleToolEnv({
      profile: 'workflow-read-write',
      fsScopeTier: 'sandboxed',
      workspaceDir: workspace,
    });
    const fs = host.fs;
    expect(fs).toBeDefined();
    if (fs === undefined) return;
    const written = await fs.writeFile('out.txt', 'data', {});
    expect(written.bytesWritten).toBe(4);
    expect((await fs.readFile('out.txt', {})).content).toBe('data');
  });

  it('does NOT wire egress or os in 2.5.A (deferred to 2.5.E)', () => {
    const { host } = assembleToolEnv({
      profile: 'workflow-read-write',
      fsScopeTier: 'sandboxed',
      workspaceDir: workspace,
    });
    expect(host.egress).toBeUndefined();
    expect(host.os).toBeUndefined();
  });

  it('clamps the `full` tier to `project` for chat (read-only does not stop whole-FS exfiltration)', async () => {
    const outside = join(workspace, '..', 'outside-clamp');
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    await writeFile(join(workspace, 'in.txt'), 'INSIDE');
    try {
      // chat-read-only + full ⇒ clamped to project (workspace-only): the OUTSIDE read is REJECTED, but an
      // IN-workspace read still works (so the clamp landed at project/workspace-only, not something stricter).
      const chat = assembleToolEnv({ profile: 'chat-read-only', fsScopeTier: 'full', workspaceDir: workspace });
      const chatFs = chat.host.fs;
      expect(chatFs).toBeDefined();
      if (chatFs === undefined) return;
      await expect(chatFs.readFile(join(outside, 'secret.txt'), {})).rejects.toThrow();
      expect((await chatFs.readFile('in.txt', {})).content).toBe('INSIDE');
      // workflow-read-write + full ⇒ NOT clamped (author-trusted): the outside read succeeds.
      const run = assembleToolEnv({ profile: 'workflow-read-write', fsScopeTier: 'full', workspaceDir: workspace });
      const runFs = run.host.fs;
      expect(runFs).toBeDefined();
      if (runFs === undefined) return;
      expect((await runFs.readFile(join(outside, 'secret.txt'), {})).content).toBe('SECRET');
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('wiredToolIds (advertise-filter)', () => {
  // The arms are built by the real factory (lazy — no disk I/O until a method is called, and the filter only
  // checks arm PRESENCE), so no unsafe casts. The workspace path is never touched here.
  const fsHost: ToolHost = assembleToolEnv({
    profile: 'workflow-read-write',
    fsScopeTier: 'sandboxed',
    workspaceDir: '/tmp/relavium-advertise-filter',
  }).host;
  const mcpHost: ToolHost = { ...fsHost, mcp: { call: () => Promise.resolve(undefined) } };
  const mcpCallDef = BUILTIN_TOOLS.find((d) => d.id === 'mcp_call');
  if (mcpCallDef === undefined) throw new Error('the mcp_call built-in is missing');
  const mcpTool: ToolDef = { ...mcpCallDef, id: 'mcp__server__read', source: 'mcp' };
  const defs = [...BUILTIN_TOOLS, mcpTool];

  it('keeps fs/process tools when those arms are wired', () => {
    const kept = wiredToolIds(['read_file', 'list_directory', 'git_status'], fsHost, defs);
    expect(kept).toEqual(['read_file', 'list_directory', 'git_status']);
  });

  it('drops egress (http/search) tools when the egress arm is absent', () => {
    const kept = wiredToolIds(['read_file', 'http_request', 'web_search'], fsHost, defs);
    expect(kept).toEqual(['read_file']); // egress not wired ⇒ http_request / web_search not advertised
  });

  it('keeps write_file because its fs arm is present (the read-only writeFile fail-closes at dispatch instead)', () => {
    // The advertise-filter is capability-presence based; the read-only fs writeFile is the authoritative gate.
    expect(wiredToolIds(['write_file'], fsHost, defs)).toEqual(['write_file']);
  });

  it('routes MCP tools (discovered + the mcp_call built-in) to host.mcp, not host.egress', () => {
    expect(wiredToolIds(['mcp__server__read', 'mcp_call'], fsHost, defs)).toEqual([]); // no host.mcp ⇒ dropped
    expect(wiredToolIds(['mcp__server__read', 'mcp_call'], mcpHost, defs)).toEqual([
      'mcp__server__read',
      'mcp_call',
    ]); // host.mcp present ⇒ both advertised
  });

  it('keeps an unknown granted id (a dynamically-registered tool resolved elsewhere)', () => {
    expect(wiredToolIds(['not_a_builtin'], fsHost, defs)).toEqual(['not_a_builtin']);
  });
});
