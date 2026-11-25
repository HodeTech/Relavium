import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { effortUnavailableNote, unpricedModelNote } from '../chat/effort-notice.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { gateCommand } from '../commands/gate.js';
import { runCommand } from '../commands/run.js';
import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { approvalDecision } from '../gate/decision.js';
import { RunHost } from '../home/run-host.js';
import { createCliInvocation } from '../process/invocation.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';

/**
 * The warnings a run leg writes name a remedy in the words of the surface that READS them (MVP-11 Step 2 review round 2, N2): the shell's
 * `run` and `gate` name the shell commands, the Home's hosted leg (every line becomes a notice inside the TUI) names the Home's actions
 * and never a shell command. The wording used to be the shell's for every host. A new file: the pinned counts of `run.test.ts` belong to
 * the causal and secrets controls. The real run core, the real engine and the real agent gate; only the provider is scripted.
 */
const MODEL = 'my-self-hosted-model'; // not in the catalog: its reasoning control is unknown, and it has no price
const CAP = 500_000_000;
const AGENT = `  budget:
    max_cost_microcents: ${CAP}
    on_exceed: warn
  agents:
    - id: worker
      provider: anthropic
      model: ${MODEL}
      reasoning_effort: high
      system_prompt: go`;
const PLAIN = `schema_version: '1.0'
workflow:
  id: surface-plain
${AGENT}
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: worker, prompt_template: hello }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }
`;
const GATED = `schema_version: '1.0'
workflow:
  id: surface-gated
${AGENT}
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: work, type: agent, agent_ref: worker, prompt_template: hello }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: work }
    - { from: work, to: out }
`;

/** What the shell has always printed: the notes composed with their DEFAULT surface (no argument), one `warning:` line each. */
const SHELL_STDERR = [
  `warning: ${effortUnavailableNote(MODEL)}\n`,
  `warning: ${unpricedModelNote(MODEL, CAP, 'budget.strict_cost_cap')}\n`,
].join('');
/** A shell command a person types: lower-case `relavium` followed by a word (the product's own name, `Relavium's`, is prose). */
const SHELL_COMMAND = /\brelavium\s+[a-z]/u;
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

describe('the warnings of a run leg, by the surface that reads them', () => {
  let root: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  const global = (): GlobalOptions => ({
    json: false,
    color: false,
    cwd: root,
    configPath: undefined,
    verbosity: 'normal',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-run-surface-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-run-surface-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home; // the operator's real home is never read
    }
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    if (client.sqlite.open) client.sqlite.close();
    for (const v of HOME_ENV_VARS) {
      const prev = savedHome.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function workflowFile(yaml: string): string {
    const path = join(root, 'surface.relavium.yaml');
    writeFileSync(path, yaml);
    return path;
  }

  function hostOf(): { host: RunHost; stderr: () => string } {
    const io = captureIo();
    const host = new RunHost({
      invocation: invocationFixture().invocation,
      io: io.io,
      global: global(),
      db: client.db,
      homeDir: home,
      providers: scriptedResolver([textTurn('done')]),
    });
    return { host, stderr: io.err };
  }

  /** A run that parked at its human gate, recorded in the shared database, with the agent still to run. */
  async function parkedRun(): Promise<string> {
    const def = parseWorkflow(GATED, { source: 'surface.test' });
    const store = createRunHistoryStore(client.db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      projectRoot: root, // a hosted resume answers only a run recorded for the directory the Home is open in
      workflow: {
        slug: def.workflow.id,
        name: def.workflow.id,
        definitionJson: JSON.stringify(def),
      },
    });
    const engine = await buildEngine({
      host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    });
    const handle = engine.start({ workflow: def, inputs: {} });
    let runId = '';
    for await (const event of handle.events) {
      if (event.type === 'run:started') runId = event.runId;
      if (event.type === 'run:paused') break;
    }
    return runId;
  }

  it('relavium run keeps the shell wording, byte for byte', async () => {
    const io = captureIo();
    const code = await runCommand(
      { workflow: workflowFile(PLAIN), input: [], allowMcpStdio: [] },
      {
        invocation: invocationFixture().invocation,
        io: io.io,
        global: global(),
        providers: scriptedResolver([textTurn('done')]),
      },
    );
    expect(code).toBe(0);
    expect(io.err()).toBe(SHELL_STDERR);
  });

  it('a hosted start leg names the Home’s actions, and no shell command', async () => {
    const { host, stderr } = hostOf();
    const launched = await host.start({ workflow: workflowFile(PLAIN), rawInputs: {} });
    if (launched.kind !== 'started')
      throw new Error(`expected a started leg: ${JSON.stringify(launched)}`);
    await launched.ended;
    const notices = host.notices.snapshot().join('\n');
    expect(notices).toContain('Open /models and choose "Refresh the list"');
    expect(notices).toContain('Price it from the Home with /pricing');
    expect(notices).not.toMatch(SHELL_COMMAND);
    expect(stderr(), 'nothing reaches the Home’s own stderr').toBe('');
  });

  it('relavium gate keeps the shell wording, byte for byte', async () => {
    const runId = await parkedRun();
    const io = captureIo();
    const code = await gateCommand(
      { runId, approve: true },
      {
        io: io.io,
        invocation: createCliInvocation({ exit: () => undefined, setExitCode: () => undefined }),
        global: global(),
        providers: scriptedResolver([textTurn('done')]),
        openDb: () => ({ db: client.db, close: () => undefined }),
      },
    );
    expect(code).toBe(0);
    expect(io.err()).toBe(SHELL_STDERR);
  });

  it('a hosted resume leg names the Home’s actions, and no shell command', async () => {
    const runId = await parkedRun();
    const { host } = hostOf();
    const launched = await host.resume({ runId, kind: 'human', decision: approvalDecision() });
    if (launched.kind !== 'started')
      throw new Error(`expected a started leg: ${JSON.stringify(launched)}`);
    await launched.ended;
    const notices = host.notices.snapshot().join('\n');
    expect(notices).toContain('Open /models and choose "Refresh the list"');
    expect(notices).toContain('Price it from the Home with /pricing');
    expect(notices).not.toMatch(SHELL_COMMAND);
  });
});
