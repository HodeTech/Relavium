import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import {
  McpError,
  type McpClient,
  type McpConnection,
  type HttpServerSpec,
  type McpServerConfig,
  type StdioServerSpec,
} from '@relavium/mcp';
import type { Agent, McpServerRef, McpServerRegistration } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { CliError, isCliError } from '../process/errors.js';
import { captureIo } from '../test-support.js';
import type { ResolvedStdioSpawn } from './mcp-consent.js';
import {
  buildChildEnv,
  connectAgentMcp,
  connectWorkflowMcp,
  mcpSkippedLines,
  resolveMcpServerRef,
  resolveServerConfigs,
  surfaceMcpSkipped,
} from './mcp-servers.js';

/** A fake live client — the injected `startMcpClient` returns it, so no child is ever spawned. */
function fakeClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    capability: { call: () => Promise.resolve({ content: [], isError: false }) },
    toolDefs: [],
    toolIdsByServer: new Map(),
    childPids: [],
    skipped: [],
    close: () => Promise.resolve(),
    ...overrides,
  };
}

const stdioRef = (over: Partial<McpServerRef> = {}): McpServerRef => ({
  id: 'fs',
  transport: 'stdio',
  command: 'my-server',
  ...over,
});

/**
 * A gate that consents to everything, resolving nothing.
 *
 * `connectAgentMcp` / `connectWorkflowMcp` REFUSE a stdio declaration when no gate was wired (ADR-0084 §1),
 * because that optionality is exactly what left four of the five entry points ungated. These cases are about
 * host wiring rather than about consent, so they say so explicitly instead of inheriting a default.
 */
const PASS_CONSENT = (): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> =>
  Promise.resolve(new Map());

describe('resolveServerConfigs', () => {
  it('maps a stdio ref to a config carrying its id + allowlist (open is a deferred spawn closure)', () => {
    const configs = resolveServerConfigs(
      [stdioRef({ tools_allowlist: ['read', 'write'] })],
      '/work',
    );
    expect(configs).toHaveLength(1);
    expect(configs[0]?.id).toBe('fs');
    expect(configs[0]?.toolsAllowlist).toEqual(['read', 'write']);
    expect(typeof configs[0]?.open).toBe('function'); // not invoked here — no spawn in a unit test
  });

  it('carries an authored connect_timeout_ms all the way into the STDIO spawn spec (ADR-0088 §1.4)', async () => {
    // **The journey a review proved untested.** Four independent mutations — dropping the forwarding in
    // `buildStdioConfig`, in `buildNetworkConfig`, in the registration carry-through, and in all four
    // adapters' `spec.connectTimeoutMs ?? DEFAULT` — each left every suite green. `packages/shared` proves
    // the SHAPE is admitted; nothing proved the admitted value is USED, so the whole field was decorative.
    let seen: StdioServerSpec | undefined;
    const configs = resolveServerConfigs(
      [stdioRef({ connect_timeout_ms: 300_000 })],
      '/work',
      undefined,
      {
        stdio: (_id, spec) => {
          seen = spec;
          return Promise.reject(new Error('not connecting in a unit test'));
        },
      },
    );
    await expect(configs[0]?.open()).rejects.toThrow('not connecting');
    expect(seen?.connectTimeoutMs).toBe(300_000);
  });

  it('omits connectTimeoutMs entirely when unauthored, so the adapter default applies', () => {
    // `exactOptionalPropertyTypes`: an explicit `undefined` would be a different value from absent, and the
    // adapter's `spec.connectTimeoutMs ?? MCP_DEADLINES.x` reads absent as "use the default".
    let seen: StdioServerSpec | undefined;
    const configs = resolveServerConfigs([stdioRef()], '/work', undefined, {
      stdio: (_id, spec) => {
        seen = spec;
        return Promise.reject(new Error('stop'));
      },
    });
    void configs[0]?.open().catch(() => undefined);
    expect(seen !== undefined && 'connectTimeoutMs' in seen).toBe(false);
  });

  it('carries an authored connect_timeout_ms into a NETWORK connect spec too', async () => {
    let seen: HttpServerSpec | undefined;
    const configs = resolveServerConfigs(
      [
        {
          id: 'docs',
          transport: 'http',
          url: 'https://docs.example/mcp',
          connect_timeout_ms: 45_000,
        },
      ],
      '/work',
      undefined,
      {
        http: (_id, spec) => {
          seen = spec;
          return Promise.reject(new Error('not connecting in a unit test'));
        },
      },
    );
    await expect(configs[0]?.open()).rejects.toThrow('not connecting');
    expect(seen?.connectTimeoutMs).toBe(45_000);
  });

  it('hands the CONNECT SIGNAL to the opener — a parameter, not a dropped argument', async () => {
    // **The defect this pins was found one layer up from where it was fixed.** The adapters took a `signal`,
    // `startMcpClient` passed one, and the closure built HERE was written `open: () => …` — which accepts the
    // call and silently drops the argument. TypeScript is happy; the cancel path type-checks and cannot fire.
    // A Ctrl-C during a cold `npx` therefore stopped nothing, and the child was orphaned, because
    // `McpClient.childPids` stays empty until a connect fully succeeds so neither reaper had a pid either.
    //
    // Asserting IDENTITY, not merely presence: a closure that captured some other controller's signal would
    // pass a presence check and still not be cancellable by the caller who owns the teardown.
    const controller = new AbortController();
    let seenSignal: unknown = 'never called';
    const configs = resolveServerConfigs([stdioRef()], '/work', undefined, {
      stdio: (_id, _spec, signal) => {
        seenSignal = signal;
        return Promise.reject(new Error('not connecting in a unit test'));
      },
    });
    await expect(configs[0]?.open(controller.signal)).rejects.toThrow('not connecting');
    expect(seenSignal).toBe(controller.signal);
  });

  it('hands the connect signal to a NETWORK opener too', async () => {
    const controller = new AbortController();
    let seenSignal: unknown = 'never called';
    const configs = resolveServerConfigs(
      [{ id: 'docs', transport: 'http', url: 'https://docs.example/mcp' }],
      '/work',
      undefined,
      {
        http: (_id, _spec, signal) => {
          seenSignal = signal;
          return Promise.reject(new Error('not connecting in a unit test'));
        },
      },
    );
    await expect(configs[0]?.open(controller.signal)).rejects.toThrow('not connecting');
    expect(seenSignal).toBe(controller.signal);
  });

  it('omits toolsAllowlist when the ref declares none (exactOptionalPropertyTypes — never an explicit undefined)', () => {
    const configs = resolveServerConfigs([stdioRef()], '/work');
    expect('toolsAllowlist' in configs[0]!).toBe(false);
  });

  it('RE-ASSERTS the declared-env denylist, for a caller that bypassed the schema (ADR-0084 §4)', () => {
    // The parse-time rule is the primary one, but `resolveMcpServerRef` hand-builds a ref from a
    // registration and is documented as never re-parsed, and ADR-0084 §1 designates this function's caller
    // as THE chokepoint. Its network sibling re-asserts its own rules for exactly this reason; this one did
    // not. `stdioRef` builds a `McpServerRef` directly, which is the programmatic caller in question.
    expect(() =>
      resolveServerConfigs([stdioRef({ env: { NODE_OPTIONS: '--require /tmp/x.js' } })], '/work'),
    ).toThrow(/environment variable/);
    // …and an ordinary declared variable still passes, so the guard is narrow rather than a refusal.
    expect(() =>
      resolveServerConfigs([stdioRef({ env: { ACME_TOKEN: 'x' } })], '/work'),
    ).not.toThrow();
  });

  it('a REFUSING gate means nothing is ever handed to the client — §10.1 counted, not believed', async () => {
    // §1: "proven by counting spawns, not by reading a flag". `startMcpClient` is what invokes every
    // config's `open()`, so a counter on it observes the process boundary: zero calls is zero spawns. This
    // is the shape of test whose absence made the gate's non-coverage of the chat family invisible.
    let started = 0;
    await expect(
      connectAgentMcp([stdioRef()], {
        cwd: '/work',
        consentGate: () => Promise.reject(new CliError('invalid_invocation', 'declined')),
        startMcpClient: () => {
          started += 1;
          return Promise.resolve(fakeClient());
        },
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(started).toBe(0);
  });

  it('…and an APPROVING gate hands them over exactly once', async () => {
    let started = 0;
    await connectAgentMcp([stdioRef()], {
      cwd: '/work',
      consentGate: () => Promise.resolve(new Map()),
      startMcpClient: () => {
        started += 1;
        return Promise.resolve(fakeClient());
      },
    });
    expect(started).toBe(1);
  });

  it('spawns the CONSENTED absolute executable, not the authored word (ADR-0084 §10.6)', async () => {
    // The other half of resolving before the decision, and it was unmeasured: mutating the fallback to
    // always use `ref.command` survived the entire 2487-test suite. If it regresses, the child's `PATH`
    // selects the binary again under an approved fingerprint — silently, which is the whole failure mode
    // §3 exists to close.
    const seen: StdioServerSpec[] = [];
    const configs = resolveServerConfigs(
      [stdioRef({ command: 'node' })],
      '/work',
      undefined,
      {
        stdio: (_id, spec) => {
          seen.push(spec);
          return Promise.resolve({
            listTools: () => Promise.resolve([]),
            callTool: () => Promise.resolve({ content: [], isError: false }),
            close: () => Promise.resolve(),
          });
        },
      },
      new Map([
        [
          'fs',
          {
            serverId: 'fs',
            provenance: { kind: 'inline' as const },
            command: 'node',
            resolvedCommand: '/abs/planted/node',
            args: [],
            env: {},
            cwd: '/work',
            consentGate: PASS_CONSENT,
          },
        ],
      ]),
    );
    await configs[0]?.open();
    expect(seen[0]?.command).toBe('/abs/planted/node');
  });

  it('falls back to the authored command when no gate ran — the un-gated fixture path', async () => {
    const seen: StdioServerSpec[] = [];
    const configs = resolveServerConfigs([stdioRef({ command: 'node' })], '/work', undefined, {
      stdio: (_id, spec) => {
        seen.push(spec);
        return Promise.resolve({
          listTools: () => Promise.resolve([]),
          callTool: () => Promise.resolve({ content: [], isError: false }),
          close: () => Promise.resolve(),
        });
      },
    });
    await configs[0]?.open();
    expect(seen[0]?.command).toBe('node');
  });

  it('returns an empty list for undefined / empty mcp_servers', () => {
    expect(resolveServerConfigs(undefined, '/work')).toEqual([]);
    expect(resolveServerConfigs([], '/work')).toEqual([]);
  });

  it('dispatches each network transport to its opener (http → Streamable HTTP, sse → legacy, websocket → ws)', async () => {
    const calls: string[] = [];
    const conn: McpConnection = {
      listTools: () => Promise.resolve([]),
      callTool: () => Promise.resolve({ content: [], isError: false }),
      close: () => Promise.resolve(),
    };
    const spy =
      (label: string) =>
      (serverId: string, spec: { url: string }): Promise<McpConnection> => {
        calls.push(`${label}:${serverId}:${spec.url}`);
        return Promise.resolve(conn);
      };
    const configs = resolveServerConfigs(
      [
        { id: 'a', transport: 'http', url: 'https://h/mcp' },
        { id: 'b', transport: 'sse', url: 'https://h/sse' },
        { id: 'c', transport: 'websocket', url: 'wss://h/ws' },
      ],
      '/work',
      undefined,
      { http: spy('http'), sse: spy('sse'), websocket: spy('ws') },
    );
    await Promise.all(configs.map((c) => c.open()));
    expect(calls.sort()).toEqual([
      'http:a:https://h/mcp',
      'sse:b:https://h/sse',
      'ws:c:wss://h/ws',
    ]);
  });

  it('rejects a stdio ref with no command (defensive — the schema guarantees it, but the spawn must be total)', () => {
    // Construct the ref directly (bypassing the schema superRefine) to exercise the host-side guard.
    const bad: McpServerRef = { id: 'fs', transport: 'stdio' };
    expect(() => resolveServerConfigs([bad], '/work')).toThrow(/requires a 'command'/);
  });

  it('rejects `env` on a network ref at the host boundary (defense-in-depth below the schema)', () => {
    // The schema already rejects network `env`; this re-asserts at the host so a programmatic caller that
    // bypassed the schema fails loud rather than silently discarding what is almost always an auth secret.
    const bad: McpServerRef = {
      id: 'docs',
      transport: 'http',
      url: 'https://docs.example/mcp',
      env: { TOKEN: '{{secrets.gh}}' },
    };
    expect(() => resolveServerConfigs([bad], '/work')).toThrow(/'env' is not used by a network/);
  });

  it('rejects an env value carrying a {{…}} marker when NO secret resolver is wired', () => {
    try {
      resolveServerConfigs([stdioRef({ env: { TOKEN: '{{secrets.gh}}' } })], '/work');
      expect.unreachable('a {{…}} env value must throw');
    } catch (err) {
      if (!isCliError(err)) throw err; // narrow to CliError (no cast); a non-CliError is an unexpected fault
      expect(err.code).toBe('invalid_invocation');
      // The error names the KEY, never the value — a placeholder is not a secret, but stay disciplined.
      expect(err.message).toContain('TOKEN');
      expect(err.message).not.toContain('secrets.gh');
    }
  });

  it('accepts a literal env value (the common case)', () => {
    expect(() =>
      resolveServerConfigs([stdioRef({ env: { LOG_LEVEL: 'debug' } })], '/work'),
    ).not.toThrow();
  });

  it('carries the RESOLVED secret into the spawn-spec env (and only there) — ties resolver → buildChildEnv → open', async () => {
    // The genuine custody tie: inject a spy `openConnection`, invoke the config's `open()`, and assert the
    // resolved value reached the spawn boundary's `env`. In production that spec.env is the ONLY place the value
    // flows (sdk-stdio.ts `env: {...spec.env}`); nothing else observes it.
    let capturedSpec: { command: string; env: Record<string, string>; cwd?: string } | undefined;
    const conn: McpConnection = {
      listTools: () => Promise.resolve([]),
      callTool: () => Promise.resolve({ content: [], isError: false }),
      close: () => Promise.resolve(),
    };
    const configs = resolveServerConfigs(
      [stdioRef({ env: { TOKEN: 'Bearer {{secrets.gh}}' } })],
      '/work',
      (name) => (name === 'gh' ? 'ghp_SENTINEL' : 'OTHER'),
      {
        stdio: (_serverId, spec) => {
          capturedSpec = spec;
          return Promise.resolve(conn);
        },
      },
    );
    await configs[0]!.open(); // invoke the spawn closure → calls the spy with the built spec (await: surface a reject)
    expect(capturedSpec?.env).toEqual({ TOKEN: 'Bearer ghp_SENTINEL' }); // the resolved value reached the spawn env
    expect(capturedSpec?.command).toBe('my-server');
  });
});

describe('SSRF floor (resolveServerConfigs network gate, 2.R Step 4c / ADR-0053)', () => {
  const netRef = (over: Partial<McpServerRef> = {}): McpServerRef => ({
    id: 'n',
    transport: 'http',
    url: 'https://api.example/mcp',
    ...over,
  });
  // The gate runs synchronously at config build (before any connect), so a throw surfaces from resolveServerConfigs.
  const build = (over: Partial<McpServerRef> = {}): McpServerConfig[] =>
    resolveServerConfigs([netRef(over)], '/work');

  it('accepts a remote https/wss endpoint', () => {
    expect(build({ url: 'https://api.example/mcp' })).toHaveLength(1);
    expect(build({ transport: 'websocket', url: 'wss://api.example/ws' })).toHaveLength(1);
  });

  it('rejects a private/loopback/link-local host without allow_local_endpoint', () => {
    for (const url of [
      'http://127.0.0.1:4000/mcp',
      'http://localhost:4000/mcp',
      'http://10.0.0.5/mcp',
      'http://192.168.1.2/mcp',
      'http://169.254.169.254/latest', // the cloud metadata endpoint
      'http://[::1]/mcp',
    ]) {
      expect(() => build({ url })).toThrow(/private\/loopback/);
    }
  });

  it('rejects canonical SSRF bypass-encodings of a loopback host (the shared primitive normalizes them)', () => {
    // Lock the gate's host-extraction + the reuse of `isPrivateOrLocalHost` against an encoding-based bypass.
    for (const url of [
      'http://2130706433/mcp', // decimal 127.0.0.1
      'http://0x7f000001/mcp', // hex 127.0.0.1
      'http://0177.0.0.1/mcp', // octal-leading 127.0.0.1
      'http://127.1/mcp', // inet_aton short form
      'http://LOCALHOST./mcp', // uppercase + trailing FQDN dot
      'http://[::ffff:127.0.0.1]/mcp', // IPv4-mapped IPv6
      'http://0.0.0.0/mcp', // the "this host" wildcard
    ]) {
      expect(() => build({ url })).toThrow(/private\/loopback/);
    }
  });

  it('permits a private/loopback endpoint AND plaintext WITH allow_local_endpoint', () => {
    expect(build({ url: 'http://localhost:4000/mcp', allow_local_endpoint: true })).toHaveLength(1);
    expect(
      build({ transport: 'sse', url: 'http://127.0.0.1:4000/sse', allow_local_endpoint: true }),
    ).toHaveLength(1); // the sse alias runs the same floor as http
    expect(
      build({ transport: 'websocket', url: 'ws://127.0.0.1:4000/ws', allow_local_endpoint: true }),
    ).toHaveLength(1);
  });

  it('rejects a REMOTE plaintext endpoint regardless of allow_local_endpoint (the flag is local-only)', () => {
    expect(() => build({ url: 'http://api.example/mcp' })).toThrow(/must use https\/wss/);
    expect(() => build({ url: 'http://api.example/mcp', allow_local_endpoint: true })).toThrow(
      /must use https\/wss/,
    );
    expect(() => build({ transport: 'sse', url: 'http://api.example/sse' })).toThrow(
      /must use https\/wss/,
    ); // the sse alias is gated identically
    expect(() => build({ transport: 'websocket', url: 'ws://api.example/ws' })).toThrow(
      /must use https\/wss/,
    );
  });

  it('rejects an embedded-credentials url (the flag never relaxes it)', () => {
    expect(() =>
      build({ url: 'https://user:pass@api.example/mcp', allow_local_endpoint: true }),
    ).toThrow(/must not embed credentials/);
  });

  it('rejects a malformed url', () => {
    expect(() => build({ url: 'not a url' })).toThrow(/malformed url/);
  });
});

describe('buildChildEnv (secret interpolation, 2.R Step 4)', () => {
  it('resolves {{secrets.<name>}} into the child env value via the resolver (whole + embedded)', () => {
    const env = buildChildEnv(
      'fs',
      { TOKEN: '{{secrets.gh}}', AUTH: 'Bearer {{ secrets.gh }}' },
      (name) => (name === 'gh' ? 'ghp_resolved' : 'OTHER'),
    );
    expect(env).toEqual({ TOKEN: 'ghp_resolved', AUTH: 'Bearer ghp_resolved' });
  });

  it('passes a literal env value through unchanged', () => {
    expect(buildChildEnv('fs', { LOG: 'debug' }, () => 'x')).toEqual({ LOG: 'debug' });
  });

  it('propagates the resolver fail-closed throw (a missing secret fails the build, never a literal)', () => {
    expect(() =>
      buildChildEnv('fs', { TOKEN: '{{secrets.missing}}' }, () => {
        throw new CliError('invalid_invocation', "MCP secret 'missing' is not set");
      }),
    ).toThrow(/is not set/);
  });

  it('rejects a non-secret interpolation (only {{secrets.<name>}} is supported), even with a resolver', () => {
    try {
      buildChildEnv('fs', { HOST: '{{env.HOSTNAME}}' }, () => 'x');
      expect.unreachable('an unsupported interpolation must throw');
    } catch (err) {
      if (!isCliError(err)) throw err; // narrow to CliError (no cast)
      expect(err.code).toBe('invalid_invocation');
      expect(err.message).toContain('HOST'); // names the key
      expect(err.message).toContain('only {{secrets.<name>}}');
    }
  });

  it('rejects a {{secrets.…}} when no resolver is wired with a WIRING-GAP message (not a syntax red herring)', () => {
    // A correctly-written `{{secrets.gh}}` that fails only because no resolver was wired must say exactly that —
    // "no MCP secret resolver is wired" — not "unsupported interpolation" (which would mislead the operator into
    // suspecting their syntax). The key is named; the secret name is never echoed.
    try {
      buildChildEnv('fs', { TOKEN: '{{secrets.gh}}' });
      expect.unreachable('a {{secrets.…}} with no resolver must throw');
    } catch (err) {
      if (!isCliError(err)) throw err; // narrow to CliError (no cast)
      expect(err.code).toBe('invalid_invocation');
      expect(err.message).toContain('TOKEN'); // names the key
      expect(err.message).toContain('no MCP secret resolver is wired');
      expect(err.message).not.toContain('secrets.gh'); // never echo the secret name
    }
  });

  it('does NOT false-reject a resolved secret whose VALUE itself contains "{{" (scan the pre-substitution value)', () => {
    // A token like `a{{b` is a legitimate resolved value; the leftover-`{{` check must scan the DECLARED value
    // (placeholders removed), not the substituted result — else a valid secret becomes unusable.
    const env = buildChildEnv('fs', { TOKEN: '{{secrets.gh}}' }, () => 'a{{b}}c');
    expect(env).toEqual({ TOKEN: 'a{{b}}c' });
  });

  it('rejects a malformed {{secrets …}} (invalid name) as an unsupported interpolation, before the resolver', () => {
    // The placeholder regex pre-filters the name charset, so `{{secrets.bad name}}` never matches → it is left as
    // a leftover `{{` and rejected as unsupported (the resolver's own charset guard is defense-in-depth for a
    // direct/programmatic call). The resolver is therefore never invoked here.
    let called = false;
    expect(() =>
      buildChildEnv('fs', { TOKEN: '{{secrets.bad name}}' }, () => {
        called = true;
        return 'x';
      }),
    ).toThrow(/unsupported interpolation/);
    expect(called).toBe(false);
  });
});

describe('connectAgentMcp', () => {
  it('returns undefined when the agent declares no servers (no client, nothing to tear down)', async () => {
    const client = await connectAgentMcp(undefined, { cwd: '/work', consentGate: PASS_CONSENT });
    expect(client).toBeUndefined();
  });

  it('starts the resolved stdio configs via the injected starter and returns the live client', async () => {
    let seen: readonly McpServerConfig[] | undefined;
    const expected = fakeClient({
      skipped: [{ server: 'fs', name: 'bad', reason: 'unsupported' }],
    });
    const client = await connectAgentMcp([stdioRef()], {
      cwd: '/work',
      consentGate: PASS_CONSENT,
      startMcpClient: (servers) => {
        seen = servers;
        return Promise.resolve(expected);
      },
    });
    expect(seen?.[0]?.id).toBe('fs'); // the resolver's config reached the starter
    expect(client).toBe(expected);
  });

  it('wraps an McpError connect failure as a typed CliError with the secret-free message, no cause', async () => {
    const promise = connectAgentMcp([stdioRef()], {
      cwd: '/work',
      consentGate: PASS_CONSENT,
      startMcpClient: () => Promise.reject(new McpError('spawn failed for "fs"')),
    });
    await expect(promise).rejects.toMatchObject({ code: 'invalid_invocation' });
    await promise.catch((err: unknown) => {
      if (!isCliError(err)) throw err; // narrow to CliError (no cast); a non-CliError is an unexpected fault
      expect(err.message).toContain('spawn failed for "fs"');
      expect(err.cause).toBeUndefined(); // the opaque cause chain is never attached
    });
  });

  it('rethrows a non-McpError failure unchanged (an unexpected fault is not masked as invalid_invocation)', async () => {
    const boom = new TypeError('unexpected');
    await expect(
      connectAgentMcp([stdioRef()], {
        cwd: '/work',
        consentGate: PASS_CONSENT,
        startMcpClient: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });

  it('resolves a by-name `ref` against the registrations before connecting (chat path, Step 4b)', async () => {
    let seen: readonly McpServerConfig[] | undefined;
    const registrations: McpServerRegistration[] = [
      { name: 'github', transport: 'stdio', command: 'gh-mcp' },
    ];
    const client = await connectAgentMcp([{ ref: 'github' }], {
      cwd: '/work',
      consentGate: PASS_CONSENT,
      registrations,
      startMcpClient: (servers) => {
        seen = servers;
        return Promise.resolve(fakeClient());
      },
    });
    expect(seen?.[0]?.id).toBe('github'); // the ref resolved to a stdio connection keyed by the registration name
    expect(client).toBeDefined();
  });
});

describe('the consent gate is REQUIRED, not optional (ADR-0084 §1)', () => {
  // The gate landed as an optional dependency and exactly one of five entry points wired it, so `chat`,
  // `chat-resume`, Home and `agent run` all spawned local programs with no decision at all. An unwired gate
  // is a wiring defect; it fails loud here rather than silently bypassing the chokepoint.
  it('connectAgentMcp refuses a stdio declaration when no gate was wired, and starts nothing', async () => {
    let started = 0;
    await expect(
      connectAgentMcp([stdioRef()], {
        cwd: '/work',
        startMcpClient: () => {
          started += 1;
          return Promise.resolve(fakeClient());
        },
      }),
    ).rejects.toThrow(/without a consent gate/);
    expect(started).toBe(0);
  });

  it('a NETWORK-only declaration still needs no gate — the refusal is about LOCAL programs', async () => {
    const client = await connectAgentMcp(
      [{ id: 'api', transport: 'http', url: 'https://example.com/mcp' }],
      { cwd: '/work', startMcpClient: () => Promise.resolve(fakeClient()) },
    );
    expect(client).toBeDefined();
  });
});

describe('connectWorkflowMcp (run path)', () => {
  // A minimal valid workflow whose inline `agents:` block is the parameter under test.
  const wf = (agentsYaml: string): WorkflowDefinition =>
    parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: wf\n  agents:\n${agentsYaml}  nodes:\n    - { id: s, type: input }\n    - { id: a, type: agent, agent_ref: scanner, prompt_template: go }\n    - { id: o, type: output }\n  edges:\n    - { from: s, to: a }\n    - { from: a, to: o }\n`,
    );
  const agentOf = (def: WorkflowDefinition, id: string): Agent =>
    (def.workflow.agents ?? []).find((e): e is Agent => 'id' in e && e.id === id)!;
  // A fake client whose per-server grouping the augmentation reads (the configs reaching it are ignored).
  const fakeStart =
    (toolIdsByServer: ReadonlyMap<string, readonly string[]>) => (): Promise<McpClient> =>
      Promise.resolve(fakeClient({ toolIdsByServer }));

  it('refuses a stdio declaration when no gate was wired, naming the server (ADR-0084 §1)', async () => {
    const def = wf(
      `    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: node }] }\n`,
    );
    let started = 0;
    await expect(
      connectWorkflowMcp(def, {
        cwd: '/w',
        startMcpClient: () => {
          started += 1;
          return fakeStart(new Map())();
        },
      }),
    ).rejects.toThrow(/without a consent gate.*fs|fs.*without a consent gate/s);
    expect(started).toBe(0);
  });

  it('returns undefined when no inline agent declares a server', async () => {
    const def = wf(
      `    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go }\n`,
    );
    expect(
      await connectWorkflowMcp(def, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        startMcpClient: fakeStart(new Map()),
      }),
    ).toBeUndefined();
  });

  it('augments ONLY the declaring agent grant with ITS server tool ids (per-agent isolation)', async () => {
    const def = wf(
      [
        '    - id: scanner',
        '      model: claude-sonnet-4-6',
        '      provider: anthropic',
        '      system_prompt: go',
        '      tools: [read_file]',
        '      mcp_servers: [{ id: fs, transport: stdio, command: x }]',
        '    - id: other',
        '      model: claude-sonnet-4-6',
        '      provider: anthropic',
        '      system_prompt: go',
        '      tools: [git_status]',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      startMcpClient: fakeStart(new Map([['fs', ['mcp_fs_read', 'mcp_fs_write']]])),
    });
    expect(runtime).toBeDefined();
    // The declaring agent's grant gains its server's ids (union with the original); the other is untouched.
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual([
      'read_file',
      'mcp_fs_read',
      'mcp_fs_write',
    ]);
    expect(agentOf(runtime!.workflow, 'other').tools).toEqual(['git_status']);
  });

  it('shares ONE connection when two agents declare an identical server (dedup by id)', async () => {
    let startedWith: readonly McpServerConfig[] | undefined;
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      startMcpClient: (servers) => {
        startedWith = servers;
        return Promise.resolve(fakeClient({ toolIdsByServer: new Map([['fs', ['mcp_fs_read']]]) }));
      },
    });
    expect(startedWith).toHaveLength(1); // the duplicate `fs` declaration collapsed to one connection
    // BOTH agents are granted the shared server's tools.
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_fs_read']);
    expect(agentOf(runtime!.workflow, 'writer').tools).toEqual(['mcp_fs_read']);
  });

  it('fails loud when two agents declare the same server id with conflicting settings', async () => {
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: DIFFERENT }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(def, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        startMcpClient: fakeStart(new Map()),
      }),
    ).rejects.toThrow(/conflicting settings/);
  });

  it('fails loud when two agents share a server id but DIFFER on connect_timeout_ms', async () => {
    // **A review deleted `d: ref.connect_timeout_ms ?? null` from `serverFingerprint` and all 2534 CLI tests
    // stayed green.** Every sibling identity field (`env`, `tools_allowlist`, `allow_local_endpoint`) has a
    // fail-loud test; this one had none, so the comment claiming it "enters the fingerprint for the reason
    // `allow_local_endpoint` already does" was unbacked. Two authors would silently share a bound neither
    // wrote — first-wins.
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, connect_timeout_ms: 5000 }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, connect_timeout_ms: 300000 }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(def, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        startMcpClient: fakeStart(new Map()),
      }),
    ).rejects.toThrow(/conflicting settings/);
  });

  it('shares ONE connection when the two declarations agree on connect_timeout_ms', async () => {
    // The negative control. Without it the test above would also pass against a fingerprint that treats every
    // declaration as unique — which would break legitimate sharing rather than catch a conflict.
    let startedWith: readonly McpServerConfig[] = [];
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, connect_timeout_ms: 5000 }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, connect_timeout_ms: 5000 }] }',
        '',
      ].join('\n'),
    );
    await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      startMcpClient: (servers) => {
        startedWith = servers;
        return Promise.resolve(fakeClient({ toolIdsByServer: new Map([['fs', []]]) }));
      },
    });
    expect(startedWith).toHaveLength(1);
  });

  it('fails loud when two agents share a server id but declare DIFFERENT tools_allowlist (no escalation)', async () => {
    // One physical connection cannot honor two allowlists — collapsing them would grant BOTH agents the union,
    // escalating the narrower agent past its declared grant. `tools_allowlist` is part of the dedup identity.
    const narrowVsNarrow = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [read, write] }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [read] }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(narrowVsNarrow, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        startMcpClient: fakeStart(new Map()),
      }),
    ).rejects.toThrow(/conflicting settings/);

    // The escalation direction: absent allowlist (all tools) vs an explicit narrow — also a conflict.
    const absentVsNarrow = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [read] }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(absentVsNarrow, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        startMcpClient: fakeStart(new Map()),
      }),
    ).rejects.toThrow(/conflicting settings/);
  });

  it('shares one connection for an identical env (incl. {{secrets.*}}) and fails loud — without leaking the value — on a divergent env', async () => {
    // `env` is part of the dedup fingerprint, so an identical placeholder shares one connection; a divergent one
    // fails loud. The conflict error names ONLY the server id — the `{{secrets.*}}` placeholder must never surface.
    const identical = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, env: { TOKEN: "{{secrets.gh}}" } }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, env: { TOKEN: "{{secrets.gh}}" } }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(identical, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      startMcpClient: fakeStart(new Map([['fs', ['mcp_fs_read']]])),
      resolveSecret: () => 'unused', // never invoked: the injected client ignores the spawn closures
    });
    expect(runtime).toBeDefined(); // identical env ⇒ one shared connection (no conflict)

    const divergent = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, env: { TOKEN: "{{secrets.gh}}" } }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, env: { TOKEN: "{{secrets.OTHER}}" } }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(divergent, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        startMcpClient: fakeStart(new Map()),
      }),
    ).rejects.toThrow(/conflicting settings/);
    // The placeholder must NOT surface in the operator-facing conflict message.
    await connectWorkflowMcp(divergent, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      startMcpClient: fakeStart(new Map()),
    }).catch((err: unknown) => {
      if (!isCliError(err)) throw err; // narrow to CliError (no cast)
      expect(err.message).not.toContain('secrets.gh');
      expect(err.message).not.toContain('secrets.OTHER');
    });
  });

  it('fails loud when two agents share a server id but DIFFER on allow_local_endpoint (no silent opt-in sharing)', async () => {
    // The SSRF opt-in is part of the server identity (ADR-0053 §3): one agent's allow_local_endpoint must NOT be
    // silently inherited by another sharing the id — the divergent pair fails loud.
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: local, transport: http, url: "http://localhost:4000/mcp", allow_local_endpoint: true }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: local, transport: http, url: "http://localhost:4000/mcp" }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(def, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        startMcpClient: fakeStart(new Map()),
      }),
    ).rejects.toThrow(/conflicting settings/);
  });

  it('shares one connection when two agents share a server id with the SAME allowlist (order-insensitive)', async () => {
    // The allowlist is a set — declaration order must NOT spuriously conflict. `[read, write]` ≡ `[write, read]`.
    let startedWith: readonly McpServerConfig[] | undefined;
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [read, write] }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [write, read] }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      startMcpClient: (servers) => {
        startedWith = servers;
        return Promise.resolve(fakeClient({ toolIdsByServer: new Map([['fs', ['mcp_fs_read']]]) }));
      },
    });
    expect(startedWith).toHaveLength(1); // same set, different order ⇒ one shared connection (no false conflict)
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_fs_read']);
  });

  it('isolates grants across agents declaring DIFFERENT servers (A gets fs only, B gets gh only)', async () => {
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: gh, transport: stdio, command: y }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      startMcpClient: fakeStart(
        new Map([
          ['fs', ['mcp_fs_read']],
          ['gh', ['mcp_gh_issue']],
        ]),
      ),
    });
    // Each agent is granted ONLY its own server's tools — never the other's.
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_fs_read']);
    expect(agentOf(runtime!.workflow, 'writer').tools).toEqual(['mcp_gh_issue']);
  });

  it('leaves a $ref agent entry byte-identical, augmenting only the inline agent', async () => {
    const def = wf(
      [
        '    - { $ref: ./reviewer.agent.yaml }',
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      startMcpClient: fakeStart(new Map([['fs', ['mcp_fs_read']]])),
    });
    const entries = runtime!.workflow.workflow.agents ?? [];
    expect(entries[0]).toEqual({ $ref: './reviewer.agent.yaml' }); // the $ref passes through untouched
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_fs_read']);
  });

  it('resolves a by-name `ref` against the config registrations and augments the agent grant (Step 4b)', async () => {
    const def = wf(
      `    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ ref: github }] }\n`,
    );
    const registrations: McpServerRegistration[] = [
      { name: 'github', transport: 'stdio', command: 'gh-mcp' },
    ];
    let startedWith: readonly McpServerConfig[] | undefined;
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      registrations,
      startMcpClient: (servers) => {
        startedWith = servers;
        return Promise.resolve(
          fakeClient({ toolIdsByServer: new Map([['github', ['mcp_github_issue']]]) }),
        );
      },
    });
    expect(startedWith?.[0]?.id).toBe('github'); // the ref resolved to a connection keyed by the registration name
    // The agent's grant is augmented with the RESOLVED server's discovered tools (keyed by the ref name).
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_github_issue']);
  });

  it('fails loud when a by-name `ref` is not registered in [[mcp_servers]]', async () => {
    const def = wf(
      `    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ ref: unknown }] }\n`,
    );
    await expect(
      connectWorkflowMcp(def, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        registrations: [],
        startMcpClient: fakeStart(new Map()),
      }),
    ).rejects.toThrow(/ref 'unknown' is not registered/);
  });

  it('dedups two agents each referencing the SAME registration by name to one connection (both granted)', async () => {
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ ref: github }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ ref: github }] }',
        '',
      ].join('\n'),
    );
    let startedWith: readonly McpServerConfig[] | undefined;
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      registrations: [{ name: 'github', transport: 'stdio', command: 'gh' }],
      startMcpClient: (servers) => {
        startedWith = servers;
        return Promise.resolve(
          fakeClient({ toolIdsByServer: new Map([['github', ['mcp_github_issue']]]) }),
        );
      },
    });
    expect(startedWith).toHaveLength(1); // the two refs to `github` collapse to one connection
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_github_issue']);
    expect(agentOf(runtime!.workflow, 'writer').tools).toEqual(['mcp_github_issue']);
  });

  it('resolves a `ref` to a remote https http registration through the SSRF gate (the network path is wired)', async () => {
    const def = wf(
      `    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ ref: remote }] }\n`,
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      registrations: [{ name: 'remote', transport: 'http', url: 'https://api.example/mcp' }],
      startMcpClient: fakeStart(new Map([['remote', ['mcp_remote_x']]])),
    });
    expect(runtime).toBeDefined(); // a remote https ref resolves + passes the SSRF floor (no fail-loud)
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_remote_x']);
  });

  it('fails loud at the SSRF floor when a `ref` resolves to a private http url without allow_local_endpoint', async () => {
    const def = wf(
      `    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ ref: local }] }\n`,
    );
    await expect(
      connectWorkflowMcp(def, {
        cwd: '/w',
        consentGate: PASS_CONSENT,
        registrations: [{ name: 'local', transport: 'http', url: 'http://127.0.0.1:4000/mcp' }],
        startMcpClient: fakeStart(new Map()),
      }),
    ).rejects.toThrow(/private\/loopback/);
  });

  it('PERMITS a `ref` to a private http url when the registration opts in via allow_local_endpoint (the accept arm)', async () => {
    // The accept counterpart to the fail-loud floor test: the opt-in flows registration → resolveMcpServerRef
    // → the SSRF gate, which permits exactly the authored private host:port without throwing (ADR-0053 §3).
    const def = wf(
      `    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ ref: local }] }\n`,
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      consentGate: PASS_CONSENT,
      registrations: [
        {
          name: 'local',
          transport: 'http',
          url: 'http://127.0.0.1:4000/mcp',
          allow_local_endpoint: true,
        },
      ],
      startMcpClient: fakeStart(new Map([['local', ['mcp_local_x']]])),
    });
    expect(runtime).toBeDefined(); // the opt-in lets the private ref pass the floor (no fail-loud)
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_local_x']);
  });
});

describe('resolveMcpServerRef (by-name resolution, 2.R Step 4b)', () => {
  const regs: McpServerRegistration[] = [
    { name: 'github', transport: 'stdio', command: 'gh-mcp', args: ['--stdio'], env: { GH: '1' } },
  ];

  it('passes an inline entry through unchanged (same object)', () => {
    const inline: McpServerRef = { id: 'fs', transport: 'stdio', command: 'x' };
    expect(resolveMcpServerRef(inline, regs)).toBe(inline);
  });

  it('resolves a { ref } to the registration connection (id = the registration name), carrying its allowlist', () => {
    const resolved = resolveMcpServerRef({ ref: 'github', tools_allowlist: ['issue'] }, regs);
    // The resolved shape also carries the originating registration NAME — host-only, outside the strict
    // schema, and the reason a config-declared server no longer displays as `inline` at the consent prompt
    // (ADR-0084 §7). Asserted here so the field cannot be dropped silently.
    expect(resolved.registrationName).toBe('github');
    expect(resolved).toEqual({
      registrationName: 'github',
      id: 'github',
      transport: 'stdio',
      command: 'gh-mcp',
      args: ['--stdio'],
      env: { GH: '1' },
      tools_allowlist: ['issue'],
    });
  });

  it('preserves a registration `connect_timeout_ms` on the resolved ref (ADR-0088 §1.4)', () => {
    // The registration owns the connection, so it owns the deadline — and the schema refuses an inline
    // override alongside a `ref`, so this carry-through is the ONLY way an authored value reaches a by-name
    // server. Deleting the carry line was measured to cost nothing.
    const regs: McpServerRegistration[] = [
      { name: 'gh', transport: 'stdio', command: 'npx', connect_timeout_ms: 300_000 },
    ];
    expect(resolveMcpServerRef({ ref: 'gh' }, regs)).toMatchObject({
      id: 'gh',
      transport: 'stdio',
      command: 'npx',
      connect_timeout_ms: 300_000,
    });
  });

  it('preserves a registration `allow_local_endpoint` opt-in on the resolved network ref', () => {
    // The SSRF opt-in must survive resolution so the host-side floor honors it (ADR-0053 §3) — assert the
    // flag is carried through, not dropped, so the connectWorkflowMcp accept-arm above is grounded in unit code.
    const netRegs: McpServerRegistration[] = [
      {
        name: 'local',
        transport: 'http',
        url: 'http://127.0.0.1:4000/mcp',
        allow_local_endpoint: true,
      },
    ];
    expect(resolveMcpServerRef({ ref: 'local' }, netRegs)).toMatchObject({
      id: 'local',
      transport: 'http',
      url: 'http://127.0.0.1:4000/mcp',
      allow_local_endpoint: true,
    });
  });

  it('fails loud (typed exit-2 CliError) when the ref names no registration', () => {
    try {
      resolveMcpServerRef({ ref: 'nope' }, regs);
      expect.unreachable('an unknown ref must throw');
    } catch (err) {
      if (!isCliError(err)) throw err; // narrow to CliError (no cast)
      expect(err.code).toBe('invalid_invocation');
      expect(err.message).toContain("ref 'nope' is not registered");
    }
  });

  it('SANITIZES a non-charset registration name into a namespace-safe id (no silent total tool loss)', () => {
    // A `[[mcp_servers]]` name is a free string (`github:prod`, `my server`); the namespace charset is
    // `[A-Za-z0-9_-]`. The resolved id must be sanitized so `mcp_{server}_{tool}` stays valid and the server's
    // tools are namespaced — NOT dropped at discovery (ADR-0052 §4/§5).
    const messy: McpServerRegistration[] = [
      { name: 'github:prod', transport: 'stdio', command: 'gh' },
      { name: 'my server', transport: 'stdio', command: 'x' },
    ];
    expect(resolveMcpServerRef({ ref: 'github:prod' }, messy).id).toBe('github_prod');
    expect(resolveMcpServerRef({ ref: 'my server' }, messy).id).toBe('my_server');
  });
});

describe('surfaceMcpSkipped', () => {
  it('mcpSkippedLines returns one secret-free line per dropped tool WITHOUT a trailing newline (for store routing)', () => {
    // The re-drive path routes these to a transcript `notice` (Step-4b-3), so the lines must carry no `\n`.
    expect(mcpSkippedLines([])).toEqual([]);
    const lines = mcpSkippedLines([
      { server: 'fs', name: 'danger', reason: 'not in tools_allowlist' },
      { server: 'gh', name: 'bad-id!', reason: 'unsafe LLM tool name' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => !l.includes('\n'))).toBe(true); // no terminator — the sink adds it (or renders a notice)
    expect(lines[0]).toContain("MCP tool 'danger' (server 'fs')");
    expect(lines[1]).toContain("MCP tool 'bad-id!' (server 'gh')");
  });

  it('writes one stderr note per dropped tool (name + server + reason), nothing on an empty list', () => {
    const { io, err, out } = captureIo();
    surfaceMcpSkipped(io, []);
    expect(err()).toBe(''); // nothing dropped ⇒ silent (the common case)

    surfaceMcpSkipped(io, [
      { server: 'fs', name: 'danger', reason: 'not in tools_allowlist' },
      { server: 'gh', name: 'bad-id!', reason: 'unsafe LLM tool name' },
    ]);
    const lines = err().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("MCP tool 'danger' (server 'fs')");
    expect(lines[0]).toContain('not in tools_allowlist');
    expect(lines[1]).toContain("MCP tool 'bad-id!' (server 'gh')");
    expect(out()).toBe(''); // diagnostics stay on stderr — stdout (the --json stream) is untouched
  });

  it('sanitizes a hostile server-controlled tool name + reason (no terminal-escape injection reaches the TTY)', () => {
    // `name`/`reason` are server-controlled and the MCP server is in-threat-model untrusted (ADR-0052 §4): a
    // crafted tool returning ANSI/OSC control bytes must NOT write them raw to the operator's terminal.
    const { io, err } = captureIo();
    surfaceMcpSkipped(io, [
      // The `server` segment is ALSO sanitized (the by-name `ref` form derives it from a free registration name,
      // ADR-0052 §4/§5), so feed it control bytes too — all three segments must be scrubbed.
      {
        server: 'srv\x1b[2J\x1b]0;x\x07',
        name: 'evil\x1b[2J\x1b]0;pwned\x07',
        reason: 'bad\x1b[31m schema\x1b[0m',
      },
    ]);
    const written = err();
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes is the point
    expect(/[\x00-\x1f\x7f]/.test(written.replace(/\n$/, ''))).toBe(false); // none survived (besides the \n)
    expect(written).not.toContain('\x1b'); // the ESC that opens every escape sequence is gone
  });
});
