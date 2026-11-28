/**
 * The words a session's and a run's row of the work page are made of (MVP-11 unit 7, round 2; `home-projection.ts`): which time a run's age is
 * counted from, and what a session is known by: its title (even one character long), else its agent; the agent is named beside a title unless
 * it is the built-in chat agent. The fitting of those words to a width is `fit-row-ladder.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_AGENT_ID } from '../../chat/default-agent.js';
import type { HomeRunRow, HomeSessionRow } from '../../home/home-store.js';
import { runLabel, sessionLabel } from './home-projection.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const session = (title: string | undefined, agentSlug = 'chatter'): HomeSessionRow => ({
  sessionId: 'session-1',
  title,
  agentSlug,
  modelId: undefined,
  status: 'ended',
  updatedAt: ago(60),
  totalCostMicrocents: 0,
});

describe('a session is known by its title, else by its agent', () => {
  it('a title of one character is the row’s name, and the agent follows it', () => {
    expect(sessionLabel(session('x'), NOW, 80)).toMatch(/^x · chatter/u);
  });

  it('no title and a title of blanks: the agent is the name, and it is named once', () => {
    expect(sessionLabel(session(undefined), NOW, 80)).toMatch(/^chatter · /u);
    expect(sessionLabel(session('   '), NOW, 80)).toMatch(/^chatter · /u);
    expect(sessionLabel(session(undefined), NOW, 80).split('chatter')).toHaveLength(2);
  });

  it('the built-in chat agent is not named beside a title, and is the name of an untitled session', () => {
    const titled = sessionLabel(session('Fix the login bug', DEFAULT_CHAT_AGENT_ID), NOW, 80);
    expect(titled).toMatch(/^Fix the login bug · 1h ago · /u);
    expect(titled).not.toContain(DEFAULT_CHAT_AGENT_ID);
    expect(sessionLabel(session(undefined, DEFAULT_CHAT_AGENT_ID), NOW, 80)).toMatch(
      new RegExp(`^${DEFAULT_CHAT_AGENT_ID} · `, 'u'),
    );
  });
});

describe('the time a run row counts its age from', () => {
  const run = (over: Partial<HomeRunRow>): HomeRunRow => ({
    runId: 'run-0123456789',
    workflowSlug: 'wf',
    status: 'completed',
    createdAt: ago(300),
    startedAt: ago(200),
    completedAt: ago(100),
    totalCostMicrocents: 0,
    ...over,
  });

  it('a running run from its start, a finished one from its end, a run with neither from its creation', () => {
    expect(runLabel(run({ status: 'running' }), NOW, 80)).toContain('3h ago');
    expect(runLabel(run({ status: 'completed' }), NOW, 80)).toContain('1h ago');
    expect(runLabel(run({ status: 'completed', completedAt: undefined }), NOW, 80)).toContain(
      '3h ago',
    );
    expect(
      runLabel(run({ status: 'pending', startedAt: undefined, completedAt: undefined }), NOW, 80),
    ).toContain('5h ago');
  });

  it('a running run is counted from its start even when it has an end on record, and from its creation when it has no start', () => {
    expect(runLabel(run({ status: 'running', completedAt: ago(10) }), NOW, 80)).toContain('3h ago');
    expect(runLabel(run({ status: 'running', startedAt: undefined }), NOW, 80)).toContain('5h ago');
  });
});
