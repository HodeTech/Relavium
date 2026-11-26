/**
 * The work page's rows as the maintainer's ruling 4 words them (MVP-11 unit 7): one row per item, its fields joined by ` · `, the run named by
 * its workflow and the first eight characters of its id (last), cut at its width and never wrapped, with stored text scrubbed BEFORE the cut.
 * What a narrow row gives up, in order: a run's row its workflow's tail (to twelve columns), then its cost, then its age, then its id (the
 * status word never); a session's row its cost, then its age, then its title's tail, then its agent (its title is how a person knows it).
 * Pinned at the rows' widths on an 80- and a 100-column terminal (70 and 88 columns: the margin and the row's indent taken).
 */
import { describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeUnreadableRun } from '../../home/home-store.js';
import {
  agentLabel,
  failedRunLabel,
  ROW_NAME_FLOOR,
  runLabel,
  sessionLabel,
  unreadableRunLabel,
} from './home-projection.js';
import { withGlyphForm } from './glyphs.js';
import { displayWidth } from './viewport.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const AT_80 = 80 - 6 - 4;
const AT_100 = 100 - 8 - 4;
const ESC = String.fromCharCode(0x1b);

const run = (over: Partial<HomeRunRow> = {}): HomeRunRow => ({
  runId: '3f9a1c2e-7b64-4d0a-9c11-5a2e8f6d0b13',
  workflowSlug: 'release-notes',
  status: 'completed',
  createdAt: '2026-11-26T09:55:00.000Z',
  startedAt: '2026-11-26T09:55:00.000Z',
  completedAt: '2026-11-26T10:00:00.000Z',
  totalCostMicrocents: 4_000_000,
  usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
  ...over,
});
const session = (over: Partial<HomeSessionRow> = {}): HomeSessionRow => ({
  sessionId: 's1',
  workingDir: '/work',
  title: 'Refactor the billing module',
  agentSlug: 'coder',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-26T11:00:00.000Z',
  totalCostMicrocents: 12_000_000,
  usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
  ...over,
});
const LONG = 'nightly-release-pipeline-for-the-eu-region';

describe('a run of the Runs section', () => {
  it('`workflow · status · age · cost · id` whole at 80 and 100 columns', () => {
    expect(runLabel(run(), NOW, AT_80)).toBe('release-notes · completed · 2h ago · $0.0400 · 3f9a1c2e');
    expect(runLabel(run(), NOW, AT_100)).toBe('release-notes · completed · 2h ago · $0.0400 · 3f9a1c2e');
  }); // prettier-ignore

  it('a long workflow gives up its tail first and keeps the cost, the age and the id while its floor allows', () => {
    expect(runLabel(run({ workflowSlug: LONG }), NOW, AT_80)).toBe(
      'nightly-release-pipeline-fo… · completed · 2h ago · $0.0400 · 3f9a1c2e',
    );
    expect(displayWidth(runLabel(run({ workflowSlug: LONG }), NOW, AT_80))).toBeLessThanOrEqual(AT_80);
    // narrower: the name down to its floor (54 = 12 + the rest's 42), then the cost, then the age, then the id; the status word stays
    expect(runLabel(run({ workflowSlug: LONG }), NOW, 54)).toBe('nightly-rel… · completed · 2h ago · $0.0400 · 3f9a1c2e');
    expect(runLabel(run({ workflowSlug: LONG }), NOW, 50)).toBe('nightly-release-p… · completed · 2h ago · 3f9a1c2e');
    expect(runLabel(run({ workflowSlug: LONG }), NOW, 39)).toBe('nightly-release… · completed · 3f9a1c2e');
    expect(runLabel(run({ workflowSlug: LONG }), NOW, 30)).toBe('nightly-release-p… · completed');
    expect(runLabel(run({ workflowSlug: LONG }), NOW, 20)).toBe('nightly… · completed');
    expect(runLabel(run({ workflowSlug: LONG }), NOW, 9)).toBe('completed');
  }); // prettier-ignore

  it('never draws a row wider than it was given, and always keeps the status word down to the word’s own width', () => {
    for (let columns = 9; columns <= 120; columns += 1) {
      const label = runLabel(run({ workflowSlug: LONG }), NOW, columns);
      expect(displayWidth(label), String(columns)).toBeLessThanOrEqual(columns);
      expect(label, String(columns)).toContain('completed');
    }
  });
});

describe('a failed run under Attention', () => {
  it('`✗ workflow · failed 2h ago · cost · id`, the glyph in the form in force', () => {
    expect(failedRunLabel(run({ status: 'failed' }), NOW, AT_80)).toBe(
      '✗ release-notes · failed 2h ago · $0.0400 · 3f9a1c2e',
    );
    expect(withGlyphForm(true, () => failedRunLabel(run({ status: 'failed' }), NOW, AT_100))).toBe(
      'x release-notes · failed 2h ago · $0.0400 · 3f9a1c2e',
    );
  });

  it('with no workflow name, its id names it alone; narrow, its age goes after its cost and the word `failed` stays', () => {
    expect(failedRunLabel(run({ status: 'failed', workflowSlug: undefined }), NOW, AT_80)).toBe(
      '✗ failed 2h ago · $0.0400 · 3f9a1c2e',
    );
    expect(failedRunLabel(run({ status: 'failed' }), NOW, 42)).toBe('✗ release-notes · failed 2h ago · 3f9a1c2e');
    expect(failedRunLabel(run({ status: 'failed' }), NOW, 40)).toBe('✗ release-notes · failed · 3f9a1c2e');
  }); // prettier-ignore
});

describe('a run whose log cannot be read', () => {
  const broken = (over: Partial<HomeUnreadableRun> = {}): HomeUnreadableRun => ({
    runId: '3f9a1c2e-7b64-4d0a-9c11-5a2e8f6d0b13',
    reason: 'corrupt-row',
    ...over,
  });
  it('`⚠ id · workflow · cannot be read`, the workflow only when the summary read named it', () => {
    expect(unreadableRunLabel(broken({ workflowSlug: 'release-notes' }), AT_80)).toBe(
      '⚠ 3f9a1c2e · release-notes · cannot be read',
    );
    expect(unreadableRunLabel(broken(), AT_80)).toBe('⚠ 3f9a1c2e · cannot be read');
  });
});

describe('a session', () => {
  it('`title · agent · age · cost`, one row, at 80 and 100 columns', () => {
    expect(sessionLabel(session(), NOW, AT_80)).toBe('Refactor the billing module · coder · 1h ago · $0.1200');
    expect(sessionLabel(session(), NOW, AT_100)).toBe('Refactor the billing module · coder · 1h ago · $0.1200');
  }); // prettier-ignore

  it('narrow, it gives up its cost, then its age, then its title’s tail, then its agent: two titles that differ at their end stay apart', () => {
    const one = session({ title: 'Conversation about the billing module, part 1' });
    const two = session({ title: 'Conversation about the billing module, part 2' });
    expect(sessionLabel(one, NOW, 70)).toBe('Conversation about the billing module, part 1 · coder · 1h ago');
    expect(sessionLabel(one, NOW, 60)).toBe('Conversation about the billing module, part 1 · coder');
    expect(sessionLabel(one, NOW, 50)).toBe('Conversation about the billing module, pa… · coder');
    // the title down to its floor beside the agent (12 + 8), then the agent goes and the title has the row
    expect(sessionLabel(one, NOW, 20)).toBe('Conversatio… · coder');
    expect(sessionLabel(one, NOW, 15)).toBe('Conversation a…');
    for (const columns of [60, 70, 88]) expect(sessionLabel(one, NOW, columns)).not.toBe(sessionLabel(two, NOW, columns));
    const short = session({ title: 'Conversation 1' });
    expect(sessionLabel(short, NOW, 31)).toBe('Conversation 1 · coder · 1h ago');
    expect(sessionLabel(short, NOW, 30)).toBe('Conversation 1 · coder');
  }); // prettier-ignore

  it('an untitled session is named by its agent, once', () => {
    expect(sessionLabel(session({ title: undefined }), NOW, AT_80)).toBe(
      'coder · 1h ago · $0.1200',
    );
  });
});

describe('an agent', () => {
  it('`agent · when last used`', () => {
    expect(agentLabel({ agentSlug: 'reviewer', lastUsedAt: '2026-11-26T11:30:00.000Z' }, NOW, AT_80)).toBe(
      'reviewer · 30m ago',
    );
  }); // prettier-ignore
});

describe('stored text is scrubbed BEFORE the cut', () => {
  it('an escape at the cut point never leaves half a sequence, and nothing of it reaches the row', () => {
    const hostile = `${'a'.repeat(10)}${ESC}[31m${'b'.repeat(40)}`;
    for (let columns = 20; columns <= 80; columns += 1) {
      const label = runLabel(run({ workflowSlug: hostile }), NOW, columns);
      expect(label, String(columns)).not.toContain(ESC);
      expect(label, String(columns)).not.toContain('[31m');
    }
  });

  it('a separator, a chord and a host glyph in a name are inert: the row’s own separators are the only ones on it', () => {
    const label = runLabel(run({ workflowSlug: 'x · [Ctrl+Y] allow › y' }), NOW, 120);
    expect(label.split(' · ')).toHaveLength(5);
    expect(label).not.toContain('[Ctrl+Y]');
    expect(label).not.toContain('›');
    const titled = sessionLabel(session({ title: 'a · b · c' }), NOW, 120);
    expect(titled.split(' · ')).toHaveLength(4);
  });

  it('a wide-character name is cut by display columns, with an ellipsis, and the row keeps to its width', () => {
    const wide = '日本語のワークフロー'.repeat(8);
    for (const columns of [AT_80, AT_100]) {
      const label = runLabel(run({ workflowSlug: wide }), NOW, columns);
      expect(displayWidth(label), String(columns)).toBeLessThanOrEqual(columns);
      expect(label.split(' · ')[0]?.endsWith('…')).toBe(true);
    }
    expect(ROW_NAME_FLOOR).toBe(12);
  });
});
