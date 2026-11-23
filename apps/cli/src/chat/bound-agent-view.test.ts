import { describe, expect, it } from 'vitest';

import type { Agent } from '@relavium/shared';

import { AGENT_TOOLS_MAX } from '../history/agents-model.js';
import { boundAgentView } from './bound-agent-view.js';

/**
 * The two facts the host adds to the definition the `/agent` view shows (the register's MVP-8 step 5 low): which declared tools the chat does
 * not offer, and the label of the file the agent was read from. The view stays pure; these cases pin what it keeps and what it never carries.
 */

// A key-shaped string: the `sk-` prefix and thirty alphanumerics. Built from parts so no literal credential sits in the source.
const KEY = `sk-${'A1b2C3d4E5'.repeat(3)}`;

const definition = (over: Partial<Agent> = {}): Agent => ({
  id: 'reviewer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'You review code.',
  tools: ['read_file', 'ask_user', 'search_files'],
  ...over,
});

describe('the tools the chat does not offer', () => {
  it('says nothing when the host did not say: no marks, no counts', () => {
    expect(boundAgentView(definition(), undefined).toolOffer).toBeUndefined();
    expect(boundAgentView(definition(), undefined, {}).toolOffer).toBeUndefined();
    expect(boundAgentView(definition(), undefined, { wiredTools: undefined }).toolOffer).toBe(
      undefined,
    );
  });

  it('marks, in the definition’s own order, each declared tool the session does not offer, and counts the rest', () => {
    const view = boundAgentView(definition(), undefined, {
      wiredTools: ['search_files', 'read_file'],
    });
    expect(view.toolOffer).toEqual({ unwired: [false, true, false], declared: 3, offered: 2 });
    // The grant itself is untouched: the names are the declared ones, in the declared order.
    expect(view.detail.tools).toEqual(['read_file', 'ask_user', 'search_files']);
  });

  it('marks nothing when every declared tool is offered, whatever else the host adds (discovered tools are not declared)', () => {
    const view = boundAgentView(definition(), undefined, {
      wiredTools: ['read_file', 'ask_user', 'search_files', 'mcp__server__lookup'],
    });
    expect(view.toolOffer).toEqual({ unwired: [false, false, false], declared: 3, offered: 3 });
  });

  it('compares the RAW declared name with the offered ids, and shows only the scrubbed name', () => {
    // A tool named like a key would be masked on screen; it is still the tool the host wires, so it must not be marked unavailable.
    const view = boundAgentView(definition({ tools: [KEY, 'read_file'] }), undefined, {
      wiredTools: [KEY],
    });
    expect(view.toolOffer?.unwired).toEqual([false, true]);
    expect(view.detail.tools[0]).not.toContain(KEY);
  });

  it('answers for every declared tool in the count and for the shown ones in the marks', () => {
    const many = Array.from({ length: AGENT_TOOLS_MAX + 6 }, (_, index) => `tool_${String(index)}`);
    const view = boundAgentView(definition({ tools: many }), undefined, {
      wiredTools: many.slice(0, 10),
    });
    expect(view.toolOffer?.declared).toBe(AGENT_TOOLS_MAX + 6);
    expect(view.toolOffer?.offered).toBe(10);
    expect(view.toolOffer?.unwired).toHaveLength(AGENT_TOOLS_MAX);
    expect(view.toolOffer?.unwired.slice(0, 10).every((missing) => !missing)).toBe(true);
    expect(view.toolOffer?.unwired.slice(10).every((missing) => missing)).toBe(true);
  });

  it('an agent that declares no tool has nothing to mark', () => {
    const bare: Agent = {
      id: 'bare',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: '',
    };
    expect(boundAgentView(bare, undefined, { wiredTools: [] }).toolOffer).toEqual({
      unwired: [],
      declared: 0,
      offered: 0,
    });
  });
});

describe('the file label', () => {
  it('is absent when the host names no file, and when the label is empty', () => {
    expect(boundAgentView(definition(), undefined).sourceLabel).toBeUndefined();
    expect(boundAgentView(definition(), undefined, { sourceLabel: undefined }).sourceLabel).toBe(
      undefined,
    );
    expect(
      boundAgentView(definition(), undefined, { sourceLabel: '' }).sourceLabel,
    ).toBeUndefined();
  });

  it('keeps a relative label as it is', () => {
    const label = '.relavium/agents/reviewer.agent.yaml';
    expect(boundAgentView(definition(), undefined, { sourceLabel: label }).sourceLabel).toBe(label);
  });

  it('takes the one scrub-and-bound floor: a key-shaped string, a control sequence and a very long label', () => {
    const hostile = boundAgentView(definition(), undefined, {
      sourceLabel: `agents/${KEY}\u001b[31m/x\u0007.agent.yaml`,
    }).sourceLabel;
    expect(hostile).not.toContain(KEY);
    // eslint-disable-next-line no-control-regex -- the point of the test: no escape or bell survives the view
    expect(hostile).not.toMatch(/[\u001b\u0007]/u);
    const long = boundAgentView(definition(), undefined, {
      sourceLabel: `agents/${'d'.repeat(1_000)}.agent.yaml`,
    }).sourceLabel;
    expect(long?.length).toBeLessThanOrEqual(257);
    expect(long?.endsWith('…')).toBe(true);
  });
});
