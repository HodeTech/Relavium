import { BudgetExceededError, BudgetPauseError } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { buildChatSession, buildGovernorWiring, type ChatBudgetWarning } from './session-host.js';
import { drainHandle, scriptedResolver, textTurn, unresolvedResolver } from './test-support.js';

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultModel: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
};

function deterministicIds() {
  let tick = Date.parse('2026-06-25T00:00:00.000Z');
  return { now: () => tick++, uuid: () => 'sess-test-1' };
}

function build(overrides: Partial<Parameters<typeof buildChatSession>[0]> = {}) {
  const { now, uuid } = deterministicIds();
  return buildChatSession({
    chat: EMPTY_CHAT,
    agentRef: undefined,
    cwd: '/workspace',
    projectConfigDir: undefined,
    now,
    uuid,
    providers: scriptedResolver([textTurn('hello there')]),
    ...overrides,
  });
}

describe('buildChatSession', () => {
  it('mints the session over the default agent + a handle scoped to the same id', () => {
    const built = build({ chat: { ...EMPTY_CHAT, defaultModel: 'claude-sonnet-4-6' } });
    expect(built.sessionId).toBe('sess-test-1');
    expect(built.handle.sessionId).toBe('sess-test-1');
    expect(built.agent.id).toBe('relavium-chat');
    expect(built.agent.model).toBe('claude-sonnet-4-6');
    expect(built.context.workingDir).toBe('/workspace');
    expect(built.context.fsScopeTier).toBe('sandboxed'); // default when [chat].fs_scope is unset
  });

  it('honors [chat].fs_scope on the SessionContext', () => {
    const built = build({ chat: { ...EMPTY_CHAT, fsScope: 'project' } });
    expect(built.context.fsScopeTier).toBe('project');
  });

  it('streams a text turn end-to-end through the handle (started → tokens → cost → completed → cancelled)', async () => {
    const built = build({ providers: scriptedResolver([textTurn('hello there')]) });
    built.session.start();
    await built.session.sendMessage('hi');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const types = events.map((e) => e.type);
    expect(types).toContain('session:started');
    expect(types).toContain('session:turn_started');
    expect(types).toContain('cost:updated'); // the per-attempt cost event rides the session stream
    expect(types).toContain('session:turn_completed');
    expect(types[types.length - 1]).toBe('session:cancelled'); // the session's sole terminal

    const tokens = events.flatMap((e) => (e.type === 'agent:token' ? [e.token] : [])).join('');
    expect(tokens).toBe('hello there');
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' && completed.stopReason).toBe('stop');
  });

  it('enforces [chat].max_turns: an over-cap sendMessage settles loudly as turn_limit with no provider call', async () => {
    // unresolvedResolver ⇒ every turn fails fast as `internal` (a host-wiring gap) but still COUNTS toward
    // the cap, so the 3rd message past a cap of 2 is blocked as turn_limit without engaging a provider.
    const built = build({
      chat: { ...EMPTY_CHAT, maxTurns: 2 },
      providers: unresolvedResolver(),
    });
    built.session.start();
    await built.session.sendMessage('one');
    await built.session.sendMessage('two');
    await built.session.sendMessage('three');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const errorCodes = events.flatMap((e) =>
      e.type === 'session:turn_completed' && e.error !== undefined ? [e.error.code] : [],
    );
    expect(errorCodes).toEqual(['internal', 'internal', 'turn_limit']);
  });
});

describe('buildGovernorWiring', () => {
  // Seed the governor's cumulative directly via updateCost so the pre-egress projection trips the cap
  // regardless of model pricing — exercising the real fail/pause/warn behavior, not just the wiring shape.
  const OVER_CAP = { model: 'claude-sonnet-4-6', maxTokens: 1000 } as const;

  it('is unbounded (no governor) when the cost cap is absent or 0', () => {
    expect(buildGovernorWiring(EMPTY_CHAT)).toBeUndefined();
    expect(buildGovernorWiring({ ...EMPTY_CHAT, maxCostMicrocents: 0 })).toBeUndefined();
  });

  it('wires preEgress + updateCost when a positive cost cap is set', () => {
    const wiring = buildGovernorWiring({
      ...EMPTY_CHAT,
      maxCostMicrocents: 1000,
      onExceed: 'fail',
    });
    expect(wiring).toBeDefined();
    expect(typeof wiring?.preEgress).toBe('function');
    expect(typeof wiring?.updateCost).toBe('function');
  });

  it('on_exceed:fail — preEgress rejects with BudgetExceededError once the cap is exceeded', async () => {
    const wiring = buildGovernorWiring({ ...EMPTY_CHAT, maxCostMicrocents: 1, onExceed: 'fail' });
    wiring?.updateCost(999_999); // cumulative now far past the 1-microcent cap
    await expect(wiring?.preEgress(OVER_CAP)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('on_exceed default (pause_for_approval) — preEgress rejects with BudgetPauseError', async () => {
    // onExceed omitted ⇒ the wiring defaults to pause_for_approval (the REPL is the approval gate).
    const wiring = buildGovernorWiring({ ...EMPTY_CHAT, maxCostMicrocents: 1 });
    wiring?.updateCost(999_999);
    await expect(wiring?.preEgress(OVER_CAP)).rejects.toBeInstanceOf(BudgetPauseError);
  });

  it('on_exceed:warn — preEgress is non-blocking and forwards to onWarning (no silent drop)', async () => {
    const warnings: ChatBudgetWarning[] = [];
    const wiring = buildGovernorWiring(
      { ...EMPTY_CHAT, maxCostMicrocents: 1, onExceed: 'warn' },
      (warning) => warnings.push(warning),
    );
    wiring?.updateCost(999_999);
    await expect(wiring?.preEgress(OVER_CAP)).resolves.toBeUndefined(); // warn never blocks
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.limitMicrocents).toBe(1);
  });
});
