import { describe, expect, it } from 'vitest';

import {
  approvalDecision,
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
