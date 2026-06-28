import { describe, expect, it } from 'vitest';

import type { HomeGateRow, HomeRunRow, HomeSessionRow } from '../../home/home-store.js';
import {
  agentLabel,
  expiryLabel,
  formatCost,
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

  it('returns "" for an unparseable timestamp (the strip renders nothing, never NaN)', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('');
  });
});

describe('formatCost', () => {
  it('shows "free" at zero, 4 decimals below a cent, 2 at/above a cent', () => {
    expect(formatCost(0)).toBe('free');
    expect(formatCost(4_200)).toBe('$0.0042'); // 4200 microcents = $0.0042
    expect(formatCost(1_200_000)).toBe('$1.20');
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
});

describe('row labels', () => {
  const sessionRow = (over: Partial<HomeSessionRow> = {}): HomeSessionRow => ({
    sessionId: 's1',
    title: 'Plan the launch',
    agentSlug: 'planner',
    modelId: 'claude-opus-4-8',
    status: 'active',
    updatedAt: ago(5 * MIN),
    totalCostMicrocents: 1_200_000,
    ...over,
  });

  it('sessionLabel: title · agent · when · cost; falls back to the agent slug when untitled', () => {
    expect(sessionLabel(sessionRow(), NOW)).toBe(
      'Plan the launch  ·  planner  ·  5m ago  ·  $1.20',
    );
    expect(sessionLabel(sessionRow({ title: undefined }), NOW)).toBe(
      'planner  ·  planner  ·  5m ago  ·  $1.20',
    );
  });

  it('sessionLabel sanitizes a title carrying a control sequence (display-boundary safety)', () => {
    const label = sessionLabel(sessionRow({ title: 'hi\x1b[31mthere' }), NOW);
    expect(label).not.toContain('\x1b');
    expect(label).toContain('hithere');
  });

  it('runLabel: workflow (or short id) · status · when · cost; anchors a completed run on completedAt', () => {
    const run: HomeRunRow = {
      runId: 'aabbccdd-0000-4000-8000-000000000000',
      workflowSlug: 'deploy',
      status: 'completed',
      createdAt: ago(2 * HR),
      startedAt: ago(2 * HR),
      completedAt: ago(1 * HR),
      totalCostMicrocents: 0,
    };
    expect(runLabel(run, NOW)).toBe('deploy  ·  completed  ·  1h ago  ·  free');
    // No slug ⇒ a short run id labels it.
    expect(runLabel({ ...run, workflowSlug: undefined }, NOW)).toBe(
      `${shortId(run.runId)}  ·  completed  ·  1h ago  ·  free`,
    );
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
    const label = gateLabel(gate, NOW);
    expect(label).toBe('deploy  ·  approval  ·  ship it?  ·  expires in 5m');
    expect(label).not.toContain('\x1b');
  });

  it('agentLabel: slug · last used', () => {
    expect(agentLabel({ agentSlug: 'coder', lastUsedAt: ago(3 * DAY) }, NOW)).toBe(
      'coder  ·  3d ago',
    );
  });
});
