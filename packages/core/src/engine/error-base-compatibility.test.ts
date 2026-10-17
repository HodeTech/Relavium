import { RelaviumError } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  BudgetPauseError,
  CommitmentDurabilityError,
  EngineStateError,
  isBudgetExceededError,
  isBudgetPauseError,
  ToolDispatchError,
  ToolExecutionError,
  WorkflowParseError,
  WorkflowSyntaxError,
} from '../index.js';
import { AgentTurnError } from './agent-turn.js';

// Distinct native Error subclasses simulate foreign bundle identities, not actual bundled execution.
class ForeignBudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  constructor(readonly limitMicrocents: unknown) {
    super('foreign budget refusal');
  }
}

class ForeignBudgetPauseError extends Error {
  readonly code = 'budget_paused';
  constructor(readonly thresholdPct: unknown) {
    super('foreign budget pause');
  }
}

describe('engine error family compatibility', () => {
  it('preserves parser descendants, source position and opaque cause identity', () => {
    const cause = new SyntaxError('invalid YAML');
    const error = new WorkflowSyntaxError('workflow syntax is invalid', {
      source: 'workflow.relavium.yaml',
      line: 2,
      column: 4,
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toBeInstanceOf(WorkflowParseError);
    expect(error).toBeInstanceOf(WorkflowSyntaxError);
    expect(error).toMatchObject({
      name: 'WorkflowSyntaxError',
      code: 'invalid_yaml',
      source: 'workflow.relavium.yaml',
      line: 2,
      column: 4,
    });
    expect(error.cause).toBe(cause);
    const withoutContext = new WorkflowSyntaxError('invalid YAML', { cause: undefined });
    expect(Object.hasOwn(withoutContext, 'cause')).toBe(false);
    expect(withoutContext.source).toBeUndefined();
    expect(withoutContext.line).toBeUndefined();
    expect(withoutContext.column).toBeUndefined();
  });

  it('preserves API-boundary context identity and its optional cause convention', () => {
    const issues = Object.freeze([]);
    const cause = Object.freeze({ reason: 'storage unavailable' });
    const error = new EngineStateError('unknown_run', 'unknown run', {
      runId: 'run-1',
      gateId: 'gate-1',
      cause,
      issues,
    });
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toMatchObject({
      name: 'EngineStateError',
      code: 'unknown_run',
      runId: 'run-1',
      gateId: 'gate-1',
    });
    expect(error.issues).toBe(issues);
    expect(error.cause).toBe(cause);
    expect(
      Object.hasOwn(
        new EngineStateError('unknown_run', 'unknown run', { cause: undefined }),
        'cause',
      ),
    ).toBe(false);
  });

  it('preserves tool family ancestry and independently selected execution policy', () => {
    const cause = new Error('host failure');
    const error = new ToolExecutionError('read_file', 'read failed', cause, {
      recoverable: true,
      retryable: false,
    });
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toBeInstanceOf(ToolDispatchError);
    expect(error).toMatchObject({
      name: 'ToolExecutionError',
      code: 'execution_failed',
      runErrorCode: 'tool_failed',
      toolId: 'read_file',
      recoverable: true,
      retryable: false,
    });
    expect(error.cause).toBe(cause);
    expect(Object.hasOwn(new ToolExecutionError('read_file', 'read failed'), 'cause')).toBe(false);
  });

  it('preserves mandatory undefined cause and node attribution on durability errors', () => {
    const error = new CommitmentDurabilityError(undefined, 'agent-node');
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toMatchObject({
      name: 'CommitmentDurabilityError',
      code: 'commitment_not_durable',
      nodeId: 'agent-node',
    });
    expect(Object.hasOwn(error, 'cause')).toBe(true);
    expect(error.cause).toBeUndefined();
  });

  it('retains actual budget constructor reason and threshold context', () => {
    const exceeded = new BudgetExceededError(4, 10, undefined);
    const paused = new BudgetPauseError(4, 10, 80);
    expect(exceeded).toBeInstanceOf(RelaviumError);
    expect(paused).toBeInstanceOf(RelaviumError);
    expect(exceeded).toMatchObject({
      name: 'BudgetExceededError',
      code: 'budget_exceeded',
      spentMicrocents: 4,
      limitMicrocents: 10,
      projectedMicrocents: undefined,
      reason: 'unpriced_model',
    });
    expect(paused).toMatchObject({
      name: 'BudgetPauseError',
      code: 'budget_paused',
      spentMicrocents: 4,
      limitMicrocents: 10,
      thresholdPct: 80,
    });
    expect(isBudgetExceededError(exceeded)).toBe(true);
    expect(isBudgetPauseError(paused)).toBe(true);
  });

  it('recognizes simulated foreign budgets without local family or shared base identity', () => {
    const exceeded = new ForeignBudgetExceededError(10);
    const paused = new ForeignBudgetPauseError(80);
    expect(exceeded).not.toBeInstanceOf(BudgetExceededError);
    expect(paused).not.toBeInstanceOf(BudgetPauseError);
    expect(exceeded).not.toBeInstanceOf(RelaviumError);
    expect(paused).not.toBeInstanceOf(RelaviumError);
    expect(isBudgetExceededError(exceeded), 'FOREIGN_BUDGET_GUARD').toBe(true);
    expect(isBudgetPauseError(paused), 'FOREIGN_BUDGET_GUARD').toBe(true);
    expect(isBudgetPauseError(exceeded)).toBe(false);
    expect(isBudgetExceededError(paused)).toBe(false);
  });

  it.each([undefined, null, '10', {}])(
    'refuses a foreign budget with nonnumeric field %j',
    (field) => {
      expect(isBudgetExceededError(new ForeignBudgetExceededError(field))).toBe(false);
      expect(isBudgetPauseError(new ForeignBudgetPauseError(field))).toBe(false);
    },
  );

  it('refuses code collisions, opposite shape fields and non-Error lookalikes', () => {
    const collision = new AgentTurnError('budget_exceeded', 'turn budget failed', false);
    expect(collision).toBeInstanceOf(RelaviumError);
    expect(isBudgetExceededError(collision)).toBe(false);
    expect(isBudgetPauseError(collision)).toBe(false);
    for (const candidate of [
      Object.assign(new Error('wrong field'), { code: 'budget_exceeded', thresholdPct: 80 }),
      Object.assign(new Error('wrong field'), { code: 'budget_paused', limitMicrocents: 10 }),
      Object.assign(new Error('wrong code'), {
        code: 'other',
        limitMicrocents: 10,
        thresholdPct: 80,
      }),
      { code: 'budget_exceeded', limitMicrocents: 10 },
      { code: 'budget_paused', thresholdPct: 80 },
    ]) {
      expect(isBudgetExceededError(candidate)).toBe(false);
      expect(isBudgetPauseError(candidate)).toBe(false);
    }
  });
});
