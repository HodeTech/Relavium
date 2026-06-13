import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './builtins.js';
import { ToolArgsInvalidError, ToolUnavailableError } from './errors.js';
import type { ToolDef, ToolDispatchContext, ToolHost } from './types.js';

function tool(id: string): ToolDef {
  const found = BUILTIN_TOOLS.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no built-in tool: ${id}`);
  }
  return found;
}

function fullHost(): ToolHost {
  return {
    fs: {
      readFile: (path) =>
        Promise.resolve({
          content: `c:${path}`,
          mimeType: 'text/plain',
          sizeBytes: 1,
          lastModified: 't',
        }),
      writeFile: (path, data) => Promise.resolve({ path, bytesWritten: data.length }),
      listDirectory: () =>
        Promise.resolve({
          entries: [{ name: 'a', type: 'file', sizeBytes: 1, lastModified: 't' }],
        }),
    },
    process: {
      spawn: () => Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    },
    egress: { fetch: () => Promise.resolve({ status: 200, headers: {}, body: '{}' }) },
    os: { readClipboard: () => Promise.resolve('clip'), notify: () => Promise.resolve() },
    mcp: { call: () => Promise.resolve({ ok: true }) },
    outputStore: {
      spill: (text) => Promise.resolve({ ref: 'spill://1', byteLength: text.length }),
    },
  };
}

const ctx: ToolDispatchContext = {
  nodeId: 'n',
  grantedToolIds: new Set(BUILTIN_TOOL_IDS),
  config: {},
  toolPolicy: {},
  fsScope: 'sandboxed',
  gateApproved: true,
};

// `requireX` throws synchronously inside the dispatch arrow (the registry catches it in its
// `try { await dispatch() }`), so a thunk-wrapper is needed to surface it as a rejection in tests.
async function rejection(thunk: () => unknown): Promise<unknown> {
  try {
    await thunk();
  } catch (error) {
    return error;
  }
  throw new Error('expected the dispatch to fail, but it succeeded');
}

interface ToolCase {
  readonly id: string;
  readonly args: unknown;
  readonly cap?: string;
}

// One representative valid call per tool (covers each dispatch arrow + its `?? []`/`?? {}` branches).
const CASES: readonly ToolCase[] = [
  { id: 'read_file', args: { path: 'a', glob: true }, cap: 'fs' },
  {
    id: 'write_file',
    args: { path: 'a', content: 'x', append: true, createDirs: true },
    cap: 'fs',
  },
  { id: 'list_directory', args: { path: 'a', recursive: true, glob: '*.ts' }, cap: 'fs' },
  {
    id: 'run_command',
    args: { command: 'ls', args: ['-l'], cwd: '/w', timeoutMs: 5, env: { X: '1' } },
    cap: 'process',
  },
  { id: 'git_status', args: { command: 'log', args: ['--oneline'] }, cap: 'process' },
  { id: 'git_commit', args: { message: 'm', files: ['a.ts'] }, cap: 'process' },
  {
    id: 'http_request',
    args: { method: 'POST', url: 'https://x', headers: { a: 'b' }, body: '{}' },
    cap: 'egress',
  },
  {
    id: 'web_search',
    args: { query: 'q', endpoint: 'https://s', credentialRef: 'r' },
    cap: 'egress',
  },
  { id: 'mcp_call', args: { server: 's', tool: 't', args: { a: 1 } }, cap: 'mcp' },
  { id: 'read_clipboard', args: {}, cap: 'os' },
  { id: 'notify', args: { title: 't', body: 'b' }, cap: 'os' },
];

describe('built-in catalog', () => {
  it('registers 12 unique built-ins, all sourced "builtin"', () => {
    expect(BUILTIN_TOOLS).toHaveLength(12);
    expect(new Set(BUILTIN_TOOL_IDS).size).toBe(12);
    expect(BUILTIN_TOOLS.every((candidate) => candidate.source === 'builtin')).toBe(true);
  });

  it('never exposes a config-only param in the LLM-visible schema', () => {
    for (const candidate of BUILTIN_TOOLS) {
      const props = (candidate.llmVisibleParams['properties'] ?? {}) as Record<string, unknown>;
      for (const configOnly of candidate.configOnlyParams ?? []) {
        expect(props).not.toHaveProperty(configOnly);
      }
    }
  });
});

describe('built-in dispatch', () => {
  it.each(CASES)('$id dispatches through the host capability', async ({ id, args }) => {
    const target = tool(id);
    const result = await target.dispatch(target.parseArgs(args), fullHost(), ctx);
    expect(result).toBeDefined();
  });

  it.each(
    CASES.filter((toolCase): toolCase is ToolCase & { cap: string } => toolCase.cap !== undefined),
  )(
    '$id fails with a typed ToolUnavailableError when the $cap capability is absent',
    async ({ id, args, cap }) => {
      const target = tool(id);
      const err = await rejection(() => target.dispatch(target.parseArgs(args), {}, ctx));
      expect(err).toBeInstanceOf(ToolUnavailableError);
      expect(err).toMatchObject({ capability: cap });
    },
  );

  it('invoke_agent delegates to ctx.invokeAgent and fails typed without it', async () => {
    const target = tool('invoke_agent');
    const out = await target.dispatch(
      target.parseArgs({ nodeId: 'n2', input: 1 }),
      {},
      {
        ...ctx,
        invokeAgent: (nodeId) => Promise.resolve({ ranNode: nodeId }),
      },
    );
    expect(out).toEqual({ ranNode: 'n2' });
    const err = await rejection(() => target.dispatch(target.parseArgs({ nodeId: 'n2' }), {}, ctx));
    expect(err).toBeInstanceOf(ToolUnavailableError);
  });

  it('notify acknowledges delivery', async () => {
    const target = tool('notify');
    expect(
      await target.dispatch(target.parseArgs({ title: 't', body: 'b' }), fullHost(), ctx),
    ).toEqual({ delivered: true });
  });
});

describe('web_search url construction + endpoint validation', () => {
  function captureFetch(): {
    host: ToolHost;
    calls: Array<{ url: string; credentialRef: string | undefined }>;
  } {
    const calls: Array<{ url: string; credentialRef: string | undefined }> = [];
    const host: ToolHost = {
      egress: {
        fetch: (request) => {
          calls.push({ url: request.url, credentialRef: request.credentialRef });
          return Promise.resolve({ status: 200, headers: {}, body: '{}' });
        },
      },
    };
    return { host, calls };
  }

  it('appends `?q=` when the endpoint has no query string', async () => {
    const target = tool('web_search');
    const { host, calls } = captureFetch();
    await target.dispatch(
      target.parseArgs({ query: 'a b', endpoint: 'https://s.example/search' }),
      host,
      ctx,
    );
    expect(calls[0]?.url).toBe('https://s.example/search?q=a%20b');
  });

  it('uses `&` (not a double `?`) when the endpoint already has a query string', async () => {
    const target = tool('web_search');
    const { host, calls } = captureFetch();
    await target.dispatch(
      target.parseArgs({ query: 'q', endpoint: 'https://s.example/search?engine=foo' }),
      host,
      ctx,
    );
    expect(calls[0]?.url).toBe('https://s.example/search?engine=foo&q=q');
  });

  it('threads a validated maxResults into the url, encoded', async () => {
    const target = tool('web_search');
    const { host, calls } = captureFetch();
    await target.dispatch(
      target.parseArgs({ query: 'q', maxResults: 5, endpoint: 'https://s.example/search' }),
      host,
      ctx,
    );
    expect(calls[0]?.url).toBe('https://s.example/search?q=q&maxResults=5');
  });

  it('rejects a missing endpoint at parse time (config-only, required)', () => {
    expect(() => tool('web_search').parseArgs({ query: 'q' })).toThrow();
  });

  it('rejects a non-HTTPS endpoint and never forwards the credentialRef', async () => {
    const target = tool('web_search');
    const { host, calls } = captureFetch();
    const err = await rejection(() =>
      target.dispatch(
        target.parseArgs({ query: 'q', endpoint: 'http://s.example', credentialRef: 'r' }),
        host,
        ctx,
      ),
    );
    expect(err).toBeInstanceOf(ToolArgsInvalidError);
    expect(err).toMatchObject({ fields: ['endpoint'] });
    expect(calls).toHaveLength(0); // no egress, so no credentialRef leaked to the host
  });

  it('rejects a non-absolute endpoint with a typed args error', async () => {
    const target = tool('web_search');
    const { host, calls } = captureFetch();
    const err = await rejection(() =>
      target.dispatch(
        target.parseArgs({ query: 'q', endpoint: '/relative/path', credentialRef: 'r' }),
        host,
        ctx,
      ),
    );
    expect(err).toBeInstanceOf(ToolArgsInvalidError);
    expect(calls).toHaveLength(0);
  });
});

describe('built-in policy targets', () => {
  it('run_command resolves the full command string for the allowlist', () => {
    const target = tool('run_command');
    expect(
      target.policyTarget?.(target.parseArgs({ command: 'npm', args: ['run', 'build'] })),
    ).toEqual({
      command: 'npm run build',
    });
  });

  it('http_request exposes its url as the egress policy target', () => {
    const target = tool('http_request');
    expect(target.policyTarget?.(target.parseArgs({ url: 'https://x/y' }))).toEqual({
      url: 'https://x/y',
    });
  });

  it('a pre-approved git_status has no policy target', () => {
    expect(tool('git_status').policyTarget).toBeUndefined();
  });
});

describe('built-in arg validation', () => {
  it('rejects an unknown key (strict)', () => {
    expect(() => tool('read_file').parseArgs({ path: 'a', surprise: 1 })).toThrow();
  });

  it('rejects a missing required field', () => {
    expect(() => tool('git_commit').parseArgs({})).toThrow();
    expect(() => tool('mcp_call').parseArgs({ server: 's' })).toThrow();
  });
});

describe('built-in git tool hardening', () => {
  it('git_status exposes only the subcommand to the model; args is config-only (H2)', () => {
    const props = (tool('git_status').llmVisibleParams['properties'] ?? {}) as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('command');
    expect(props).not.toHaveProperty('args'); // a model cannot inject git flags
    expect(tool('git_status').configOnlyParams).toContain('args');
  });

  it('git_commit rejects a pathspec starting with "-" (option injection) (M1)', () => {
    expect(() => tool('git_commit').parseArgs({ message: 'm', files: ['--amend'] })).toThrow();
    expect(() => tool('git_commit').parseArgs({ message: 'm', files: ['--no-verify'] })).toThrow();
    expect(() => tool('git_commit').parseArgs({ message: 'm', files: ['ok.ts'] })).not.toThrow();
  });

  it('git_commit inserts a `--` separator before pathspecs (M1)', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    );
    const target = tool('git_commit');
    await target.dispatch(
      target.parseArgs({ message: 'm', files: ['a.ts', 'b.ts'] }),
      { process: { spawn } },
      ctx,
    );
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'm', '--', 'a.ts', 'b.ts'],
      {},
      {},
      undefined,
    );
  });

  it('git_commit with no files still terminates options with `--` (TG-6)', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    );
    const target = tool('git_commit');
    await target.dispatch(target.parseArgs({ message: 'm' }), { process: { spawn } }, ctx);
    expect(spawn).toHaveBeenCalledWith('git', ['commit', '-m', 'm', '--'], {}, {}, undefined);
  });
});
