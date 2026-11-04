import { parseWorkflow } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import {
  approvalDecision,
  assertDecisionFitsGateType,
  decisionFromFlags,
  inputDecision,
  parseGateInput,
  rejectionDecision,
} from './decision.js';

describe('decision builders', () => {
  it('approvalDecision is approved/decidedBy cli, with no comment key by default', () => {
    expect(approvalDecision()).toEqual({ decision: 'approved', decidedBy: 'cli' });
    expect('comment' in approvalDecision()).toBe(false);
    expect(approvalDecision('looks good')).toEqual({
      decision: 'approved',
      decidedBy: 'cli',
      comment: 'looks good',
    });
  });

  it('rejectionDecision trims a comment and omits a blank one', () => {
    expect(rejectionDecision('  too risky  ')).toEqual({
      decision: 'rejected',
      decidedBy: 'cli',
      comment: 'too risky',
    });
    expect('comment' in rejectionDecision('   ')).toBe(false);
    expect('comment' in rejectionDecision()).toBe(false);
  });

  it('inputDecision always carries the payload (even null)', () => {
    expect(inputDecision({ api_key: 'x' })).toEqual({
      decision: 'input_provided',
      decidedBy: 'cli',
      payload: { api_key: 'x' },
    });
    expect(inputDecision(null)).toMatchObject({ decision: 'input_provided', payload: null });
  });
});

describe('parseGateInput', () => {
  it('parses JSON when it parses, else keeps the raw string', () => {
    expect(parseGateInput('{"k":1}')).toEqual({ k: 1 });
    expect(parseGateInput('42')).toBe(42);
    expect(parseGateInput('true')).toBe(true);
    expect(parseGateInput('null')).toBeNull();
    expect(parseGateInput('some-token')).toBe('some-token');
    expect(parseGateInput('')).toBe(''); // JSON.parse('') throws → raw string
  });
});

describe('decisionFromFlags', () => {
  it('requires exactly one of --approve / --reject / --input', () => {
    expect(decisionFromFlags({})).toMatchObject({ ok: false });
    expect(decisionFromFlags({ approve: true, reject: true })).toMatchObject({ ok: false });
    expect(decisionFromFlags({ approve: true, input: 'x' })).toMatchObject({ ok: false });
    expect(decisionFromFlags({ reject: true, input: 'x' })).toMatchObject({ ok: false });
    expect(decisionFromFlags({ approve: true, reject: true, input: 'x' })).toMatchObject({
      ok: false,
    });
  });

  it('builds an approval (with optional comment)', () => {
    expect(decisionFromFlags({ approve: true })).toEqual({
      ok: true,
      decision: { decision: 'approved', decidedBy: 'cli' },
    });
    expect(decisionFromFlags({ approve: true, comment: 'lgtm' })).toEqual({
      ok: true,
      decision: { decision: 'approved', decidedBy: 'cli', comment: 'lgtm' },
    });
  });

  it('builds a rejection with the comment', () => {
    expect(decisionFromFlags({ reject: true, comment: 'Too risky' })).toEqual({
      ok: true,
      decision: { decision: 'rejected', decidedBy: 'cli', comment: 'Too risky' },
    });
  });

  it('builds an input_provided decision, parsing the payload', () => {
    expect(decisionFromFlags({ input: '{"api_key":"redacted"}' })).toEqual({
      ok: true,
      decision: { decision: 'input_provided', decidedBy: 'cli', payload: { api_key: 'redacted' } },
    });
  });

  it('rejects --comment combined with --input', () => {
    expect(decisionFromFlags({ input: 'x', comment: 'y' })).toMatchObject({ ok: false });
  });
});

describe('assertDecisionFitsGateType (2.6.K, ruled 2026-11-05)', () => {
  const workflow = parseWorkflow(
    `schema_version: '1.0'\nworkflow:\n  id: gates\n  nodes:\n    - { id: start, type: input }\n    - { id: ok, type: human_gate, gate_type: approval }\n    - { id: ask, type: human_gate, gate_type: input }\n    - { id: look, type: human_gate, gate_type: review }\n    - { id: out, type: output }\n  edges:\n    - { from: start, to: ok }\n    - { from: ok, to: ask }\n    - { from: ask, to: look }\n    - { from: look, to: out }`,
  );
  const decision = (kind: 'approved' | 'rejected' | 'input_provided') =>
    kind === 'input_provided'
      ? inputDecision('x')
      : kind === 'approved'
        ? approvalDecision()
        : rejectionDecision();

  it('accepts each fitting decision and refuses the rest with the flags to use', () => {
    for (const [node, fits, misfit, hint] of [
      [
        'ok',
        ['approved', 'rejected'],
        'input_provided',
        'approval gate — use --approve or --reject',
      ],
      [
        'look',
        ['approved', 'rejected'],
        'input_provided',
        'review gate — use --approve or --reject',
      ],
      [
        'ask',
        ['input_provided', 'rejected'],
        'approved',
        'input gate — use --input <json> or --reject',
      ],
    ] as const) {
      for (const kind of fits) {
        expect(() => assertDecisionFitsGateType(workflow, node, decision(kind))).not.toThrow();
      }
      expect(() => assertDecisionFitsGateType(workflow, node, decision(misfit))).toThrow(hint);
    }
  });

  it('leaves a node it cannot find to the engine', () => {
    expect(() =>
      assertDecisionFitsGateType(workflow, 'missing', decision('input_provided')),
    ).not.toThrow();
  });
});
