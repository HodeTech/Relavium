import type { AbortSignalLike, ToolPolicy } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './builtins.js';
import {
  ToolArgsInvalidError,
  ToolCancelledError,
  ToolExecutionError,
  ToolPolicyError,
  ToolUnavailableError,
  UnknownToolError,
} from './errors.js';
import { createToolRegistry } from './registry.js';
import { isUntrusted, unwrapUntrusted } from './untrusted.js';
import type {
  EgressRequest,
  EgressResponse,
  FsCapability,
  ToolCallPart,
  ToolDispatchContext,
  ToolHost,
} from './types.js';

/* --- helpers --- */

function call(name: string, args?: unknown, providerExecuted?: boolean): ToolCallPart {
  return {
    type: 'tool_call',
    id: 'c1',
    name,
    args,
    ...(providerExecuted === undefined ? {} : { providerExecuted }),
  };
}

function stubHost(overrides?: Partial<ToolHost>): ToolHost {
  return {
    fs: {
      readFile: (path) =>
        Promise.resolve({
          content: `body:${path}`,
          mimeType: 'text/plain',
          sizeBytes: 4,
          lastModified: 't',
        }),
      writeFile: (path, data) => Promise.resolve({ path, bytesWritten: data.length }),
      listDirectory: () => Promise.resolve({ entries: [] }),
    },
    process: {
      spawn: () => Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    },
    egress: {
      fetch: () => Promise.resolve({ status: 200, headers: {}, body: '{}' }),
    },
    os: {
      readClipboard: () => Promise.resolve('clip'),
      notify: () => Promise.resolve(),
    },
    mcp: {
      call: () => Promise.resolve({ ok: true }),
    },
    outputStore: {
      spill: (text) => Promise.resolve({ ref: 'spill://1', byteLength: text.length }),
    },
    ...overrides,
  };
}

function fsWith(readFile: FsCapability['readFile']): FsCapability {
  return {
    readFile,
    writeFile: (path, data) => Promise.resolve({ path, bytesWritten: data.length }),
    listDirectory: () => Promise.resolve({ entries: [] }),
  };
}

function ctx(overrides?: Partial<ToolDispatchContext>): ToolDispatchContext {
  return {
    nodeId: 'n1',
    grantedToolIds: new Set(BUILTIN_TOOL_IDS),
    config: {},
    toolPolicy: {} satisfies ToolPolicy,
    fsScope: 'sandboxed',
    gateApproved: false,
    ...overrides,
  };
}

async function rejectsWith<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (error) {
    return error as E;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function registry(host: ToolHost = stubHost()): ReturnType<typeof createToolRegistry> {
  return createToolRegistry({ tools: BUILTIN_TOOLS, host });
}

/* --- happy path + shape --- */

describe('ToolRegistry — happy path and outcome shape', () => {
  it('dispatches read_file and returns mapped output + untrusted result + sanitized events', async () => {
    const out = await registry().dispatch(call('read_file', { path: 'a.txt' }), ctx());
    expect(out.output).toEqual({
      content: 'body:a.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      lastModified: 't',
    });
    expect(isUntrusted(out.toolResult)).toBe(true);
    const part = unwrapUntrusted(out.toolResult);
    expect(part.type).toBe('tool_result');
    expect(part.toolCallId).toBe('c1');
    expect(out.truncated).toBe(false);
    expect(out.events.call).toEqual({ toolId: 'read_file', toolInput: { path: 'a.txt' } });
    expect(out.events.result.success).toBe(true);
    expect(out.events.result.toolId).toBe('read_file');
  });

  it('exposes has() and a sorted list() of every built-in', () => {
    const reg = registry();
    expect(reg.has('read_file')).toBe(true);
    expect(reg.has('nope')).toBe(false);
    expect(reg.list()).toEqual([...BUILTIN_TOOL_IDS].sort((a, b) => a.localeCompare(b)));
    expect(reg.list()).toHaveLength(12);
  });

  it('rejects a duplicate tool id at construction', () => {
    const dup = BUILTIN_TOOLS[0];
    if (dup === undefined) {
      throw new Error('no built-in tools');
    }
    expect(() => createToolRegistry({ tools: [dup, dup], host: stubHost() })).toThrow(
      /duplicate tool id/,
    );
  });
});

/* --- resolution + grant --- */

describe('ToolRegistry — resolution and grant', () => {
  it('rejects an unknown tool id, listing the available tools', async () => {
    const err = await rejectsWith<UnknownToolError>(registry().dispatch(call('nope'), ctx()));
    expect(err).toBeInstanceOf(UnknownToolError);
    expect(err.runErrorCode).toBe('tool_failed');
    expect(err.message).toContain('read_file');
  });

  it('refuses a registered-but-not-granted tool (registered ≠ authorized)', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(
        call('write_file', { path: 'x', content: 'y' }),
        ctx({ grantedToolIds: new Set(['read_file']) }),
      ),
    );
    expect(err).toBeInstanceOf(ToolPolicyError);
    expect(err.reason).toBe('not_granted');
    expect(err.runErrorCode).toBe('tool_denied');
  });

  it('never dispatches a provider-executed call', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(call('read_file', { path: 'a' }, true), ctx()),
    );
    expect(err).toBeInstanceOf(ToolPolicyError);
    expect(err.message).toContain('provider-executed');
  });
});

/* --- arg validation + secret taint --- */

describe('ToolRegistry — argument validation and secret taint', () => {
  it('rejects effective args that fail the validator, naming the field (not the value)', async () => {
    const err = await rejectsWith<ToolArgsInvalidError>(
      registry().dispatch(call('read_file', {}), ctx()),
    );
    expect(err).toBeInstanceOf(ToolArgsInvalidError);
    expect(err.runErrorCode).toBe('validation');
    expect(err.fields).toContain('path');
  });

  it('rejects a secret-tainted value flowing into a tool argument (ADR-0029(c), effective set)', async () => {
    const err = await rejectsWith<ToolArgsInvalidError>(
      registry().dispatch(
        call('read_file', { path: 'a' }),
        ctx({ secretArgKeys: new Set(['path']) }),
      ),
    );
    expect(err).toBeInstanceOf(ToolArgsInvalidError);
    expect(err.fields).toEqual(['path']);
    expect(err.message).toContain('credential reference');
  });
});

/* --- the ordering / tool-node bypass guarantee --- */

describe('ToolRegistry — guardrails run on the EFFECTIVE args (no tool-node bypass)', () => {
  it('enforces the command allowlist on an input_mapping-derived command with NO model args', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(
        call('run_command'), // no model args — a tool-node-style call
        ctx({
          config: { inputMapping: { command: 'rm', args: ['-rf', '/'] } },
          toolPolicy: { allowedCommands: ['ls'] },
        }),
      ),
    );
    expect(err).toBeInstanceOf(ToolPolicyError);
    expect(err.reason).toBe('command_not_allowed');
  });

  it('allows an input_mapping-derived command that IS on the allowlist', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    );
    const out = await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ process: { spawn } }),
    }).dispatch(
      call('run_command'),
      ctx({
        config: { inputMapping: { command: 'ls', args: ['-la'] } },
        toolPolicy: { allowedCommands: ['ls -la'] },
      }),
    );
    expect(out.events.result.success).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
  });
});

/* --- run_command allowlist matching --- */

describe('ToolRegistry — run_command allowlist', () => {
  const run = (args: unknown, policy: ToolPolicy): Promise<unknown> =>
    registry().dispatch(call('run_command', args), ctx({ toolPolicy: policy }));

  it('matches EXACTLY — `npm` is not authorized by `npm test`', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      run({ command: 'npm' }, { allowedCommands: ['npm test'] }),
    );
    expect(err.reason).toBe('command_not_allowed');
  });

  it('allows an exact resolved match (command + args joined)', async () => {
    const out = await run({ command: 'npm', args: ['test'] }, { allowedCommands: ['npm test'] });
    expect((out as { events: { result: { success: boolean } } }).events.result.success).toBe(true);
  });

  it('allows an opt-in glob match', async () => {
    const out = await run(
      { command: 'npm', args: ['run', 'build'] },
      { allowedCommandGlobs: ['npm *'] },
    );
    expect((out as { events: { result: { success: boolean } } }).events.result.success).toBe(true);
  });

  it('denies by default when both allowlists are empty/absent', async () => {
    const err = await rejectsWith<ToolPolicyError>(run({ command: 'ls' }, {}));
    expect(err.reason).toBe('command_not_allowed');
  });

  it('skips the allowlist for a pre-approved git_status (no policy target)', async () => {
    const out = await registry().dispatch(
      call('git_status', { command: 'status' }),
      ctx({ toolPolicy: {} }),
    );
    expect(out.events.result.success).toBe(true);
  });
});

/* --- http_request egress policy --- */

describe('ToolRegistry — http_request egress policy', () => {
  const http = (url: string, policy: ToolPolicy): Promise<unknown> =>
    registry().dispatch(call('http_request', { url }), ctx({ toolPolicy: policy }));

  it('allows an exact-FQDN host on the allowlist', async () => {
    const out = await http('https://api.example.com/v1/x', { allowedDomains: ['api.example.com'] });
    expect((out as { events: { result: { success: boolean } } }).events.result.success).toBe(true);
  });

  it('rejects a non-HTTPS URL', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      http('http://api.example.com', { allowedDomains: ['api.example.com'] }),
    );
    expect(err.reason).toBe('insecure_url');
  });

  it('rejects credentials embedded in the URL', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      http('https://user:pass@api.example.com/x', { allowedDomains: ['api.example.com'] }),
    );
    expect(err.reason).toBe('insecure_url');
  });

  it('rejects a host not on the allowlist', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      http('https://evil.example.org/x', { allowedDomains: ['api.example.com'] }),
    );
    expect(err.reason).toBe('domain_not_allowed');
  });

  it('denies by default when allowedDomains is empty/absent', async () => {
    const err = await rejectsWith<ToolPolicyError>(http('https://api.example.com/x', {}));
    expect(err.reason).toBe('domain_not_allowed');
  });

  it('strips a port before matching the FQDN', async () => {
    const out = await http('https://api.example.com:8443/x', {
      allowedDomains: ['api.example.com'],
    });
    expect((out as { events: { result: { success: boolean } } }).events.result.success).toBe(true);
  });
});

/* --- git_commit gate --- */

describe('ToolRegistry — git_commit human-gate', () => {
  it('blocks git_commit without a gate approval', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(call('git_commit', { message: 'x' }), ctx({ gateApproved: false })),
    );
    expect(err.reason).toBe('gate_required');
  });

  it('allows git_commit once a gate approval is present', async () => {
    const out = await registry().dispatch(
      call('git_commit', { message: 'x' }),
      ctx({ gateApproved: true }),
    );
    expect(out.events.result.success).toBe(true);
  });
});

/* --- config-only params + I/O mapping --- */

describe('ToolRegistry — config-only params and I/O mapping', () => {
  it('merges config-only values last (a model arg cannot override) and strips them from events', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    );
    const out = await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ process: { spawn } }),
    }).dispatch(
      call('run_command', { command: 'ls', cwd: '/evil' }),
      ctx({ config: { parameters: { cwd: '/safe' } }, toolPolicy: { allowedCommands: ['ls'] } }),
    );
    expect(spawn).toHaveBeenCalledWith(
      'ls',
      [],
      {},
      { cwd: '/safe', timeoutMs: undefined },
      undefined,
    );
    expect(out.events.call.toolInput).not.toHaveProperty('cwd'); // config-only stripped from the event
  });

  it('applies output_mapping to the FULL result', async () => {
    const out = await registry().dispatch(
      call('run_command', { command: 'ls' }),
      ctx({
        config: { outputMapping: { code: 'exitCode', text: 'stdout' } },
        toolPolicy: { allowedCommands: ['ls'] },
      }),
    );
    expect(out.output).toEqual({ code: 0, text: 'ok' });
  });

  it('web_search uses the config-pinned endpoint + credentialRef (never the raw key in args/events)', async () => {
    const fetch = vi.fn<(req: EgressRequest, signal?: AbortSignalLike) => Promise<EgressResponse>>(
      () => Promise.resolve({ status: 200, headers: {}, body: '[]' }),
    );
    const out = await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ egress: { fetch } }),
    }).dispatch(
      call('web_search', { query: 'hello world' }),
      ctx({
        config: { parameters: { endpoint: 'https://search.example', credentialRef: 'ref-1' } },
      }),
    );
    expect(fetch).toHaveBeenCalledOnce();
    const req = fetch.mock.calls[0]?.[0];
    expect(req?.url).toBe('https://search.example?q=hello%20world');
    expect(req?.credentialRef).toBe('ref-1');
    expect(out.events.call.toolInput).toEqual({ query: 'hello world' }); // endpoint/credentialRef stripped
  });
});

/* --- capability availability + execution + cancellation --- */

describe('ToolRegistry — host capability, execution, cancellation', () => {
  it('surfaces a missing capability as a typed (internal) error, not execution_failed', async () => {
    const processOnly: ToolHost = {
      process: {
        spawn: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }),
      },
    };
    const err = await rejectsWith<ToolUnavailableError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host: processOnly }).dispatch(
        call('read_file', { path: 'a' }),
        ctx(),
      ),
    );
    expect(err).toBeInstanceOf(ToolUnavailableError);
    expect(err.capability).toBe('fs');
    expect(err.runErrorCode).toBe('internal');
  });

  it('wraps a host throw as a retryable execution error', async () => {
    const host = stubHost({ fs: fsWith(() => Promise.reject(new Error('disk gone'))) });
    const err = await rejectsWith<ToolExecutionError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('read_file', { path: 'a' }),
        ctx(),
      ),
    );
    expect(err).toBeInstanceOf(ToolExecutionError);
    expect(err.runErrorCode).toBe('tool_failed');
    expect(err.retryable).toBe(true);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const err = await rejectsWith<ToolCancelledError>(
      registry().dispatch(
        call('read_file', { path: 'a' }),
        ctx({ signal: { aborted: true } as never }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
    expect(err.runErrorCode).toBe('cancelled');
  });

  it('routes an AbortError host throw to the cancellation path, not tool_failed', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const host = stubHost({ fs: fsWith(() => Promise.reject(abortErr)) });
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('read_file', { path: 'a' }),
        ctx(),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
  });
});

/* --- result bounding --- */

describe('ToolRegistry — model-facing result bounding', () => {
  it('truncates the model-facing result while output_mapping keeps the full value', async () => {
    const big = 'z'.repeat(5000);
    const host = stubHost({
      fs: fsWith(() =>
        Promise.resolve({
          content: big,
          mimeType: 'text/plain',
          sizeBytes: 5000,
          lastModified: 't',
        }),
      ),
    });
    const out = await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      call('read_file', { path: 'a' }),
      ctx({ limits: { maxBytes: 100, maxLines: 5 } }),
    );
    expect(out.truncated).toBe(true);
    expect(String(unwrapUntrusted(out.toolResult).result)).toContain('spill://1');
    // output_mapping sees the FULL result, not the preview:
    expect((out.output as { content: string }).content).toBe(big);
  });
});

/* --- os + orchestration tools --- */

describe('ToolRegistry — os and orchestration tools', () => {
  it('read_clipboard returns the clipboard text', async () => {
    const out = await registry().dispatch(call('read_clipboard', {}), ctx());
    expect(out.output).toBe('clip');
  });

  it('notify acknowledges delivery', async () => {
    const out = await registry().dispatch(call('notify', { title: 't', body: 'b' }), ctx());
    expect(out.output).toEqual({ delivered: true });
  });

  it('mcp_call dispatches through the mcp capability', async () => {
    const out = await registry().dispatch(
      call('mcp_call', { server: 's', tool: 't', args: { a: 1 } }),
      ctx(),
    );
    expect(out.output).toEqual({ ok: true });
  });

  it('invoke_agent delegates to ctx.invokeAgent', async () => {
    const invokeAgent = vi.fn(() => Promise.resolve({ delegated: true }));
    const out = await registry().dispatch(
      call('invoke_agent', { nodeId: 'n2', input: { x: 1 } }),
      ctx({ invokeAgent }),
    );
    expect(invokeAgent).toHaveBeenCalledWith('n2', { x: 1 });
    expect(out.output).toEqual({ delegated: true });
  });

  it('invoke_agent without a delegate is a typed unavailable error', async () => {
    const err = await rejectsWith<ToolUnavailableError>(
      registry().dispatch(call('invoke_agent', { nodeId: 'n2' }), ctx()),
    );
    expect(err).toBeInstanceOf(ToolUnavailableError);
    expect(err.capability).toBe('invokeAgent');
  });
});

describe('ToolRegistry — policy parsing edge cases', () => {
  it('extracts a bracketed IPv6 host for the allowlist check', async () => {
    const out = await registry().dispatch(
      call('http_request', { url: 'https://[::1]:8443/x' }),
      ctx({ toolPolicy: { allowedDomains: ['::1'] } }),
    );
    expect(out.events.result.success).toBe(true);
  });

  it('honors a `?` single-char glob in allowedCommandGlobs', async () => {
    const out = await registry().dispatch(
      call('run_command', { command: 'ls' }),
      ctx({ toolPolicy: { allowedCommandGlobs: ['l?'] } }),
    );
    expect(out.events.result.success).toBe(true);
  });

  it('yields undefined for an output_mapping path that misses', async () => {
    const out = await registry().dispatch(
      call('run_command', { command: 'ls' }),
      ctx({
        config: { outputMapping: { missing: 'a.b.c' } },
        toolPolicy: { allowedCommands: ['ls'] },
      }),
    );
    expect(out.output).toEqual({ missing: undefined });
  });
});

/* --- round-2 hardening regressions (config-only override, proto, host-extract, cancel, taint) --- */

describe('ToolRegistry — config-only params cannot be model- or mapping-supplied (H1/M3)', () => {
  it('drops a model-supplied config-only key when config does not pin it (run_command env/cwd)', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    );
    await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ process: { spawn } }),
    }).dispatch(
      call('run_command', {
        command: 'ls',
        cwd: '/evil',
        env: { NODE_OPTIONS: '--require /tmp/x.js' },
        timeoutMs: 9_999_999,
      }),
      ctx({ toolPolicy: { allowedCommands: ['ls'] } }), // config pins NONE of cwd/env/timeoutMs
    );
    // env/cwd/timeoutMs come ONLY from config — a model-supplied value never reaches spawn.
    expect(spawn).toHaveBeenCalledWith(
      'ls',
      [],
      {},
      { cwd: undefined, timeoutMs: undefined },
      undefined,
    );
  });

  it('does not let the model redirect web_search to its own endpoint (no secret-exfil)', async () => {
    const fetch = vi.fn<(req: EgressRequest, signal?: AbortSignalLike) => Promise<EgressResponse>>(
      () => Promise.resolve({ status: 200, headers: {}, body: '[]' }),
    );
    await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ egress: { fetch } }),
    }).dispatch(
      // config pins BOTH the endpoint and the credentialRef (both config-only); the model tries to
      // supply a malicious endpoint + credentialRef, which must be dropped.
      call('web_search', {
        query: 'q',
        endpoint: 'https://attacker.evil',
        credentialRef: 'STOLEN',
      }),
      ctx({
        config: {
          parameters: { endpoint: 'https://api.search.example', credentialRef: 'real-key-ref' },
        },
      }),
    );
    const req = fetch.mock.calls[0]?.[0];
    expect(req?.url).toContain('api.search.example'); // the config-pinned endpoint is used…
    expect(req?.url).not.toContain('attacker.evil'); // …and the model's endpoint override is dropped
    expect(req?.credentialRef).toBe('real-key-ref'); // the model's 'STOLEN' override is dropped
  });

  it('drops a config-only key supplied via input_mapping too (M3)', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    );
    await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ process: { spawn } }),
    }).dispatch(
      call('run_command', { command: 'ls' }),
      ctx({
        config: { inputMapping: { cwd: '/from-state' } },
        toolPolicy: { allowedCommands: ['ls'] },
      }),
    );
    expect(spawn).toHaveBeenCalledWith(
      'ls',
      [],
      {},
      { cwd: undefined, timeoutMs: undefined },
      undefined,
    );
  });

  it('git_status drops a model-supplied args[] (flag-injection closed) (H2)', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    );
    await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ process: { spawn } }),
    }).dispatch(
      call('git_status', { command: 'diff', args: ['--no-index', '--', '/etc/passwd'] }),
      ctx(),
    );
    // The model's injected `args` is config-only → stripped; only the safe subcommand runs.
    expect(spawn).toHaveBeenCalledWith('git', ['diff'], {}, {}, undefined);
  });

  it('git_status runs author-pinned args from config', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    );
    await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ process: { spawn } }),
    }).dispatch(
      call('git_status', { command: 'diff' }),
      ctx({ config: { parameters: { args: ['--stat'] } } }),
    );
    expect(spawn).toHaveBeenCalledWith('git', ['diff', '--stat'], {}, {}, undefined);
  });
});

describe('ToolRegistry — prototype-pollution resistance', () => {
  it('output_mapping readPath returns undefined for inherited members, never the prototype/constructor', async () => {
    const out = await registry().dispatch(
      call('run_command', { command: 'ls' }),
      ctx({
        config: { outputMapping: { a: '__proto__', b: 'constructor', c: 'stdout' } },
        toolPolicy: { allowedCommands: ['ls'] },
      }),
    );
    expect(out.output).toEqual({ a: undefined, b: undefined, c: 'ok' });
  });

  it('a `__proto__` key in input_mapping does not pollute Object.prototype', async () => {
    await registry().dispatch(
      call('read_file', { path: 'a' }),
      ctx({ config: { inputMapping: { ['__proto__']: { polluted: true } } } }),
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('ToolRegistry — host extraction rejects smuggling chars but allows hyphens (L5)', () => {
  it('allows a legitimate hyphenated FQDN', async () => {
    const out = await registry().dispatch(
      call('http_request', { url: 'https://my-api.example.com/x' }),
      ctx({ toolPolicy: { allowedDomains: ['my-api.example.com'] } }),
    );
    expect(out.events.result.success).toBe(true);
  });

  it.each([
    ['backslash', String.raw`https://api.example.com\@evil.com/`],
    ['space', 'https://exa mple.com/'],
    ['tab', 'https://e\tvil/'],
  ])('rejects a %s in the authority as insecure', async (_name, url) => {
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(
        call('http_request', { url }),
        ctx({ toolPolicy: { allowedDomains: ['api.example.com'] } }),
      ),
    );
    expect(err.reason).toBe('insecure_url');
  });
});

describe('ToolRegistry — glob, provider_executed, and mid-dispatch cancel', () => {
  it('matches a consecutive-`*` glob without hanging (collapse)', async () => {
    const out = await registry().dispatch(
      call('run_command', { command: 'a b c' }),
      ctx({ toolPolicy: { allowedCommandGlobs: ['****'] } }),
    );
    expect(out.events.result.success).toBe(true);
  });

  it('classifies a provider-executed call with the provider_executed reason', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(call('read_file', { path: 'a' }, true), ctx()),
    );
    expect(err.reason).toBe('provider_executed');
    expect(err.runErrorCode).toBe('tool_denied');
  });

  it('classifies an abort that flips mid-dispatch (plain host error) as cancelled, not tool_failed', async () => {
    const signal = { aborted: false };
    const host = stubHost({
      fs: fsWith(() => {
        signal.aborted = true; // the run is cancelled while the host is in-flight
        return Promise.reject(new Error('boom')); // a plain (non-AbortError) host error
      }),
    });
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('read_file', { path: 'a' }),
        ctx({ signal: signal as never }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
    expect(err.runErrorCode).toBe('cancelled');
  });

  it('rejects a secret-tainted value supplied via input_mapping (T2)', async () => {
    const err = await rejectsWith<ToolArgsInvalidError>(
      registry().dispatch(
        call('read_file'),
        ctx({
          config: { inputMapping: { path: '/etc/passwd' } },
          secretArgKeys: new Set(['path']),
        }),
      ),
    );
    expect(err).toBeInstanceOf(ToolArgsInvalidError);
    expect(err.fields).toEqual(['path']);
  });
});

/* --- round-3 regressions: the round-2 (Sonnet) findings --- */

describe('ToolRegistry — abort precedence after each await (M-3 line-109, H-1 post-bounding)', () => {
  it('classifies an abort that lands after the host RESOLVES (M-3 / line 109)', async () => {
    const signal = { aborted: false };
    const host = stubHost({
      fs: fsWith(() => {
        signal.aborted = true; // cancelled while in-flight, but the host RESOLVES (no throw)
        return Promise.resolve({
          content: 'ok',
          mimeType: 'text/plain',
          sizeBytes: 2,
          lastModified: 't',
        });
      }),
    });
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('read_file', { path: 'a' }),
        ctx({ signal: signal as never }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
  });

  it('classifies an abort that lands during bounding (H-1 / post-boundForModel guard)', async () => {
    const signal = { aborted: false };
    const big = 'z'.repeat(5000);
    const host = stubHost({
      fs: fsWith(() =>
        Promise.resolve({
          content: big,
          mimeType: 'text/plain',
          sizeBytes: 5000,
          lastModified: 't',
        }),
      ),
      outputStore: {
        spill: (text) => {
          signal.aborted = true; // the run is cancelled during the spill, but spill RESOLVES (no throw)
          return Promise.resolve({ ref: 'spill://x', byteLength: text.length });
        },
      },
    });
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('read_file', { path: 'a' }),
        ctx({ signal: signal as never, limits: { maxBytes: 10, maxLines: 1 } }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
  });
});

describe('ToolRegistry — output_mapping stateKey cannot pollute the prototype (M-2)', () => {
  it('drops a __proto__ stateKey, leaving the result a clean Object.prototype object', async () => {
    const out = await registry().dispatch(
      call('run_command', { command: 'ls' }),
      ctx({
        config: { outputMapping: { ['__proto__']: 'stdout', code: 'exitCode' } },
        toolPolicy: { allowedCommands: ['ls'] },
      }),
    );
    expect(out.output).toEqual({ code: 0 }); // __proto__ stateKey skipped
    expect(Object.getPrototypeOf(out.output)).toBe(Object.prototype);
    expect(Object.hasOwn(out.output as object, '__proto__')).toBe(false);
  });
});

describe('ToolRegistry — globMatch is linear-time (no ReDoS) and correct (M-1)', () => {
  it('rejects a pathological alternating glob without hanging', async () => {
    const evilGlob = 'a*'.repeat(20) + 'X'; // the classic ReDoS shape against a long non-match
    const start = performance.now();
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(
        call('run_command', { command: 'a'.repeat(60) }),
        ctx({ toolPolicy: { allowedCommandGlobs: [evilGlob] } }),
      ),
    );
    expect(performance.now() - start).toBeLessThan(1000); // linear matcher returns near-instantly
    expect(err.reason).toBe('command_not_allowed');
  });

  it.each([
    ['a*b*c', 'aXXbYYc', true],
    ['a*X', 'aYYYX', true],
    ['a*X', 'aYYY', false],
    ['*', 'anything at all', true],
    ['gi?', 'git', true],
    ['gi?', 'gie', true],
    ['gi?', 'giff', false],
  ])('glob %s vs %s = %s', async (glob, command, allowed) => {
    const run = registry().dispatch(
      call('run_command', { command }),
      ctx({ toolPolicy: { allowedCommandGlobs: [glob] } }),
    );
    if (allowed) {
      expect((await run).events.result.success).toBe(true);
    } else {
      const err = await rejectsWith<ToolPolicyError>(run);
      expect(err.reason).toBe('command_not_allowed');
    }
  });
});

describe('ToolRegistry — remaining hardening regressions (TG-2, TG-4)', () => {
  it('git_status drops an args[] supplied via input_mapping (TG-2)', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    );
    await createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: stubHost({ process: { spawn } }),
    }).dispatch(
      call('git_status', { command: 'diff' }),
      ctx({ config: { inputMapping: { args: ['--no-index', '/etc/passwd'] } } }),
    );
    expect(spawn).toHaveBeenCalledWith('git', ['diff'], {}, {}, undefined); // args is config-only; input_mapping cannot supply it
  });

  it('rejects a DEL (0x7f) control char in the authority (TG-4)', async () => {
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(
        call('http_request', {
          url: 'https://api' + String.fromCodePoint(0x7f) + '.example.com/x',
        }),
        ctx({ toolPolicy: { allowedDomains: ['api.example.com'] } }),
      ),
    );
    expect(err.reason).toBe('insecure_url');
  });
});
