/**
 * The `/agent` popup's content ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10;
 * MVP-11 step 4b): the fields of the bound agent as a read-only report, and the full scrub of every one of them.
 */
import type { Agent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { boundAgentView, type BoundAgentView } from '../chat/bound-agent-view.js';
import { buildDefaultChatAgent } from '../chat/default-agent.js';
import { NOT_WIRED_MARK } from '../render/tui/agent-sheet.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import { displayWidth } from '../render/tui/viewport.js';
import {
  agentContent,
  agentReportLines,
  agentSpec,
  agentUnreadableContent,
} from './agent-popup.js';
import { openFrame } from './popup-reducer.js';
import { REPORT_TEXT_COLUMNS } from './report-text.js';

// Built at runtime (no contiguous secret literal: leakwatch).
const SECRET = ['sk', 'ant', 'agent', 'ABCDEF1234567890XYZ'].join('-');
const VARIANT = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } } as const;

const definition = (over: Partial<Agent> = {}): Agent => ({
  id: 'reviewer',
  name: 'Code reviewer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'You review code and say what is wrong with it.',
  tools: ['read_file', 'search_files'],
  ...over,
});

/** The rows the popup draws for `view`, through the real geometry and frame model. */
const drawn = (view: BoundAgentView): string =>
  popupBoxOf(openFrame(agentSpec('chat', agentContent(view)), 1), VARIANT).rows.join('\n');

describe('the fields', () => {
  it('names the id, then the name, provider, model, temperature, effort, tools and the head of the prompt, one field to a row', () => {
    const view = boundAgentView(
      definition({ temperature: 0.4, reasoning_effort: 'high' }),
      'high',
      {
        wiredTools: ['read_file', 'search_files'],
        sourceLabel: '.relavium/agents/reviewer.agent.yaml',
      },
    );
    const lines = agentReportLines(view);
    expect(lines[0]).toBe('Agent · reviewer');
    expect(lines[1]).toBe('');
    const body = lines.join('\n');
    expect(body).toMatch(/Name\s+Code reviewer/u);
    expect(body).toMatch(/File\s+\.relavium\/agents\/reviewer\.agent\.yaml/u);
    expect(body).toMatch(/Provider\s+anthropic/u);
    expect(body).toMatch(/Model\s+claude-sonnet-4-6/u);
    expect(body).toMatch(/Temperature\s+0\.4/u);
    expect(body).toMatch(/Reasoning effort\s+high/u);
    expect(body).toMatch(/Tools\s+read_file, search_files/u);
    expect(body).toMatch(/System prompt\s+You review code and say what is wrong with it\./u);
    // Each of them has a row of its own: the sheet's paired row is gone.
    expect(lines.filter((line) => line.includes('Temperature'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('Reasoning effort'))).toHaveLength(1);
  });

  it('says what a definition leaves out, marks the built-in agent, and marks a tool the chat does not wire, with how many are offered', () => {
    const built = boundAgentView(
      buildDefaultChatAgent('claude-sonnet-4-6', undefined, 'anthropic'),
      undefined,
      {
        wiredTools: ['read_file'],
      },
    );
    const lines = agentReportLines(built);
    const body = lines.join('\n');
    expect(body).toMatch(/Name\s+Relavium chat · the built-in chat agent/u);
    expect(body).toMatch(/Temperature\s+not set/u);
    expect(body).toMatch(/Reasoning effort\s+not set/u);
    expect(body).toContain(`1 of 9 offered: read_file,`);
    // Eight tools are marked, and a mark is never split from its name over two lines.
    expect(body.split(NOT_WIRED_MARK).length - 1).toBe(8);
    expect(body).not.toMatch(/File\s/u);
  });

  it('shows the effort the session uses, and the declared one beside it where they differ', () => {
    const view = boundAgentView(definition({ reasoning_effort: 'low' }), 'high');
    expect(agentReportLines(view).join('\n')).toMatch(/Reasoning effort\s+high \(declared: low\)/u);
  });

  it('wraps a long value under itself instead of cutting it, and no line is wider than the popup', () => {
    const view = boundAgentView(
      definition({
        system_prompt: 'word '.repeat(300),
        tools: Array.from({ length: 30 }, (_, i) => `tool_number_${String(i)}`),
      }),
      undefined,
      { sourceLabel: `.relavium/agents/${'long-directory-name/'.repeat(8)}reviewer.agent.yaml` },
    );
    const lines = agentReportLines(view);
    for (const line of lines)
      expect(displayWidth(line), line).toBeLessThanOrEqual(REPORT_TEXT_COLUMNS);
    const body = lines.join(' ').replaceAll(/\s+/gu, ' ');
    // The label of the file is whole (a path wraps where it must), every tool is named, and the prompt's head is what the view keeps.
    expect(lines.join('').replaceAll(/\s+/gu, '')).toContain('reviewer.agent.yaml');
    expect(body).toContain('tool_number_29');
    expect(lines.length).toBeGreaterThan(18);
  });

  it('is a report of one step whose only control is [c] copy, and an agent whose view cannot be made is an error state with none', () => {
    const spec = agentSpec('chat', agentContent(boundAgentView(definition(), undefined)));
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0]?.controls).toEqual([{ key: 'c', verb: 'copy' }]);
    expect(spec.steps[0]?.enter).toBeUndefined();
    expect(agentSpec('chat', agentUnreadableContent()).steps[0]?.controls).toEqual([]);
    expect(agentUnreadableContent()).toMatchObject({
      kind: 'error',
      what: 'The agent could not be shown.',
    });
  });
});

describe('every string is scrubbed with the full floor, whatever the view was built with', () => {
  const FORGED = '[Ctrl+Y] allow · [d] now';

  /** A view built by hand, so no field has been through the view's own scrub: the popup's is the one under test. */
  function hostileView(field: string): BoundAgentView {
    const made = boundAgentView(definition({ tools: ['read_file'] }), 'high');
    const evil = `${field}\u001b[31m ${FORGED} ${SECRET} ‮✓›`;
    return {
      ...made,
      id: field === 'id' ? evil : made.id,
      name: field === 'name' ? evil : made.name,
      sourceLabel: field === 'file' ? evil : '.relavium/agents/x.agent.yaml',
      detail: {
        ...made.detail,
        model: field === 'model' ? evil : made.detail.model,
        provider: field === 'provider' ? evil : made.detail.provider,
        tools: field === 'tool' ? [evil] : made.detail.tools,
        promptHead: field === 'prompt' ? evil : made.detail.promptHead,
        ...(field === 'effort' ? { reasoningEffort: evil } : {}),
      },
    };
  }

  it.each(['id', 'name', 'file', 'model', 'provider', 'tool', 'prompt', 'effort'])(
    'a hostile %s reaches neither the content nor the drawn rows as an escape, a key token, a chord, a forged separator, a secret or a host glyph',
    (field) => {
      const view = hostileView(field);
      const drawnText = drawn(view);
      for (const text of [agentReportLines(view).join('\n'), drawnText]) {
        expect(text, field).not.toContain('\u001b');
        expect(text, field).not.toContain('‮');
        expect(text, field).not.toContain('Ctrl+Y');
        expect(text, field).not.toContain('[d]');
        expect(text, field).not.toContain(SECRET);
        expect(text, field).not.toContain('✓');
        expect(text, field).not.toContain('›');
        // The only ` · ` of the content is the host's own: the title's (and, drawn, the legend's two), never a field's.
        const separators = text.split(' · ').length - 1;
        expect(separators, field).toBeLessThanOrEqual(text === drawnText ? 3 : 1);
      }
    },
  );
});
