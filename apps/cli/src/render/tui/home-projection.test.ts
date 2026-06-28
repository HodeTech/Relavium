import { describe, expect, it } from 'vitest';

import type { HomeGateRow, HomeRunRow, HomeSessionRow } from '../../home/home-store.js';
import {
  agentLabel,
  expiryLabel,
  gateLabel,
  homeFitsTerminal,
  HOME_MIN_COLS,
  HOME_MIN_ROWS,
  relativeTime,
  runLabel,
  sessionLabel,
  shortId,
  tooSmallMessage,
} from './home-projection.js';

const NOW = Date.parse('2026-06-28T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

describe('homeFitsTerminal / tooSmallMessage', () => {
  it('passes at exactly the minimum and fails below either dimension', () => {
    expect(homeFitsTerminal(HOME_MIN_COLS, HOME_MIN_ROWS)).toBe(true);
    expect(homeFitsTerminal(HOME_MIN_COLS - 1, HOME_MIN_ROWS)).toBe(false);
    expect(homeFitsTerminal(HOME_MIN_COLS, HOME_MIN_ROWS - 1)).toBe(false);
  });

  it('names both the actual size and the required minimum', () => {
    expect(tooSmallMessage(40, 10)).toBe('Terminal too small (40×10) — resize to at least 80×24.');
  });
});

describe('relativeTime', () => {
  it('buckets sub-minute / minutes / hours / days, and treats a future skew as "just now"', () => {
    expect(relativeTime(ago(5_000), NOW)).toBe('just now');
    expect(relativeTime(ahead(5_000), NOW)).toBe('just now'); // clock skew, not a negative count
    expect(relativeTime(ago(5 * MIN), NOW)).toBe('5m ago');
    expect(relativeTime(ago(3 * HR), NOW)).toBe('3h ago');
    expect(relativeTime(ago(2 * DAY), NOW)).toBe('2d ago');
  });

  it('pins the 60-second bucket boundary (59s is "just now", 60s is "1m ago")', () => {
    expect(relativeTime(ago(59_000), NOW)).toBe('just now');
    expect(relativeTime(ago(60_000), NOW)).toBe('1m ago');
  });

  it('returns "" for an unparseable timestamp (the strip renders nothing, never NaN)', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('');
  });
});

describe('expiryLabel', () => {
  it('is undefined when there is no deadline or it is unparseable', () => {
    expect(expiryLabel(undefined, NOW)).toBeUndefined();
    expect(expiryLabel('nope', NOW)).toBeUndefined();
  });

  it('shows "expired" once past (the Phase-1 in-process-timer caveat) and a forward count otherwise', () => {
    expect(expiryLabel(ago(MIN), NOW)).toBe('expired');
    expect(expiryLabel(ahead(5 * MIN), NOW)).toBe('expires in 5m');
    expect(expiryLabel(ahead(2 * HR), NOW)).toBe('expires in 2h');
  });

  it('is "expired" exactly at now, and floors a sub-second remaining to "in 1s" (never "in 0s")', () => {
    expect(expiryLabel(ahead(0), NOW)).toBe('expired'); // deadline == now ⇒ already due
    expect(expiryLabel(ahead(500), NOW)).toBe('expires in 1s'); // sub-second ⇒ floored to 1s
  });
});

describe('row labels', () => {
  const sessionRow = (over: Partial<HomeSessionRow> = {}): HomeSessionRow => ({
    sessionId: 's1',
    title: 'Plan the launch',
    agentSlug: 'planner',
    modelId: 'claude-opus-4-8',
    status: 'active',
    updatedAt: ago(5 * MIN),
    totalCostMicrocents: 120_000_000, // $1.2000 via the canonical 1e8 µ¢→USD conversion
    ...over,
  });

  const runRow = (over: Partial<HomeRunRow> = {}): HomeRunRow => ({
    runId: 'aabbccdd-0000-4000-8000-000000000000',
    workflowSlug: 'deploy',
    status: 'completed',
    createdAt: ago(2 * HR),
    startedAt: ago(2 * HR),
    completedAt: ago(1 * HR),
    totalCostMicrocents: 0,
    ...over,
  });

  it('sessionLabel: title · agent · when · cost; falls back to the agent slug when untitled', () => {
    expect(sessionLabel(sessionRow(), NOW)).toBe(
      'Plan the launch  ·  planner  ·  5m ago  ·  $1.2000',
    );
    expect(sessionLabel(sessionRow({ title: undefined }), NOW)).toBe(
      'planner  ·  planner  ·  5m ago  ·  $1.2000',
    );
  });

  it('sessionLabel sanitizes a title — strips a control seq AND collapses a newline/tab (no forged rows)', () => {
    expect(sessionLabel(sessionRow({ title: 'hi\x1b[31mthere' }), NOW)).toContain('hithere');
    const multi = sessionLabel(sessionRow({ title: 'Plan\nthe\tlaunch' }), NOW);
    expect(multi).not.toMatch(/[\n\t]/); // one physical line — a newline/tab cannot spoof an extra strip row
    expect(multi).not.toContain('\x1b');
    expect(multi).toContain('Plan the launch');
  });

  it('runLabel: completed anchors on completedAt; falls back to a short id with no slug', () => {
    expect(runLabel(runRow(), NOW)).toBe('deploy  ·  completed  ·  1h ago  ·  free');
    expect(runLabel(runRow({ workflowSlug: undefined }), NOW)).toBe(
      `${shortId(runRow().runId)}  ·  completed  ·  1h ago  ·  free`,
    );
  });

  it('runLabel: a RUNNING run anchors on startedAt (not completedAt/createdAt)', () => {
    const run = runRow({ status: 'running', startedAt: ago(10 * MIN), completedAt: undefined });
    expect(runLabel(run, NOW)).toBe('deploy  ·  running  ·  10m ago  ·  free');
  });

  it('runLabel: a queued run (no started/completed) falls back to createdAt', () => {
    const run = runRow({
      status: 'pending',
      createdAt: ago(3 * MIN),
      startedAt: undefined,
      completedAt: undefined,
    });
    expect(runLabel(run, NOW)).toBe('deploy  ·  pending  ·  3m ago  ·  free');
  });

  it('gateLabel: workflow · gateType · message · expiry urgency; sanitizes the message', () => {
    const gate: HomeGateRow = {
      runId: 'r1',
      workflowSlug: 'deploy',
      gateId: 'g1',
      gateType: 'approval',
      nodeId: 'g',
      message: 'ship\x1b[0m it?',
      expiresAt: ahead(5 * MIN),
    };
    expect(gateLabel(gate, NOW)).toBe('deploy  ·  approval  ·  ship it?  ·  expires in 5m');
    // A free-form gate message with a newline must NOT forge a second row in the one-line Attention strip.
    const injected = gateLabel({ ...gate, message: 'Approve?\nFAKE PROMPT:' }, NOW);
    expect(injected).not.toMatch(/[\n\t]/);
    expect(injected).not.toContain('\x1b');
    expect(injected).toContain('Approve? FAKE PROMPT:');
  });

  it('agentLabel: slug · last used', () => {
    expect(agentLabel({ agentSlug: 'coder', lastUsedAt: ago(3 * DAY) }, NOW)).toBe(
      'coder  ·  3d ago',
    );
  });
});
