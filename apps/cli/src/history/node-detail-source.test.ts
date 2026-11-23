/**
 * The read behind the node page ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, §4, MVP-8 step 4): which attempt it reads, how a document over the store's size gate reaches the page (its byte length and no text), what the
 * frozen workflow snapshot adds (the node's place and type), and what a node that has no attempt row or cannot be read answers. Every claim runs
 * over a real in-memory `history.db` seeded through the real store.
 */
import {
  MAX_RUN_DETAIL_DOCUMENT_BYTES,
  createClient,
  createRunHistoryReader,
  runEvents,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_STORED_OUTPUT_BYTES } from './node-detail-model.js';
import { FIXTURE_RUN_IDS, FIXTURE_SNAPSHOT, seedFixtureRuns } from './node-run-fixture.js';
import {
  createNodeDetailLoader,
  readNodeDetail,
  type NodeDetailLoad,
  type NodeDetailRead,
  type NodeDetailLoaderDeps,
} from './node-detail-source.js';

let client: DbClient;
let reader: RunHistoryReader;

beforeEach(async () => {
  client = createClient(':memory:');
  runMigrations(client.db);
  reader = createRunHistoryReader(client.db);
  await seedFixtureRuns(client.db);
});
afterEach(() => {
  client.sqlite.close();
});

const deps = (over: Partial<NodeDetailLoaderDeps> = {}): NodeDetailLoaderDeps => ({
  reader,
  loadSnapshot: () => FIXTURE_SNAPSHOT,
  ...over,
});

function ready(load: NodeDetailLoad): NodeDetailRead {
  if (load.kind !== 'ready') throw new Error(`the node page is ${load.kind}`);
  return load.detail;
}

/** A JSON document of exactly `bytes` UTF-8 bytes: `{"v":"aaa…"}`. */
function documentOfBytes(bytes: number): string {
  const frame = '{"v":""}'.length;
  return `{"v":"${'a'.repeat(bytes - frame)}"}`;
}

function setDocument(
  column: 'output_json' | 'error_json',
  runId: string,
  nodeId: string,
  text: string,
): void {
  const result = client.sqlite
    .prepare(`UPDATE step_executions SET ${column} = ? WHERE run_id = ? AND node_id = ?`)
    .run(text, runId, nodeId);
  expect(result.changes, 'the step row was written').toBeGreaterThan(0);
}

describe('the step detail is read through the size gate', () => {
  const run = FIXTURE_RUN_IDS.reversed;

  it('shows an output over 1 MiB as its byte length and no text of it', () => {
    setDocument('output_json', run, 'plan', documentOfBytes(MAX_RUN_DETAIL_DOCUMENT_BYTES + 1));
    const { model } = ready(
      readNodeDetail(deps(), { runId: run, nodeId: 'plan', terminalHeld: false }),
    );
    expect(model.outputPreview?.text).toBe(
      `output too large to preview (${String(MAX_STORED_OUTPUT_BYTES + 1)} bytes)`,
    );
    expect(model.outputPreview?.text).not.toContain('aaaa');
    expect(model.outputPreview?.masked).toBe(false);
  });

  it('reads an output of exactly 1 MiB as text, bounded to the preview`s own caps', () => {
    setDocument('output_json', run, 'plan', documentOfBytes(MAX_RUN_DETAIL_DOCUMENT_BYTES));
    const { model } = ready(
      readNodeDetail(deps(), { runId: run, nodeId: 'plan', terminalHeld: false }),
    );
    expect(model.outputPreview?.text).toContain('aaaa');
    expect(model.outputPreview?.truncated).toBe(true);
    expect(model.outputPreview?.chars).toBeLessThanOrEqual(4000);
  });

  it('says only the size of an error over 1 MiB, and gates it independently of the output', () => {
    setDocument('error_json', run, 'build', documentOfBytes(MAX_RUN_DETAIL_DOCUMENT_BYTES + 1));
    setDocument('output_json', run, 'build', '{"ok":1}');
    const { model } = ready(
      readNodeDetail(deps(), { runId: run, nodeId: 'build', terminalHeld: false }),
    );
    expect(model.error?.message).toBe(
      `error record too large to show (${String(MAX_RUN_DETAIL_DOCUMENT_BYTES + 1)} bytes)`,
    );
    expect(model.outputPreview?.text).toContain('"ok": 1');
  });

  it('never reads a document into the page whole: the store hands over null text for an over-bound one', () => {
    setDocument('output_json', run, 'plan', documentOfBytes(MAX_RUN_DETAIL_DOCUMENT_BYTES + 1));
    const loadStepDetail = vi.fn(reader.loadStepDetail);
    ready(
      readNodeDetail(deps({ reader: { ...reader, loadStepDetail } }), {
        runId: run,
        nodeId: 'plan',
        terminalHeld: false,
      }),
    );
    const record: unknown = loadStepDetail.mock.results[0]?.value;
    expect(record).toMatchObject({
      outputJson: null,
      outputByteLength: MAX_RUN_DETAIL_DOCUMENT_BYTES + 1,
    });
  });
});

describe('which attempt is read', () => {
  const run = FIXTURE_RUN_IDS.failed;

  it('reads the last attempt of a node unless one is named, and lists every attempt number', () => {
    const last = ready(
      readNodeDetail(deps(), { runId: run, nodeId: 'build', terminalHeld: false }),
    );
    expect(last.model.attemptNumber).toBe(2);
    expect(last.model.status).toBe('completed');
    expect(last.attemptNumbers).toEqual([1, 2]);
    expect(last.model.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed']);
  });

  it('reads the attempt it is asked for, with that attempt`s own record', () => {
    const first = ready(
      readNodeDetail(deps(), {
        runId: run,
        nodeId: 'review',
        attemptNumber: 1,
        terminalHeld: false,
      }),
    );
    expect(first.model.attemptNumber).toBe(1);
    expect(first.model.status).toBe('failed');
    expect(first.model.toolActivity).toEqual({
      recorded: false,
      text: 'not recorded for this attempt',
    });
  });

  it('answers `unavailable` for an attempt the node has no row for, never another attempt in its place', () => {
    expect(
      readNodeDetail(deps(), {
        runId: run,
        nodeId: 'build',
        attemptNumber: 9,
        terminalHeld: false,
      }),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('the frozen workflow gives the node its place, its type and what the workflow authored', () => {
  it('says which node of how many it is in the order the workflow authored, whatever order the run took', () => {
    const request = { runId: FIXTURE_RUN_IDS.reversed, terminalHeld: false } as const;
    const places = ['plan', 'build', 'review'].map((nodeId) => {
      const detail = ready(readNodeDetail(deps(), { ...request, nodeId }));
      return [nodeId, detail.position, detail.authoredType];
    });
    expect(places).toEqual([
      ['plan', { index: 1, of: 4 }, 'agent'],
      ['build', { index: 2, of: 4 }, 'agent'],
      ['review', { index: 3, of: 4 }, 'agent'],
    ]);
  });

  it('carries the authored agent and model (its own, else its inline agent`s) apart from the models the node ran on', () => {
    const request = { runId: FIXTURE_RUN_IDS.failed, terminalHeld: false } as const;
    const plan = ready(readNodeDetail(deps(), { ...request, nodeId: 'plan' }));
    expect(plan.model.authored).toEqual({ agent: 'planner', model: 'claude-planner' });
    const build = ready(readNodeDetail(deps(), { ...request, nodeId: 'build' }));
    expect(build.model.authored).toEqual({ agent: 'builder', model: 'claude-builder' });
    expect(build.model.modelsUsed).toEqual(['claude-builder']);
  });

  it('shows neither place nor type when the snapshot cannot be read, and the page still opens', () => {
    const request = {
      runId: FIXTURE_RUN_IDS.failed,
      nodeId: 'build',
      terminalHeld: false,
    } as const;
    for (const loadSnapshot of [
      () => undefined,
      () => 'not json',
      () => {
        throw new Error('the row is gone');
      },
    ]) {
      const detail = ready(readNodeDetail(deps({ loadSnapshot }), request));
      expect(detail.position).toBeUndefined();
      expect(detail.authoredType).toBeUndefined();
      expect(detail.model.authored).toEqual({});
      expect(detail.model.nodeType).toBe('agent');
    }
  });

  it('shows no place for a node the snapshot does not name', () => {
    const detail = ready(
      readNodeDetail(
        deps({
          loadSnapshot: () =>
            JSON.stringify({ workflow: { nodes: [{ id: 'other', type: 'agent' }] } }),
        }),
        { runId: FIXTURE_RUN_IDS.failed, nodeId: 'build', terminalHeld: false },
      ),
    );
    expect(detail.position).toBeUndefined();
  });
});

describe('a node that has no attempt row, and a node that cannot be read', () => {
  it('answers `no-attempts` with the node`s place for a node the run never reached or skipped', () => {
    expect(
      readNodeDetail(deps(), {
        runId: FIXTURE_RUN_IDS.failed,
        nodeId: 'ship',
        terminalHeld: false,
      }),
    ).toEqual({ kind: 'no-attempts', position: { index: 4, of: 4 }, authoredType: 'transform' });
    expect(
      readNodeDetail(deps(), {
        runId: FIXTURE_RUN_IDS.reversed,
        nodeId: 'ship',
        terminalHeld: false,
      }),
    ).toMatchObject({ kind: 'no-attempts' });
  });

  it('answers `unavailable` for a run that is not there and for a run whose log is damaged', () => {
    expect(
      readNodeDetail(deps(), { runId: 'no-such-run', nodeId: 'plan', terminalHeld: false }),
    ).toEqual({ kind: 'unavailable' });
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000aa',
        runId: FIXTURE_RUN_IDS.stopped,
        seq: 900,
        eventType: 'node:started',
        payloadJson: '{"not":"an event"}',
        ts: 0,
      })
      .run();
    expect(
      readNodeDetail(deps(), {
        runId: FIXTURE_RUN_IDS.stopped,
        nodeId: 'plan',
        terminalHeld: false,
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('lets a fault that is not about the node`s rows propagate: a closed database is not an `unavailable` node', () => {
    const own = createClient(':memory:');
    runMigrations(own.db);
    const closed = createRunHistoryReader(own.db);
    own.sqlite.close();
    expect(() =>
      readNodeDetail(deps({ reader: closed }), {
        runId: FIXTURE_RUN_IDS.failed,
        nodeId: 'plan',
        terminalHeld: false,
      }),
    ).toThrow();
  });
});

describe('the run`s state decides what an absent figure says', () => {
  it('reads a node left running under a run whose end is held in the outbox as finished: it did not finish, it is not in progress', () => {
    const request = { runId: FIXTURE_RUN_IDS.running, nodeId: 'build' } as const;
    const going = ready(readNodeDetail(deps(), { ...request, terminalHeld: false }));
    expect(going.model.tokens.text).toBe('in progress');
    const held = ready(readNodeDetail(deps(), { ...request, terminalHeld: true }));
    expect(held.model.tokens.text).toBe('did not finish');
    expect(held.model.status).toBe('stopped');
  });

  it('reads a node left running under a run that failed as stopped', () => {
    const detail = ready(
      readNodeDetail(deps(), {
        runId: FIXTURE_RUN_IDS.stopped,
        nodeId: 'build',
        terminalHeld: false,
      }),
    );
    expect(detail.model.status).toBe('stopped');
    expect(detail.model.tokens.text).toBe('did not finish');
  });
});

describe('the run`s log is read page by page', () => {
  it('says so when the log is longer than the pages read, and reads it whole otherwise', () => {
    const request = { runId: FIXTURE_RUN_IDS.failed, nodeId: 'plan', terminalHeld: false } as const;
    expect(ready(readNodeDetail(deps(), request)).eventsComplete).toBe(true);
    expect(ready(readNodeDetail(deps({ eventPage: 2, maxPages: 2 }), request)).eventsComplete).toBe(
      false,
    );
  });

  it('is the same read as a loader built over the same deps', () => {
    const request = { runId: FIXTURE_RUN_IDS.failed, nodeId: 'plan', terminalHeld: false } as const;
    expect(createNodeDetailLoader(deps())(request)).toEqual(readNodeDetail(deps(), request));
  });
});
