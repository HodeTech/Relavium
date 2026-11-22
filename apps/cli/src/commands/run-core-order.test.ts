/**
 * Order pins for the shared run core (MVP-8 step 2, round-1 fix F1): the position of four refusals that no
 * other test fixes, so moving any one of them would still leave the suite green.
 *
 * `prepareRun` — the stdin secret read comes first and is consumed even when the workflow is then refused
 * for an ungranted tool (admission needs the secret, so the tool check cannot precede it); the admission
 * refusal outranks the tool refusal; the provider-key preflight comes before the MCP connect.
 * `resumeRun` — the human-gate decision-fit check comes before the secret read.
 *
 * Every case reads a REAL stdin stream and asks it whether it was consumed (`readableDidRead`), so a pin is on
 * the stream and not on an injected fixture reader.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createInMemoryHost } from '@relavium/core';
import { createClient, createRunHistoryStore, runMigrations, type DbClient } from '@relavium/db';
import { startMcpClient as realStartMcpClient } from '@relavium/mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine } from '../engine/build-engine.js';
import type { ResolvedStdioSpawn } from '../engine/mcp-consent.js';
import { createProviderResolver } from '../engine/providers.js';
import type { OpenedHistory } from '../history/open.js';
import { isCliError } from '../process/errors.js';
import { createCliInvocation } from '../process/invocation.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { gateCommand } from './gate.js';
import { runCommand, type RunCommandDeps } from './run.js';

let root: string;
vi.mock('../config/load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...actual,
    loadResolvedConfig: (options: Parameters<typeof actual.loadResolvedConfig>[0]) =>
      actual.loadResolvedConfig({ ...options, home: root }),
  };
});

let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-core-order-'));
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

const SECRET_VALUE = 'opaque-order-pin-secret-value';
const MCP_SERVER = '{ id: fs, transport: stdio, command: x }';

/** An agent granted a tool the run path does not wire, on a provider that needs a key, with an MCP server. */
const UNWIRED_WITH_SECRET = `schema_version: '1.0'
workflow:
  id: order-unwired
  inputs:
    - { name: n, type: number }
    - { name: token, type: secret, required: true }
  agents:
    - { id: scanner, model: claude-opus-4-8, provider: anthropic, system_prompt: inspect, tools: [web_search], mcp_servers: [${MCP_SERVER}] }
  nodes:
    - { id: start, type: input }
    - { id: a, type: agent, agent_ref: scanner, prompt_template: 'go' }
    - { id: out, type: output }
  edges:
    - { from: start, to: a }
    - { from: a, to: out }
`;

/** A wired workflow whose provider key is missing and which declares an inline MCP server. */
const NEEDS_KEY_WITH_MCP = UNWIRED_WITH_SECRET.replace(', tools: [web_search]', '')
  .replace('    - { name: token, type: secret, required: true }\n', '')
  .replace('id: order-unwired', 'id: order-needs-key');

/** A secret-bearing run parked at an `input` gate, which an `--approve` does not fit. */
const INPUT_GATE_WITH_SECRET = `schema_version: '1.0'
workflow:
  id: order-input-gate
  inputs:
    - { name: api_key, type: secret }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

function globalOptions(): GlobalOptions {
  return { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' };
}

function writeWorkflow(name: string, yaml: string): string {
  const path = join(root, name);
  writeFileSync(path, yaml);
  return path;
}

/** A real piped stdin that remembers whether anyone read it. */
function pipedStdin(text: string): Readable {
  return Readable.from([text]);
}

function withStdin(io: CliIo, stdin: Readable): CliIo {
  return { ...io, stdin };
}

const PASS_CONSENT = (): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> =>
  Promise.resolve(new Map<string, ResolvedStdioSpawn>());

function openDurable(
  workflow: Parameters<NonNullable<RunCommandDeps['openRunStore']>>[0],
): OpenedHistory {
  return {
    store: createRunHistoryStore(client.db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: {
        slug: workflow.workflow.id,
        name: workflow.workflow.id,
        definitionJson: JSON.stringify(workflow),
      },
    }),
    db: client.db,
    terminalOutboxPath: join(root, 'outbox.ndjson'),
    close: () => undefined,
  };
}

function lastRunId(): string {
  const row = client.sqlite.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 1').get();
  if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string')
    throw new Error('no run was recorded');
  return row.id;
}

async function refusalOf(call: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call();
  } catch (cause) {
    if (isCliError(cause)) return { code: cause.code, message: cause.message };
    throw cause;
  }
  throw new Error('the command was expected to refuse');
}

/** The services a refused start must leave untouched. */
function untouchedServices() {
  return {
    buildEngine: vi.fn(() => buildEngine({ host: createInMemoryHost() })),
    resolveKeys: vi.fn(() => ({
      providers: createProviderResolver({}),
      mcpSecretResolver: () => 'unused',
    })),
    startMcpClient: vi.fn(() => realStartMcpClient([])),
    openRunStore: vi.fn(openDurable),
  };
}

describe('run core order — what relavium run does before it refuses an ungranted tool', () => {
  it('reads the stdin secret first, then refuses the tool with every service untouched', async () => {
    const path = writeWorkflow('unwired.relavium.yaml', UNWIRED_WITH_SECRET);
    const stdin = pipedStdin(`token=${SECRET_VALUE}\n`);
    const out = captureIo();
    const services = untouchedServices();
    const refusal = await refusalOf(() =>
      runCommand(
        { workflow: path, input: ['n=1'], allowMcpStdio: [], secretInputsStdin: true },
        {
          io: withStdin(out.io, stdin),
          invocation: createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() }),
          global: globalOptions(),
          consentGate: PASS_CONSENT,
          ...services,
        },
      ),
    );
    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.message).toContain('web_search needs a host capability');
    // The secret is read BEFORE the tool check: admission needs it, and admission precedes the check.
    expect(stdin.readableDidRead, 'the stdin secret was read before the refusal').toBe(true);
    expect(services.resolveKeys, 'no key service').not.toHaveBeenCalled();
    expect(services.startMcpClient, 'no MCP connect').not.toHaveBeenCalled();
    expect(services.openRunStore, 'no history open').not.toHaveBeenCalled();
    expect(services.buildEngine, 'no engine build').not.toHaveBeenCalled();
    expect(out.out() + out.err()).not.toContain(SECRET_VALUE);
  });

  it('refuses an inadmissible input before it refuses the tool', async () => {
    const path = writeWorkflow('unwired.relavium.yaml', UNWIRED_WITH_SECRET);
    const stdin = pipedStdin(`token=${SECRET_VALUE}\n`);
    const out = captureIo();
    const services = untouchedServices();
    const refusal = await refusalOf(() =>
      runCommand(
        { workflow: path, input: ['n=abc'], allowMcpStdio: [], secretInputsStdin: true },
        {
          io: withStdin(out.io, stdin),
          invocation: createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() }),
          global: globalOptions(),
          consentGate: PASS_CONSENT,
          ...services,
        },
      ),
    );
    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.message, 'the admission refusal, not the tool refusal').toBe(
      "input 'n' must be a decimal number.",
    );
    expect(services.resolveKeys).not.toHaveBeenCalled();
    expect(services.startMcpClient).not.toHaveBeenCalled();
    expect(services.openRunStore).not.toHaveBeenCalled();
    expect(services.buildEngine).not.toHaveBeenCalled();
  });
});

describe('run core order — the provider-key preflight comes before the MCP connect', () => {
  it('a missing key is refused and no MCP server is spawned', async () => {
    const path = writeWorkflow('needs-key-mcp.relavium.yaml', NEEDS_KEY_WITH_MCP);
    const out = captureIo();
    const services = untouchedServices();
    const refusal = await refusalOf(() =>
      runCommand(
        { workflow: path, input: ['n=1'], allowMcpStdio: [] },
        {
          io: out.io,
          invocation: createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() }),
          global: globalOptions(),
          consentGate: PASS_CONSENT,
          buildEngine: services.buildEngine,
          startMcpClient: services.startMcpClient,
          openRunStore: services.openRunStore,
        },
      ),
    );
    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.message).toContain("no API key for provider 'anthropic'");
    expect(services.startMcpClient, 'a missing key spawns no MCP server').not.toHaveBeenCalled();
    expect(services.openRunStore).not.toHaveBeenCalled();
    expect(services.buildEngine).not.toHaveBeenCalled();
  });
});

describe('run core order — the gate decision-fit check comes before the secret read', () => {
  it('a decision the gate type refuses leaves stdin unread, with no service built', async () => {
    const path = writeWorkflow('input-gate.relavium.yaml', INPUT_GATE_WITH_SECRET);
    await runCommand(
      { workflow: path, input: [], allowMcpStdio: [], secretInputsStdin: true },
      {
        io: withStdin(captureIo().io, pipedStdin(`api_key=${SECRET_VALUE}\n`)),
        invocation: createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() }),
        global: globalOptions(),
        openRunStore: openDurable,
      },
    );
    const runId = lastRunId();
    const stdin = pipedStdin(`api_key=${SECRET_VALUE}\n`);
    const out = captureIo();
    const services = untouchedServices();
    const refusal = await refusalOf(() =>
      gateCommand(
        { runId, approve: true, secretStdin: true },
        {
          io: withStdin(out.io, stdin),
          invocation: createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() }),
          global: globalOptions(),
          openDb: () => ({ db: client.db, close: () => undefined }),
          consentGate: PASS_CONSENT,
          buildEngine: services.buildEngine,
          resolveKeys: services.resolveKeys,
          startMcpClient: services.startMcpClient,
        },
      ),
    );
    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.message).toBe(
      'the gate at node g is an input gate — use --input <json> or --reject',
    );
    expect(stdin.readableDidRead, 'the decision is refused before any secret is read').toBe(false);
    expect(services.resolveKeys).not.toHaveBeenCalled();
    expect(services.startMcpClient).not.toHaveBeenCalled();
    expect(services.buildEngine).not.toHaveBeenCalled();
    expect(out.out() + out.err()).not.toContain(SECRET_VALUE);
  });
});
