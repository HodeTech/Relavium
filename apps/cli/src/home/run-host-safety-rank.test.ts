/**
 * Which safety fact the Home keeps when several legs end with one
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6).
 *
 * `RunHost` keeps the leg that carried the MOST serious fact, in the registry's own order (8, then 7, 5, 6), and a later, lesser leg never
 * replaces it: the Home's exit line and its exit code name the worst thing that happened, not the last. The order is ONE table
 * (`safetyRank` in `process/exit-observations.ts`: the registry, the host and the hosted legs all read it), pinned there by its own test and
 * here through what the host reports, over real legs on a real run core. A TIE keeps the FIRST leg: a later leg of the same rank never
 * replaces the one the exit line already names.
 *
 * Every leg is a scripted handle on a real engine object; every home is a temporary directory handed to the host.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WorkflowEngine,
  createInMemoryHost,
  type RunDeparture,
  type RunHandle,
} from '@relavium/core';
import { createClient, runMigrations, type DbClient } from '@relavium/db';
import type { RunDurability, RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { RunHost, type HostedLegEnd } from './run-host.js';

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: host-safety-rank
  inputs:
    - { name: n, type: number }
  nodes:
    - { id: start, type: input }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: double }
    - { from: double, to: out }
`;

type Departure = Exclude<RunDeparture, { readonly kind: 'continue' }>;
const DETACHED: Departure = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

/** The four workflow safety facts, each as the leg that produces it. */
type Safety = 8 | 7 | 5 | 6 | undefined;

function legFor(safety: Safety): {
  readonly departure: Departure;
  readonly durability: RunDurability;
  /** Exit 6 is a run fenced mid-leg: its stream ends with no terminal event while the disposition is uncertain. */
  readonly terminal: boolean;
} {
  switch (safety) {
    case 8:
      return {
        departure: { ...DETACHED, moneyDurability: 'uncertain' },
        durability: 'durable',
        terminal: true,
      };
    case 7:
      return {
        departure: { ...DETACHED, effectNeedsAttention: true },
        durability: 'durable',
        terminal: true,
      };
    case 5:
      return { departure: DETACHED, durability: 'uncertain', terminal: true };
    case 6:
      return { departure: DETACHED, durability: 'uncertain', terminal: false };
    default:
      return { departure: DETACHED, durability: 'durable', terminal: true };
  }
}

function handleFor(runId: string, safety: Safety): RunHandle {
  const leg = legFor(safety);
  const event: RunEvent = {
    runId,
    timestamp: '2026-11-23T00:00:00.000Z',
    sequenceNumber: 1,
    type: 'run:completed',
    outputs: {},
    totalTokensUsed: { input: 0, output: 0 },
    totalCostMicrocents: 0,
    durationMs: 1,
  };
  return {
    runId,
    events: (async function* (): AsyncGenerator<RunEvent> {
      await Promise.resolve();
      if (leg.terminal) yield event;
    })(),
    subscribe: () => () => undefined,
    cancel: () => undefined,
    depart: () => Promise.resolve(leg.departure),
    whenConsumersReady: () => Promise.resolve(),
    highWaterMark: 256,
    bufferedCount: 0,
    durability: () => leg.durability,
    terminalError: () => undefined,
  };
}

let root: string;
let operatorHome: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-safety-rank-'));
  operatorHome = mkdtempSync(join(tmpdir(), 'relavium-safety-rank-home-'));
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(operatorHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** One host over the in-memory `history.db`; each leg it starts ends as `sequence` says, with run ids `run-1`, `run-2`, … */
async function runLegs(sequence: readonly Safety[]): Promise<{
  readonly host: RunHost;
  readonly ends: readonly HostedLegEnd[];
}> {
  let n = 0;
  const host = new RunHost({
    invocation: invocationFixture().invocation,
    io: captureIo().io,
    global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir: operatorHome,
    buildEngine: () => {
      const safety = sequence[n];
      n += 1;
      const engine = new WorkflowEngine({
        host: createInMemoryHost(),
        executor: { execute: () => Promise.resolve({ kind: 'completed', output: null }) },
      });
      vi.spyOn(engine, 'start').mockReturnValue(handleFor(`run-${String(n)}`, safety));
      return Promise.resolve(engine);
    },
    sweepMedia: () => Promise.resolve(undefined),
  });
  const path = join(root, 'rank.relavium.yaml');
  writeFileSync(path, WORKFLOW);
  const ends: HostedLegEnd[] = [];
  for (let i = 0; i < sequence.length; i += 1) {
    const launch = await host.start({ workflow: path, rawInputs: { n: '3' } });
    if (launch.kind !== 'started') throw new Error(`leg ${String(i + 1)}: ${launch.kind}`);
    ends.push(await launch.ended);
  }
  return { host, ends };
}

describe('the Home keeps the most serious safety fact across legs', () => {
  it.each([
    { name: '7 then 8 keeps 8', sequence: [7, 8], kept: 'run-2', exit: 8 },
    { name: '8 then 7 keeps 8', sequence: [8, 7], kept: 'run-1', exit: 8 },
    { name: '8 then 5 keeps 8', sequence: [8, 5], kept: 'run-1', exit: 8 },
    { name: '5 then 7 keeps 7', sequence: [5, 7], kept: 'run-2', exit: 7 },
    { name: '7 then 5 keeps 7', sequence: [7, 5], kept: 'run-1', exit: 7 },
    {
      name: '5 then 6 keeps 5 (a held record outranks a taken-over run)',
      sequence: [5, 6],
      kept: 'run-1',
      exit: 5,
    },
    { name: '6 then 5 keeps 5', sequence: [6, 5], kept: 'run-2', exit: 5 },
    { name: '6 then an ordinary leg keeps 6', sequence: [6, undefined], kept: 'run-1', exit: 6 },
    {
      name: '7 then 7 keeps the FIRST 7 (a tie never moves the kept leg)',
      sequence: [7, 7],
      kept: 'run-1',
      exit: 7,
    },
    { name: '8 then 8 keeps the FIRST 8', sequence: [8, 8], kept: 'run-1', exit: 8 },
  ] satisfies readonly {
    readonly name: string;
    readonly sequence: readonly Safety[];
    readonly kept: string;
    readonly exit: 8 | 7 | 5 | 6;
  }[])('$name', async ({ sequence, kept, exit }) => {
    const { host, ends } = await runLegs(sequence);
    const carried = ends.map((end) => end.terminal.safety);
    expect(carried, 'every leg carried the fact the script gave it').toEqual(sequence);
    const facts = host.exitFacts();
    expect(facts, 'one line, for the one leg that carried the worst fact').toHaveLength(1);
    expect(facts[0]?.kind).toBe('safety');
    expect(facts[0]?.runId).toBe(kept);
    // The line is the kept leg's own words, so it can never name the lesser leg.
    const keptEnd = ends.find((end) => end.runId === kept);
    expect(keptEnd?.terminal.safety).toBe(exit);
    expect(facts[0]?.line).toContain(kept);
    for (const end of ends) if (end.runId !== kept) expect(facts[0]?.line).not.toContain(end.runId);
  });

  it('exit 6, a run taken over elsewhere, is a taken_over line naming the run and the shell remedy', async () => {
    const { host, ends } = await runLegs([6]);
    expect(ends[0]?.terminal.disposition).toBe('taken_over');
    expect(ends[0]?.terminal.safety).toBe(6);
    const facts = host.exitFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.kind).toBe('safety');
    expect(facts[0]?.runId).toBe('run-1');
    expect(facts[0]?.line).toContain('taken over by another process');
    expect(facts[0]?.line).toContain('`relavium logs run-1`');
    expect(facts[0]?.line, 'one plain line').not.toContain('\n');
  });

  it('a leg that carries no fact owes nothing', async () => {
    const alone = await runLegs([undefined]);
    expect(alone.host.exitFacts()).toEqual([]);
  });
});
