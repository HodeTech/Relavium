/**
 * What the run pages read from a run's frozen workflow snapshot ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): the nodes in authored order with their types, agents and models, and a tolerant `undefined` for everything it cannot use.
 */
import { describe, expect, it } from 'vitest';

import { FIXTURE_SNAPSHOT } from './node-run-fixture.js';
import { MAX_SNAPSHOT_CHARS, MAX_SNAPSHOT_NODES, readSnapshotNodes } from './snapshot-nodes.js';

const snapshotOf = (nodes: unknown, agents?: unknown): string =>
  JSON.stringify({ workflow: { nodes, ...(agents === undefined ? {} : { agents }) } });

describe('readSnapshotNodes', () => {
  it('lists the nodes in the order the workflow authored them, with their type, agent and model', () => {
    expect(readSnapshotNodes(FIXTURE_SNAPSHOT)).toEqual([
      { id: 'plan', type: 'agent', agent: 'planner', model: 'claude-planner' },
      { id: 'build', type: 'agent', agent: 'builder', model: 'claude-builder' },
      { id: 'review', type: 'agent', agent: 'reviewer' },
      { id: 'ship', type: 'transform' },
    ]);
  });

  it('takes the node`s own model over its inline agent`s, and no model from an agent that is only a reference', () => {
    const nodes = readSnapshotNodes(
      snapshotOf(
        [
          { id: 'a', type: 'agent', agent_ref: 'inline', model: 'node-model' },
          { id: 'b', type: 'agent', agent_ref: 'inline' },
          { id: 'c', type: 'agent', agent_ref: 'by-ref' },
        ],
        [{ id: 'inline', model: 'agent-model' }, { ref: 'by-ref' }, 'not an agent', null],
      ),
    );
    expect(nodes?.map((node) => node.model)).toEqual(['node-model', 'agent-model', undefined]);
  });

  it('lists a node id that the document names twice once, at its first place', () => {
    const nodes = readSnapshotNodes(
      snapshotOf([
        { id: 'a', type: 'agent' },
        { id: 'b', type: 'transform' },
        { id: 'a', type: 'transform' },
      ]),
    );
    expect(nodes).toEqual([
      { id: 'a', type: 'agent' },
      { id: 'b', type: 'transform' },
    ]);
  });

  it('answers undefined, and never throws, for text it cannot use', () => {
    const unusable: readonly (string | undefined)[] = [
      undefined,
      '',
      'not json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ workflow: null }),
      JSON.stringify({ workflow: { nodes: 'plan' } }),
      snapshotOf([{ id: 'a' }]),
      snapshotOf([{ type: 'agent' }]),
      snapshotOf([{ id: '', type: 'agent' }]),
      snapshotOf([{ id: 7, type: 'agent' }]),
      snapshotOf(['plan']),
      snapshotOf([null]),
    ];
    for (const text of unusable) expect(readSnapshotNodes(text), String(text)).toBeUndefined();
  });

  it('refuses a document over the character bound and a workflow with more nodes than a page can list, and accepts both bounds exactly', () => {
    const nodes = (count: number): unknown[] =>
      Array.from({ length: count }, (_, index) => ({ id: `n${String(index)}`, type: 'agent' }));
    expect(readSnapshotNodes(snapshotOf(nodes(MAX_SNAPSHOT_NODES)))).toHaveLength(
      MAX_SNAPSHOT_NODES,
    );
    expect(readSnapshotNodes(snapshotOf(nodes(MAX_SNAPSHOT_NODES + 1)))).toBeUndefined();
    const padded = (length: number): string => {
      const base = snapshotOf([{ id: 'a', type: 'agent' }]);
      return `${base}${' '.repeat(length - base.length)}`;
    };
    expect(readSnapshotNodes(padded(MAX_SNAPSHOT_CHARS))).toHaveLength(1);
    expect(readSnapshotNodes(padded(MAX_SNAPSHOT_CHARS + 1))).toBeUndefined();
  });

  it('keeps an own `__proto__` id as a plain string', () => {
    expect(readSnapshotNodes('{"workflow":{"nodes":[{"id":"__proto__","type":"agent"}]}}')).toEqual(
      [{ id: '__proto__', type: 'agent' }],
    );
  });
});
