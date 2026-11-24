/**
 * The shared run core's binding of a confirmed start to the file that was confirmed (LAUNCH-5), and its one-start rule.
 *
 * `prepareRun` is driven directly, on the Home's own lifetime, so what a refusal left untouched is the fact each spy says: no secret asked,
 * no consent gate built, no key service, no MCP connect, no history opened (the lease is built from its store), no engine built, no
 * engine or handle adopted, no second owner registered. A workflow that declares a secret and an MCP server is used for the refusal, so
 * that every one of those would be reached by a start that was not refused.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryHost, type RunHandle } from '@relavium/core';
import { createClient, createRunHistoryStore, runMigrations, type DbClient } from '@relavium/db';
import { startMcpClient as realStartMcpClient } from '@relavium/mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedRunLifetime } from '../home/hosted-run-lifetime.js';
import { buildEngine } from '../engine/build-engine.js';
import type { ResolvedStdioSpawn } from '../engine/mcp-consent.js';
import { createProviderResolver } from '../engine/providers.js';
import type { OpenedHistory } from '../history/open.js';
import { CliError, isCliError } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { SignalCustody } from '../process/signal-custody.js';
import { captureIo } from '../test-support.js';
import {
  PREPARED_RUN_REUSED,
  prepareRun,
  type PreparedRun,
  type PrepareRunRequest,
} from './prepare-run.js';
import type { RunTerminalView } from './run-lifetime.js';
import { RunResources } from './run-resources.js';
import {
  assertWorkflowSourceDigest,
  WORKFLOW_SOURCE_CHANGED,
  workflowSourceDigest,
} from './source-digest.js';

let root: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-prepare-run-'));
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A secret, an inline MCP server and a provider: a start that is not refused would reach every service. */
const CONFIRMED = `schema_version: '1.0'
workflow:
  id: bound-start
  inputs:
    - { name: n, type: number }
    - { name: token, type: secret }
  agents:
    - { id: worker, model: claude-opus-4-8, provider: anthropic, system_prompt: go, tools: [], mcp_servers: [{ id: fs, transport: stdio, command: x }] }
  nodes:
    - { id: start, type: input }
    - { id: a, type: agent, agent_ref: worker, prompt_template: 'go' }
    - { id: out, type: output }
  edges:
    - { from: start, to: a }
    - { from: a, to: out }
`;

/** The same id and shape, a different graph: what a writer who edited the file after the confirmation left behind. */
const CHANGED = CONFIRMED.replace(
  "prompt_template: 'go'",
  "prompt_template: 'go and delete it all'",
);

/** No service at all: starts, runs and finishes on its own. */
const PLAIN = `schema_version: '1.0'
workflow:
  id: bound-plain
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

function writeWorkflow(yaml: string): string {
  const path = join(root, 'bound.relavium.yaml');
  writeFileSync(path, yaml);
  return path;
}

function openDurable(
  workflow: Parameters<NonNullable<Parameters<typeof prepareRun>[1]['openRunStore']>>[0],
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

function rig() {
  const f = invocationFixture();
  const custody = new SignalCustody();
  custody.claim();
  const register = vi.spyOn(f.registry, 'register');
  const view: RunTerminalView = {
    sealed: false,
    releaseInput: () => Promise.resolve(),
    createJobControl: (factory) => factory(() => undefined),
    createRenderer: (factory) =>
      factory({ acknowledgeNoAcquisition: () => undefined, adopt: () => undefined }),
    runPrompt: (factory) => factory(),
    runViewOperation: (factory) => Promise.resolve().then(factory),
  };
  const lifetime = new HostedRunLifetime({ ...f.invocation, signalCustody: custody }, view);
  const io = captureIo();
  const resources = new RunResources(lifetime, io.io);
  const services = {
    buildEngine: vi.fn(() => buildEngine({ host: createInMemoryHost() })),
    resolveKeys: vi.fn(() => ({
      providers: createProviderResolver({ RELAVIUM_ANTHROPIC_API_KEY: 'sk-ant-test' }),
      mcpSecretResolver: () => 'unused',
    })),
    startMcpClient: vi.fn(() => realStartMcpClient([])),
    openRunStore: vi.fn(openDurable),
  };
  const ports = {
    secretInputs: vi.fn(() => Promise.resolve({})),
    consentGate: vi.fn(
      () => (): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> =>
        Promise.resolve(new Map<string, ResolvedStdioSpawn>()),
    ),
  };
  const adoptEngine = vi.spyOn(lifetime, 'adoptEngine');
  const adoptHandle = vi.spyOn(lifetime, 'adoptHandle');
  const prepare = (request: PrepareRunRequest): Promise<PreparedRun> =>
    prepareRun(
      request,
      {
        io: io.io,
        noticeSurface: 'shell',
        global: { cwd: root, configPath: undefined },
        home: root,
        ...services,
      },
      ports,
      lifetime,
      resources,
    );
  return {
    prepare,
    services,
    ports,
    adoptEngine,
    adoptHandle,
    register,
    err: io.err,
    cleanup: async (): Promise<void> => {
      await resources.releaseMcp();
      await lifetime.finish();
    },
  };
}

/** Let a started run finish, so nothing of it is left running when the test ends. */
async function drain(handle: RunHandle): Promise<void> {
  for await (const event of handle.events) void event;
}

async function refusalOf(call: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call();
  } catch (cause) {
    if (isCliError(cause)) return { code: cause.code, message: cause.message };
    throw cause;
  }
  throw new Error('the call was expected to refuse');
}

describe('a confirmed start runs the file that was confirmed (LAUNCH-5)', () => {
  it('refuses a file that changed after the confirmation, with every service untouched', async () => {
    const path = writeWorkflow(CONFIRMED);
    const digest = workflowSourceDigest(CONFIRMED);
    writeFileSync(path, CHANGED); // the writer, between the confirmation and the start
    const r = rig();
    const baseline = r.register.mock.calls.length;

    const refusal = await refusalOf(() =>
      r.prepare({ workflow: path, rawInputs: { n: '1' }, expectedSourceDigest: digest }),
    );
    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.message).toBe(
      'The workflow file changed after you confirmed. Open the list again.',
    );
    expect(refusal.message).toBe(WORKFLOW_SOURCE_CHANGED);
    expect(r.ports.secretInputs, 'no secret asked').not.toHaveBeenCalled();
    expect(r.ports.consentGate, 'no consent gate built').not.toHaveBeenCalled();
    expect(r.services.resolveKeys, 'no key service').not.toHaveBeenCalled();
    expect(r.services.startMcpClient, 'no MCP connect').not.toHaveBeenCalled();
    expect(r.services.openRunStore, 'no history opened, so no lease').not.toHaveBeenCalled();
    expect(r.services.buildEngine, 'no engine built').not.toHaveBeenCalled();
    expect(r.adoptEngine, 'no engine adopted by the owner').not.toHaveBeenCalled();
    expect(r.adoptHandle, 'no handle adopted by the owner').not.toHaveBeenCalled();
    expect(r.register.mock.calls.length, 'no owner registered by the preparation').toBe(baseline);
    expect(r.err(), 'nothing was warned about the file it refused').toBe('');
    expect(
      client.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get(),
      'and no run was recorded',
    ).toEqual({ n: 0 });
    await r.cleanup();
  });

  it('refuses a change that does not touch the id, and one that only adds a space', async () => {
    const r = rig();
    for (const changed of [CHANGED, `${CONFIRMED} `, CONFIRMED.replace('\n', '\r\n')]) {
      const path = writeWorkflow(changed);
      const refusal = await refusalOf(() =>
        r.prepare({
          workflow: path,
          rawInputs: { n: '1' },
          expectedSourceDigest: workflowSourceDigest(CONFIRMED),
        }),
      );
      expect(refusal.message).toBe(WORKFLOW_SOURCE_CHANGED);
    }
    expect(r.ports.secretInputs).not.toHaveBeenCalled();
    expect(r.services.buildEngine).not.toHaveBeenCalled();
    await r.cleanup();
  });

  it('refuses a digest that is empty, short, a prefix of the right one, or the right one with a byte changed', async () => {
    const path = writeWorkflow(CONFIRMED);
    const right = workflowSourceDigest(CONFIRMED);
    const flipped = `${right.slice(0, -1)}${right.endsWith('0') ? '1' : '0'}`;
    const r = rig();
    for (const given of ['', 'abc', right.slice(0, 32), flipped, `${right}0`]) {
      const refusal = await refusalOf(() =>
        r.prepare({ workflow: path, rawInputs: { n: '1' }, expectedSourceDigest: given }),
      );
      expect(refusal.message, JSON.stringify(given)).toBe(WORKFLOW_SOURCE_CHANGED);
    }
    expect(r.ports.secretInputs).not.toHaveBeenCalled();
    expect(r.services.buildEngine).not.toHaveBeenCalled();
    await r.cleanup();
  });

  it('starts a file that did not change exactly as it starts with no digest', async () => {
    const path = writeWorkflow(PLAIN);
    const bound = rig();
    const prepared = await bound.prepare({
      workflow: path,
      rawInputs: {},
      expectedSourceDigest: workflowSourceDigest(PLAIN),
    });
    expect(bound.ports.secretInputs).toHaveBeenCalledTimes(1);
    expect(bound.services.buildEngine).toHaveBeenCalledTimes(1);
    expect(
      bound.services.openRunStore,
      'the history, and so the lease, was opened',
    ).toHaveBeenCalledTimes(1);
    await drain(prepared.start());
    await bound.cleanup();

    // The shell paths pass no digest: the same file, a different request, the same outcome.
    const shell = rig();
    const plain = await shell.prepare({ workflow: path, rawInputs: {} });
    expect(shell.ports.secretInputs).toHaveBeenCalledTimes(1);
    expect(shell.services.buildEngine).toHaveBeenCalledTimes(1);
    expect(plain.workflow).toEqual(prepared.workflow);
    await drain(plain.start());
    await shell.cleanup();
  });

  it('with no digest binds nothing: a file that changed since anyone looked still starts (the shell path)', async () => {
    const path = writeWorkflow(PLAIN);
    const r = rig();
    const prepared = await r.prepare({ workflow: path, rawInputs: {} });
    expect(r.services.buildEngine).toHaveBeenCalledTimes(1);
    await drain(prepared.start());
    await r.cleanup();
  });

  it('digests the text it parses: the digest covers the decoded text, not a trimmed or converted view of it', async () => {
    const BOM = String.fromCharCode(0xfeff);
    const ACUTE = String.fromCharCode(0x0301); // a decomposed é: NFC would change the text
    const text = `${BOM}${PLAIN.replaceAll('\n', '\r\n')}# cafe${ACUTE}  \r\n\r\n\t `;
    const path = writeWorkflow(text);
    const r = rig();
    const prepared = await r.prepare({
      workflow: path,
      rawInputs: {},
      expectedSourceDigest: workflowSourceDigest(text),
    });
    await drain(prepared.start());
    await r.cleanup();
    for (const view of [text.trim(), text.normalize('NFC'), text.replaceAll('\r\n', '\n')]) {
      expect(() => {
        assertWorkflowSourceDigest(workflowSourceDigest(view), text);
      }, 'a different view of the same text is a different text').toThrow(CliError);
    }
  });
});

describe('a prepared run starts one run', () => {
  it('throws a typed internal error on a second start() and starts nothing more', async () => {
    const path = writeWorkflow(PLAIN);
    const r = rig();
    const prepared = await r.prepare({ workflow: path, rawInputs: {} });
    const engineStart = vi.spyOn(prepared.engine, 'start');
    const handle = prepared.start();
    expect(engineStart).toHaveBeenCalledTimes(1);

    let second: unknown;
    try {
      prepared.start();
    } catch (cause) {
      second = cause;
    }
    expect(second).toBeInstanceOf(CliError);
    expect(second).toMatchObject({ code: 'internal', message: PREPARED_RUN_REUSED });
    expect(PREPARED_RUN_REUSED).toBe(
      'a PreparedRun was reused: its start ran twice; prepare one run for each start',
    );
    expect(engineStart, 'no second leg off one preparation').toHaveBeenCalledTimes(1);
    expect(r.adoptHandle, 'and one handle adopted').toHaveBeenCalledTimes(1);
    await drain(handle);
    await r.cleanup();
  });

  it('is single-use even when the first start threw: it is not retried into a second leg', async () => {
    const path = writeWorkflow(PLAIN);
    const r = rig();
    const prepared = await r.prepare({ workflow: path, rawInputs: {} });
    const engineStart = vi.spyOn(prepared.engine, 'start').mockImplementationOnce(() => {
      throw new Error('plan refusal');
    });
    expect(() => prepared.start()).toThrow('plan refusal');
    expect(() => prepared.start()).toThrow(PREPARED_RUN_REUSED);
    expect(engineStart).toHaveBeenCalledTimes(1);
    expect(r.adoptHandle).not.toHaveBeenCalled();
    await r.cleanup();
  });
});
