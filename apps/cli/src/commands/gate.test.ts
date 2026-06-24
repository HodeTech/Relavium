import { randomUUID } from 'node:crypto';

import { parseWorkflow, type CheckpointState } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  loadRunSnapshot,
  runMigrations,
  type Db,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { gateCommand, selectGate, type GateCommandDeps } from './gate.js';

// gate → double (reads inputs.n, restored on resume) → out. The in-memory host pauses at the fail-closed gate.
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

// Two gates on parallel branches → a multi-gate pause that requires --gate to disambiguate.
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

function globalOptions(): GlobalOptions {
  return {
    json: false,
    color: false,
    cwd: process.cwd(),
    configPath: undefined,
    verbosity: 'normal',
  };
}

describe('gateCommand', () => {
  let client: DbClient;
  let db: Db;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    db = client.db;
  });
  afterEach(() => {
    client.sqlite.close();
  });

  /** The injected deps for a resume over the SHARED in-memory db (no-op close — the db spans the whole test). */
  function deps(io: ReturnType<typeof captureIo>['io']): GateCommandDeps {
    return { io, global: globalOptions(), openDb: () => ({ db, close: () => {} }) };
  }

  /** Drive a gated workflow to its pause against the db store (persisting run:started → run:paused). */
  async function setupPausedRun(
    yaml = GATED,
    inputs: Record<string, unknown> = { n: 7 },
  ): Promise<{ runId: string; gateIds: string[] }> {
    const def = parseWorkflow(yaml, { source: 'gate.test' });
    const store = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: {
        slug: def.workflow.id,
        name: def.workflow.name ?? def.workflow.id,
        definitionJson: JSON.stringify(def),
      },
    });
    const engine = await buildEngine({ host: createCliHost(store) });
    const handle = engine.start({ workflow: def, inputs });
    let runId = '';
    const gateIds: string[] = [];
    for await (const event of handle.events) {
      if (event.type === 'run:started') runId = event.runId;
      if (event.type === 'human_gate:paused') gateIds.push(event.gateId);
      if (event.type === 'run:paused') break;
    }
    return { runId, gateIds };
  }

  it('resumes a paused run on --approve, drives it to completion (exit 0), and persists the decision', async () => {
    const { runId } = await setupPausedRun();
    const { io } = captureIo();

    const code = await gateCommand({ runId, approve: true }, deps(io));

    expect(code).toBe(EXIT_CODES.success);
    expect(loadRunSnapshot(db, runId)?.status).toBe('completed'); // the cross-process resume reached the terminal
    const store = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'gate-resume', name: 'gate-resume', definitionJson: '{}' },
    });
    const events = store.loadRunEvents(runId);
    expect(events.find((e) => e.type === 'human_gate:resumed')).toMatchObject({
      decision: 'approved',
      decidedBy: 'cli',
    });
    // Inputs were RESTORED across the process boundary: the post-gate `double` node read inputs.n (=7) and
    // produced d=14. A lost-inputs regression would compute `undefined * 2` = NaN instead.
    const doubled = events.find((e) => e.type === 'node:completed' && e.nodeId === 'double');
    expect(doubled).toMatchObject({ output: { d: 14 } });
  });

  it('surfaces a corrupt stored inputs blob as a clean exit-2 fault (no silent empty-inputs resume)', async () => {
    const { runId } = await setupPausedRun();
    // Corrupt the persisted input_json to a non-JSON blob (simulating a damaged store row).
    client.sqlite.prepare('UPDATE runs SET input_json = ? WHERE id = ?').run('{not json', runId);
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
  });

  it('resumes on --reject, persisting the rejection + comment', async () => {
    const { runId } = await setupPausedRun();
    const { io } = captureIo();
    const code = await gateCommand({ runId, reject: true, comment: 'not now' }, deps(io));
    expect(code).toBe(EXIT_CODES.success);
    const store = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'gate-resume', name: 'gate-resume', definitionJson: '{}' },
    });
    expect(store.loadRunEvents(runId).find((e) => e.type === 'human_gate:resumed')).toMatchObject({
      decision: 'rejected',
    });
  });

  it('is idempotent: a doubled decision on an already-completed run is a clean exit-0 no-op (no double-advance)', async () => {
    const { runId } = await setupPausedRun();
    const { io, out } = captureIo();
    const reader = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'gate-resume', name: 'gate-resume', definitionJson: '{}' },
    });
    await gateCommand({ runId, approve: true }, deps(io)); // first resume → completes
    const eventsAfterFirst = reader.loadRunEvents(runId).length;

    const code = await gateCommand({ runId, approve: true }, deps(io)); // second decision
    expect(code).toBe(EXIT_CODES.success);
    expect(out()).toContain('nothing to resume'); // idempotent message, not a re-run
    expect(reader.loadRunEvents(runId).length).toBe(eventsAfterFirst); // NO new events — not advanced twice
  });

  it('rejects an unknown runId (exit 2)', async () => {
    const { io } = captureIo();
    let caught: unknown;
    try {
      await gateCommand({ runId: 'no-such-run', approve: true }, deps(io));
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) expect(caught.code).toBe('invalid_invocation');
  });

  it('rejects an invalid flag combination before touching the db (exit 2)', async () => {
    const { io } = captureIo();
    await expect(gateCommand({ runId: 'any' }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
    await expect(
      gateCommand({ runId: 'any', approve: true, reject: true }, deps(io)),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
  });

  it('requires --gate when more than one gate is pending, then resolves the named one', async () => {
    const { runId, gateIds } = await setupPausedRun(TWO_GATES, {});
    expect(gateIds.length).toBeGreaterThan(1);
    const firstGate = gateIds[0];
    if (firstGate === undefined) throw new Error('expected a pending gate');
    const { io } = captureIo();

    // No --gate → ambiguous → exit 2 listing the pending ids.
    let caught: unknown;
    try {
      await gateCommand({ runId, approve: true }, deps(io));
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain(firstGate);
    }

    // Naming the first gate resolves it; the run pauses again at the second → exit 3 (resume that one next).
    const code = await gateCommand({ runId, approve: true, gate: firstGate }, deps(io));
    expect(code).toBe(EXIT_CODES.gatePaused);
  });

  it('treats a re-approval of an already-resolved gate as an idempotent no-op (exit 0)', async () => {
    const { runId, gateIds } = await setupPausedRun(TWO_GATES, {});
    const firstGate = gateIds[0];
    if (firstGate === undefined) throw new Error('expected a pending gate');
    const { io, out } = captureIo();
    await gateCommand({ runId, approve: true, gate: firstGate }, deps(io)); // resolve g1 (run pauses at g2)
    const code = await gateCommand({ runId, approve: true, gate: firstGate }, deps(io)); // re-approve g1
    expect(code).toBe(EXIT_CODES.success);
    expect(out()).toContain('already resolved');
  });
});

describe('selectGate', () => {
  const checkpoint = (over: Partial<CheckpointState> = {}): CheckpointState => ({
    schemaVersion: 1,
    runStatus: 'paused',
    workflowId: 'wf',
    startedAtMs: 0,
    nodeStates: new Map(),
    completedNodeIds: [],
    pendingGates: [],
    pendingMediaJobs: [],
    resolvedGateIds: [],
    lastSequenceNumber: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cumulativeCostMicrocents: 0,
    ...over,
  });
  const gate = (gateId: string, isBudgetGate = false) => ({ gateId, nodeId: gateId, isBudgetGate });

  it('auto-fills the single pending human gate', () => {
    expect(selectGate(checkpoint({ pendingGates: [gate('g1')] }), 'paused', undefined)).toEqual({
      kind: 'resume',
      gateId: 'g1',
    });
  });

  it('excludes a budget gate — that is the `relavium budget resume` surface, not a human gate', () => {
    // A pending budget gate alone reads as "no human gate", not as something `relavium gate` resolves.
    expect(
      selectGate(checkpoint({ pendingGates: [gate('b1', true)] }), 'paused', undefined),
    ).toEqual({
      kind: 'invalid',
      message: 'the run is not paused at a human gate',
    });
  });

  it('treats a terminal run (completed / failed / cancelled) as an idempotent no-op', () => {
    expect(selectGate(checkpoint(), 'completed', undefined).kind).toBe('idempotent');
    expect(selectGate(checkpoint(), 'failed', undefined).kind).toBe('idempotent');
    expect(selectGate(checkpoint(), 'cancelled', undefined).kind).toBe('idempotent');
  });

  it('requires --gate for more than one pending gate, listing the ids', () => {
    const sel = selectGate(
      checkpoint({ pendingGates: [gate('g1'), gate('g2')] }),
      'paused',
      undefined,
    );
    expect(sel.kind).toBe('invalid');
    if (sel.kind === 'invalid') {
      expect(sel.message).toContain('g1');
      expect(sel.message).toContain('g2');
    }
  });

  it('--gate naming an already-resolved id is idempotent; an unknown id is invalid', () => {
    expect(selectGate(checkpoint({ resolvedGateIds: ['g1'] }), 'paused', 'g1').kind).toBe(
      'idempotent',
    );
    expect(selectGate(checkpoint({ pendingGates: [gate('g1')] }), 'paused', 'gX').kind).toBe(
      'invalid',
    );
  });

  it('reports "not paused at a human gate" when nothing is pending and nothing was resolved', () => {
    expect(selectGate(checkpoint(), 'running', undefined)).toEqual({
      kind: 'invalid',
      message: 'the run is not paused at a human gate',
    });
  });
});
