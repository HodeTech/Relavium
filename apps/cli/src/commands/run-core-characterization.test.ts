/**
 * Byte-identity characterization of the three commands that share one run core
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1,
 * [ADR-0122](../../../../docs/decisions/0122-the-home-is-the-interactive-product.md) §2): `relavium run`,
 * `relavium gate` and `relavium budget resume`.
 *
 * Every case drives the command through its existing entry point (`runCommand`, `gateCommand`,
 * `budgetCommand`) and pins the exact stdout, the exact stderr (both as the full byte sequence, split on
 * `\n` so the trailing newline is part of the value), the exit code or the typed refusal, and the observed
 * process exit of the invocation. It was written against the code BEFORE `prepareRun`/`resumeRun`/`RunLifetime`
 * were extracted and its expected values were not edited by the extraction.
 *
 * Only three things are volatile and are replaced with a stable placeholder, in this order of appearance
 * per scenario: an ISO timestamp (`<ts>`), a UUID (`<uuid-N>`) and a `"durationMs"` number (`<ms>`). The
 * in-memory host cases carry no volatile field at all (the host's clock and ids are counters) and are
 * asserted raw.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  createInMemoryEffectJournal,
  createInMemoryHost,
  parseWorkflow,
  type WorkflowDefinition,
} from '@relavium/core';
import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { startMcpClient as realStartMcpClient, type McpConnection } from '@relavium/mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { fingerprint, resolveStdioSpawn, type ResolvedStdioSpawn } from '../engine/mcp-consent.js';
import type { OpenedHistory } from '../history/open.js';
import { isCliError, toUserFacing } from '../process/errors.js';
import { createCliInvocation, type CliInvocation } from '../process/invocation.js';
import { FATAL_TERMINATION_MS } from '../process/invocation-registry.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { createProviderResolver } from '../engine/providers.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { createPlainRenderer } from '../render/renderer.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { budgetCommand, gateCommand, type GateCommandDeps } from './gate.js';
import { runCommand, type RunCommandDeps } from './run.js';

const { consentPrompt, consentBinds } = vi.hoisted(() => ({
  consentPrompt: vi.fn<(subject: unknown, options?: unknown) => Promise<boolean>>(() =>
    Promise.resolve(false),
  ),
  consentBinds: vi.fn<(io: unknown) => void>(),
}));
vi.mock('../mcp/consent-prompt.js', () => ({
  createConsentPrompter: () => consentPrompt,
  createBoundConsentPrompter: (io: unknown) => {
    consentBinds(io);
    return consentPrompt;
  },
}));

let root: string;
vi.mock('../config/load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...actual,
    loadResolvedConfig: (options: Parameters<typeof actual.loadResolvedConfig>[0]) =>
      actual.loadResolvedConfig({ ...options, home: root }),
  };
});

const HAPPY = `schema_version: '1.0'
workflow:
  id: cli-run-happy
  inputs:
    - name: n
      type: number
  nodes:
    - { id: start, type: input }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: double }
    - { from: double, to: out }
`;

const FAILING = `schema_version: '1.0'
workflow:
  id: cli-run-fail
  nodes:
    - { id: start, type: input }
    - { id: boom, type: transform, transform: 'null.boom' }
    - { id: out, type: output }
  edges:
    - { from: start, to: boom }
    - { from: boom, to: out }
`;

const GATED = `schema_version: '1.0'
workflow:
  id: gate-resume
  inputs:
    - { name: n, type: number }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: double }
    - { from: double, to: out }
`;

const TWO_GATES = `schema_version: '1.0'
workflow:
  id: gate-two
  nodes:
    - { id: start, type: input }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g1 }
    - { from: start, to: g2 }
    - { from: g1, to: out }
    - { from: g2, to: out }
`;

const INPUT_GATED = `schema_version: '1.0'
workflow:
  id: gate-input
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

/** A declared secret plus an ordinary number; no provider is needed to complete. */
const SECRET_RUN = HAPPY.replace(
  '    - name: n\n      type: number',
  '    - { name: n, type: number }\n    - { name: token, type: secret, required: true }',
);

/** A gated run carrying a secret: its durable record holds only the masked slot. */
const GATED_SECRET = GATED.replace(
  '    - { name: n, type: number }',
  '    - { name: n, type: number }\n    - { name: api_key, type: secret }',
).replace('id: gate-resume', 'id: gate-secret');

const SECRET_VALUE = 'opaque-characterization-secret-value';

/** A credential-shaped literal in authored metadata: scanned (and reported) only after the inputs are admitted. */
const AUTHORED_LITERAL = 'sk-runAuthoredSyntheticCredential123456789';
const WITH_LITERAL = (yaml: string): string =>
  yaml.replace(
    '  id: cli-run-happy',
    `  id: cli-run-happy\n  metadata: { private: ${AUTHORED_LITERAL} }`,
  );

/** An inline agent granted a tool the run path does not wire, and one whose provider needs a key. */
const UNWIRED_TOOL = `schema_version: '1.0'
workflow:
  id: cli-run-unwired
  agents:
    - { id: scanner, model: claude-opus-4-8, provider: anthropic, system_prompt: inspect, tools: [web_search] }
  nodes:
    - { id: start, type: input }
    - { id: a, type: agent, agent_ref: scanner, prompt_template: 'go' }
    - { id: out, type: output }
  edges:
    - { from: start, to: a }
    - { from: a, to: out }
`;
const NEEDS_KEY = UNWIRED_TOOL.replace(', tools: [web_search]', '').replace(
  'id: cli-run-unwired',
  'id: cli-run-needs-key',
);

/** The only volatile fields: timestamps, UUIDs and durations. Everything else is compared byte for byte. */
function createNormalizer(): (text: string) => string {
  const ids = new Map<string, string>();
  return (text) =>
    text
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<ts>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
        let stable = ids.get(id);
        if (stable === undefined) {
          stable = `<uuid-${String(ids.size + 1)}>`;
          ids.set(id, stable);
        }
        return stable;
      })
      .replace(/"durationMs":\d+/g, '"durationMs":<ms>');
}

interface Observed {
  /** The returned exit code, or the typed refusal that replaced it. */
  readonly result:
    | number
    | { readonly code: string; readonly exitCode: number; readonly message: string };
  readonly out: readonly string[];
  readonly err: readonly string[];
  /** What the invocation published as the process exit, and how many owners were still registered. */
  readonly observedExit: number;
  readonly activeOwners: number;
  /** How many times the history database was closed: once per open, on every path. */
  readonly closes: number;
  /** The sequence of the observable service calls of a start or a resume, when a case records it. */
  readonly order?: readonly string[];
  /** The MCP consent prompts asked, as scrubbed JSON, and the TTY metadata of the io each was bound to. */
  readonly prompts?: readonly string[];
  readonly promptBindings?: readonly string[];
}

let historyCloses = 0;
const countClose = (): void => {
  historyCloses += 1;
};

interface Harness {
  readonly normalize: (text: string) => string;
  readonly observe: (
    invoke: (io: CliIo, invocation: CliInvocation) => Promise<number>,
    ioOverride?: (io: CliIo) => CliIo,
  ) => Promise<Observed>;
}

function createHarness(): Harness {
  const normalize = createNormalizer();
  return {
    normalize,
    observe: async (invoke, ioOverride) => {
      historyCloses = 0;
      const capture = captureIo();
      const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
      let result: Observed['result'];
      try {
        result = await invoke(
          ioOverride === undefined ? capture.io : ioOverride(capture.io),
          invocation,
        );
      } catch (cause) {
        if (!isCliError(cause)) throw cause;
        result = {
          code: cause.code,
          exitCode: toUserFacing(cause).exitCode,
          message: normalize(cause.message),
        };
      }
      return {
        result,
        out: normalize(capture.out()).split('\n'),
        err: normalize(capture.err()).split('\n'),
        observedExit: invocation.registry.observations.exitCode(),
        activeOwners: invocation.registry.activeOwners,
        closes: historyCloses,
      };
    },
  };
}

function globalOptions(json: boolean): GlobalOptions {
  return { json, color: false, cwd: root, configPath: undefined, verbosity: 'normal' };
}

function writeWorkflow(name: string, yaml: string): string {
  const path = join(root, name);
  writeFileSync(path, yaml);
  return path;
}

/** A client whose `history.db` stands in for the operator's; closed by the test. */
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-core-char-'));
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

/** The in-memory host: the engine's clock and ids are counters, so the whole stream is deterministic. */
function inMemoryRun(json: boolean): Pick<RunCommandDeps, 'buildEngine' | 'global'> {
  return {
    global: globalOptions(json),
    buildEngine: () =>
      buildEngine({
        host: createInMemoryHost(),
        effectJournal: (correlation) => createInMemoryEffectJournal(correlation),
      }),
  };
}

/** The durable store `relavium run` opens in production, over the shared in-memory SQLite database. */
function openDurable(workflow: WorkflowDefinition, close: () => void = countClose): OpenedHistory {
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
    close,
  };
}

function durableRun(json: boolean): Pick<RunCommandDeps, 'openRunStore' | 'global'> {
  return { global: globalOptions(json), openRunStore: (workflow) => openDurable(workflow) };
}

/** A consent gate that approves nothing and refuses nothing: these cases test routing, not consent. */
const PASS_CONSENT = (): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> =>
  Promise.resolve(new Map<string, ResolvedStdioSpawn>());

function lastRunId(): string {
  const row = client.sqlite.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 1').get();
  if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string')
    throw new Error('no run was recorded');
  return row.id;
}

function gateDeps(io: CliIo, invocation: CliInvocation, json: boolean): GateCommandDeps {
  return {
    io,
    invocation,
    global: globalOptions(json),
    openDb: () => ({ db: client.db, close: countClose }),
  };
}

/** A stdin that yields the given text exactly once, shaped like the real piped stream. */
function pipedStdin(text: string): (io: CliIo) => CliIo {
  return (io) => ({ ...io, stdin: Readable.from([text]) });
}

/** The digest `--allow-mcp-stdio` takes for the one inline stdio server these workflows declare (`local`). */
async function localDigest(cwd: string): Promise<string> {
  return fingerprint(
    await resolveStdioSpawn(
      { serverId: 'local', command: process.execPath, provenance: { kind: 'inline' } },
      cwd,
    ),
  );
}

/** A well-formed `--allow-mcp-stdio` digest that names no declaration these workflows make. */
const WRONG_DIGEST = `v1:${'0'.repeat(64)}`;

/** Replace what differs between machines and runs inside a consent refusal: the root, node and the digest. */
const scrubConsent = (text: string): string =>
  text
    .split(`/private${root}`)
    .join('<root>')
    .split(root)
    .join('<root>')
    .split(process.execPath)
    .join('<node>')
    .replace(/v1:[0-9a-f]{64}/g, '<digest>');

/**
 * What a command that never settles leaves behind. A release the host cannot acknowledge keeps the process
 * alive for its exit authority, so the observation is taken at the hang and again once the finite-exit bound
 * has elapsed on a controlled clock: the command still has not settled, the database was never closed and the
 * authority published its code.
 */
interface Hung {
  readonly settled: boolean;
  readonly out: readonly string[];
  readonly err: readonly string[];
  /** How many times the history database was closed; a hang never reaches it. */
  readonly closes: number;
  readonly activeOwners: number;
  /** The exit the finite-exit authority published once its bound elapsed, and every code it asked to exit with. */
  readonly boundExit: number;
  readonly exitCalls: readonly number[];
  readonly settledAfterBound: boolean;
  readonly closesAfterBound: number;
  readonly activeOwnersAfterBound: number;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Real time, not ticks: how long the hang is given to reach its teardown warning, and how often it is polled.
const HANG_OBSERVATION_DEADLINE_MS = 10_000;
const HANG_POLL_MS = 5;

async function observeHang(
  invoke: (io: CliIo, invocation: CliInvocation) => Promise<number>,
  normalize: (text: string) => string,
): Promise<Hung> {
  historyCloses = 0;
  const capture = captureIo();
  const control = invocationFixture();
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void invoke(capture.io, control.invocation).then(mark, mark);
  // The release tail is asynchronous: wait for the teardown warning that shows the close was refused,
  // then give anything the shell might still do after it (the database close) every chance to run.
  // The wait is bound by wall-clock time, not by a count of ticks: the path includes real `node:fs/promises`
  // calls, which the thread pool answers at its own pace under load.
  const deadline = Date.now() + HANG_OBSERVATION_DEADLINE_MS;
  while (!capture.err().includes('MCP teardown failed')) {
    if (Date.now() > deadline) throw new Error('the MCP teardown warning never appeared');
    await new Promise<void>((resolve) => setTimeout(resolve, HANG_POLL_MS));
  }
  for (let n = 0; n < 20; n += 1) await tick();
  const atHang = {
    settled,
    out: normalize(capture.out()).split('\n'),
    err: normalize(capture.err()).split('\n'),
    closes: historyCloses,
    activeOwners: control.registry.activeOwners,
  };
  control.advance(FATAL_TERMINATION_MS);
  const boundExit = await control.invocation.finiteExit.exited;
  for (let n = 0; n < 20; n += 1) await tick();
  return {
    ...atHang,
    boundExit,
    exitCalls: control.exit.mock.calls.map((call) => Number(call[0])),
    settledAfterBound: settled,
    closesAfterBound: historyCloses,
    activeOwnersAfterBound: control.registry.activeOwners,
  };
}

// ---------------------------------------------------------------------------------------------------
// Expected values. The original cases were recorded from the pre-extraction code; the cases added later
// (commit c64164fc onward) were recorded from the committed post-extraction code and reproduce at the
// pre-extraction commit 022e182d (checked 2026-11-22; see the step-2 entry in the phase record). Edited only
// to add a new case, never to follow a behaviour change.
// ---------------------------------------------------------------------------------------------------

const EXPECTED: Readonly<Record<string, Observed>> = {
  'budget.abort.json': {
    result: 1,
    out: [
      '{"type":"budget:authorization","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":7,"nodeId":"agent","gateId":"<uuid-2>","authorization":{"state":"decided","allowance":{"kind":"frozen","quote":{"kind":"quoted","quote":{"amount":{"kind":"representable","microcents":150},"provenance":{"version":1,"route":"text","calls":1,"attempts":2,"entries":[{"index":0,"model":"offline-core-characterization","provider":"openai","endpoint":"custom","attempts":2,"estimate":{"kind":"priced","microcents":75,"basis":{"inputTokensEstimate":11,"outputTokensReservation":64,"inputRateKind":"non_cached","inputPerMtokMicrocents":1000000,"outputPerMtokMicrocents":1000000,"media":[]},"unpricedModalities":[]}}]},"excludedEntries":[]}}},"decision":"rejected","decidedBy":"cli"}}',
      '{"type":"human_gate:resumed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":8,"nodeId":"agent","decision":"rejected","decidedBy":"cli","allowanceQuote":{"kind":"quoted","quote":{"amount":{"kind":"representable","microcents":150},"provenance":{"version":1,"route":"text","calls":1,"attempts":2,"entries":[{"index":0,"model":"offline-core-characterization","provider":"openai","endpoint":"custom","attempts":2,"estimate":{"kind":"priced","microcents":75,"basis":{"inputTokensEstimate":11,"outputTokensReservation":64,"inputRateKind":"non_cached","inputPerMtokMicrocents":1000000,"outputPerMtokMicrocents":1000000,"media":[]},"unpricedModalities":[]}}]},"excludedEntries":[]}},"gateId":"<uuid-2>"}',
      '{"type":"node:skipped","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":9,"nodeId":"out","reason":"upstream_unreachable"}',
      '{"type":"run:failed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":10,"error":{"code":"budget_exceeded","message":"the budget gate was rejected","retryable":false,"correlationId":"<uuid-3>","nodeId":"agent"},"partialOutputs":{}}',
      '',
    ],
    err: [''],
    observedExit: 1,
    activeOwners: 0,
    closes: 1,
  },
  'budget.abort.plain': {
    result: 1,
    out: ['  skip out (upstream_unreachable)', 'done: run failed (budget_exceeded)', ''],
    err: [''],
    observedExit: 1,
    activeOwners: 0,
    closes: 1,
  },
  'budget.approve.json': {
    result: 0,
    out: [
      '{"type":"budget:authorization","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":7,"nodeId":"agent","gateId":"<uuid-2>","authorization":{"state":"decided","allowance":{"kind":"frozen","quote":{"kind":"quoted","quote":{"amount":{"kind":"representable","microcents":150},"provenance":{"version":1,"route":"text","calls":1,"attempts":2,"entries":[{"index":0,"model":"offline-core-characterization","provider":"openai","endpoint":"custom","attempts":2,"estimate":{"kind":"priced","microcents":75,"basis":{"inputTokensEstimate":11,"outputTokensReservation":64,"inputRateKind":"non_cached","inputPerMtokMicrocents":1000000,"outputPerMtokMicrocents":1000000,"media":[]},"unpricedModalities":[]}}]},"excludedEntries":[]}}},"decision":"approved","decidedBy":"cli","approvedAmountMicrocents":150}}',
      '{"type":"human_gate:resumed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":8,"nodeId":"agent","decision":"approved","decidedBy":"cli","allowanceQuote":{"kind":"quoted","quote":{"amount":{"kind":"representable","microcents":150},"provenance":{"version":1,"route":"text","calls":1,"attempts":2,"entries":[{"index":0,"model":"offline-core-characterization","provider":"openai","endpoint":"custom","attempts":2,"estimate":{"kind":"priced","microcents":75,"basis":{"inputTokensEstimate":11,"outputTokensReservation":64,"inputRateKind":"non_cached","inputPerMtokMicrocents":1000000,"outputPerMtokMicrocents":1000000,"media":[]},"unpricedModalities":[]}}]},"excludedEntries":[]}},"gateId":"<uuid-2>","approvedAmountMicrocents":150}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":9,"nodeId":"agent","nodeType":"agent"}',
      '{"model":"offline-core-characterization","invocation":{"producerId":"<uuid-3>","ordinal":1,"dispatchId":"1","round":0,"chainAttempt":1},"type":"cost:usage_pending","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"timestamp":"<ts>","sequenceNumber":10,"nodeId":"agent"}',
      '{"type":"agent:token","runId":"<uuid-1>","timestamp":"<ts>","sequenceNumber":11,"nodeId":"agent","token":"ANSWER","model":"offline-core-characterization"}',
      '{"type":"cost:updated","runId":"<uuid-1>","cumulativeCostMicrocents":2,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":1,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":12,"nodeId":"agent","model":"offline-core-characterization","inputTokens":1,"outputTokens":1,"costMicrocents":2,"attemptNumber":1,"priced":true}',
      '{"type":"cost:attempt_settled","invocation":{"producerId":"<uuid-3>","ordinal":1,"dispatchId":"1","round":0,"chainAttempt":1},"runId":"<uuid-1>","cumulativeCostMicrocents":2,"cumulativeUnpricedCalls":0,"timestamp":"<ts>","sequenceNumber":13,"nodeId":"agent","model":"offline-core-characterization","attemptNumber":1,"inputTokens":1,"outputTokens":1,"costMicrocents":2,"priced":true}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":2,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":14,"nodeId":"agent","output":"ANSWER","tokensUsed":{"input":1,"output":1,"model":"offline-core-characterization"},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":2,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":15,"nodeId":"out","nodeType":"output"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":2,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":16,"nodeId":"out","output":"ANSWER","tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"run:completed","runId":"<uuid-1>","cumulativeCostMicrocents":2,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":17,"outputs":{"out":"ANSWER"},"totalTokensUsed":{"input":1,"output":1},"totalCostMicrocents":2,"durationMs":<ms>}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'budget.approve.plain': {
    result: 0,
    out: [
      '  - agent ...',
      '  ok agent',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: ANSWER',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'budget.refusal.amount': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'the frozen allowance is 150 microcents; --approve-amount must equal that amount',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'budget.refusal.price': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'the frozen budget quote no longer matches current pricing; reject this gate and start a new run',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'consent.gate.approved': {
    result: 0,
    out: [
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '\u001b[?25h\u001b[?25h',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
    prompts: [
      '{"subject":{"serverId":"local","provenance":"inline","artifact":"frozen run <uuid-1>","resolvedCommand":"<node>","args":[],"env":[],"cwd":"<root>","digest":"<digest>","total":1,"index":1},"hasSignal":true}',
    ],
    promptBindings: ['stdinIsTty=true stdoutIsTty=true'],
  },
  'consent.gate.secret-stdin': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'this run would start 1 local program(s) not approved on this machine (listed above). Approve them interactively, or pass --allow-mcp-stdio <digest> for each \u2014 the digest is a hash of the declaration, not a secret.',
    },
    out: [''],
    err: ['  local: <node>  <digest>', ''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
    prompts: [],
    promptBindings: [],
  },
  'consent.run.explicit-digest': {
    result: 3,
    out: [
      '> run <uuid-1> started',
      '  - start ...',
      '  ok start',
      '  - g ...',
      '  paused at gate <uuid-2> (approval)',
      '\u001b[?25h\u001b[?25h',
    ],
    err: [''],
    observedExit: 3,
    activeOwners: 0,
    closes: 1,
    prompts: [],
    promptBindings: [],
  },
  'consent.run.refused': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: "MCP server 'local' was not approved, so the run did not start.",
    },
    out: ['\u001b[?25h\u001b[?25h'],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
    prompts: [
      '{"subject":{"serverId":"local","provenance":"inline","artifact":"<root>/mcp-gated.relavium.yaml","resolvedCommand":"<node>","args":[],"env":[],"cwd":"<root>","digest":"<digest>","total":1,"index":1},"hasSignal":true}',
    ],
    promptBindings: ['stdinIsTty=true stdoutIsTty=true'],
  },
  'consent.run.secret-stdin': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'this run would start 1 local program(s) not approved on this machine (listed above). Approve them interactively, or pass --allow-mcp-stdio <digest> for each \u2014 the digest is a hash of the declaration, not a secret.',
    },
    out: [''],
    err: ['  local: <node>  <digest>', ''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
    prompts: [],
    promptBindings: [],
  },
  'gate.approve.resume.json': {
    result: 0,
    out: [
      '{"type":"human_gate:resumed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":7,"nodeId":"g","decision":"approved","decidedBy":"cli"}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":8,"nodeId":"double","nodeType":"transform"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":9,"nodeId":"double","output":{"d":6},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":10,"nodeId":"out","nodeType":"output"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":11,"nodeId":"out","output":{"d":6},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"run:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":12,"outputs":{"out":{"d":6}},"totalTokensUsed":{"input":0,"output":0},"totalCostMicrocents":0,"durationMs":<ms>}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'gate.approve.resume.plain': {
    result: 0,
    out: [
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'gate.approve.start.json': {
    result: 3,
    out: [
      '{"type":"run:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":true,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":0,"workflowId":"<uuid-2>","inputs":{"n":3},"executionMode":"local"}',
      '{"basis":"complete","type":"cost:coverage_started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"timestamp":"<ts>","sequenceNumber":1}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":2,"nodeId":"start","nodeType":"input"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":3,"nodeId":"start","output":{"n":3},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":4,"nodeId":"g","nodeType":"human_in_the_loop"}',
      '{"type":"human_gate:paused","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":5,"nodeId":"g","gateId":"<uuid-3>","gateType":"approval","message":""}',
      '{"type":"run:paused","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":6,"pendingGateCount":1,"gateIds":["<uuid-3>"]}',
      '',
    ],
    err: [''],
    observedExit: 3,
    activeOwners: 0,
    closes: 1,
  },
  'gate.approve.start.plain': {
    result: 3,
    out: [
      '> run <uuid-1> started',
      '  - start ...',
      '  ok start',
      '  - g ...',
      '  paused at gate <uuid-2> (approval)',
      '',
    ],
    err: [''],
    observedExit: 3,
    activeOwners: 0,
    closes: 1,
  },
  'gate.doubled.json': {
    result: 0,
    out: [''],
    err: ['run completed; nothing to resume', ''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'gate.doubled.plain': {
    result: 0,
    out: ['run completed; nothing to resume', ''],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'gate.order': {
    result: 0,
    out: [
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
    order: ['stdin', 'keys', 'mcp', 'engine', 'resume', 'mcp-close', 'history-close'],
  },
  'gate.refusal.ambiguous': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'more than one gate is pending \u2014 pass --gate <gateId>: (pending: <uuid-1>, <uuid-2>)',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.refusal.decision-fit': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'the gate at node g is an input gate \u2014 use --input <json> or --reject',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.refusal.secret-empty-value': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'stdin for run <uuid-1> must be `name=value` lines with a non-empty value.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.refusal.secret-missing-slot': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'stdin did not supply the `secret` input(s) [api_key] this run needs.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.refusal.secret-not-needed': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'run <uuid-1> has no `secret` inputs to re-supply \u2014 drop --secret-stdin.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.refusal.secret-required': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        "run <uuid-1> needs its `secret` input(s) [api_key] re-supplied to resume \u2014 they are never persisted. Pipe the run's secret inputs as name=value lines on stdin \u2014 e.g. `printf 'api_key=%s\\n' \"$VALUE\" | relavium gate <uuid-1> --gate <uuid-2> --approve --secret-stdin` (a credential is never passed as an argument).",
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.refusal.secret-unknown-name': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'stdin supplied a name that run <uuid-1> has no `secret` slot for.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.refusal.unknown-gate': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'no pending gate not-a-gate on run (pending: <uuid-1>, <uuid-2>)',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.refusal.unknown-run': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'no run found with id no-such-run',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
  },
  'gate.reject.plain': {
    result: 0,
    out: [
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'gate.secret.resume.json': {
    result: 0,
    out: [
      '{"type":"human_gate:resumed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":7,"nodeId":"g","decision":"approved","decidedBy":"cli"}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":8,"nodeId":"double","nodeType":"transform"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":9,"nodeId":"double","output":{"d":6},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":10,"nodeId":"out","nodeType":"output"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":11,"nodeId":"out","output":{"d":6},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"run:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":12,"outputs":{"out":{"d":6}},"totalTokensUsed":{"input":0,"output":0},"totalCostMicrocents":0,"durationMs":<ms>}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'gate.secret.resume.plain': {
    result: 0,
    out: [
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'gate.secret.start.json': {
    result: 3,
    out: [
      '{"type":"run:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":true,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":0,"workflowId":"<uuid-2>","inputs":{"n":3,"api_key":{"secret":true,"ref":"inputs.api_key"}},"executionMode":"local"}',
      '{"basis":"complete","type":"cost:coverage_started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"timestamp":"<ts>","sequenceNumber":1}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":2,"nodeId":"start","nodeType":"input"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":3,"nodeId":"start","output":{"n":3,"api_key":{"secret":true,"ref":"inputs.api_key"}},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":4,"nodeId":"g","nodeType":"human_in_the_loop"}',
      '{"type":"human_gate:paused","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":5,"nodeId":"g","gateId":"<uuid-3>","gateType":"approval","message":""}',
      '{"type":"run:paused","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":6,"pendingGateCount":1,"gateIds":["<uuid-3>"]}',
      '',
    ],
    err: [''],
    observedExit: 3,
    activeOwners: 0,
    closes: 1,
  },
  'gate.secret.start.plain': {
    result: 3,
    out: [
      '> run <uuid-1> started',
      '  - start ...',
      '  ok start',
      '  - g ...',
      '  paused at gate <uuid-2> (approval)',
      '',
    ],
    err: [''],
    observedExit: 3,
    activeOwners: 0,
    closes: 1,
  },
  'run.completed.json': {
    result: 0,
    out: [
      '{"type":"run:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":true,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":0,"workflowId":"<uuid-1>","inputs":{"n":3},"executionMode":"local"}',
      '{"basis":"complete","type":"cost:coverage_started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"timestamp":"<ts>","sequenceNumber":1}',
      '{"type":"node:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":2,"nodeId":"start","nodeType":"input"}',
      '{"type":"node:completed","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":3,"nodeId":"start","output":{"n":3},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":4,"nodeId":"double","nodeType":"transform"}',
      '{"type":"node:completed","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":5,"nodeId":"double","output":{"d":6},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":6,"nodeId":"out","nodeType":"output"}',
      '{"type":"node:completed","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":7,"nodeId":"out","output":{"d":6},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"run:completed","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":8,"outputs":{"out":{"d":6}},"totalTokensUsed":{"input":0,"output":0},"totalCostMicrocents":0,"durationMs":<ms>}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 0,
  },
  'run.completed.plain': {
    result: 0,
    out: [
      '> run id-2 started',
      '  - start ...',
      '  ok start',
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 0,
  },
  'run.failed.json': {
    result: 1,
    out: [
      '{"type":"run:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":true,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":0,"workflowId":"<uuid-1>","inputs":{},"executionMode":"local"}',
      '{"basis":"complete","type":"cost:coverage_started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"timestamp":"<ts>","sequenceNumber":1}',
      '{"type":"node:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":2,"nodeId":"start","nodeType":"input"}',
      '{"type":"node:completed","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":3,"nodeId":"start","output":{},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":4,"nodeId":"boom","nodeType":"transform"}',
      '{"type":"node:failed","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":5,"nodeId":"boom","error":{"code":"sandbox_error","message":"the expression failed to evaluate","retryable":false,"correlationId":"id-3"},"toolActivity":[]}',
      '{"type":"node:skipped","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":6,"nodeId":"out","reason":"upstream_unreachable"}',
      '{"type":"run:failed","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":7,"error":{"code":"sandbox_error","message":"the expression failed to evaluate","retryable":false,"correlationId":"id-4","nodeId":"boom"},"partialOutputs":{"start":{}}}',
      '',
    ],
    err: [''],
    observedExit: 1,
    activeOwners: 0,
    closes: 0,
  },
  'run.failed.plain': {
    result: 1,
    out: [
      '> run id-2 started',
      '  - start ...',
      '  ok start',
      '  - boom ...',
      '  FAIL boom: sandbox_error',
      '  skip out (upstream_unreachable)',
      'done: run failed (sandbox_error)',
      '',
    ],
    err: [''],
    observedExit: 1,
    activeOwners: 0,
    closes: 0,
  },
  'run.order': {
    result: 0,
    out: [
      '> run <uuid-1> started',
      '  - start ...',
      '  ok start',
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [
      'Warning: authored definition has 1 string(s) matching known credential shapes. Authored content is preserved in files and run snapshots; review literals before sharing or running. This check is best effort.',
      '',
    ],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
    order: [
      'stdin',
      'notice',
      'keys',
      'mcp',
      'history:[["read_file","mcp_fs_read"]]',
      'engine',
      'start',
      'mcp-close',
      'history-close',
    ],
  },
  'run.paused.json': {
    result: 3,
    out: [
      '{"type":"run:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":true,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":0,"workflowId":"<uuid-1>","inputs":{"n":3},"executionMode":"local"}',
      '{"basis":"complete","type":"cost:coverage_started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"timestamp":"<ts>","sequenceNumber":1}',
      '{"type":"node:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":2,"nodeId":"start","nodeType":"input"}',
      '{"type":"node:completed","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":3,"nodeId":"start","output":{"n":3},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":4,"nodeId":"g","nodeType":"human_in_the_loop"}',
      '{"type":"human_gate:paused","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":5,"nodeId":"g","gateId":"id-3","gateType":"approval","message":""}',
      '{"type":"run:paused","runId":"id-2","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":6,"pendingGateCount":1,"gateIds":["id-3"]}',
      '',
    ],
    err: [''],
    observedExit: 3,
    activeOwners: 0,
    closes: 0,
  },
  'run.paused.plain': {
    result: 3,
    out: [
      '> run id-2 started',
      '  - start ...',
      '  ok start',
      '  - g ...',
      '  paused at gate id-3 (approval)',
      '',
    ],
    err: [''],
    observedExit: 3,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.--secret-inputs-stdin without a declared secret': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: '--secret-inputs-stdin requires a declared secret input.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a credential-shaped literal is not scanned before the inputs are admitted': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: "input 'n' must be a decimal number.",
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a granted tool the run path does not wire is refused before any key is resolved': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'node `a`.tools: web_search needs a host capability this run path does not provide \u2014 remove the grant to run this workflow here',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a malformed --input comes before the configuration and the workflow are read': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: '--input must be key=value.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a required secret that stdin does not supply': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: "missing required secret input 'token'; use --secret-inputs-stdin.",
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a secret given as an ordinary --input': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'secret inputs cannot be supplied with --input; use --secret-inputs-stdin.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a secret given as an ordinary --input is refused before stdin is read': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'secret inputs cannot be supplied with --input; use --secret-inputs-stdin.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a value of the wrong type': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: "input 'n' must be a decimal number.",
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a workflow that does not exist': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        "workflow 'missing.relavium.yaml' not found \u2014 looked for: missing.relavium.yaml.",
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.a workflow that does not parse': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'Flow sequence in block collection must be sufficiently indented and end with a ]',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.an undeclared --input name': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'unknown input in --input.',
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.missing-key': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        "no API key for provider 'anthropic' \u2014 store one with `relavium provider set-key anthropic` or set RELAVIUM_ANTHROPIC_API_KEY.",
    },
    out: [''],
    err: [''],
    observedExit: 2,
    activeOwners: 0,
    closes: 0,
  },
  'run.refusal.the filesystem-root refusal comes before a malformed --input and a missing workflow':
    {
      result: {
        code: 'invalid_invocation',
        exitCode: 2,
        message: '--allow-fs-root applies only to Home, chat, chat-resume and agent run.',
      },
      out: [''],
      err: [''],
      observedExit: 2,
      activeOwners: 0,
      closes: 0,
    },
  'run.secret-stdin.json': {
    result: 0,
    out: [
      '{"type":"run:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":true,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":0,"workflowId":"<uuid-2>","inputs":{"n":3,"token":{"secret":true,"ref":"inputs.token"}},"executionMode":"local"}',
      '{"basis":"complete","type":"cost:coverage_started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"timestamp":"<ts>","sequenceNumber":1}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":2,"nodeId":"start","nodeType":"input"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":3,"nodeId":"start","output":{"n":3,"token":{"secret":true,"ref":"inputs.token"}},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":4,"nodeId":"double","nodeType":"transform"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":5,"nodeId":"double","output":{"d":6},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"node:started","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":6,"nodeId":"out","nodeType":"output"}',
      '{"type":"node:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":7,"nodeId":"out","output":{"d":6},"tokensUsed":{"input":0,"output":0},"durationMs":<ms>,"toolActivity":[]}',
      '{"type":"run:completed","runId":"<uuid-1>","cumulativeCostMicrocents":0,"cumulativeUnpricedCalls":0,"usageCoverage":{"unverified":false,"pendingInvocations":0,"unknownCalls":0},"timestamp":"<ts>","sequenceNumber":8,"outputs":{"out":{"d":6}},"totalTokensUsed":{"input":0,"output":0},"totalCostMicrocents":0,"durationMs":<ms>}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'run.secret-stdin.plain': {
    result: 0,
    out: [
      '> run <uuid-1> started',
      '  - start ...',
      '  ok start',
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
  },
  'run.snapshot-warning.plain': {
    result: 0,
    out: [
      '> run id-2 started',
      '  - start ...',
      '  ok start',
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [
      'Warning: authored definition has 1 string(s) matching known credential shapes. Authored content is preserved in files and run snapshots; review literals before sharing or running. This check is best effort.',
      '',
    ],
    observedExit: 0,
    activeOwners: 0,
    closes: 0,
  },
  // -------------------------------------------------------------------------------------------------
  // Round-1 additions (MVP-8 step 2): a stop during a resume, a release that never settles, and
  // `--allow-mcp-stdio` on a resume. Recorded from the committed code (after the extraction), then verified
  // to fail under a deliberate mutation of the path each covers.
  // -------------------------------------------------------------------------------------------------
  'budget.allow-mcp-stdio.allowed': {
    result: 0,
    out: [
      '  - agent ...',
      '  ok agent',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: ANSWER',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
    order: ['spawn'],
  },
  'budget.allow-mcp-stdio.refused': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'this run would start 1 local program(s) not approved on this machine (listed above). Approve them interactively, or pass --allow-mcp-stdio <digest> for each \u2014 the digest is a hash of the declaration, not a secret.',
    },
    out: [''],
    err: ['  local: <node>  <digest>', ''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
    order: [],
  },
  'gate.allow-mcp-stdio.allowed': {
    result: 0,
    out: [
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: [''],
    observedExit: 0,
    activeOwners: 0,
    closes: 1,
    prompts: [],
    promptBindings: [],
    order: ['spawn'],
  },
  'gate.allow-mcp-stdio.refused': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'this run would start 1 local program(s) not approved on this machine (listed above). Approve them interactively, or pass --allow-mcp-stdio <digest> for each \u2014 the digest is a hash of the declaration, not a secret.',
    },
    out: [''],
    err: ['  local: <node>  <digest>', ''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
    prompts: [],
    promptBindings: [],
    order: [],
  },
  // Round-2 additions (MVP-8 step 2): a well-formed digest that names no declaration is refused like no flag.
  // Recorded from the committed code and verified to fail when the allowed-digest list accepts any digest.
  'budget.allow-mcp-stdio.wrong-digest': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'this run would start 1 local program(s) not approved on this machine (listed above). Approve them interactively, or pass --allow-mcp-stdio <digest> for each \u2014 the digest is a hash of the declaration, not a secret.',
    },
    out: [''],
    err: ['  local: <node>  <digest>', ''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
    order: [],
  },
  'gate.allow-mcp-stdio.wrong-digest': {
    result: {
      code: 'invalid_invocation',
      exitCode: 2,
      message:
        'this run would start 1 local program(s) not approved on this machine (listed above). Approve them interactively, or pass --allow-mcp-stdio <digest> for each \u2014 the digest is a hash of the declaration, not a secret.',
    },
    out: [''],
    err: ['  local: <node>  <digest>', ''],
    observedExit: 2,
    activeOwners: 0,
    closes: 1,
    prompts: [],
    promptBindings: [],
    order: [],
  },
  'gate.stop.engine': {
    result: 1,
    out: [''],
    err: ['resume interrupted before a decision was recorded; the gate remains pending', ''],
    observedExit: 1,
    activeOwners: 0,
    closes: 1,
    order: ['keys', 'mcp', 'engine', 'sigint', 'mcp-close', 'history-close'],
  },
  'gate.stop.keys': {
    result: 1,
    out: [''],
    err: ['resume interrupted before a decision was recorded; the gate remains pending', ''],
    observedExit: 1,
    activeOwners: 0,
    closes: 1,
    order: ['keys', 'sigint', 'history-close'],
  },
};

/** The same, for a command that hangs on an unacknowledged MCP release. */
const EXPECTED_HANG: Readonly<Record<string, Hung>> = {
  'gate.mcp-release-hang': {
    settled: false,
    out: [
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: ['warning: MCP teardown failed', ''],
    closes: 0,
    activeOwners: 1,
    boundExit: 9,
    exitCalls: [9],
    settledAfterBound: false,
    closesAfterBound: 0,
    activeOwnersAfterBound: 1,
  },
  'run.mcp-release-hang': {
    settled: false,
    out: [
      '> run <uuid-1> started',
      '  - start ...',
      '  ok start',
      '  - double ...',
      '  ok double',
      '  - out ...',
      '  ok out',
      'done: run completed',
      '  outputs:',
      '    out: {"d":6}',
      '',
    ],
    err: ['warning: MCP teardown failed', ''],
    closes: 0,
    activeOwners: 1,
    boundExit: 9,
    exitCalls: [9],
    settledAfterBound: false,
    closesAfterBound: 0,
    activeOwnersAfterBound: 1,
  },
};

function expectObserved(name: string, observed: Observed): void {
  expect(observed, name).toEqual(EXPECTED[name]);
}

function expectHung(name: string, hung: Hung): void {
  expect(hung, name).toEqual(EXPECTED_HANG[name]);
}

describe('run core characterization — relavium run', () => {
  describe.each([false, true])('json=%s', (json) => {
    const tag = json ? 'json' : 'plain';

    it('a completed run', async () => {
      const path = writeWorkflow('happy.relavium.yaml', HAPPY);
      const h = createHarness();
      expectObserved(
        `run.completed.${tag}`,
        await h.observe((io, invocation) =>
          runCommand(
            { workflow: path, input: ['n=3'], allowMcpStdio: [] },
            { io, invocation, ...inMemoryRun(json) },
          ),
        ),
      );
    });

    it('a run that fails', async () => {
      const path = writeWorkflow('failing.relavium.yaml', FAILING);
      const h = createHarness();
      expectObserved(
        `run.failed.${tag}`,
        await h.observe((io, invocation) =>
          runCommand(
            { workflow: path, input: [], allowMcpStdio: [] },
            { io, invocation, ...inMemoryRun(json) },
          ),
        ),
      );
    });

    it('a run that pauses at a human gate and exits 3 with no prompter', async () => {
      const path = writeWorkflow('gated.relavium.yaml', GATED);
      const h = createHarness();
      expectObserved(
        `run.paused.${tag}`,
        await h.observe((io, invocation) =>
          runCommand(
            { workflow: path, input: ['n=3'], allowMcpStdio: [] },
            { io, invocation, ...inMemoryRun(json) },
          ),
        ),
      );
    });

    it('a run whose secret input arrives on stdin, through the real reader', async () => {
      const path = writeWorkflow('secret.relavium.yaml', SECRET_RUN);
      const h = createHarness();
      const observed = await h.observe(
        (io, invocation) =>
          runCommand(
            { workflow: path, input: ['n=3'], allowMcpStdio: [], secretInputsStdin: true },
            { io, invocation, ...durableRun(json) },
          ),
        pipedStdin(`token=${SECRET_VALUE}\n`),
      );
      expect(JSON.stringify(observed), 'the secret never reaches either stream').not.toContain(
        SECRET_VALUE,
      );
      expectObserved(`run.secret-stdin.${tag}`, observed);
    });

    it('a run paused at a human gate, answered by `gate --approve`', async () => {
      const path = writeWorkflow('gated.relavium.yaml', GATED);
      const h = createHarness();
      const started = await h.observe((io, invocation) =>
        runCommand(
          { workflow: path, input: ['n=3'], allowMcpStdio: [] },
          { io, invocation, ...durableRun(json) },
        ),
      );
      const resumed = await h.observe((io, invocation) =>
        gateCommand({ runId: lastRunId(), approve: true }, gateDeps(io, invocation, json)),
      );
      expectObserved(`gate.approve.start.${tag}`, started);
      expectObserved(`gate.approve.resume.${tag}`, resumed);
    });

    it('a doubled `gate --approve` is a clean no-op', async () => {
      const path = writeWorkflow('gated.relavium.yaml', GATED);
      const h = createHarness();
      await h.observe((io, invocation) =>
        runCommand(
          { workflow: path, input: ['n=3'], allowMcpStdio: [] },
          { io, invocation, ...durableRun(json) },
        ),
      );
      const runId = lastRunId();
      await h.observe((io, invocation) =>
        gateCommand({ runId, approve: true }, gateDeps(io, invocation, json)),
      );
      const second = await h.observe((io, invocation) =>
        gateCommand({ runId, approve: true }, gateDeps(io, invocation, json)),
      );
      expectObserved(`gate.doubled.${tag}`, second);
    });

    it('a secret-bearing run paused at a gate, answered with the secret re-supplied on stdin', async () => {
      const path = writeWorkflow('gated-secret.relavium.yaml', GATED_SECRET);
      const h = createHarness();
      const started = await h.observe(
        (io, invocation) =>
          runCommand(
            { workflow: path, input: ['n=3'], allowMcpStdio: [], secretInputsStdin: true },
            { io, invocation, ...durableRun(json) },
          ),
        pipedStdin(`api_key=${SECRET_VALUE}\n`),
      );
      const resumed = await h.observe(
        (io, invocation) =>
          gateCommand(
            { runId: lastRunId(), approve: true, secretStdin: true },
            gateDeps(io, invocation, json),
          ),
        pipedStdin(`api_key=${SECRET_VALUE}\n`),
      );
      expect(JSON.stringify([started, resumed]), 'the secret never reaches a stream').not.toContain(
        SECRET_VALUE,
      );
      expectObserved(`gate.secret.start.${tag}`, started);
      expectObserved(`gate.secret.resume.${tag}`, resumed);
    });
  });

  it('a gate answered by --reject with a comment continues the run (plain)', async () => {
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const h = createHarness();
    await h.observe((io, invocation) =>
      runCommand(
        { workflow: path, input: ['n=3'], allowMcpStdio: [] },
        { io, invocation, ...durableRun(false) },
      ),
    );
    expectObserved(
      'gate.reject.plain',
      await h.observe((io, invocation) =>
        gateCommand(
          { runId: lastRunId(), reject: true, comment: 'not now' },
          gateDeps(io, invocation, false),
        ),
      ),
    );
  });
});

describe('run core characterization — the order in which relavium run refuses', () => {
  const cases: readonly {
    readonly name: string;
    readonly yaml?: string;
    readonly input?: readonly string[];
    readonly workflow?: string;
    readonly allowFsRoots?: readonly string[];
    readonly stdin?: boolean;
    /** The refusal precedes the stdin read, so the injected reader is never called. */
    readonly noRead?: boolean;
  }[] = [
    {
      name: 'the filesystem-root refusal comes before a malformed --input and a missing workflow',
      workflow: 'missing.relavium.yaml',
      input: ['malformed'],
      allowFsRoots: ['/somewhere'],
    },
    {
      name: 'a malformed --input comes before the configuration and the workflow are read',
      workflow: 'missing.relavium.yaml',
      input: ['malformed'],
    },
    { name: 'a workflow that does not exist', workflow: 'missing.relavium.yaml' },
    { name: 'a workflow that does not parse', yaml: 'not: [a workflow' },
    { name: 'an undeclared --input name', yaml: HAPPY, input: ['nope=1'] },
    { name: 'a value of the wrong type', yaml: HAPPY, input: ['n=abc'] },
    {
      name: 'a required secret that stdin does not supply',
      yaml: SECRET_RUN,
      input: ['n=1'],
      stdin: true,
    },
    { name: 'a secret given as an ordinary --input', yaml: SECRET_RUN, input: ['n=1', 'token=x'] },
    {
      name: 'a secret given as an ordinary --input is refused before stdin is read',
      yaml: SECRET_RUN,
      input: ['n=1', 'token=x'],
      stdin: true,
      noRead: true,
    },
    {
      name: 'a credential-shaped literal is not scanned before the inputs are admitted',
      yaml: WITH_LITERAL(HAPPY),
      input: ['n=bad'],
    },
    {
      name: 'a granted tool the run path does not wire is refused before any key is resolved',
      yaml: UNWIRED_TOOL,
    },
    {
      name: '--secret-inputs-stdin without a declared secret',
      yaml: HAPPY,
      input: ['n=1'],
      stdin: true,
    },
  ];

  it.each(cases)('$name', async ({ name, yaml, input, workflow, allowFsRoots, stdin, noRead }) => {
    const path = workflow ?? writeWorkflow('refusal.relavium.yaml', yaml ?? HAPPY);
    const h = createHarness();
    const readSecretInput = vi.fn(() => Promise.resolve(''));
    const resolveKeys = vi.fn(() => ({
      providers: createProviderResolver({}),
      mcpSecretResolver: () => 'unused',
    }));
    const buildEngineSpy = vi.fn(() => buildEngine({ host: createInMemoryHost() }));
    const observed = await h.observe((io, invocation) =>
      runCommand(
        {
          workflow: path,
          input: input ?? [],
          allowMcpStdio: [],
          secretInputsStdin: stdin === true,
        },
        {
          io,
          invocation,
          global: {
            ...globalOptions(false),
            ...(allowFsRoots === undefined ? {} : { allowFsRoots }),
          },
          buildEngine: buildEngineSpy,
          readSecretInput,
          resolveKeys,
        },
      ),
    );
    expect(buildEngineSpy, 'a refusal never reaches the engine build').not.toHaveBeenCalled();
    expect(resolveKeys, 'a refusal needs no key').not.toHaveBeenCalled();
    if (noRead === true) expect(readSecretInput).not.toHaveBeenCalled();
    expectObserved(
      `run.refusal.${name}`,
      // The refusal messages name the temporary workflow path; the root differs on every run.
      scrubObserved(observed, (text) => text.split(root).join('<root>')),
    );
  });
});

describe('run core characterization — gate refusals, in the order they are raised', () => {
  async function pause(yaml: string, input: readonly string[], stdin?: string): Promise<string> {
    const path = writeWorkflow('paused.relavium.yaml', yaml);
    const h = createHarness();
    await h.observe(
      (io, invocation) =>
        runCommand(
          {
            workflow: path,
            input,
            allowMcpStdio: [],
            ...(stdin === undefined ? {} : { secretInputsStdin: true }),
          },
          { io, invocation, ...durableRun(false) },
        ),
      stdin === undefined ? undefined : pipedStdin(stdin),
    );
    return lastRunId();
  }

  it('an unknown run id', async () => {
    const h = createHarness();
    expectObserved(
      'gate.refusal.unknown-run',
      await h.observe((io, invocation) =>
        gateCommand({ runId: 'no-such-run', approve: true }, gateDeps(io, invocation, false)),
      ),
    );
  });

  it('more than one pending gate without --gate, then a gate id that is not pending', async () => {
    const runId = await pause(TWO_GATES, []);
    const h = createHarness();
    expectObserved(
      'gate.refusal.ambiguous',
      await h.observe((io, invocation) =>
        gateCommand({ runId, approve: true }, gateDeps(io, invocation, false)),
      ),
    );
    expectObserved(
      'gate.refusal.unknown-gate',
      await h.observe((io, invocation) =>
        gateCommand({ runId, approve: true, gate: 'not-a-gate' }, gateDeps(io, invocation, false)),
      ),
    );
  });

  it('a decision the gate type does not accept refuses before the engine is built', async () => {
    const runId = await pause(INPUT_GATED, []);
    const h = createHarness();
    const buildEngineSpy = vi.fn(() => buildEngine({ host: createInMemoryHost() }));
    expectObserved(
      'gate.refusal.decision-fit',
      await h.observe((io, invocation) =>
        gateCommand(
          { runId, approve: true },
          { ...gateDeps(io, invocation, false), buildEngine: buildEngineSpy },
        ),
      ),
    );
    expect(buildEngineSpy).not.toHaveBeenCalled();
  });

  it('a secret-bearing run needs its secret before any service is built', async () => {
    const runId = await pause(GATED_SECRET, ['n=1'], `api_key=${SECRET_VALUE}\n`);
    const h = createHarness();
    const resolveKeys = vi.fn(() => {
      throw new Error('keys must not be resolved before the secrets are supplied');
    });
    expectObserved(
      'gate.refusal.secret-required',
      await h.observe((io, invocation) =>
        gateCommand({ runId, approve: true }, { ...gateDeps(io, invocation, false), resolveKeys }),
      ),
    );
    expect(resolveKeys).not.toHaveBeenCalled();
  });

  it.each([
    ['missing-slot', 'n=7\n'],
    ['unknown-name', `api_key=${SECRET_VALUE}\nother=x\n`],
    ['empty-value', 'api_key=\n'],
  ])('a stdin payload that does not fit the run (%s)', async (label, payload) => {
    const runId = await pause(GATED_SECRET, ['n=1'], `api_key=${SECRET_VALUE}\n`);
    const h = createHarness();
    expectObserved(
      `gate.refusal.secret-${label}`,
      await h.observe(
        (io, invocation) =>
          gateCommand({ runId, approve: true, secretStdin: true }, gateDeps(io, invocation, false)),
        pipedStdin(payload),
      ),
    );
  });

  it('--secret-stdin on a run with no secrets reads nothing', async () => {
    const runId = await pause(GATED, ['n=1']);
    const h = createHarness();
    const readSecretInput = vi.fn(() => Promise.resolve(''));
    expectObserved(
      'gate.refusal.secret-not-needed',
      await h.observe((io, invocation) =>
        gateCommand(
          { runId, approve: true, secretStdin: true },
          { ...gateDeps(io, invocation, false), readSecretInput },
        ),
      ),
    );
    expect(readSecretInput).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
// relavium budget resume: a budget gate raised by a real engine run, answered through the command.
// ---------------------------------------------------------------------------------------------------

const MODEL = 'offline-core-characterization';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 100000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};

describe('run core characterization — relavium budget resume', () => {
  let prices: Map<string, ModelPricing>;
  let generated: number;
  let keyReads: number;
  let factories: number;
  beforeEach(() => {
    prices = new Map([[MODEL, PRICE]]);
    generated = 0;
    keyReads = 0;
    factories = 0;
  });

  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    generate: () => Promise.reject(new Error('unexpected generate')),
    stream: async function* () {
      await Promise.resolve();
      generated++;
      yield { type: 'text_delta', text: 'ANSWER' };
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
      };
    },
  };
  const providers = () => ({
    resolveProvider: () => provider,
    keyFor: () => {
      keyReads++;
      return 'offline-key';
    },
    endpointKind: () => 'custom' as const,
  });

  function persistPrice(price: ModelPricing): void {
    const storeDeps = { uuid: randomUUID, now: Date.now };
    const providerId = createProviderStore(client.db, storeDeps).upsert({
      name: 'openai',
      displayName: 'Offline fixture',
      baseUrl: 'https://offline.example.invalid/v1',
    }).id;
    createModelCatalogStore(client.db, storeDeps).upsert({
      providerId,
      modelId: price.nativeId,
      displayName: price.displayName,
      source: 'user',
      contextWindowTokens: price.contextWindowTokens,
      maxOutputTokens: price.maxOutputTokens,
      inputCostPerMtokMicrocents: price.inputPerMtokMicrocents,
      outputCostPerMtokMicrocents: price.outputPerMtokMicrocents,
      cachedInputCostPerMtokMicrocents: price.cachedInputPerMtokMicrocents,
    });
  }

  /** Run a one-agent workflow to its budget gate (cap 1 microcent, pause for approval). */
  async function seed(agentExtra = ''): Promise<{ runId: string; gateId: string; amount: number }> {
    persistPrice(PRICE);
    const workflow = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: budget-command\n  budget: {max_cost_microcents: 1, on_exceed: pause_for_approval, strict_cost_cap: true}\n  agents:\n    - {id: worker, model: ${MODEL}, provider: openai, system_prompt: go${agentExtra}}\n  nodes:\n    - {id: agent, type: agent, agent_ref: worker, prompt_template: hello, max_tokens: 64}\n    - {id: out, type: output}\n  edges:\n    - {from: agent, to: out}\n`,
    );
    const store = createRunHistoryStore(client.db, {
      uuid: randomUUID,
      now: Date.now,
      projectRoot: root,
      workflow: {
        slug: workflow.workflow.id,
        name: 'Budget command',
        definitionJson: JSON.stringify(workflow),
      },
    });
    const engine = await buildEngine({
      host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
      resolvePrice: prices,
      providers: providers(),
    });
    const handle = engine.start({ workflow, inputs: {} });
    let gateId: string | undefined;
    let amount: number | undefined;
    for await (const event of handle.events) {
      if (event.type === 'budget:authorization' && event.authorization.state === 'paused') {
        gateId = event.gateId;
        const allowance = event.authorization.allowance;
        if (
          allowance.kind === 'frozen' &&
          allowance.quote.kind === 'quoted' &&
          allowance.quote.quote.amount.kind === 'representable'
        )
          amount = allowance.quote.quote.amount.microcents;
      }
      if (event.type === 'run:paused') break;
    }
    if (gateId === undefined || amount === undefined)
      throw new Error('the producer did not pause with a frozen amount');
    expect(generated).toBe(0);
    return { runId: handle.runId, gateId, amount };
  }

  function budgetDeps(io: CliIo, invocation: CliInvocation, json: boolean): GateCommandDeps {
    return {
      io,
      invocation,
      global: globalOptions(json),
      openDb: () => ({ db: client.db, close: countClose }),
      resolveKeys: () => {
        factories++;
        return {
          providers: providers(),
          mcpSecretResolver: () => {
            throw new Error('unexpected MCP secret');
          },
        };
      },
      buildEngine: (options) => buildEngine({ ...options, resolvePrice: prices }),
    };
  }

  describe.each([false, true])('json=%s', (json) => {
    const tag = json ? 'json' : 'plain';

    it('a budget gate answered with --approve-amount', async () => {
      const paused = await seed();
      const h = createHarness();
      expectObserved(
        `budget.approve.${tag}`,
        await h.observe((io, invocation) =>
          budgetCommand(
            { runId: paused.runId, approveAmount: String(paused.amount) },
            budgetDeps(io, invocation, json),
          ),
        ),
      );
      expect(generated).toBe(1);
      expect(keyReads).toBe(1);
      expect(factories, 'an approval builds the key resolvers once').toBe(1);
    });

    it('a budget gate aborted with --abort', async () => {
      const paused = await seed();
      const h = createHarness();
      expectObserved(
        `budget.abort.${tag}`,
        await h.observe((io, invocation) =>
          budgetCommand({ runId: paused.runId, abort: true }, budgetDeps(io, invocation, json)),
        ),
      );
      expect(generated).toBe(0);
      expect(keyReads).toBe(0);
      expect(factories, 'an abort never builds the key resolvers').toBe(0);
    });
  });

  it('refuses a wrong amount and a moved price before any key, engine or decision', async () => {
    const paused = await seed();
    const h = createHarness();
    expectObserved(
      'budget.refusal.amount',
      await h.observe((io, invocation) =>
        budgetCommand(
          { runId: paused.runId, approveAmount: String(paused.amount + 1) },
          budgetDeps(io, invocation, false),
        ),
      ),
    );
    prices.set(MODEL, { ...PRICE, inputPerMtokMicrocents: 2000000 });
    persistPrice({ ...PRICE, inputPerMtokMicrocents: 2000000 });
    expectObserved(
      'budget.refusal.price',
      await h.observe((io, invocation) =>
        budgetCommand(
          { runId: paused.runId, approveAmount: String(paused.amount) },
          budgetDeps(io, invocation, false),
        ),
      ),
    );
    expect(generated).toBe(0);
    expect(keyReads).toBe(0);
    expect(factories, 'a refusal builds no key resolver').toBe(0);
  });

  describe('--allow-mcp-stdio on a budget resume, with no terminal to ask', () => {
    const declaresServer = `, mcp_servers: [{id: local, transport: stdio, command: ${JSON.stringify(process.execPath)}}]`;

    it('the matching digest lets the approved resume spawn the server and finish, with no prompt', async () => {
      const paused = await seed(declaresServer);
      const allowed = await localDigest(root);
      const startMcpClient = vi.fn(() => realStartMcpClient([]));
      const h = createHarness();
      const observed = await h.observe((io, invocation) =>
        budgetCommand(
          { runId: paused.runId, approveAmount: String(paused.amount), allowMcpStdio: [allowed] },
          { ...budgetDeps(io, invocation, false), startMcpClient },
        ),
      );
      expect(startMcpClient).toHaveBeenCalledOnce();
      expect(generated, 'the approved agent ran once').toBe(1);
      expectObserved('budget.allow-mcp-stdio.allowed', {
        ...scrubObserved(observed, scrubConsent),
        order: startMcpClient.mock.calls.map(() => 'spawn'),
      });
    });

    it('the same resume without the flag is refused, spawns nothing and dispatches nothing', async () => {
      const paused = await seed(declaresServer);
      const startMcpClient = vi.fn(() => realStartMcpClient([]));
      const h = createHarness();
      const observed = await h.observe((io, invocation) =>
        budgetCommand(
          { runId: paused.runId, approveAmount: String(paused.amount) },
          { ...budgetDeps(io, invocation, false), startMcpClient },
        ),
      );
      expect(startMcpClient).not.toHaveBeenCalled();
      expect(generated, 'a refused resume dispatches no agent').toBe(0);
      expectObserved('budget.allow-mcp-stdio.refused', {
        ...scrubObserved(observed, scrubConsent),
        order: startMcpClient.mock.calls.map(() => 'spawn'),
      });
    });

    it('a digest that names no declaration is refused like no flag: nothing spawns, the expected digest is listed', async () => {
      const paused = await seed(declaresServer);
      const startMcpClient = vi.fn(() => realStartMcpClient([]));
      const h = createHarness();
      const observed = await h.observe((io, invocation) =>
        budgetCommand(
          {
            runId: paused.runId,
            approveAmount: String(paused.amount),
            allowMcpStdio: [WRONG_DIGEST],
          },
          { ...budgetDeps(io, invocation, false), startMcpClient },
        ),
      );
      expect(startMcpClient).not.toHaveBeenCalled();
      expect(generated, 'a refused resume dispatches no agent').toBe(0);
      const listed = observed.err.join('\n');
      expect(listed, 'the digest to pass is listed').toContain(await localDigest(root));
      expect(listed, 'the wrong digest is not what is listed').not.toContain(WRONG_DIGEST);
      expectObserved('budget.allow-mcp-stdio.wrong-digest', {
        ...scrubObserved(observed, scrubConsent),
        order: startMcpClient.mock.calls.map(() => 'spawn'),
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// The MCP stdio consent prompt: what is asked, on which io, and what a refusal says.
// ---------------------------------------------------------------------------------------------------

describe('run core characterization — the MCP consent prompt', () => {
  const MCP_GATED = GATED.replace(
    '  nodes:',
    `  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: []
      mcp_servers:
        - { id: local, transport: stdio, command: ${JSON.stringify(process.execPath)} }
  nodes:`,
  );

  beforeEach(() => {
    consentPrompt.mockReset();
    consentPrompt.mockImplementation(() => Promise.resolve(false));
    consentBinds.mockReset();
  });

  /** Interactive-looking metadata, so a prompt is only skipped for the reason under test. */
  const interactive =
    (stdin?: string) =>
    (io: CliIo): CliIo => ({
      ...io,
      stdinIsTty: true,
      stdoutIsTty: true,
      env: {},
      ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) }),
    });

  const scrub = (text: string): string =>
    text
      .split(`/private${root}`)
      .join('<root>')
      .split(root)
      .join('<root>')
      .split(process.execPath)
      .join('<node>')
      .replace(/v1:[0-9a-f]{64}/g, '<digest>');

  function withPrompts(observed: Observed, normalize: (text: string) => string): Observed {
    return {
      ...scrubObserved(observed, scrub),
      prompts: consentPrompt.mock.calls.map((call) => {
        const options: unknown = call[1];
        const signal = typeof options === 'object' && options !== null && 'signal' in options;
        return normalize(scrub(JSON.stringify({ subject: call[0], hasSignal: signal })));
      }),
      promptBindings: consentBinds.mock.calls.map((call) => {
        const bound = call[0];
        const tty = (key: string): unknown =>
          typeof bound === 'object' && bound !== null ? Reflect.get(bound, key) : undefined;
        return `stdinIsTty=${String(tty('stdinIsTty'))} stdoutIsTty=${String(tty('stdoutIsTty'))}`;
      }),
    };
  }

  const plainRenderer = (io: CliIo): ReturnType<typeof createPlainRenderer> =>
    createPlainRenderer(io);

  async function digest(): Promise<string> {
    return fingerprint(
      await resolveStdioSpawn(
        { serverId: 'local', command: process.execPath, provenance: { kind: 'inline' } },
        root,
      ),
    );
  }

  it('asks once on an interactive run and refuses when the answer is no', async () => {
    const path = writeWorkflow('mcp-gated.relavium.yaml', MCP_GATED);
    const h = createHarness();
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const observed = await h.observe(
      (io, invocation) =>
        runCommand(
          { workflow: path, input: ['n=3'], allowMcpStdio: [] },
          {
            io,
            invocation,
            ...durableRun(false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      interactive(),
    );
    expect(startMcpClient).not.toHaveBeenCalled();
    expectObserved('consent.run.refused', withPrompts(observed, h.normalize));
  });

  it('asks nothing when stdin was consumed for secrets, despite TTY metadata', async () => {
    const path = writeWorkflow(
      'mcp-secret.relavium.yaml',
      MCP_GATED.replace('  id: gate-resume', '  id: gate-resume-secret').replace(
        '    - { name: n, type: number }',
        '    - { name: n, type: number }\n    - { name: api_key, type: secret }',
      ),
    );
    const h = createHarness();
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const observed = await h.observe(
      (io, invocation) =>
        runCommand(
          { workflow: path, input: ['n=3'], allowMcpStdio: [], secretInputsStdin: true },
          {
            io,
            invocation,
            ...durableRun(false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      interactive(`api_key=${SECRET_VALUE}\n`),
    );
    expect(startMcpClient).not.toHaveBeenCalled();
    expectObserved('consent.run.secret-stdin', withPrompts(observed, h.normalize));
  });

  it('an explicit digest starts the client without a prompt, and the resume then asks and is approved', async () => {
    const path = writeWorkflow('mcp-gated.relavium.yaml', MCP_GATED);
    const h = createHarness();
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const allowed = await digest();
    const started = await h.observe(
      (io, invocation) =>
        runCommand(
          { workflow: path, input: ['n=3'], allowMcpStdio: [allowed] },
          {
            io,
            invocation,
            ...durableRun(false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      interactive(),
    );
    expect(startMcpClient).toHaveBeenCalledOnce();
    expectObserved('consent.run.explicit-digest', withPrompts(started, h.normalize));

    consentPrompt.mockReset();
    consentPrompt.mockImplementation(() => Promise.resolve(true));
    consentBinds.mockReset();
    const resumed = await h.observe(
      (io, invocation) =>
        gateCommand(
          { runId: lastRunId(), approve: true },
          {
            ...gateDeps(io, invocation, false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      interactive(),
    );
    expect(startMcpClient).toHaveBeenCalledTimes(2);
    expectObserved('consent.gate.approved', withPrompts(resumed, h.normalize));
  });

  it('a resume that consumed stdin for secrets asks nothing and refuses an unapproved server', async () => {
    const path = writeWorkflow(
      'mcp-secret.relavium.yaml',
      MCP_GATED.replace('  id: gate-resume', '  id: gate-resume-secret').replace(
        '    - { name: n, type: number }',
        '    - { name: n, type: number }\n    - { name: api_key, type: secret }',
      ),
    );
    const h = createHarness();
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const allowed = await digest();
    await h.observe(
      (io, invocation) =>
        runCommand(
          { workflow: path, input: ['n=3'], allowMcpStdio: [allowed], secretInputsStdin: true },
          {
            io,
            invocation,
            ...durableRun(false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      interactive(`api_key=${SECRET_VALUE}\n`),
    );
    consentPrompt.mockClear();
    consentBinds.mockClear();
    const resumed = await h.observe(
      (io, invocation) =>
        gateCommand(
          { runId: lastRunId(), approve: true, secretStdin: true },
          {
            ...gateDeps(io, invocation, false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      interactive(`api_key=${SECRET_VALUE}\n`),
    );
    expectObserved('consent.gate.secret-stdin', withPrompts(resumed, h.normalize));
  });

  describe('--allow-mcp-stdio on a gate resume, with no terminal to ask', () => {
    /** Park a run whose one stdio server was authorized for the start, so only the resume is under test. */
    async function parked(
      h: Harness,
      startMcpClient: NonNullable<RunCommandDeps['startMcpClient']>,
    ) {
      const path = writeWorkflow('mcp-gated.relavium.yaml', MCP_GATED);
      const allowed = await localDigest(root);
      await h.observe((io, invocation) =>
        runCommand(
          { workflow: path, input: ['n=3'], allowMcpStdio: [allowed] },
          {
            io,
            invocation,
            ...durableRun(false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      );
      return { runId: lastRunId(), allowed };
    }

    it('the matching digest lets the resume spawn the server and finish, with no prompt', async () => {
      const h = createHarness();
      const startMcpClient = vi.fn(() => realStartMcpClient([]));
      const { runId, allowed } = await parked(h, startMcpClient);
      startMcpClient.mockClear();
      const observed = await h.observe((io, invocation) =>
        gateCommand(
          { runId, approve: true, allowMcpStdio: [allowed] },
          {
            ...gateDeps(io, invocation, false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      );
      expect(startMcpClient).toHaveBeenCalledOnce();
      expectObserved('gate.allow-mcp-stdio.allowed', {
        ...withPrompts(observed, h.normalize),
        order: startMcpClient.mock.calls.map(() => 'spawn'),
      });
    });

    it('the same resume without the flag is refused and spawns nothing', async () => {
      const h = createHarness();
      const startMcpClient = vi.fn(() => realStartMcpClient([]));
      const { runId } = await parked(h, startMcpClient);
      startMcpClient.mockClear();
      const observed = await h.observe((io, invocation) =>
        gateCommand(
          { runId, approve: true },
          {
            ...gateDeps(io, invocation, false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      );
      expect(startMcpClient).not.toHaveBeenCalled();
      expectObserved('gate.allow-mcp-stdio.refused', {
        ...withPrompts(observed, h.normalize),
        order: startMcpClient.mock.calls.map(() => 'spawn'),
      });
    });

    it('a digest that names no declaration is refused like no flag: nothing spawns, the expected digest is listed', async () => {
      const h = createHarness();
      const startMcpClient = vi.fn(() => realStartMcpClient([]));
      const { runId, allowed } = await parked(h, startMcpClient);
      startMcpClient.mockClear();
      const observed = await h.observe((io, invocation) =>
        gateCommand(
          { runId, approve: true, allowMcpStdio: [WRONG_DIGEST] },
          {
            ...gateDeps(io, invocation, false),
            startMcpClient,
            selectRenderer: plainRenderer,
            selectGatePrompter: () => undefined,
          },
        ),
      );
      expect(startMcpClient).not.toHaveBeenCalled();
      const listed = observed.err.join('\n');
      expect(listed, 'the digest to pass is listed').toContain(allowed);
      expect(listed, 'the wrong digest is not what is listed').not.toContain(WRONG_DIGEST);
      expectObserved('gate.allow-mcp-stdio.wrong-digest', {
        ...withPrompts(observed, h.normalize),
        order: startMcpClient.mock.calls.map(() => 'spawn'),
      });
    });
  });
});

describe('run core characterization — a start and a resume that need no prompt', () => {
  it('a missing provider key is an exit-2 refusal before the engine is built', async () => {
    const path = writeWorkflow('needs-key.relavium.yaml', NEEDS_KEY);
    const h = createHarness();
    const buildEngineSpy = vi.fn(() => buildEngine({ host: createInMemoryHost() }));
    const observed = await h.observe((io, invocation) =>
      runCommand(
        { workflow: path, input: [], allowMcpStdio: [] },
        { io, invocation, global: globalOptions(false), buildEngine: buildEngineSpy },
      ),
    );
    expect(buildEngineSpy).not.toHaveBeenCalled();
    expectObserved(
      'run.refusal.missing-key',
      scrubObserved(observed, (text) => text.split(root).join('<root>')),
    );
  });

  it('warns once about an authored credential-shaped literal, on stderr, after admission', async () => {
    const path = writeWorkflow('literal.relavium.yaml', WITH_LITERAL(HAPPY));
    const h = createHarness();
    const observed = await h.observe((io, invocation) =>
      runCommand(
        { workflow: path, input: ['n=3'], allowMcpStdio: [] },
        { io, invocation, ...inMemoryRun(false) },
      ),
    );
    expect(JSON.stringify(observed), 'the literal itself is never echoed').not.toContain(
      AUTHORED_LITERAL,
    );
    expectObserved('run.snapshot-warning.plain', observed);
  });
});

describe('run core characterization — the sequence of a start and of a resume', () => {
  const MCP_AGENTS = `  agents:
    - id: scanner
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: inspect
      tools: [read_file]
      mcp_servers: [{ id: fs, transport: stdio, command: x }]
`;
  const toolsOf = (agent: object): unknown => {
    const tools: unknown = Reflect.get(agent, 'tools');
    return tools;
  };
  const withMcp = (yaml: string): string => yaml.replace('  nodes:', `${MCP_AGENTS}  nodes:`);

  /** One server `fs` with one tool; every start and every close is appended to `order`. */
  function recordingMcp(order: string[]): NonNullable<RunCommandDeps['startMcpClient']> {
    const connection: McpConnection = {
      listTools: () => Promise.resolve([{ name: 'read', inputSchema: { type: 'object' } }]),
      callTool: () =>
        Promise.resolve({ content: [{ type: 'text', text: 'unused' }], isError: false }),
      close: () => {
        order.push('mcp-close');
        return Promise.resolve();
      },
    };
    return () => {
      order.push('mcp');
      return realStartMcpClient([{ id: 'fs', open: () => Promise.resolve(connection) }]);
    };
  }

  it('a start: stdin, the notice, the keys, MCP, the history, the engine, the start — then the releases', async () => {
    const path = writeWorkflow('order.relavium.yaml', withMcp(WITH_LITERAL(SECRET_RUN)));
    const order: string[] = [];
    const h = createHarness();
    const observed = await h.observe((io, invocation) =>
      runCommand(
        { workflow: path, input: ['n=3'], allowMcpStdio: [], secretInputsStdin: true },
        {
          io: {
            ...io,
            writeErr: (text) => {
              if (text.startsWith('Warning: authored')) order.push('notice');
              io.writeErr(text);
            },
          },
          invocation,
          global: globalOptions(false),
          readSecretInput: () => {
            order.push('stdin');
            return Promise.resolve(`token=${SECRET_VALUE}`);
          },
          resolveKeys: () => {
            order.push('keys');
            return {
              providers: createProviderResolver({}),
              mcpSecretResolver: () => 'unused',
            };
          },
          consentGate: PASS_CONSENT,
          startMcpClient: recordingMcp(order),
          openRunStore: (workflow) => {
            order.push(`history:${JSON.stringify(workflow.workflow.agents?.map(toolsOf))}`);
            return openDurable(workflow, () => {
              order.push('history-close');
              countClose();
            });
          },
          buildEngine: async (options) => {
            order.push('engine');
            const engine = await buildEngine(options);
            const start = engine.start.bind(engine);
            vi.spyOn(engine, 'start').mockImplementation((input) => {
              order.push('start');
              return start(input);
            });
            return engine;
          },
        },
      ),
    );
    expect(JSON.stringify(observed)).not.toContain(SECRET_VALUE);
    expectObserved('run.order', { ...observed, order });
  });

  it('a resume: stdin, the keys, MCP, the engine, the resume — then the releases', async () => {
    const path = writeWorkflow('order-gate.relavium.yaml', withMcp(GATED_SECRET));
    const h = createHarness();
    await h.observe((io, invocation) =>
      runCommand(
        { workflow: path, input: ['n=3'], allowMcpStdio: [], secretInputsStdin: true },
        {
          io,
          invocation,
          ...durableRun(false),
          readSecretInput: () => Promise.resolve(`api_key=${SECRET_VALUE}`),
          consentGate: PASS_CONSENT,
          startMcpClient: recordingMcp([]),
        },
      ),
    );
    const runId = lastRunId();
    const order: string[] = [];
    const observed = await h.observe((io, invocation) =>
      gateCommand(
        { runId, approve: true, secretStdin: true },
        {
          ...gateDeps(io, invocation, false),
          openDb: () => ({
            db: client.db,
            close: () => {
              order.push('history-close');
              countClose();
            },
          }),
          readSecretInput: () => {
            order.push('stdin');
            return Promise.resolve(`api_key=${SECRET_VALUE}`);
          },
          resolveKeys: () => {
            order.push('keys');
            return {
              providers: createProviderResolver({}),
              mcpSecretResolver: () => 'unused',
            };
          },
          consentGate: PASS_CONSENT,
          startMcpClient: recordingMcp(order),
          buildEngine: async (options) => {
            order.push('engine');
            const engine = await buildEngine(options);
            const resume = engine.resumeFromCheckpoint.bind(engine);
            vi.spyOn(engine, 'resumeFromCheckpoint').mockImplementation((params) => {
              order.push('resume');
              return resume(params);
            });
            return engine;
          },
        },
      ),
    );
    expect(JSON.stringify(observed)).not.toContain(SECRET_VALUE);
    expectObserved('gate.order', { ...observed, order });
  });

  /** Park a run with one declared MCP server at its approval gate, ready for a resume. */
  async function pauseWithMcp(h: Harness): Promise<string> {
    const path = writeWorkflow('stop-gate.relavium.yaml', withMcp(GATED));
    await h.observe((io, invocation) =>
      runCommand(
        { workflow: path, input: ['n=3'], allowMcpStdio: [] },
        {
          io,
          invocation,
          ...durableRun(false),
          consentGate: PASS_CONSENT,
          startMcpClient: recordingMcp([]),
        },
      ),
    );
    return lastRunId();
  }

  it.each([
    {
      stage: 'keys',
      title: 'a SIGINT while a gate resume resolves its keys stops it before any MCP server starts',
    },
    {
      stage: 'engine',
      title:
        'a SIGINT while a gate resume builds its engine stops it, and the MCP servers and the history are released',
    },
  ] as const)('$title', async ({ stage }) => {
    const h = createHarness();
    const runId = await pauseWithMcp(h);
    const order: string[] = [];
    let interrupt: (signo: number) => void = () => {
      throw new Error('the resume never subscribed to signals');
    };
    const sigint = (): void => {
      order.push('sigint');
      interrupt(2);
    };
    const observed = await h.observe((io, invocation) =>
      gateCommand(
        { runId, approve: true },
        {
          ...gateDeps(io, invocation, false),
          subscribeSignals: (onSignal) => {
            interrupt = onSignal;
            return () => undefined;
          },
          openDb: () => ({
            db: client.db,
            close: () => {
              order.push('history-close');
              countClose();
            },
          }),
          resolveKeys: () => {
            order.push('keys');
            if (stage === 'keys') sigint();
            return { providers: createProviderResolver({}), mcpSecretResolver: () => 'unused' };
          },
          consentGate: PASS_CONSENT,
          startMcpClient: recordingMcp(order),
          buildEngine: async (options) => {
            order.push('engine');
            const engine = await buildEngine(options);
            if (stage === 'engine') sigint();
            return engine;
          },
        },
      ),
    );
    expectObserved(`gate.stop.${stage}`, { ...observed, order });
  });

  /** One server `fs` whose connection refuses to close, so the manager reports a close failure. */
  function refusingCloseMcp(): NonNullable<RunCommandDeps['startMcpClient']> {
    const connection: McpConnection = {
      listTools: () => Promise.resolve([{ name: 'read', inputSchema: { type: 'object' } }]),
      callTool: () =>
        Promise.resolve({ content: [{ type: 'text', text: 'unused' }], isError: false }),
      close: () => Promise.reject(new Error('synthetic close refusal')),
    };
    return () => realStartMcpClient([{ id: 'fs', open: () => Promise.resolve(connection) }]);
  }

  it('relavium run with an MCP release that is never acknowledged never settles and keeps the history open', async () => {
    const path = writeWorkflow('hang-run.relavium.yaml', withMcp(HAPPY));
    const h = createHarness();
    expectHung(
      'run.mcp-release-hang',
      await observeHang(
        (io, invocation) =>
          runCommand(
            { workflow: path, input: ['n=3'], allowMcpStdio: [] },
            {
              io,
              invocation,
              ...durableRun(false),
              consentGate: PASS_CONSENT,
              startMcpClient: refusingCloseMcp(),
            },
          ),
        h.normalize,
      ),
    );
  });

  it('relavium gate with an MCP release that is never acknowledged never settles and keeps the history open', async () => {
    const h = createHarness();
    const runId = await pauseWithMcp(h);
    expectHung(
      'gate.mcp-release-hang',
      await observeHang(
        (io, invocation) =>
          gateCommand(
            { runId, approve: true },
            {
              ...gateDeps(io, invocation, false),
              consentGate: PASS_CONSENT,
              startMcpClient: refusingCloseMcp(),
            },
          ),
        h.normalize,
      ),
    );
  });
});

/** Apply a text scrub to every string an observation holds. */
function scrubObserved(observed: Observed, scrub: (text: string) => string): Observed {
  return {
    ...observed,
    result:
      typeof observed.result === 'number'
        ? observed.result
        : { ...observed.result, message: scrub(observed.result.message) },
    out: observed.out.map(scrub),
    err: observed.err.map(scrub),
  };
}
