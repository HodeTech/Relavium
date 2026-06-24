import type { Scope } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './builtins.js';
import { ToolArgsInvalidError, ToolPolicyError, ToolUnavailableError } from './errors.js';
import type { MediaReadAccess, ToolDef, ToolDispatchContext, ToolHost } from './types.js';

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
  it('registers 13 unique built-ins, all sourced "builtin"', () => {
    expect(BUILTIN_TOOLS).toHaveLength(13);
    expect(new Set(BUILTIN_TOOL_IDS).size).toBe(13);
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

/** A ToolHost whose egress records each fetch's url + credentialRef — for the web_search url tests. */
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

describe('web_search url construction + endpoint validation', () => {
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

describe('read_media (1.AF/D12 — scope-set authz + Range gate)', () => {
  const HANDLE = `media://sha256-${'a'.repeat(64)}`;
  const SESSION: Scope = { kind: 'session', id: 's1' };

  function access(allowed: readonly Scope[], byteLength = 5): MediaReadAccess {
    return {
      describe: () =>
        Promise.resolve({ mimeType: 'image/png', byteLength, allowedScopes: allowed }),
      readRange: (_handle, range) =>
        Promise.resolve({ kind: 'base64', data: `B${range.start}-${range.end}` }),
    };
  }
  function mediaCtx(requestingScope: Scope, mediaRead: MediaReadAccess): ToolDispatchContext {
    return { ...ctx, requestingScope, mediaRead };
  }

  it('returns the media inline (whole-handle default) when the scope is in allowedScopes', async () => {
    const t = tool('read_media');
    const out = await t.dispatch(
      t.parseArgs({ handle: HANDLE }),
      {},
      mediaCtx(SESSION, access([SESSION], 5)),
    );
    expect(out).toEqual({
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: 'B0-4' },
    });
  });

  it('honors an explicit inclusive byte range', async () => {
    const t = tool('read_media');
    const out = await t.dispatch(
      t.parseArgs({ handle: HANDLE, start: 1, end: 3 }),
      {},
      mediaCtx(SESSION, access([SESSION], 10)),
    );
    expect(out).toMatchObject({ source: { kind: 'base64', data: 'B1-3' } });
  });

  it('denies (media_scope_denied) when the scope is NOT in allowedScopes', async () => {
    const t = tool('read_media');
    const err = await rejection(() =>
      t.dispatch(
        t.parseArgs({ handle: HANDLE }),
        {},
        mediaCtx(SESSION, access([{ kind: 'session', id: 'other' }], 5)),
      ),
    );
    expect(err).toBeInstanceOf(ToolPolicyError);
    if (err instanceof ToolPolicyError) {
      expect(err.reason).toBe('media_scope_denied'); // narrow, never an unsafe `as` cast
    }
  });

  it('rejects an unknown handle (describe → undefined)', async () => {
    const t = tool('read_media');
    const unknown: MediaReadAccess = {
      describe: () => Promise.resolve(undefined),
      readRange: () => Promise.reject(new Error('must not read')),
    };
    const err = await rejection(() =>
      t.dispatch(t.parseArgs({ handle: HANDLE }), {}, mediaCtx(SESSION, unknown)),
    );
    expect(err).toBeInstanceOf(ToolArgsInvalidError);
  });

  it('rejects an out-of-bounds range BEFORE any host read (fail-closed)', async () => {
    const t = tool('read_media');
    let read = false;
    const spy: MediaReadAccess = {
      describe: () =>
        Promise.resolve({ mimeType: 'image/png', byteLength: 5, allowedScopes: [SESSION] }),
      readRange: () => {
        read = true;
        return Promise.resolve({ kind: 'base64', data: 'x' });
      },
    };
    const err = await rejection(() =>
      t.dispatch(t.parseArgs({ handle: HANDLE, start: 0, end: 99 }), {}, mediaCtx(SESSION, spy)),
    );
    expect(err).toBeInstanceOf(ToolArgsInvalidError);
    expect(read).toBe(false);
  });

  it('is unavailable when the host wires no media-read delegate', async () => {
    const t = tool('read_media');
    const err = await rejection(() => t.dispatch(t.parseArgs({ handle: HANDLE }), {}, ctx));
    expect(err).toBeInstanceOf(ToolUnavailableError);
  });

  it('forwards ctx.signal to describe() and readRange() (D13 cancellation threading)', async () => {
    const t = tool('read_media');
    const signal = new AbortController().signal;
    const seen: { describe?: unknown; readRange?: unknown } = {};
    const capturing: MediaReadAccess = {
      describe: (_handle, s) => {
        seen.describe = s;
        return Promise.resolve({ mimeType: 'image/png', byteLength: 5, allowedScopes: [SESSION] });
      },
      readRange: (_handle, range, s) => {
        seen.readRange = s;
        return Promise.resolve({ kind: 'base64', data: `B${range.start}-${range.end}` });
      },
    };
    await t.dispatch(
      t.parseArgs({ handle: HANDLE }),
      {},
      { ...mediaCtx(SESSION, capturing), signal },
    );
    expect(seen.describe).toBe(signal);
    expect(seen.readRange).toBe(signal);
  });

  it('returns a HANDLE source (schema-valid, not empty base64) for a whole-handle read of a zero-byte handle', async () => {
    const t = tool('read_media');
    let read = false;
    const empty: MediaReadAccess = {
      describe: () =>
        Promise.resolve({ mimeType: 'image/png', byteLength: 0, allowedScopes: [SESSION] }),
      readRange: () => {
        read = true;
        return Promise.resolve({ kind: 'base64', data: 'x' });
      },
    };
    const out = await t.dispatch(t.parseArgs({ handle: HANDLE }), {}, mediaCtx(SESSION, empty));
    // A handle source (not `{ kind:'base64', data:'' }`, which violates the base64 nonEmptyString contract).
    expect(out).toEqual({
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'handle', ref: HANDLE },
    });
    expect(read).toBe(false); // the empty whole-handle read short-circuits before any host read
  });

  it('still rejects an EXPLICIT range on a zero-byte handle (out of bounds, fail-closed)', async () => {
    const t = tool('read_media');
    const empty: MediaReadAccess = {
      describe: () =>
        Promise.resolve({ mimeType: 'image/png', byteLength: 0, allowedScopes: [SESSION] }),
      readRange: () => Promise.reject(new Error('must not read')),
    };
    const err = await rejection(() =>
      t.dispatch(t.parseArgs({ handle: HANDLE, start: 0, end: 0 }), {}, mediaCtx(SESSION, empty)),
    );
    expect(err).toBeInstanceOf(ToolArgsInvalidError);
  });

  it('denies (media_scope_denied) a zero-byte handle when the scope is NOT granted — authz BEFORE the 0-byte short-circuit', async () => {
    const t = tool('read_media');
    let read = false;
    const empty: MediaReadAccess = {
      describe: () =>
        Promise.resolve({
          mimeType: 'image/png',
          byteLength: 0,
          allowedScopes: [{ kind: 'session', id: 'other' }],
        }),
      readRange: () => {
        read = true;
        return Promise.resolve({ kind: 'base64', data: 'x' });
      },
    };
    const err = await rejection(() =>
      t.dispatch(t.parseArgs({ handle: HANDLE }), {}, mediaCtx(SESSION, empty)),
    );
    expect(err).toBeInstanceOf(ToolPolicyError);
    expect(err).toMatchObject({ reason: 'media_scope_denied' }); // not the empty-content short-circuit
    expect(read).toBe(false);
  });

  it('rejects a syntactically malformed handle at parse time (engine-pure structural check)', () => {
    const t = tool('read_media');
    expect(() => t.parseArgs({ handle: '../../etc/passwd' })).toThrow();
    expect(() => t.parseArgs({ handle: 'media://sha256-not-hex' })).toThrow();
  });
});
