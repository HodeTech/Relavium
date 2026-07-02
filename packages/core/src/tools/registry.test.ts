import type { AbortSignalLike, ToolPolicy } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './builtins.js';
import {
  ToolArgsInvalidError,
  ToolCancelledError,
  ToolDeniedByUserError,
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
  ToolApprovalDecision,
  ToolApprovalRequest,
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
    // The result event carries a bounded, non-empty summary (registry → bounding wiring), not raw/empty.
    expect(typeof out.events.result.outputSummary).toBe('string');
    expect(out.events.result.outputSummary.length).toBeGreaterThan(0);
    expect(out.events.result.outputSummary).toContain('body:a.txt');
  });

  it('exposes has() and a sorted list() of every built-in', () => {
    const reg = registry();
    expect(reg.has('read_file')).toBe(true);
    expect(reg.has('nope')).toBe(false);
    expect(reg.list()).toEqual([...BUILTIN_TOOL_IDS].sort((a, b) => a.localeCompare(b)));
    expect(reg.list()).toHaveLength(13);
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

/* --- per-tool approval (ADR-0057 EA3) --- */

/**
 * A MUTABLE {@link AbortSignalLike} test double: `aborted` can be flipped mid-prompt (a cancel-during-confirm
 * test), and the listeners are no-ops (the registry's `isAbort` reads `.aborted` / `cause.name`, never the
 * listener path). Assignable to the `readonly aborted` param without an `as never` cast.
 */
function mutableSignal(aborted = false): { aborted: boolean } & AbortSignalLike {
  return { aborted, addEventListener: () => undefined, removeEventListener: () => undefined };
}

describe('ToolRegistry — per-tool approval (ADR-0057 EA3)', () => {
  // The `vi.fn<Fn>` function-type generic types `.mock.calls[0]` as [ToolApprovalRequest, signal?] (no
  // unused impl param) and contextually types the decision literals (`'approve'`/`'reject'`). The 2nd
  // (signal) param lets a test assert ctx.signal is forwarded to the hook.
  type ConfirmFn = (
    req: ToolApprovalRequest,
    signal?: AbortSignalLike,
  ) => Promise<ToolApprovalDecision>;
  const approving = () => vi.fn<ConfirmFn>(() => Promise.resolve({ outcome: 'approve' }));
  const rejecting = (reason?: string) =>
    vi.fn<ConfirmFn>(() =>
      Promise.resolve({ outcome: 'reject', ...(reason === undefined ? {} : { reason }) }),
    );

  /** A host whose `writeFile` is a spy, so a denied write can be proven to never reach the side effect. */
  function hostWithWriteSpy(): { host: ToolHost; writeFile: ReturnType<typeof vi.fn> } {
    const writeFile = vi.fn((path: string, data: string) =>
      Promise.resolve({ path, bytesWritten: data.length }),
    );
    return {
      writeFile,
      host: stubHost({
        fs: {
          readFile: () =>
            Promise.resolve({
              content: 'x',
              mimeType: 'text/plain',
              sizeBytes: 1,
              lastModified: 't',
            }),
          writeFile,
          listDirectory: () => Promise.resolve({ entries: [] }),
        },
      }),
    };
  }

  // --- the regime gate: present ⇒ chat (governed), absent ⇒ workflow author-trust (unchanged) ---

  it('does NOT prompt on the workflow path (no ctx.approval) — a governed write dispatches under the floor', async () => {
    const { host, writeFile } = hostWithWriteSpy();
    const out = await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      call('write_file', { path: './out.txt', content: 'hi' }),
      ctx(), // no approval regime
    );
    expect(out.events.result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it('prompts a governed write under the approval regime and dispatches on approve, with an fs_write preview', async () => {
    const confirm = approving();
    const { host, writeFile } = hostWithWriteSpy();
    const out = await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      call('write_file', { path: './out.txt', content: 'hi' }),
      ctx({ approval: { confirm } }),
    );
    expect(out.events.result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    const req = confirm.mock.calls[0]?.[0];
    expect(req).toMatchObject({
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: './out.txt' },
    });
  });

  it('emits agent:approval_requested (EA5) BEFORE invoking confirm — same request; an emit fault never breaks the floor', async () => {
    const order: string[] = [];
    const confirm = vi.fn<ConfirmFn>(() => {
      order.push('confirm');
      return Promise.resolve({ outcome: 'approve' });
    });
    const emitApprovalRequested = vi.fn<(req: ToolApprovalRequest) => void>(() =>
      order.push('emit'),
    );
    const { host } = hostWithWriteSpy();
    await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      call('write_file', { path: './out.txt', content: 'hi' }),
      ctx({ approval: { confirm, emitApprovalRequested } }),
    );
    expect(order).toEqual(['emit', 'confirm']); // the observability event fires just BEFORE the prompt
    expect(emitApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'write_file', action: 'fs_write', preview: { path: './out.txt' } }),
    );
    // The confirm hook received the SAME request object (one construction, EA5-emitted then confirmed).
    expect(emitApprovalRequested.mock.calls[0]?.[0]).toBe(confirm.mock.calls[0]?.[0]);
  });

  it('a THROWING emitApprovalRequested does not break the approval decision (best-effort observability)', async () => {
    const confirm = approving();
    const { host, writeFile } = hostWithWriteSpy();
    const out = await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      call('write_file', { path: './out.txt', content: 'hi' }),
      ctx({
        approval: {
          confirm,
          emitApprovalRequested: () => {
            throw new Error('sink boom');
          },
        },
      }),
    );
    expect(out.events.result.success).toBe(true); // the emit fault was swallowed; the write still dispatched
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it('denies a rejected write as a fatal tool_denied (user_rejected) and never reaches the side effect', async () => {
    const confirm = rejecting();
    const { host, writeFile } = hostWithWriteSpy();
    const err = await rejectsWith<ToolDeniedByUserError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('write_file', { path: './out.txt', content: 'hi' }),
        ctx({ approval: { confirm } }),
      ),
    );
    expect(err).toBeInstanceOf(ToolDeniedByUserError);
    expect(err.code).toBe('tool_denied');
    expect(err.runErrorCode).toBe('tool_denied');
    expect(err.retryable).toBe(false);
    expect(err.reason).toBe('user_rejected');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('echoes a host-supplied, secret-free reject reason in the (secret-free) message', async () => {
    const err = await rejectsWith<ToolDeniedByUserError>(
      registry().dispatch(
        call('write_file', { path: './out.txt', content: 'hi' }),
        ctx({ approval: { confirm: rejecting('writes are not allowed in ask mode') } }),
      ),
    );
    expect(err.message).toContain('writes are not allowed in ask mode');
  });

  it('is FAIL-CLOSED: an active regime with no confirm hook denies a governed write (no_approval_hook)', async () => {
    const { host, writeFile } = hostWithWriteSpy();
    const err = await rejectsWith<ToolDeniedByUserError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('write_file', { path: './out.txt', content: 'hi' }),
        ctx({ approval: {} }), // regime active, but the hook was never wired (a bug)
      ),
    );
    expect(err.reason).toBe('no_approval_hook');
    expect(writeFile).not.toHaveBeenCalled();
  });

  // --- only governed classes are gated (read-only / pre-approved tools bypass the prompt) ---

  it('does NOT prompt for a read-only fs tool (read_file) even under the regime', async () => {
    const confirm = approving();
    const out = await registry().dispatch(
      call('read_file', { path: 'a.txt' }),
      ctx({ approval: { confirm } }),
    );
    expect(out.events.result.success).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does NOT prompt for the pre-approved git_status (a process tool with no model command target)', async () => {
    const confirm = approving();
    const out = await registry().dispatch(call('git_status', {}), ctx({ approval: { confirm } }));
    expect(out.events.result.success).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  // --- the governed process / egress classes, with their previews ---

  it('prompts a model-controlled run_command (process) with the resolved command preview', async () => {
    const confirm = approving();
    const out = await registry().dispatch(
      call('run_command', { command: 'ls', args: ['-la'] }),
      ctx({ approval: { confirm }, toolPolicy: { allowedCommands: ['ls -la'] } }),
    );
    expect(out.events.result.success).toBe(true);
    const req = confirm.mock.calls[0]?.[0];
    expect(req).toMatchObject({
      toolId: 'run_command',
      action: 'process',
      preview: { command: 'ls -la' },
    });
  });

  it('prompts http_request (egress) with the host-only preview (never the full URL)', async () => {
    const confirm = approving();
    const out = await registry().dispatch(
      call('http_request', { url: 'https://api.example.com/secret?token=abc' }),
      ctx({ approval: { confirm }, toolPolicy: { allowedDomains: ['api.example.com'] } }),
    );
    expect(out.events.result.success).toBe(true);
    const req = confirm.mock.calls[0]?.[0];
    expect(req).toMatchObject({
      toolId: 'http_request',
      action: 'egress',
      preview: { host: 'api.example.com' },
    });
    // the query string (and its token) never enters the preview — assert over all recorded call args
    expect(JSON.stringify(confirm.mock.calls)).not.toContain('token');
  });

  it('prompts web_search (egress) with an empty preview — it exposes no pre-dispatch URL target', async () => {
    const confirm = approving();
    const out = await registry().dispatch(
      call('web_search', { query: 'hi' }),
      ctx({
        approval: { confirm },
        config: { parameters: { endpoint: 'https://search.example.com' } },
      }),
    );
    expect(out.events.result.success).toBe(true);
    const req = confirm.mock.calls[0]?.[0];
    expect(req).toMatchObject({ toolId: 'web_search', action: 'egress', preview: {} });
  });

  it('prompts read_clipboard (os) with an empty preview and dispatches on approve (an exfil sink is gated)', async () => {
    const confirm = approving();
    const out = await registry().dispatch(
      call('read_clipboard', {}),
      ctx({ approval: { confirm } }),
    );
    expect(out.events.result.success).toBe(true);
    const req = confirm.mock.calls[0]?.[0];
    expect(req).toMatchObject({ toolId: 'read_clipboard', action: 'os', preview: {} });
  });

  it('denies a rejected read_clipboard as fatal tool_denied and never reads the clipboard', async () => {
    const readClipboard = vi.fn(() => Promise.resolve('a-secret'));
    const host: ToolHost = {
      ...stubHost(),
      os: { readClipboard, notify: () => Promise.resolve() },
    };
    const err = await rejectsWith<ToolDeniedByUserError>(
      registry(host).dispatch(
        call('read_clipboard', {}),
        ctx({ approval: { confirm: rejecting() } }),
      ),
    );
    expect(err.code).toBe('tool_denied');
    expect(readClipboard).not.toHaveBeenCalled(); // denied BEFORE the host call — no clipboard read
  });

  // --- ordering + cancellation ---

  it('runs the enforcePolicy floor BEFORE approval — a denied run_command never reaches the prompt', async () => {
    const confirm = approving();
    const err = await rejectsWith<ToolPolicyError>(
      registry().dispatch(
        call('run_command', { command: 'rm', args: ['-rf', '/'] }),
        ctx({ approval: { confirm }, toolPolicy: { allowedCommands: [] } }), // empty ⇒ deny-all
      ),
    );
    expect(err).toBeInstanceOf(ToolPolicyError);
    expect(err.reason).toBe('command_not_allowed');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('classifies an abort raised while prompting (hook throws AbortError) as cancelled, not a denial', async () => {
    const { host, writeFile } = hostWithWriteSpy();
    const confirm = vi.fn(() =>
      Promise.reject(Object.assign(new Error('prompt aborted'), { name: 'AbortError' })),
    );
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('write_file', { path: './out.txt', content: 'hi' }),
        ctx({ approval: { confirm } }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('cancel-wins-all: a signal that aborts mid-prompt + a hook that throws a PLAIN error classifies as cancelled, not approval_error', async () => {
    // Exercises the `ctx.signal?.aborted` branch of isAbort in the confirm catch (the AbortError test
    // above exercises only the cause.name branch), and proves cancel precedence over the fail-closed deny.
    // The signal must flip DURING the prompt (not before): an already-aborted signal short-circuits at the
    // dispatch entry guard before the hook ever runs.
    const signal = mutableSignal();
    const { host, writeFile } = hostWithWriteSpy();
    const confirm = vi.fn<ConfirmFn>(() => {
      signal.aborted = true; // cancelled while the prompt is pending…
      return Promise.reject(new Error('hook bug while cancelling')); // …and the hook then throws a plain error
    });
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('write_file', { path: './out.txt', content: 'hi' }),
        ctx({ approval: { confirm }, signal: signal }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('cancels (never executes) when the signal aborts WHILE prompting and the hook still resolves approve', async () => {
    // The fail-closed cancellation contract: a hook that ignores the AbortSignal and approves anyway must
    // NOT reach the side effect — the trailing throwIfAborted in confirmDispatch catches it.
    const signal = mutableSignal();
    const { host, writeFile } = hostWithWriteSpy();
    const confirm = vi.fn<ConfirmFn>(() => {
      signal.aborted = true; // the run is cancelled while the prompt is pending…
      return Promise.resolve({ outcome: 'approve' }); // …but the hook approves anyway
    });
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('write_file', { path: './out.txt', content: 'hi' }),
        ctx({ approval: { confirm }, signal: signal }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('is FAIL-CLOSED on a hook that THROWS a non-abort error — denies (approval_error), never retryable', async () => {
    const { host, writeFile } = hostWithWriteSpy();
    const confirm = vi.fn<ConfirmFn>(() => Promise.reject(new Error('hook bug')));
    const err = await rejectsWith<ToolDeniedByUserError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('write_file', { path: './out.txt', content: 'hi' }),
        ctx({ approval: { confirm } }),
      ),
    );
    expect(err).toBeInstanceOf(ToolDeniedByUserError);
    expect(err.reason).toBe('approval_error');
    expect(err.runErrorCode).toBe('tool_denied'); // fatal, NOT the retryable tool_failed a host throw gets
    expect(err.retryable).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('gates mcp_call (egress) — confirm prompts with an empty preview; approve runs it, reject denies it', async () => {
    const call_ = vi.fn(() => Promise.resolve({ ok: true }));
    const host = stubHost({ mcp: { call: call_ } });
    const reg = () => createToolRegistry({ tools: BUILTIN_TOOLS, host });
    // approve
    const confirm = approving();
    const out = await reg().dispatch(
      call('mcp_call', { server: 's', tool: 't' }),
      ctx({ approval: { confirm } }),
    );
    expect(out.events.result.success).toBe(true);
    expect(call_).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      toolId: 'mcp_call',
      action: 'egress',
      preview: {},
    });
    // reject — the side effect must not run
    call_.mockClear();
    const err = await rejectsWith<ToolDeniedByUserError>(
      reg().dispatch(
        call('mcp_call', { server: 's', tool: 't' }),
        ctx({ approval: { confirm: rejecting() } }),
      ),
    );
    expect(err.reason).toBe('user_rejected');
    expect(call_).not.toHaveBeenCalled();
  });

  it('previews a no-args run_command as the bare command (join yields { command:"ls" }, not "ls ")', async () => {
    const confirm = approving();
    await registry().dispatch(
      call('run_command', { command: 'ls' }),
      ctx({ approval: { confirm }, toolPolicy: { allowedCommands: ['ls'] } }),
    );
    expect(confirm.mock.calls[0]?.[0]?.preview).toEqual({ command: 'ls' });
  });

  it('forwards ctx.signal to the confirm hook as its second argument', async () => {
    const signal = mutableSignal();
    const confirm = approving();
    await registry().dispatch(
      call('write_file', { path: './out.txt', content: 'hi' }),
      ctx({ approval: { confirm }, signal: signal }),
    );
    expect(confirm.mock.calls[0]?.[1]).toBe(signal);
  });

  it('denies a rejected http_request (egress) — the host fetch is never reached', async () => {
    const fetch = vi.fn(() => Promise.resolve({ status: 200, headers: {}, body: '{}' }));
    const err = await rejectsWith<ToolDeniedByUserError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host: stubHost({ egress: { fetch } }) }).dispatch(
        call('http_request', { url: 'https://api.example.com/x' }),
        ctx({
          approval: { confirm: rejecting() },
          toolPolicy: { allowedDomains: ['api.example.com'] },
        }),
      ),
    );
    expect(err.reason).toBe('user_rejected');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('denies a rejected run_command (process) — the host spawn is never reached', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    );
    const err = await rejectsWith<ToolDeniedByUserError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host: stubHost({ process: { spawn } }) }).dispatch(
        call('run_command', { command: 'ls' }),
        ctx({ approval: { confirm: rejecting() }, toolPolicy: { allowedCommands: ['ls'] } }),
      ),
    );
    expect(err.reason).toBe('user_rejected');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancel-wins-all: an already-aborted signal yields cancelled (never a fail-closed deny) for a governed write', async () => {
    // An already-aborted signal short-circuits at the dispatch entry guard (cancel precedence, ADR-0036)
    // BEFORE the approval gate runs — so a would-be fail-closed `no_approval_hook` deny on an aborted turn
    // correctly surfaces as cancelled, not denied, and the side effect never runs.
    const { host, writeFile } = hostWithWriteSpy();
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('write_file', { path: './out.txt', content: 'hi' }),
        ctx({ approval: {}, signal: mutableSignal(true) }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
    expect(writeFile).not.toHaveBeenCalled();
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

  it('redacts inline media base64 from agent:tool_call.toolInput (I3 — symmetric to the result-side outputSummary redaction)', async () => {
    // A model can emit a base64 `data:` URI as a free-form string tool argument (here http_request's `body`
    // and a header value). toolInput rides the event/IPC/log stream (an I3 boundary the emit-time
    // deInlineMedia choke point cannot catch in a flat string), so the bytes must be redacted there exactly
    // as the result side redacts outputSummary — the dispatch still ran on the real (un-redacted) args.
    const dataUri = 'data:image/png;base64,aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSByZWFsIGltYWdl';
    const out = await registry().dispatch(
      call('http_request', {
        url: 'https://api.example.com/x',
        body: dataUri,
        headers: { 'x-thumb': dataUri },
      }),
      ctx({ toolPolicy: { allowedDomains: ['api.example.com'] } }),
    );
    expect(out.events.call.toolInput).toMatchObject({
      body: '[base64 data URI omitted]',
      headers: { 'x-thumb': '[base64 data URI omitted]' }, // the walk recurses into nested objects
    });
    // No fragment of the payload survives anywhere in the event field.
    expect(JSON.stringify(out.events.call.toolInput)).not.toContain('aGVsbG8');
  });

  it('scrubs a secret-shaped value from agent:tool_call.toolInput (a model-set credential in a header/body/url)', async () => {
    // The security-load-bearing wiring: sanitizeInput runs redactSecretShapedValue so a model-injected token in
    // an http_request header VALUE / body / url-query never rides toolInput → the --json/event/log stream. The
    // header NAME is kept; the dispatch still ran on the real args.
    const out = await registry().dispatch(
      call('http_request', {
        url: 'https://api.example.com/x?api_key=sk-' + 'abcdef0123456789xyz',
        body: 'client_secret=supersecretvalue123',
        headers: { Authorization: 'Bearer tok_live_abcdef123456', 'x-keep': 'plain' },
      }),
      ctx({ toolPolicy: { allowedDomains: ['api.example.com'] } }),
    );
    const toolInput = out.events.call.toolInput as {
      url: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(toolInput.headers['Authorization']).toBe('Bearer [redacted]'); // value scrubbed, NAME kept
    expect(toolInput.headers['x-keep']).toBe('plain'); // non-secret header untouched
    expect(toolInput.body).toBe('[redacted]');
    expect(toolInput.url).not.toContain('sk-' + 'abcdef0123456789xyz');
    const serialized = JSON.stringify(out.events.call.toolInput);
    expect(serialized).not.toContain('supersecretvalue123');
    expect(serialized).not.toContain('tok_live_abcdef123456');
  });
});

/* --- capability availability + execution + cancellation --- */

describe('ToolRegistry — host capability, execution, cancellation', () => {
  it('surfaces a missing capability as a typed (tool_unavailable) error, not execution_failed', async () => {
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
    expect(err.runErrorCode).toBe('tool_unavailable'); // EA1 (ADR-0055) — actionable, never a bare `internal`
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
        ctx({ signal: mutableSignal(true) }),
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
    const signal = mutableSignal();
    const host = stubHost({
      fs: fsWith(() => {
        signal.aborted = true; // the run is cancelled while the host is in-flight
        return Promise.reject(new Error('boom')); // a plain (non-AbortError) host error
      }),
    });
    const err = await rejectsWith<ToolCancelledError>(
      createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
        call('read_file', { path: 'a' }),
        ctx({ signal: signal }),
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
    const signal = mutableSignal();
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
        ctx({ signal: signal }),
      ),
    );
    expect(err).toBeInstanceOf(ToolCancelledError);
  });

  it('classifies an abort that lands during bounding (H-1 / post-boundForModel guard)', async () => {
    const signal = mutableSignal();
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
        ctx({ signal: signal, limits: { maxBytes: 10, maxLines: 1 } }),
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
