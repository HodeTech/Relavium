import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createCheckpointReconstructor, parseWorkflow, WorkflowEngine } from '@relavium/core';
import { createClient, createRunHistoryReader, loadRunSnapshot } from '@relavium/db';
import * as prompts from '@clack/prompts';
import * as llm from '@relavium/llm';
import * as mcp from '@relavium/mcp';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import * as localDb from './db/open.js';
import * as engineBuilder from './engine/build-engine.js';
import * as consentGate from './engine/mcp-consent-gate.js';
import * as mcpServers from './engine/mcp-servers.js';
import * as mcpConsent from './engine/mcp-consent.js';
import * as providerResolver from './engine/providers.js';
import * as history from './history/open.js';
import { run } from './run.js';
import { captureIo as captureOutput } from './test-support.js';

const isolated = vi.hoisted(() => ({ home: '' }));
const keychain = vi.hoisted(() => ({
  get: vi.fn<(_account: string) => string | null>(() => null),
  set: vi.fn<(_account: string, _secret: string) => void>(),
  delete: vi.fn<(_account: string) => boolean>(() => false),
}));
const keyFactory = vi.hoisted(() => vi.fn(() => keychain));
// Vitest's call-through module spies observe native ESM exports without replacing prompt behavior.
vi.mock('@clack/prompts', async (original) => {
  const actual = await original<typeof import('@clack/prompts')>();
  return { ...actual, confirm: vi.fn(actual.confirm) };
});
vi.mock('./secrets/os-keychain.js', () => ({ createOsKeychainStore: keyFactory }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => isolated.home,
}));

// Input-only, deliberately opaque: none of the credential-shape scrubbers recognizes this value.
const realStartMcpClient = mcp.startMcpClient;
const SENTINEL = 'opaqueJadeQuartz782';
const MASK = { secret: true, ref: 'inputs.token' };
const MODES = [[], ['--verbose'], ['--json'], ['--json', '--verbose']];

function workflow(inputs: string, gated = false): string {
  return `schema_version: '1.0'
workflow:
  id: secret-stdin-native
  inputs:
${inputs}
  nodes:
    - { id: start, type: input }
${gated ? '    - { id: first, type: human_gate, gate_type: approval }\n    - { id: second, type: human_gate, gate_type: approval }\n' : ''}    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
${gated ? '    - { from: start, to: first }\n    - { from: first, to: second }\n    - { from: second, to: double }' : '    - { from: start, to: double }'}
    - { from: double, to: out }
`;
}
const INPUTS = `    - { name: token, type: secret, required: true }
    - { name: n, type: number, default: 2 }
    - { name: optional, type: secret, required: false }`;

let capturedSecretInput: Readable | undefined;
function captureIo() {
  const capture = captureOutput();
  return {
    ...capture,
    io: { ...capture.io, stdin: capturedSecretInput ?? capture.io.stdin },
  };
}
function installSource(iterator: () => AsyncIterator<unknown>, isTTY = false): void {
  capturedSecretInput = new Readable({ read() {} });
  Object.defineProperties(capturedSecretInput, {
    isTTY: { value: isTTY },
    [Symbol.asyncIterator]: { value: iterator },
  });
}

/** Real default reader, owned async source. Never replace readSecretFromStdin or inject a string reader. */
function installStdin(chunks: readonly unknown[], isTTY = false) {
  const cleanup = vi.fn(
    (): Promise<IteratorResult<unknown>> => Promise.resolve({ done: true, value: undefined }),
  );
  const iterator = vi.fn((): AsyncIterator<unknown> => {
    let index = 0;
    return {
      next: () =>
        Promise.resolve(
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined },
        ),
      return: cleanup,
    };
  });
  installSource(iterator, isTTY);
  return Object.assign(iterator, { cleanup });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('expected an object in native test evidence');
  return Object.fromEntries(Object.entries(value));
}
function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('expected a native JSON column');
  const parsed: unknown = JSON.parse(value);
  return record(parsed);
}

/** Read ACTUAL native columns after production has closed its handles, plus the real resume projection. */
function nativeEvidence(home: string) {
  const client = createClient(join(home, '.relavium', 'history.db'));
  try {
    const rows = client.sqlite.prepare('SELECT * FROM runs').all().map(record);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined || typeof row['id'] !== 'string') throw new Error('missing native run');
    const steps = client.sqlite.prepare('SELECT * FROM step_executions').all().map(record);
    const events = client.sqlite.prepare('SELECT * FROM run_events ORDER BY seq').all().map(record);
    const reader = createRunHistoryReader(client.db);
    const stateEvents = reader.loadRunStateEvents(row['id']);
    const fold = createCheckpointReconstructor();
    reader.visitRunEventsForReplay(row['id'], fold.apply);
    return {
      row,
      steps,
      events,
      stateEvents,
      state: fold.finish(),
      snapshot: loadRunSnapshot(client.db, row['id']),
    };
  } finally {
    client.sqlite.close();
  }
}

describe('top-level secret stdin admission with native history (ADR-0107)', () => {
  let startSpy: MockInstance<WorkflowEngine['start']>;
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'relavium-secret-native-'));
    isolated.home = directory;
    vi.stubEnv('HOME', directory);
    vi.stubEnv('USERPROFILE', directory);
    capturedSecretInput = undefined;
    vi.clearAllMocks();
    // These are observations, not replacements: both production history opens and the real engine run.
    vi.spyOn(localDb, 'openLocalDb');
    vi.spyOn(history, 'openHistoryStore');
    vi.spyOn(providerResolver, 'createProviderResolver');
    vi.spyOn(llm, 'defaultProviders');
    vi.spyOn(llm, 'createCustomOpenAiProvider');
    vi.spyOn(engineBuilder, 'buildEngine');
    vi.spyOn(mcpServers, 'connectWorkflowMcp');
    vi.spyOn(consentGate, 'createConsentGate');
    vi.spyOn(mcp, 'startMcpClient');
    vi.spyOn(mcpConsent, 'appendGrant');
    startSpy = vi.spyOn(WorkflowEngine.prototype, 'start');
  });
  afterEach(() => {
    capturedSecretInput?.destroy();
    capturedSecretInput = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function writeWorkflow(yaml = workflow(INPUTS)): string {
    const path = join(directory, 'input.relavium.yaml');
    writeFileSync(path, yaml);
    return path;
  }
  function argv(...tokens: string[]): string[] {
    return ['node', 'relavium', '--cwd', directory, ...tokens];
  }
  function expectNoEffects(): void {
    expect(keyFactory, 'SECRETS_CAUSAL_NATIVE_LAZY_FACTORY').not.toHaveBeenCalled();
    expect(keychain.get).not.toHaveBeenCalled();
    expect(keychain.set).not.toHaveBeenCalled();
    expect(keychain.delete).not.toHaveBeenCalled();
    // The provider-registry open bypasses openHistoryStore; asserting BOTH catches eager composition.
    expect(localDb.openLocalDb, 'SECRETS_CAUSAL_NATIVE_LAZY_DATABASE').not.toHaveBeenCalled();
    expect(history.openHistoryStore).not.toHaveBeenCalled();
    expect(providerResolver.createProviderResolver).not.toHaveBeenCalled();
    expect(llm.defaultProviders).not.toHaveBeenCalled();
    expect(llm.createCustomOpenAiProvider).not.toHaveBeenCalled();
    expect(mcpServers.connectWorkflowMcp).not.toHaveBeenCalled();
    expect(consentGate.createConsentGate).not.toHaveBeenCalled();
    expect(mcp.startMcpClient).not.toHaveBeenCalled();
    expect(engineBuilder.buildEngine).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(existsSync(join(directory, '.relavium', 'history.db'))).toBe(false);
  }

  const invalid = [
    { label: 'ordinary secret', args: ['--input', `token=${SENTINEL}`], reads: 0 },
    { label: 'empty ordinary secret', args: ['--input', 'token='], reads: 0 },
    {
      label: 'ordinary secret plus stdin',
      args: ['--secret-inputs-stdin', '--input', `token=${SENTINEL}`],
      reads: 0,
    },
    {
      label: 'empty ordinary secret plus stdin',
      args: ['--secret-inputs-stdin', '--input', 'token='],
      reads: 0,
    },
    { label: 'malformed ordinary input', args: ['--input', SENTINEL], reads: 0 },
    { label: 'empty ordinary name', args: ['--input', `=${SENTINEL}`], reads: 0 },
    { label: 'unknown ordinary name', args: ['--input', `${SENTINEL}=value`], reads: 0 },
    { label: 'duplicate ordinary name', args: ['--input', `n=${SENTINEL}`, 'n=1'], reads: 0 },
    { label: 'required secret missing', args: [], reads: 0 },
    { label: 'boolean attached value', args: [`--secret-inputs-stdin=${SENTINEL}`], reads: 0 },
    { label: 'unknown option', args: [`--${SENTINEL}`], reads: 0 },
    { label: 'excess positional', args: ['--secret-inputs-stdin', SENTINEL], reads: 0 },
    { label: 'stdin malformed', raw: SENTINEL, reads: 1 },
    { label: 'stdin unknown', raw: `${SENTINEL}=value`, reads: 1 },
    { label: 'stdin ordinary', raw: `n=${SENTINEL}`, reads: 1 },
    { label: 'stdin duplicate after trim', raw: `token=${SENTINEL}\n token =other`, reads: 1 },
    { label: 'stdin empty secret', raw: 'token=   ', reads: 1 },
    { label: 'stdin empty stream', raw: '', reads: 1 },
    { label: 'stdin missing required', raw: `optional=${SENTINEL}`, reads: 1 },
    {
      label: 'secret minimum',
      raw: `token=${SENTINEL}`,
      validation: '{ min_length: 50 }',
      reads: 1,
    },
    {
      label: 'secret maximum',
      raw: `token=${SENTINEL}`,
      validation: '{ max_length: 3 }',
      reads: 1,
    },
    {
      label: 'secret pattern',
      raw: `token=${SENTINEL}`,
      validation: "{ pattern: '^allowed$' }",
      reads: 1,
    },
    { label: 'secret format', raw: `token=${SENTINEL}`, validation: '{ format: email }', reads: 1 },
    {
      label: 'ordinary number',
      args: ['--secret-inputs-stdin', '--input', `n=${SENTINEL}`],
      reads: 1,
    },
    {
      label: 'ordinary minimum',
      args: ['--secret-inputs-stdin', '--input', 'n=-1'],
      ordinary: '{ min: 0 }',
      reads: 1,
    },
    {
      label: 'ordinary maximum',
      args: ['--secret-inputs-stdin', '--input', 'n=10'],
      ordinary: '{ max: 5 }',
      reads: 1,
    },
    {
      label: 'ordinary enum',
      args: ['--secret-inputs-stdin', '--input', 'n=10'],
      ordinary: '{ enum: [1, 2] }',
      reads: 1,
    },
    { label: 'TTY with redirected stdout', raw: `token=${SENTINEL}`, tty: true, reads: 0 },
    { label: 'oversized stdin', raw: `token=${SENTINEL}${'a'.repeat(65_536)}`, reads: 1 },
  ];
  for (const mode of MODES) {
    for (const test of invalid) {
      it(`refuses ${test.label} before native effects (${mode.join(' ') || 'human'})`, async () => {
        let inputs = INPUTS;
        if (test.validation !== undefined)
          inputs = inputs.replace(
            'type: secret, required: true }',
            () => `type: secret, required: true, validation: ${test.validation} }`,
          );
        if (test.ordinary !== undefined)
          inputs = inputs.replace('default: 2 }', `default: 2, validation: ${test.ordinary} }`);
        const path = writeWorkflow(workflow(inputs));
        const iterator = installStdin([test.raw ?? `token=${SENTINEL}`], test.tty);
        const capture = captureIo();
        const exit = await run(
          argv('run', path, ...(test.args ?? ['--secret-inputs-stdin']), ...mode),
          capture.io,
        );
        expectNoEffects();
        expect(exit, 'SECRETS_CAUSAL_NATIVE_ARGV_REFUSAL').toBe(2);
        expect(capture.out() + capture.err(), 'SECRETS_CAUSAL_NATIVE_INPUT_OPACITY').not.toContain(
          SENTINEL,
        );
        expect(iterator).toHaveBeenCalledTimes(test.reads);
        expect(capture.out()).toBe('');
        expect(capture.err()).not.toBe('');
      });
    }
  }

  it('does not consume stdin when the workflow declares no secret', async () => {
    const path = writeWorkflow(workflow('    - { name: n, type: number, default: 2 }'));
    const iterator = installStdin([SENTINEL]);
    const capture = captureIo();
    expect(await run(argv('run', path, '--secret-inputs-stdin'), capture.io)).toBe(2);
    expect(iterator).not.toHaveBeenCalled();
    expectNoEffects();
  });

  for (const mode of MODES) {
    it(`delivers one verbatim default-stdin read through real engine start and persists only masks (${mode.join(' ') || 'human'})`, async () => {
      const yaml = workflow(
        `${INPUTS}\n    - { name: '__proto__', type: secret }\n    - { name: constructor, type: secret }\n    - { name: toString, type: secret }\n    - { name: enabled, type: boolean }`,
      );
      const path = writeWorkflow(yaml);
      const secret = `  ${SENTINEL}=雪  `;
      const raw = `\r\n token =${secret}\r\n__proto__=proto-${SENTINEL}\r\nconstructor=ctor-${SENTINEL}\r\ntoString=string-${SENTINEL}\r\n`;
      const bytes = Buffer.from(raw);
      const iterator = installStdin([bytes.subarray(0, 35), bytes.subarray(35)]);
      const capture = captureIo();
      const exit = await run(
        argv('run', path, '--secret-inputs-stdin', '--input', 'n=7', 'enabled=true', ...mode),
        capture.io,
      );
      expect(exit, `SECRETS_CAUSAL_NATIVE_FORWARDING: ${capture.err()}`).toBe(0);
      expect(iterator, 'SECRETS_CAUSAL_NATIVE_DEFAULT_READER').toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledTimes(1);
      const start = startSpy.mock.calls[0]?.[0];
      expect(start?.inputs?.['token'], 'SECRETS_CAUSAL_NATIVE_VERBATIM').toBe(secret);
      expect(start?.inputs?.['n']).toBe(7);
      expect(start?.inputs?.['enabled']).toBe(true);
      expect(Object.hasOwn(start?.inputs ?? {}, '__proto__')).toBe(true);
      expect(Object.hasOwn(start?.inputs ?? {}, 'optional')).toBe(false);
      expect(keyFactory).toHaveBeenCalledTimes(1);
      expect(localDb.openLocalDb).toHaveBeenCalledTimes(2);
      expect(history.openHistoryStore).toHaveBeenCalledTimes(1);
      expect(engineBuilder.buildEngine).toHaveBeenCalledTimes(1);
      expect(llm.defaultProviders).toHaveBeenCalledTimes(1);
      expect(keychain.get).not.toHaveBeenCalled();
      expect(keychain.set).not.toHaveBeenCalled();
      expect(keychain.delete).not.toHaveBeenCalled();
      assertMasked(nativeEvidence(directory), yaml, [
        'token',
        '__proto__',
        'constructor',
        'toString',
      ]);
      expect(capture.out() + capture.err()).not.toContain(SENTINEL);
    });
  }

  function assertMasked(
    evidence: ReturnType<typeof nativeEvidence>,
    yaml: string,
    names = ['token'],
  ): void {
    const inputs = jsonObject(evidence.row['input_json']);
    expect(inputs['token'], 'SECRETS_CAUSAL_NATIVE_EVENT_MASK').toEqual(MASK);
    expect(Object.hasOwn(inputs, 'optional')).toBe(false);
    for (const name of names) {
      expect(Object.hasOwn(inputs, name)).toBe(true);
      expect(inputs[name]).toEqual({ secret: true, ref: `inputs.${name}` });
    }
    const inputNode = evidence.steps.find((step) => step['node_id'] === 'start');
    expect(
      jsonObject(inputNode?.['output_json'])['token'],
      'SECRETS_CAUSAL_NATIVE_INPUT_NODE_MASK',
    ).toEqual(MASK);
    expect(jsonObject(evidence.row['workflow_definition_snapshot'])).toEqual(parseWorkflow(yaml));
    expect(JSON.stringify(evidence), 'SECRETS_CAUSAL_NATIVE_COLUMN_OPACITY').not.toContain(
      SENTINEL,
    );
    expect(evidence.events.length).toBeGreaterThan(2);
    expect(evidence.snapshot).toBeDefined();
  }

  it('pauses durably, refuses missing resupply, resumes with fresh stdin and pauses at the next gate', async () => {
    const yaml = workflow(INPUTS, true);
    const path = writeWorkflow(yaml);
    const firstRead = installStdin([`token=${SENTINEL}`]);
    const first = captureIo();
    expect(
      await run(argv('run', path, '--secret-inputs-stdin', '--json'), first.io),
      first.err(),
    ).toBe(3);
    expect(firstRead).toHaveBeenCalledTimes(1);
    const paused = nativeEvidence(directory);
    assertMasked(paused, yaml);
    const runId = paused.row['id'];
    if (typeof runId !== 'string') throw new Error('missing run id');
    const secondRead = installStdin([`token=fresh-${SENTINEL}`]);
    const absent = captureIo();
    expect(await run(argv('gate', runId, '--approve', '--json'), absent.io)).toBe(2);
    expect(secondRead).not.toHaveBeenCalled();
    expect(absent.err()).toContain('--secret-stdin');
    const resumed = captureIo();
    expect(
      await run(argv('gate', runId, '--approve', '--secret-stdin', '--json'), resumed.io),
      resumed.err(),
    ).toBe(3);
    expect(secondRead).toHaveBeenCalledTimes(1);
    expect(prompts.confirm).not.toHaveBeenCalled();
    const second = nativeEvidence(directory);
    assertMasked(second, yaml);
    expect(second.events.map((event) => jsonObject(event['payload_json']))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'human_gate:paused', nodeId: 'second' }),
      ]),
    );
    expect(
      first.out() + first.err() + absent.out() + absent.err() + resumed.out() + resumed.err(),
    ).not.toContain(SENTINEL);
  });

  for (const representation of ['buffer', 'string'] as const) {
    it(`accepts exactly 65536 UTF-8 stdin bytes through the native run (${representation})`, async () => {
      const yaml = workflow(INPUTS);
      const path = writeWorkflow(yaml);
      const prefix = `token=${SENTINEL}=雪`;
      const raw = prefix + 'x'.repeat(65_536 - Buffer.byteLength(prefix));
      expect(Buffer.byteLength(raw)).toBe(65_536);
      const bytes = Buffer.from(raw);
      const chunks =
        representation === 'buffer'
          ? [
              bytes.subarray(0, Buffer.byteLength(prefix) - 2),
              bytes.subarray(Buffer.byteLength(prefix) - 2),
            ]
          : [raw.slice(0, 30), raw.slice(30)];
      const iterator = installStdin(chunks);
      const capture = captureIo();
      expect(
        await run(argv('run', path, '--secret-inputs-stdin', '--json'), capture.io),
        capture.err(),
      ).toBe(0);
      expect(iterator).toHaveBeenCalledTimes(1);
      expect(startSpy.mock.calls[0]?.[0].inputs?.['token']).toBe(raw.slice(6));
      assertMasked(nativeEvidence(directory), yaml);
      expect(capture.out() + capture.err()).not.toContain(SENTINEL);
    });
  }

  for (const representation of ['buffer', 'string'] as const) {
    it(`refuses exactly 65537 UTF-8 stdin bytes and releases the actual reader (${representation})`, async () => {
      const path = writeWorkflow();
      const prefix = `token=${SENTINEL}=雪`;
      const raw = prefix + 'x'.repeat(65_537 - Buffer.byteLength(prefix));
      const bytes = Buffer.from(raw);
      const iterator = installStdin(
        representation === 'buffer' ? [bytes.subarray(0, 65_530), bytes.subarray(65_530)] : [raw],
      );
      const capture = captureIo();
      const code = await run(argv('run', path, '--secret-inputs-stdin', '--json'), capture.io);
      expectNoEffects();
      expect(code).toBe(2);
      expect(iterator).toHaveBeenCalledTimes(1);
      expect(iterator.cleanup).toHaveBeenCalledTimes(1);
      expect(capture.err()).toContain('65536-byte limit');
      expect(capture.out() + capture.err()).not.toContain(SENTINEL);
    });
  }

  for (const mode of MODES) {
    it(`keeps real stdin iterator faults private and closes the iterator (${mode.join(' ') || 'human'})`, async () => {
      const path = writeWorkflow();
      const cleanup = vi.fn(() => Promise.resolve({ done: true, value: undefined }));
      installSource(() => ({
        next: () => Promise.reject(new Error(SENTINEL)),
        return: cleanup,
      }));
      const capture = captureIo();
      const code = await run(argv('run', path, '--secret-inputs-stdin', ...mode), capture.io);
      expectNoEffects();
      expect(code).toBe(2);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(capture.out() + capture.err()).not.toContain(SENTINEL);
      expect(capture.err()).toContain('could not read secret input from stdin');
    });
  }

  it('uses actual noninteractive MCP consent and the exact digest without reading stdin again or appending approval', async () => {
    // An unused inline agent still declares a server for eager discovery. No provider call is needed.
    const yaml = workflow(INPUTS).replace(
      '  nodes:',
      `  agents:
    - id: unused
      model: gpt-4o
      provider: openai
      system_prompt: offline
      mcp_servers:
        - { id: native-fixture, transport: stdio, command: ${JSON.stringify(process.execPath)} }
  nodes:`,
    );
    const path = writeWorkflow(yaml);
    const connection = {
      listTools: () => Promise.resolve([]),
      callTool: () => Promise.resolve({ content: [], isError: false }),
      close: vi.fn(() => Promise.resolve()),
    };
    // Only the external transport is replaced. Consent resolution/digest/grant checks and manager run.
    vi.mocked(mcp.startMcpClient).mockImplementation((servers, signal, options) =>
      realStartMcpClient(
        servers.map((server) => ({
          ...server,
          open: () => Promise.resolve(connection),
        })),
        signal,
        options,
      ),
    );
    const firstRead = installStdin([`token=${SENTINEL}`]);
    const refused = captureIo();
    expect(
      await run(argv('run', path, '--secret-inputs-stdin', '--json'), refused.io),
      refused.err(),
    ).toBe(2);
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(mcp.startMcpClient).not.toHaveBeenCalled();
    expect(engineBuilder.buildEngine).not.toHaveBeenCalled();
    expect(history.openHistoryStore).not.toHaveBeenCalled();
    const digest = refused.err().match(/v1:[a-f0-9]{64}/u)?.[0];
    if (digest === undefined) throw new Error('actual consent refusal omitted its digest');
    const secondRead = installStdin([`token=${SENTINEL}`]);
    const allowed = captureIo();
    expect(
      await run(
        argv('run', path, '--secret-inputs-stdin', '--allow-mcp-stdio', digest, '--json'),
        allowed.io,
      ),
      allowed.err(),
    ).toBe(0);
    expect(secondRead).toHaveBeenCalledTimes(1);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(mcp.startMcpClient).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(mcpConsent.appendGrant).not.toHaveBeenCalled();
    expect(existsSync(consentGate.mcpConsentPath(directory))).toBe(false);
    expect(refused.out() + refused.err() + allowed.out() + allowed.err()).not.toContain(SENTINEL);
    expect(nativeEvidence(directory).row['status']).toBe('completed');
  });
});
